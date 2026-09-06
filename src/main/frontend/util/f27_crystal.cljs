(ns frontend.util.f27-crystal
  "F27 slice 2 — pure helpers for Crystal marker matching and preview selection.

  A Crystal is content EXPLICITLY marked with the user's chosen tag. Explicit
  means one of the two tagging forms OG already parses:

    * an inline tag node — `#tag` or `#[[multi word tag]]`
    * a block `tags::` property

  It deliberately does NOT mean:
    * an ordinary [[page link]] to the same page
    * a tag that only appears in the block's inherited path references
    * a similarly named tag (matching is on exact tag identity)
    * text inside code, because OG's own parser does not emit a tag node there

  This namespace is PURE. It performs no database read, no graph write, no
  persistence and no rendering. Callers supply already-parsed values.

  KNOWN LIMITATION (documented, not worked around): OG's parsed representation
  marks the BLOCK that carries a tag, not the individual word the user may have
  had in mind. Slice 2 therefore previews the tagged block. It does not guess
  which word inside the block was intended."
  (:require [clojure.string :as string]))

(def ^:const max-previews
  "Maximum Crystal previews rendered per incoming-reference row."
  3)

(def ^:const max-ancestor-depth
  "Bounded ancestor traversal for Crystal search. The scope is the referencing
  block plus its ancestor chain on the same source page — never the whole page,
  never an unrelated branch, never a followed reference."
  10)

(defn normalize-tag
  "Canonical form used for identity comparison. OG treats page and tag names
  case-insensitively, so comparison is lower-cased and trimmed. Returns nil for
  anything blank, so a cleared preference can never accidentally match."
  [t]
  (when (and (string? t) (not (string/blank? t)))
    (string/lower-case (string/trim t))))

(defn same-tag?
  "Exact tag identity, not substring containment.

  \"결정\" does not match \"결정사항\", and \"design\" does not match \"designer\"."
  [a b]
  (let [a (normalize-tag a) b (normalize-tag b)]
    (boolean (and a b (= a b)))))

(defn un-bracket
  "Strip the surrounding [[ ]] OG's tag extractor leaves on a bracketed tag.

  `#[[project alpha]]` is extracted as the literal \"[[project alpha]]\", so the
  brackets must come off before the name can be compared with a marker chosen
  from the inventory. Verified against the real parser, not assumed."
  [t]
  (if (and (string? t)
           (string/starts-with? t "[[")
           (string/ends-with? t "]]")
           (> (count t) 4))
    (subs t 2 (- (count t) 2))
    t))

(defn tags-from-ast
  "Extract explicit inline tag names from an already-parsed inline AST.

  `ast` is produced by OG's own inline parser. `get-tag-fn` is OG's own tag
  extractor, injected so this namespace stays pure and testable.

  Walks NESTED nodes, because OG nests inline content: a tag inside bold or
  italics is still an explicit tag and must be found. Only nodes OG itself
  labels \"Tag\" are collected, so an ordinary link stays out, and a #tag inside
  an inline code span or a fenced block never becomes a Tag node in the first
  place — both verified against the real parser."
  [ast get-tag-fn]
  ;; Always returns a set, including for degenerate input, so callers never have
  ;; to distinguish "no tags" from "could not look".
  (if (and (seqable? ast) get-tag-fn)
    (let [found (volatile! (transient #{}))]
      (letfn [(walk [node depth]
                (when (< depth 32)                 ; bounded; malformed input cannot spin
                  (cond
                    (and (vector? node) (= "Tag" (first node)))
                    (when-let [t (try (get-tag-fn node) (catch :default _ nil))]
                      (when-let [n (normalize-tag (un-bracket t))]
                        (vswap! found conj! n)))

                    (coll? node)
                    (doseq [child node] (walk child (inc depth)))

                    :else nil)))]
        (walk (seq ast) 0))
      (persistent! @found))
    #{}))

(defn tags-from-properties
  "Explicit tag names from a block's parsed `tags::` property.

  Accepts the shapes OG stores: a collection, or a single string."
  [properties]
  (let [v (or (get properties :tags) (get properties "tags"))
        vs (cond (nil? v) nil
                 (string? v) [v]
                 (coll? v) v
                 :else nil)]
    (->> vs (keep normalize-tag) set)))

(defn block-tagged?
  "True when a block is explicitly marked with `crystal-tag`.

  `inline-tags` and `prop-tags` are already-normalised sets supplied by the
  caller; nothing here re-parses or re-reads content."
  [crystal-tag inline-tags prop-tags]
  (let [want (normalize-tag crystal-tag)]
    (boolean (and want (or (contains? (or inline-tags #{}) want)
                           (contains? (or prop-tags #{}) want))))))

(defn segments
  "Split a string into user-perceived units, longest-correct first.

  `(vec s)` in ClojureScript iterates UTF-16 code UNITS, which splits a
  supplementary-plane emoji in half and mangles a ZWJ sequence. This uses, in
  order of preference:

    1. Intl.Segmenter with granularity \"grapheme\" — keeps ZWJ sequences,
       skin-tone modifiers and combining marks together;
    2. js/Array.from — iterates CODE POINTS, so surrogate pairs stay intact;
    3. (vec s) — last resort only where neither exists.

  No dependency is added; both facilities are part of the platform."
  [s]
  (if-not (string? s)
    []
    (let [seg (when (exists? js/Intl.Segmenter)
                (try
                  (let [sr (js/Intl.Segmenter. "en" #js {:granularity "grapheme"})]
                    (->> (.segment sr s)
                         (js/Array.from)
                         (map (fn [^js seg] (.-segment seg)))
                         vec))
                  (catch :default _ nil)))]
      (or seg
          (try (vec (js/Array.from s)) (catch :default _ (vec s)))))))

(defn preview-text
  "A short, single-line preview label for a matched block.

  Collapses whitespace so an indented multi-line block does not break the row,
  and truncates on user-perceived character boundaries, so a supplementary-plane
  emoji, a joined emoji sequence or Korean text is never split mid-character."
  [content max-len]
  (when (string? content)
    (let [flat (-> content
                   (string/replace #"\r?\n" " ")
                   (string/replace #"\s{2,}" " ")
                   string/trim)
          segs (segments flat)]
      (if (and (int? max-len) (pos? max-len) (> (count segs) max-len))
        (str (string/join (subvec segs 0 max-len)) "…")
        flat))))

(defn select-previews
  "Choose which Crystal matches to show for one incoming-reference row.

  `matches` is an ordered sequence of maps, nearest match first, each carrying at
  least :uuid. De-duplicates by :uuid so the same block matched twice in a chain
  is shown once, then caps the result.

  Returns {:previews [...] :remainder n :total n :duplicates n}, so the row can
  always explain the difference between what was found and what is shown."
  ([matches] (select-previews matches max-previews))
  ([matches limit]
   (let [limit (max 0 (or limit max-previews))
         {:keys [uniq dup]}
         (reduce (fn [acc m]
                   (let [id (:uuid m)]
                     (cond
                       (nil? id) (update acc :uniq conj m)
                       (contains? (:seen acc) id) (update acc :dup inc)
                       :else (-> acc (update :seen conj id) (update :uniq conj m)))))
                 {:seen #{} :uniq [] :dup 0}
                 (remove nil? matches))
         previews (vec (take limit uniq))]
     {:previews previews
      :remainder (- (count uniq) (count previews))
      :total (count uniq)
      :duplicates dup})))

;; ---------------------------------------------------------------------------
;; Marker inventory.
;;
;; The selector must offer EXPLICIT TAGS, using the same notion of "explicit" as
;; the matcher. OG has no API for this: `get-tag-pages` queries :block/tags,
;; which is the page-level `tags::` property only, and :block/refs cannot
;; distinguish #tag from [[link]]. So the inventory is derived here from the same
;; two sources the matcher accepts, and pages that are only ever ordinary link
;; targets never enter it.
;; ---------------------------------------------------------------------------

(defn collect-tags
  "Fold explicit tag names out of a sequence of already-extracted per-block tag
  sets. Pure: the caller does the reading and parsing.

  `entries` is a sequence of maps {:inline #{..} :props #{..}}."
  [entries]
  (reduce (fn [acc {:keys [inline props]}]
            (into acc (concat (or inline #{}) (or props #{}))))
          #{}
          (remove nil? entries)))

(defn filter-tags
  "Incremental search over the inventory. A blank query returns the head of the
  sorted inventory; otherwise every tag containing the query, so a tag can never
  become unreachable merely because of where it sorts."
  ([tags query] (filter-tags tags query 50))
  ([tags query limit]
   (let [q (normalize-tag query)
         all (sort (or tags #{}))
         hits (if q (filter #(string/includes? % q) all) all)]
     {:matches (vec (take (max 0 (or limit 50)) hits))
      :shown (min (count hits) (max 0 (or limit 50)))
      :total (count hits)
      :inventory-size (count all)})))

(defn selection-state
  "How to describe the current marker relative to the inventory.

  :none      — nothing chosen
  :present   — chosen and still found in the graph
  :missing   — chosen but no longer found, which must be explained rather than
               silently showing an empty result"
  [tag tags]
  (let [t (normalize-tag tag)]
    (cond
      (nil? t) :none
      (contains? (set (map normalize-tag (or tags #{}))) t) :present
      :else :missing)))

