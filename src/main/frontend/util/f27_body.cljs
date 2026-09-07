(ns frontend.util.f27-body
  "F27 readable-context batch — pure helpers for rendering ONE block's text
  inside an F27 panel.

  The problem this exists for: F27 panels render a block's text with OG's own
  inline renderer, and a `((uuid))` in that text reaches `block-reference`,
  which renders the WHOLE target block — its own references included — one
  `:link-depth` further down. Two blocks that reference each other therefore
  substitute each other's text over and over until OG's depth ceiling is
  exceeded, and every branch then prints `Block ref nesting is too deep`. The
  inbound navigator's cycle guard cannot see this: it guards NAVIGATION steps,
  and this happens inside one row's body.

  The contract implemented here, recorded in F27_BODY_DISPLAY_CONTRACT.md:

    L0   the block's own text            rendered in full, unchanged
    L1   one reference-preview level     the target's own text, BOUNDED
    L2+  never automatic                 an honest, compact, unexpanded chip

  with a cycle outranking depth, an unresolvable target said in words rather
  than as a raw identifier, and a per-body budget so reference-heavy text cannot
  produce unbounded output.

  This namespace is PURE. It reads no database, renders nothing, persists
  nothing and changes no global setting. Callers resolve blocks and render; this
  decides and bounds. In particular it introduces NO second Markdown grammar:
  every decision is taken over OG's own inline AST, and truncation drops AST
  nodes rather than rewriting markup with regular expressions."
  (:require [clojure.string :as string]
            [frontend.util.f27-crystal :as f27c]))

;; ---------------------------------------------------------------------------
;; The bounds. All small, all named on screen when they bite.
;; ---------------------------------------------------------------------------

(def ^:const max-preview-level
  "How many reference levels below the block's own text are expanded
  automatically. ONE: the block says what it says, and a reference it contains
  shows what it points at. Anything below that is reached by navigating, not by
  substitution."
  1)

(def ^:const max-expansions
  "Expanded reference previews per rendered body. A block quoting six references
  is legitimate; rendering six full previews inside one panel row is not."
  4)

(def ^:const max-preview-chars
  "Characters of text one reference preview may contribute before it is cut
  short. Enough for a sentence, not enough to bury the block that contains it."
  160)

(def ^:const max-body-chars
  "Characters of REFERENCE PREVIEW text one body may contribute in total. The
  block's own text is never counted against this and is never truncated — it is
  what the reader opened the panel to read."
  420)

(def ^:const max-label-chars
  "Length of the compact label shown for a reference that is not expanded."
  40)

(def ^:const walk-limit
  "Bound on AST recursion depth while measuring. Malformed input cannot spin."
  32)

;; ---------------------------------------------------------------------------
;; Budget. A plain map, threaded by the caller through a volatile it owns.
;; ---------------------------------------------------------------------------

(defn new-budget
  "A fresh accounting record for ONE rendered body.

  :expansions  reference previews already expanded
  :chars       preview characters already emitted
  :truncated   previews cut short by a character bound
  :withheld    references not expanded because the budget was spent

  `:truncated` and `:withheld` exist so the body can say what it did instead of
  quietly showing less."
  []
  {:expansions 0 :chars 0 :truncated 0 :withheld 0})

(defn budget-spent?
  "True when this body may not expand another reference."
  [{:keys [expansions chars]}]
  (or (>= (or expansions 0) max-expansions)
      (>= (or chars 0) max-body-chars)))

(defn remaining-chars
  "Preview characters this body may still emit, never negative."
  [{:keys [chars]}]
  (max 0 (- max-body-chars (or chars 0))))

(defn preview-allowance
  "Characters the NEXT preview may use: its own bound, capped by what the body
  has left."
  [budget]
  (min max-preview-chars (remaining-chars budget)))

(defn spend
  "Record one expanded preview against the budget."
  [budget used truncated?]
  (-> budget
      (update :expansions (fnil inc 0))
      (update :chars (fnil + 0) (max 0 (or used 0)))
      (cond-> truncated? (update :truncated (fnil inc 0)))))

(defn withhold
  "Record one reference the budget refused to expand."
  [budget]
  (update budget :withheld (fnil inc 0)))

(defn body-note-needed?
  "True when the reader must be told that this body is showing less than it
  found. A reference left unexpanded because of the LEVEL contract is not this
  case — that is the contract working normally, and each chip says so itself."
  [{:keys [truncated withheld]}]
  (or (pos? (or truncated 0)) (pos? (or withheld 0))))

;; ---------------------------------------------------------------------------
;; Classification. Cycle outranks depth, deliberately.
;; ---------------------------------------------------------------------------

(defn plan-ref
  "How ONE block reference inside an F27 body must be presented.

  `id`         the reference's target identity as a string, or nil
  `resolved?`  whether the caller could resolve it to a readable block
  `labelled?`  whether the AUTHOR wrote their own label for this reference
  `level`      0 while rendering the block's own text, 1 inside a preview
  `trail`      identities already being rendered above this point, INCLUDING
               the host block, so a self-reference is a repeat by construction
  `budget`     this body's accounting record

  Returns one of:
    :unresolved  nothing to show; say so in words, never as an identifier
    :label       the author's own label is what the reader should read
    :repeat      already on this trail — a cycle, or the same block twice
    :depth       below the one preview level this contract expands
    :budget      this body has spent its preview allowance
    :expand      show a bounded preview of the target's own text

  The order matters. A cycle is reported as a cycle even when it is also too
  deep, because 'this repeats' explains what the reader is seeing and 'too deep'
  does not."
  [{:keys [id resolved? labelled? level trail budget]}]
  (cond
    (or (nil? id) (string/blank? (str id))) :unresolved
    (not resolved?) :unresolved
    (contains? (or trail #{}) id) :repeat
    labelled? :label
    (>= (or level 0) max-preview-level) :depth
    (budget-spent? (or budget (new-budget))) :budget
    :else :expand))

(defn expandable?
  "True for the one outcome that renders the target's own text."
  [outcome]
  (= :expand outcome))

(defn push-trail
  "Add one identity to the render trail. nil is ignored rather than poisoning
  the set, so an anonymous host block cannot make every reference look repeated."
  [trail id]
  (let [trail (or trail #{})]
    (if (and id (not (string/blank? (str id)))) (conj trail id) trail)))

;; ---------------------------------------------------------------------------
;; Bounding the preview, over the AST rather than over the markup.
;; ---------------------------------------------------------------------------

(defn- text-length
  "Characters of user-visible text carried by one inline AST node.

  OG's inline nodes are `[\"NodeType\" payload…]`, so the leading tag is the
  node's NAME, not something the reader sees, and is not counted. A link's
  payload is a map whose visible part is its `:label`; its url, title and raw
  text are not on screen and are not counted either.

  This is a bound on emitted text, not a typographic measurement. It is used to
  decide when to stop rendering, and is never shown to the reader as a count.
  A nested block reference measures as its label alone, which is itself bounded
  by `max-label-chars`, so the underestimate is small and fixed."
  [node]
  (let [total (volatile! 0)]
    (letfn [(walk [n depth]
              (when (< depth walk-limit)
                (cond
                  (string? n) (vswap! total + (count n))
                  (map? n) (walk (:label n) (inc depth))
                  ;; ["Tag" …] / ["Plain" …] — skip the type, walk the payload.
                  (and (vector? n) (string? (first n)))
                  (doseq [c (rest n)] (walk c (inc depth)))
                  (coll? n) (doseq [c n] (walk c (inc depth)))
                  :else nil)))]
      (walk node 0))
    @total))

(defn plain-node?
  "True for the AST nodes that are literally a run of text, and can therefore be
  cut at a character boundary without damaging any markup."
  [node]
  (and (vector? node)
       (contains? #{"Plain" "Spaces"} (first node))
       (string? (second node))))

(defn- cut-plain
  "Shorten a plain-text node to `n` user-perceived characters.

  Uses the same grapheme-aware segmentation the Crystal chips use, so a Korean
  syllable or a joined emoji sequence is never split in half. Returns nil when
  nothing fits."
  [node n]
  (let [s (second node)
        segs (f27c/segments s)]
    (when (and (pos? n) (seq segs))
      [(first node) (string/join (subvec segs 0 (min n (count segs))))])))

(defn take-nodes
  "Take inline AST nodes until `budget` characters of text have been emitted.

  Returns {:nodes [...] :used n :truncated? bool}.

  * A plain run that does not fit is CUT at a grapheme boundary, so a preview
    ends mid-sentence rather than mid-character.
  * A structured node (emphasis, a link, a tag) is taken whole or not at all,
    because half of one is not markup.
  * At least one node is always taken when there is anything to take, so a
    preview is never rendered empty while claiming to show something.

  Truncation is reported, never assumed harmless: the caller shows `…` and the
  body offers the source block."
  [nodes budget]
  (let [budget (max 0 (or budget 0))
        nodes (vec (remove nil? nodes))]
    (if (empty? nodes)
      {:nodes [] :used 0 :truncated? false}
      (loop [i 0, used 0, out []]
        (if (>= i (count nodes))
          {:nodes out :used used :truncated? false}
          (let [n (nth nodes i)
                w (text-length n)
                left (- budget used)]
            (cond
              ;; It fits.
              (<= w left)
              (recur (inc i) (+ used w) (conj out n))

              ;; It does not fit, but it can be cut honestly.
              (and (plain-node? n) (pos? left))
              (if-let [cut (cut-plain n left)]
                {:nodes (conj out cut) :used budget :truncated? true}
                {:nodes out :used used :truncated? true})

              ;; Nothing taken yet: take this one anyway rather than render an
              ;; empty preview, and say it was truncated.
              (empty? out)
              {:nodes [n] :used w :truncated? true}

              :else
              {:nodes out :used used :truncated? true})))))))

;; ---------------------------------------------------------------------------
;; Labels for a reference that is NOT expanded.
;; ---------------------------------------------------------------------------

(defn compact-label
  "The short name shown for a reference this contract does not expand.

  `plain` is the target's text with inline reference markup already reduced to
  what a person reads — the caller passes the result of the existing compact
  label helper, so a target whose own text is mostly `((uuid))` does not produce
  a label made of identifiers.

  Returns nil when there is no usable text, and the caller then says in words
  that the block has no readable text rather than showing an empty chip. A raw
  identifier is NEVER an acceptable label."
  ([plain] (compact-label plain max-label-chars))
  ([plain max-len]
   (let [s (f27c/preview-text plain max-len)]
     (when-not (string/blank? s) s))))
