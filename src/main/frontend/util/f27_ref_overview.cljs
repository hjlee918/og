(ns frontend.util.f27-ref-overview
  "F27 slice 1 — pure, display-only helpers for the compact incoming-reference
  overview shown from a block's reference-count badge.

  Scope discipline for this namespace:
  - It is PURE. It takes plain values and returns plain values.
  - It performs NO database read, NO graph write, NO persistence, NO network.
  - It performs NO recursive reference traversal. Slice 1 shows one row per
    INCOMING reference and never follows a reference to another reference, so a
    reference cycle is unreachable by construction.
  - It renders nothing. The caller owns all rendering."
  (:require [clojure.string :as string]))

(def ^:const max-rows
  "Maximum incoming-reference rows rendered in the compact overview. Anything
  beyond this is reported as an explicit remainder, never silently dropped."
  10)

(defn dedupe-refs
  "Remove nils and de-duplicate referencing blocks by :block/uuid, preserving the
  incoming order of `refs`.

  Order matters: the caller passes `(:block/_refs block)`, the same collection the
  badge counts, so the overview follows whatever order OG itself provides rather
  than imposing a new one."
  [refs]
  (->> refs
       (remove nil?)
       (reduce (fn [{:keys [seen out] :as acc} r]
                 (let [id (:block/uuid r)]
                   (cond
                     (nil? id)      (update acc :out conj r)
                     (contains? seen id) acc
                     :else          {:seen (conj seen id) :out (conj out r)})))
               {:seen #{} :out []})
       :out))

(defn split-rows
  "Split already-deduped `refs` into the rows to render and the number withheld.

  Returns {:shown [...] :hidden n :total n}. `:hidden` is always reported so the
  caller can state exactly how many references are not displayed. It is never
  correct to imply that withheld references do not exist."
  ([refs] (split-rows refs max-rows))
  ([refs limit]
   (let [refs  (vec refs)
         total (count refs)
         limit (max 0 (or limit max-rows))]
     (if (<= total limit)
       {:shown refs :hidden 0 :total total}
       {:shown (subvec refs 0 limit) :hidden (- total limit) :total total}))))

(defn row-key
  "Stable React key for a row. Falls back to the ordinal when a referencing block
  has no uuid, so a missing uuid degrades the key rather than breaking rendering."
  [ref-block idx]
  (if-let [id (:block/uuid ref-block)]
    (str "f27-ref-" id)
    (str "f27-ref-idx-" idx)))

(defn ref-id
  "The database id of a referencing block, whichever shape it arrives in.

  `(:block/_refs block)` yields reverse-reference stubs of the form {:db/id N}
  rather than fully realised entities, so the caller must resolve them before a
  row can be rendered. Returning nil here is normal, not an error."
  [ref-block]
  (or (:db/id ref-block)
      (when (integer? ref-block) ref-block)))

(defn renderable?
  "True when a resolved referencing block carries enough identity for the row to
  render. Rows that fail this are skipped rather than throwing."
  [ref-block]
  (some? (:block/uuid ref-block)))

(defn truncate-middle
  "Shorten a long single label for display, keeping both ends recognisable.

  Used only for plain text labels. Returns `s` unchanged when it already fits or
  when it is not a string, so nil and non-string input are safe."
  [s max-len]
  (if (and (string? s) (int? max-len) (pos? max-len) (> (count s) max-len))
    (let [keep (quot (- max-len 1) 2)]
      (str (subs s 0 keep) "…" (subs s (- (count s) keep))))
    s))

(defn prepare-rows
  "Integrated row preparation with HONEST accounting.

  Takes the RAW incoming collection exactly as the badge counts it, plus a
  `resolve-fn` mapping a database id to an entity (or nil). Returns a map whose
  categories account for every raw entry:

    :total       count of raw incoming entries — the same basis as the badge
    :rows        entries that WILL render, capped at `limit`
    :displayed   (count :rows)
    :capped      renderable entries deliberately not shown because of the cap
    :duplicates  repeat references from a block already listed
    :unavailable entries whose context could not be resolved at all: an
                 unresolvable database-id stub, or a resolved entity carrying no
                 :block/uuid. These render no row and must never be presented as
                 displayed.

  The invariant :total = :displayed + :capped + :duplicates + :unavailable holds
  for every input, so the panel can always explain the difference between the
  badge count and what the reader can see."
  ([raw resolve-fn] (prepare-rows raw resolve-fn max-rows))
  ([raw resolve-fn limit]
   (let [raw   (vec (remove nil? raw))
         total (count raw)
         limit (max 0 (or limit max-rows))
         resolve-one (fn [r]
                       (cond
                         (:block/uuid r) r
                         :else (when-let [id (ref-id r)]
                                 (when resolve-fn (resolve-fn id)))))
         {:keys [uniq dup unavail]}
         (reduce (fn [acc r]
                   (let [e (resolve-one r)]
                     (if (renderable? e)
                       (let [id (:block/uuid e)]
                         (if (contains? (:seen acc) id)
                           (update acc :dup inc)
                           (-> acc (update :seen conj id) (update :uniq conj e))))
                       (update acc :unavail inc))))
                 {:seen #{} :uniq [] :dup 0 :unavail 0}
                 raw)
         rows   (vec (take limit uniq))
         capped (- (count uniq) (count rows))]
     {:total total
      :rows rows
      :displayed (count rows)
      :capped capped
      :duplicates dup
      :unavailable unavail})))

(defn accounting-balances?
  "True when every raw incoming entry is accounted for in exactly one category.
  Used by tests and available to callers that want to assert the invariant."
  [{:keys [total displayed capped duplicates unavailable]}]
  (= total (+ displayed capped duplicates unavailable)))

(defn blank-label?
  "True when a label carries no visible text."
  [s]
  (or (nil? s) (and (string? s) (string/blank? s))))
