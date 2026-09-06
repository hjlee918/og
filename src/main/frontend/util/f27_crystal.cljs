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

(defn tags-from-ast
  "Extract explicit inline tag names from an already-parsed inline AST.

  `ast` is the sequence produced by OG's own inline parser. `get-tag-fn` is OG's
  own tag extractor, injected so this namespace stays pure and testable.

  Only nodes OG itself labels \"Tag\" are considered, which is what keeps
  ordinary links and code out of the result."
  [ast get-tag-fn]
  ;; Always returns a set, including for degenerate input, so callers never have
  ;; to distinguish "no tags" from "could not look".
  (if (and (seqable? ast) get-tag-fn)
    (->> ast
         (keep (fn [node]
                 (when (and (vector? node) (= "Tag" (first node)))
                   (try (get-tag-fn node) (catch :default _ nil)))))
         (keep normalize-tag)
         set)
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

(defn preview-text
  "A short, single-line preview label for a matched block.

  Collapses whitespace so an indented multi-line block does not break the row,
  and truncates on a codepoint basis so Korean text and emoji are never split
  mid-character."
  [content max-len]
  (when (string? content)
    (let [flat (-> content
                   (string/replace #"\r?\n" " ")
                   (string/replace #"\s{2,}" " ")
                   string/trim)
          cps  (vec flat)]
      (if (and (int? max-len) (pos? max-len) (> (count cps) max-len))
        (str (string/join (subvec cps 0 max-len)) "…")
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
