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

(def ^:const min-preview-chars
  "The smallest allowance worth expanding a reference into.

  Below this a preview would be mostly ellipsis, so the reference is presented
  as a compact label instead. This is also what keeps the shared body allowance
  from being spent on fragments, and what guarantees that a preview which falls
  back to a label still had room for one."
  24)

(def ^:const unmeasured-weight
  "What one node costs when its rendered text is NOT in its payload and cannot
  be derived from it.

  A node whose display is driven by a data map — a link with no label, a macro,
  an inline source block — must never measure as nothing, because a node that
  measures as nothing is emitted whole however large it renders. That is exactly
  how a formatted target escaped the preview bound. `max-label-chars` is used
  because it is also the bound on every compact label this contract renders."
  max-label-chars)

(def ^:const measure-limit
  "Above this many code units a string is measured by code units rather than by
  graphemes.

  A grapheme count is never greater than a code-unit count, so the substitute
  can only OVER-state a string's size: it can make a preview shorter, never
  longer. It exists so an arbitrarily long string is not segmented on every
  render."
  4096)

(def ^:const walk-limit
  "Bound on AST recursion depth while measuring and shortening. Malformed input
  cannot spin."
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
  "True when this body may not expand another reference.

  Either it has expanded as many as it may, or too little of the shared
  allowance is left to say anything with. The second test is what stops the
  remainder being dribbled away on fragments, and it guarantees that a preview
  which has to fall back to a compact label had room for one."
  [{:keys [expansions chars]}]
  (or (>= (or expansions 0) max-expansions)
      (< (- max-body-chars (or chars 0)) min-preview-chars)))

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
;; Measuring, over the AST rather than over the markup.
;;
;; What is measured is PREVIEW TEXT only: the words pulled in from another
;; block. A chip's mark (`↻`, `⋯`, `⚠`), its `↗` source control, the `…` that
;; says a preview was cut, and the body's one-line note are fixed chrome. They
;; are constant in size, they are what makes a bound honest rather than silent,
;; and they are deliberately NOT charged to any allowance.
;; ---------------------------------------------------------------------------

(defn text-size
  "Size of one string in user-perceived characters.

  Graphemes, using the same segmentation the cutting below uses, so a string is
  never measured one way and cut another — a Korean syllable or a joined emoji
  sequence counts as one and is cut as one.

  Above `measure-limit` code units the code-unit count is used instead. That is
  never smaller than the grapheme count, so it can only make a preview shorter."
  [s]
  (cond
    (not (string? s)) 0
    (<= (count s) measure-limit) (count (f27c/segments s))
    :else (count s)))

(def ^:private hidden-map-keys
  "Payload-map keys that never reach the screen: the source markup, the
  destination and the tooltip. Everything else in a payload map might."
  #{:url :full_text :title :metadata})

(declare displayed-length)

(defn- map-displayed-length
  "How much text a payload MAP puts on screen.

  In order:
    * `:label` is what renders when the author wrote one;
    * with no label, a BLOCK reference renders a compact label, which this
      contract bounds at `max-label-chars`, and a page reference or search
      renders its own destination text;
    * anything else is charged every string it carries that is not source
      markup, and never less than `unmeasured-weight`.

  The floor is the point. A map this function cannot model must not measure as
  nothing, because a node that measures as nothing is emitted whole however
  large it renders."
  [m depth]
  (let [lbl (displayed-length (:label m) depth)]
    (if (pos? lbl)
      lbl
      (let [[kind payload] (:url m)]
        (cond
          (= "Block_ref" kind) max-label-chars
          (string? payload) (max 1 (text-size payload))
          :else
          (max unmeasured-weight
               (reduce-kv (fn [acc k v]
                            (+ acc (if (contains? hidden-map-keys k)
                                     0
                                     (displayed-length v (inc depth)))))
                          0
                          (if (map? m) m {}))))))))

(defn displayed-length
  "Characters of text one inline AST node — or a list of them — puts on screen.

  Three rules:
    1. a string is itself, measured in graphemes;
    2. a payload map renders by `map-displayed-length`, which has a floor;
    3. every other node is `[\"NodeType\" payload…]`: the type names the node
       and is not on screen, the payload is.

  This is what the budget is spent against. It is used to decide when to stop
  rendering, and is never shown to the reader as a count."
  ([node] (displayed-length node 0))
  ([node depth]
   (if (>= depth walk-limit)
     ;; Deeper than this is not measured, so it is not emitted either: the
     ;; caller charges an unmeasurable subtree rather than letting it through.
     unmeasured-weight
     (cond
       (nil? node) 0
       (string? node) (text-size node)
       (map? node) (map-displayed-length node depth)
       (and (vector? node) (string? (first node)))
       (reduce + 0 (map #(displayed-length % (inc depth)) (rest node)))
       (coll? node)
       (reduce + 0 (map #(displayed-length % (inc depth)) node))
       :else 0))))

;; ---------------------------------------------------------------------------
;; Shortening, over the AST rather than over the markup.
;; ---------------------------------------------------------------------------

(def ^:private cuttable-tags
  "Nodes that are one run of text and nothing else, so they can be cut at a
  grapheme boundary with their own type kept — code stays code."
  #{"Plain" "Spaces" "Code" "Verbatim"})

(defn cuttable-node?
  "True for a node that is a single run of text this contract may shorten."
  [node]
  (and (vector? node)
       (contains? cuttable-tags (first node))
       (string? (second node))))

(def ^:private wrapper-tags
  "Nodes that are one child LIST under a type, so shortening the children keeps
  the node's meaning: the superscript is still a superscript."
  #{"Superscript" "Subscript"})

(defn- emphasis-node?
  "`[\"Emphasis\" [[kind] children]]` — OG's shape, verified against the real
  parser. The kind is preserved so shortened bold text is still bold."
  [node]
  (and (vector? node)
       (= "Emphasis" (first node))
       (vector? (second node))
       (= 2 (count (second node)))
       (coll? (nth (second node) 1))))

(defn- cut-string-node
  "Shorten a single-run node to `n` user-perceived characters, keeping its type.
  Returns nil when nothing fits."
  [node n]
  (let [segs (f27c/segments (second node))]
    (when (and (pos? n) (seq segs))
      [(first node) (string/join (subvec segs 0 (min n (count segs))))])))

(declare shrink-nodes)

(defn- shrink-node
  "Shorten ONE node so it fits `budget`, preserving its markup.

  Returns {:node n :used u} or nil when nothing of it can be shown.

  * a single run of text is cut at a grapheme boundary;
  * emphasis and super/subscript keep their type and have their CHILDREN
    shortened, recursively, so long bold or nested content is bounded without
    losing its formatting;
  * anything else — a link, a tag, a macro, an inline source block — is
    ATOMIC: half of it would not mean what it says, so it is not emitted at
    all. `nil` is the honest answer, and the caller falls back to a compact
    label with source access.

  There is deliberately no 'take it anyway' branch. That branch is what let a
  single bold node of 5,000 characters through a budget of 160."
  [node budget depth]
  (when (and (pos? budget) (< depth walk-limit))
    (cond
      (cuttable-node? node)
      (when-let [cut (cut-string-node node budget)]
        {:node cut :used budget})

      (emphasis-node? node)
      (let [[kind children] (second node)
            r (shrink-nodes children budget (inc depth))]
        (when (seq (:nodes r))
          {:node ["Emphasis" [kind (:nodes r)]] :used (:used r)}))

      (and (vector? node)
           (contains? wrapper-tags (first node))
           (coll? (second node)))
      (let [r (shrink-nodes (second node) budget (inc depth))]
        (when (seq (:nodes r))
          {:node [(first node) (:nodes r)] :used (:used r)}))

      :else nil)))

(defn- shrink-nodes
  "Take nodes in order until `budget` characters of text have been emitted.

  A node that fits is taken whole. The first node that does not fit is
  shortened if it can be, and rendering then stops — later nodes are not
  reached over, because reordering a sentence is not truncating it."
  [nodes budget depth]
  (let [budget (max 0 (or budget 0))
        nodes (vec (remove nil? nodes))]
    (loop [i 0, used 0, out []]
      (if (>= i (count nodes))
        {:nodes out :used used :truncated? false}
        (let [n (nth nodes i)
              w (displayed-length n)
              left (- budget used)]
          (if (<= w left)
            (recur (inc i) (+ used w) (conj out n))
            (if-let [{:keys [node] :as shrunk} (shrink-node n left depth)]
              {:nodes (conj out node) :used (+ used (:used shrunk)) :truncated? true}
              {:nodes out :used used :truncated? true})))))))

(defn take-nodes
  "Bound an inline AST to `budget` characters of displayed text.

  Returns {:nodes [...] :used n :truncated? bool}.

  `:nodes` may be EMPTY with `:truncated?` true — an opening node that cannot be
  shortened, or no allowance left. That is not a failure and it is not an
  invitation to emit the node anyway: the caller shows a compact label with a
  source control instead, which is bounded by construction.

  Truncation is always reported. The caller shows `…` and the body offers the
  source block."
  [nodes budget]
  (shrink-nodes nodes budget 0))

;; ---------------------------------------------------------------------------
;; Labels for a reference that is NOT expanded.
;; ---------------------------------------------------------------------------

(defn compact-label
  "The short name shown for a reference this contract does not expand, and the
  fallback when a preview cannot be shortened to fit.

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
