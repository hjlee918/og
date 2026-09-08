(ns frontend.util.f27-outgoing
  "F27 outgoing first slice — the pure decision behind *Links in this block*.

  Every F27 direction shipped so far is INBOUND (what refers to this block) or
  structural (its ancestors, its children). A reader can see everything that
  points AT a block and nothing the block itself points at, which is half of the
  approved traversal requirement (C5).

  This namespace answers one question: given the inline AST of ONE block's own
  displayed text, which explicit inline BLOCK REFERENCES did its author write in
  it, in what order, and how must each be presented.

  It is PURE. It reads no database, renders nothing, executes nothing and
  persists nothing. Resolution and rendering belong to the caller.

  Three properties matter and are all tested:

    * WHAT IS CLAIMED IS EXACTLY WHAT OG PARSED. The walk runs over the same
      inline AST the panel renders, so the list and the text on screen cannot
      disagree, and there is no second Markdown grammar. `:block/refs` and
      `:block/path-refs` are deliberately NOT the basis: they carry page refs,
      tags and refs INHERITED FROM ANCESTORS, so a block would appear to link to
      things nobody wrote in it.

    * NOTHING IS MISREPRESENTED. A `{{embed ((uuid))}}` is a macro and the
      block-embed feature's own surface; a `[[Page]]`, a `#tag`, an `id:` link
      and an address are not inline block references. None of them is counted
      here, so this slice cannot claim a link the author did not write as one.

    * EVERY OCCURRENCE IS ACCOUNTED FOR. An occurrence is listed, counted as a
      repeat of a listed identity, counted as beyond the retention cap, or
      counted as malformed. `accounting-balances?` asserts it for every input,
      so nothing can be silently dropped."
  (:require [clojure.string :as string]
            [frontend.util.f27-body :as f27b]
            [logseq.graph-parser.util.block-ref :as block-ref]))

;; ---------------------------------------------------------------------------
;; Bounds. All small, all named on screen when they bite.
;; ---------------------------------------------------------------------------

(def ^:const links-per-request
  "Links added by ONE press of the control.

  Small on purpose, and the same figure a page excerpt uses: a reader asks for a
  piece at a time, and a first press that produced twenty rows would be a list
  view with extra steps."
  5)

(def ^:const max-links
  "Distinct targets one section may retain, ever.

  A RETENTION bound, not a display bound: nothing past it is resolved or read,
  so there is no larger result being hidden behind a smaller rendering. Beyond
  it the number is stated and the source block is offered, because continuation
  cannot reach them."
  20)

(def ^:const max-target-chars
  "Displayed characters ONE opened target may show.

  Deliberately the same allowance a deliberate embed expansion gets, measured
  and cut by the same `displayed-length` / `take-nodes` — graphemes, formatting
  included, an atomic node refused rather than half-emitted."
  420)

(def ^:const max-scan-nodes
  "Inline AST nodes one extraction may visit.

  The walk is over one block's own text, which is small in every ordinary graph.
  This exists so malformed or machine-generated inline data cannot make a
  bounded reading panel do unbounded work. Reaching it is reported, never
  silently treated as the end of the text."
  4096)

;; ---------------------------------------------------------------------------
;; Identity
;; ---------------------------------------------------------------------------

(defn ref-key
  "One reference identity, in the single form everything here compares.

  The same normalisation the panel's render trail uses, so an identity written
  in two cases is one target and a trail comparison cannot miss a repeat.
  nil for anything unusable, and an unusable identity is never listed."
  [id]
  (let [s (some-> id str string/trim string/lower-case)]
    (when-not (string/blank? s) s)))

(defn usable-id?
  "True when a claimed node carried an identity a caller could look up."
  [id]
  (some? (ref-key id)))

;; ---------------------------------------------------------------------------
;; What is claimed
;;
;; Exactly the three shapes OG's own parser produces for an inline block
;; reference. `logseq.graph-parser.block/get-block-reference` recognises these
;; three and two more — an `{{embed}}` macro and an `id:`-protocol link — which
;; this slice deliberately does not claim, because an embed is the block-embed
;; feature's own surface and an `id:` link is a URL form.
;; ---------------------------------------------------------------------------

(defn node-ref
  "The block-reference identity ONE inline AST node carries, or nil.

  nil is the common answer and it means 'this is not an inline block reference'.
  Ordinary text, emphasis, code, page references, tags, addresses, macros,
  queries, inline HTML and Hiccup all answer nil and are left exactly as they
  are.

  Returns {:id s :labelled? bool} — `:labelled?` records that the AUTHOR wrote
  their own text for the reference, which the caller may prefer over the
  target's own words."
  [node]
  (when (and (vector? node) (string? (first node)))
    (cond
      ;; `((uuid))` — the shape the parser emits directly.
      (= "Block_reference" (first node))
      (let [id (last node)]
        (when (string? id) {:id id :labelled? false}))

      (and (= "Link" (first node)) (map? (second node)))
      (let [{:keys [url label]} (second node)
            [kind payload] (when (vector? url) url)]
        (cond
          ;; `[label](((uuid)))` — an explicit labelled block reference.
          (= "Block_ref" kind)
          (when (string? payload)
            {:id payload :labelled? (boolean (seq label))})

          ;; `((uuid))` reaching `search-link-cp`, which is the one other place
          ;; `components/block.cljs` turns a parsed string into a block
          ;; reference. The KIND is part of the test, not an afterthought:
          ;; `[[((uuid))]]` parses as a PAGE reference whose name happens to be
          ;; that text, and claiming it would report a page link the author
          ;; wrote as a block reference — measured against OG's real parse, not
          ;; assumed.
          (and (= "Search" kind)
               (string? payload)
               (block-ref/block-ref? payload))
          {:id (block-ref/get-block-ref-id payload)
           :labelled? (boolean (seq label))}

          :else nil))

      :else nil)))

;; ---------------------------------------------------------------------------
;; The walk
;; ---------------------------------------------------------------------------

(defn scan
  "Every inline block reference in `ast`, in SOURCE ORDER.

  Depth first, left to right, which is the order the reader's eye meets them.
  A claimed node's children are not descended into: a block reference's label is
  its author's own text, and a reference written inside another reference's
  label is not a second link the author wrote in THIS block.

  Bounded twice, and both bounds are reported rather than silently applied:
  `max-scan-nodes` nodes visited, and `f27b/walk-limit` levels of depth — the
  same depth bound the body contract measures and shortens under.

  Returns {:hits [{:id :labelled? :order}] :visited n :truncated? bool}, where
  `:truncated?` means a bound stopped the walk and the text may hold further
  references this list does not name."
  [ast]
  (let [*n (volatile! 0)
        *cut (volatile! false)]
    (letfn [(walk [node depth acc]
              (cond
                @*cut acc
                (nil? node) acc

                ;; Both bounds are checked before any work, and both SET the
                ;; truncation flag rather than returning quietly, so a caller
                ;; can never read a bounded result as a complete one.
                (>= @*n max-scan-nodes) (do (vreset! *cut true) acc)
                (>= depth f27b/walk-limit) (do (vreset! *cut true) acc)

                :else
                (do
                  (vswap! *n inc)
                  (cond
                    (string? node) acc

                    (and (vector? node) (string? (first node)))
                    (if-let [r (node-ref node)]
                      ;; A claimed node's children are NOT descended into: a
                      ;; reference's label is its author's own text, and a
                      ;; reference written inside that label is not a second
                      ;; link the author wrote in THIS block.
                      (conj acc r)
                      (reduce (fn [a c] (walk c (inc depth) a)) acc (rest node)))

                    (coll? node)
                    (reduce (fn [a c] (walk c (inc depth) a)) acc node)

                    :else acc))))]
      (let [hits (walk ast 0 [])]
        {:hits (vec (map-indexed (fn [i h] (assoc h :order i)) hits))
         :visited @*n
         :truncated? @*cut}))))

;; ---------------------------------------------------------------------------
;; Accounting
;; ---------------------------------------------------------------------------

(defn collect
  "Resolve ONE block's inline block references into the rows a section shows.

  `hits` is `scan`'s output in source order. Deduplication keeps the FIRST
  occurrence's position, because that is where the reader met the target;
  later occurrences are counted, never dropped and never a second row.

  Returns:
    :links      retained distinct entries, in source order, at most `cap`
                {:id key :raw s :labelled? bool :order n :repeats k}
    :found      inline block-reference occurrences claimed, malformed included
    :distinct   distinct usable identities found
    :over-cap   distinct identities NOT retained, so continuation cannot reach
                them and no control is offered for them
    :repeats    occurrences beyond the first, over every identity
    :malformed  claimed nodes whose identifier was unusable. They name no
                target and are never listed."
  ([hits] (collect hits max-links))
  ([hits cap]
   (let [cap (max 0 (or cap max-links))
         hits (vec (remove nil? hits))
         {:keys [order counts malformed]}
         (reduce (fn [acc h]
                   (let [k (ref-key (:id h))]
                     (if (nil? k)
                       (update acc :malformed inc)
                       (if (contains? (:counts acc) k)
                         (update-in acc [:counts k :repeats] inc)
                         (-> acc
                             (update :order conj k)
                             (assoc-in [:counts k]
                                       {:id k
                                        :raw (some-> (:id h) str string/trim)
                                        :labelled? (boolean (:labelled? h))
                                        :repeats 0}))))))
                 {:order [] :counts {} :malformed 0}
                 hits)
         ordered (vec (map-indexed (fn [i k] (assoc (get counts k) :order i)) order))
         retained (vec (take cap ordered))]
     {:links retained
      :found (count hits)
      :distinct (count ordered)
      :over-cap (max 0 (- (count ordered) (count retained)))
      :repeats (reduce + 0 (map :repeats ordered))
      :malformed malformed})))

(defn accounting-balances?
  "True when every claimed occurrence is accounted for exactly once.

  Two equalities, both of which a caller's display depends on:
    found    = distinct + repeats + malformed
    distinct = retained + over-cap"
  [{:keys [links found distinct over-cap repeats malformed]}]
  (and (= (or found 0) (+ (or distinct 0) (or repeats 0) (or malformed 0)))
       (= (or distinct 0) (+ (count links) (or over-cap 0)))))

;; ---------------------------------------------------------------------------
;; Bounded pagination. The same shape the page excerpt uses.
;; ---------------------------------------------------------------------------

(defn wanted
  "How many links a section showing `shown` of them has asked for.

  Clamped at both ends, so a caller cannot ask for more than may ever be
  retained and a freshly opened section always asks for one request."
  [shown]
  (-> (or shown 0) (max links-per-request) (min max-links)))

(defn next-wanted
  "How many `Show more links` would retain, given how many are retained now."
  [shown]
  (min max-links (+ (wanted shown) links-per-request)))

(defn more-retainable?
  "May this section retain more than it does?"
  [shown]
  (< (wanted shown) max-links))

(defn page-of
  "The rows one section actually renders, with honest remainders.

  Two remainders, and they are NOT the same thing:

    :remaining   retained entries not shown yet — a continuation CAN reach these
    :beyond-cap  identities that exist and were never retained, because the
                 retention cap stopped them — a continuation can NEVER reach
                 these, so the reader is sent to the source instead

  Collapsing the two would offer a control that silently fails to reach part of
  what it claims to show."
  [collected shown]
  (let [links (vec (:links collected))
        want (wanted shown)
        rows (vec (take want links))]
    {:rows rows
     :shown-count (count rows)
     :retained (count links)
     :remaining (- (count links) (count rows))
     :more? (> (count links) (count rows))
     :beyond-cap (or (:over-cap collected) 0)}))

(defn can-continue?
  "Whether a `Show more links` control may be rendered.

  Only when there are retained entries it can actually reveal. At the retention
  cap there are none left, so the control is withheld and the limit is explained
  instead — an inert continuation is worse than an honest stop."
  [page]
  (boolean (and page (pos? (or (:remaining page) 0)))))

(defn cap-hiding-anything?
  "Whether the retention cap is withholding identities right now, as opposed to
  merely having been reached with nothing behind it."
  [page]
  (boolean (and page (pos? (or (:beyond-cap page) 0)))))

;; ---------------------------------------------------------------------------
;; The section's own state, and one link's outcome
;; ---------------------------------------------------------------------------

(defn section-state
  "What the section as a whole must say.

  `:error`    reading or parsing the block's own text threw. Whether it has any
              links is UNKNOWN, and this is never reported as empty
  `:no-text`  the block has no readable text at all to contain a link
  `:empty`    the text was read and holds no inline block reference — a genuine
              answer, said differently from a failure. Text that claimed a
              reference whose identifier was unusable is `:empty` too, and the
              malformed count is stated beside it rather than folded away
  `:ready`    there is at least one link to show

  A truncated scan is NOT a state of its own: whatever was found is shown and
  the truncation is said beside it, because a bound that stopped the walk after
  three links has still found three real links."
  [{:keys [error? text collected]}]
  (cond
    error? :error
    (or (nil? text) (string/blank? (str text))) :no-text
    (zero? (count (:links collected))) :empty
    :else :ready))

(defn readable-target?
  "Whether a resolved entity is a block this feature may show, or merely a STUB
  the parser created because something referred to it.

  This is measured, not assumed. `logseq.graph-parser.block/extract-block-refs`
  turns every `((uuid))` in a block's text into the lookup ref
  `[:block/uuid id]`, and transacting a lookup ref that resolves to nothing
  CREATES an entity carrying that uuid and nothing else. So writing
  `((7f27…ff))` for a block nobody has ever written makes `db/entity` answer a
  non-nil entity for it — and `some?` of that lookup is therefore never the
  existence test. The page-embed slice recorded the same fact for page names;
  it is true of block identities for the same reason.

  `:block/content` is what separates the two: every real block has it, a stub
  has nothing but its identity. An EMPTY block has it as the empty string,
  which is `some?` — so a block somebody wrote and left blank is available and
  simply has no readable text, which is a different sentence from 'this target
  could not be found', and the panel says whichever is true.

  The consequence is deliberate: a `((uuid))` naming a PAGE's identity rather
  than a block's reads as unavailable here. A page is not an inline block
  reference, and this slice does not claim one."
  [entity]
  (boolean (and entity (some? (:block/content entity)))))

(defn plan-link
  "How ONE listed target must be presented.

  `id`         the target's identity, normalised
  `host`       the identity of the block whose links these are
  `resolved?`  whether the caller resolved it to a READABLE block. This is
               `readable-target?` above, never `some?` of an entity lookup:
               the parser creates a stub for every identity anything refers to,
               so `some?` answers true for a block nobody has written

  Returns:
    :self         the block refers to itself. Listed, marked, never expanded —
                  expanding it would render the block inside its own context
    :unavailable  nothing to show and nowhere to go; said in words, never as an
                  identifier, and carrying no control that cannot work
    :show         list it, and offer the one-hop expansion

  Order matters: a self-reference is reported as a self-reference even when it
  also resolves, because 'this points at itself' explains what the reader is
  seeing and a bounded copy of the same text does not."
  [{:keys [id host resolved?]}]
  (let [k (ref-key id)
        h (ref-key host)]
    (cond
      (nil? k) :unavailable
      (and h (= k h)) :self
      (not resolved?) :unavailable
      :else :show)))

(defn expandable?
  "True for the one outcome that may show the target's own text."
  [outcome]
  (= :show outcome))
