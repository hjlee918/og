(ns frontend.util.f27-context
  "F27 slice 3 — pure helpers for expandable ancestor context.

  Slice 1 shows a compact breadcrumb per incoming reference. Slice 3 lets ONE row
  be expanded to show the referencing block and its ancestor chain with more
  context, then collapsed again.

  This namespace is PURE. The caller injects a `parent-fn` that resolves one
  step upward; nothing here reads the database, writes a graph file, renders, or
  persists anything.

  Two properties matter and are both tested:

    * ancestry is loaded in BOUNDED BATCHES with explicit continuation, rather
      than silently stopping at whatever depth a default query happens to use;
    * a visited-identity guard terminates a cycle before it can recurse, so a
      malformed or self-parenting chain cannot hang the interface."
  (:require [clojure.string :as string]))

(def ^:const default-batch
  "Ancestor levels loaded per request. Small enough to stay responsive, large
  enough that ordinary outlines open in one step."
  8)

(def ^:const hard-cap
  "Absolute ceiling on ancestors held for one row, so an unexpectedly deep or
  malformed outline can never grow without bound."
  200)

(defn load-ancestors
  "Walk upward from `uuid`, nearest parent first, at most `limit` levels.

  `parent-fn` maps a block uuid to its parent entity, or nil at the top of the
  outline. It is allowed to THROW: a failed lookup must stay distinguishable
  from reaching the top, so this function catches it and says so rather than
  letting a broken read masquerade as a finished chain.

  Returns:
    :ancestors  vector of parent entities, NEAREST FIRST
    :more?      further ancestry exists beyond what was loaded
    :cycle?     the walk revisited an identity and stopped
    :depth      number of levels actually loaded
    :capped?    the HARD CAP is what stopped the walk and ancestry still
                remains, so continuation cannot reach it. False for a chain
                that merely ends exactly at the cap, because nothing was
                truncated there.
    :error?     a parent lookup failed. Whatever was already loaded is kept and
                returned; the chain must NOT be presented as complete.

  `:capped?` and `:error?` each mean continuation is pointless, for different
  reasons, and callers must not offer it in either case."
  ([parent-fn uuid] (load-ancestors parent-fn uuid default-batch))
  ([parent-fn uuid limit]
   (let [limit (min (max 0 (or limit default-batch)) hard-cap)
         base {:ancestors [] :more? false :cycle? false :depth 0
               :capped? false :error? false}
         ;; [:ok parent-or-nil] on a successful read, [:error nil] on a failure.
         ;; Reaching the top and failing to look are different outcomes.
         step (fn [u] (try [:ok (parent-fn u)] (catch :default _ [:error nil])))]
     (if (or (nil? parent-fn) (nil? uuid))
       base
       (loop [current uuid
              seen #{uuid}
              acc []
              n 0]
         (let [done (fn [m] (merge base (assoc m :ancestors acc :depth (count acc))))]
           (if (>= n limit)
             ;; Peek one step further to report honestly whether more exists,
             ;; without loading it. A failure HERE is a failure too: it must not
             ;; be reported as "nothing further above".
             (let [[status nxt] (step current)
                   nxt-id (:block/uuid nxt)]
               (cond
                 (= :error status) (done {:error? true})
                 (nil? nxt) (done {})
                 (and nxt-id (contains? seen nxt-id)) (done {:cycle? true})
                 :else (done {:more? true :capped? (>= n hard-cap)})))
             (let [[status parent] (step current)
                   pid (:block/uuid parent)]
               (cond
                 (= :error status) (done {:error? true})
                 (nil? parent) (done {})
                 (and pid (contains? seen pid)) (done {:cycle? true})
                 ;; An ancestor with no identity of its own (a page) is shown,
                 ;; but there is nothing left to continue the walk from.
                 (nil? pid) (merge base {:ancestors (conj acc parent)
                                         :depth (inc (count acc))})
                 :else (recur pid (conj seen pid) (conj acc parent) (inc n)))))))))))

(defn display-order
  "Ancestors as the reader expects them: outermost first, nearest last.

  `load-ancestors` returns nearest-first because that is the walk order; the
  panel reads top-down."
  [ancestors]
  (vec (reverse (or ancestors []))))

(defn page-entity?
  "True for a page rather than a block. A page terminates the ancestor chain and
  is shown as the source page heading, not as an ancestor row."
  [e]
  (boolean (and e (:block/name e))))

(defn context-rows
  "Prepare the rows the expanded panel renders.

  Returns {:page e-or-nil :ancestors [...] :self e}, with the page separated out
  and page entities removed from the ancestor list."
  [ancestors self]
  (let [ordered (display-order ancestors)
        page (first (filter page-entity? ordered))
        blocks (vec (remove page-entity? ordered))]
    {:page page :ancestors blocks :self self}))

(def workflow-markers
  "Block-level task markers OG recognises at the start of a block's content.
  Listed here only so the compact context line can show them as structure
  instead of echoing them as literal text; nothing here changes a marker."
  #{"TODO" "DOING" "DONE" "NOW" "LATER" "WAITING" "WAIT" "CANCELED" "CANCELLED"
    "IN-PROGRESS"})

(defn split-block-prefix
  "Separate BLOCK-level markup from the INLINE text that follows it.

  The context line renders through OG's inline renderer, which handles emphasis,
  links, tags and block refs. A heading's leading `##` and a task's leading
  `TODO` are block-level constructs: passed to an inline renderer they come out
  as literal characters, so a heading ancestor would read \"## Title\" and a task
  ancestor \"TODO Something\" while bold text beside them rendered properly.

  Splitting them lets the line show the heading level and the task marker as
  structure and render the rest inline, so every ancestor is displayed
  consistently. Nothing is removed from the block itself — this affects only the
  compact label.

  Returns {:heading level-or-nil :marker \"TODO\"-or-nil :text remainder}."
  [content]
  (if-not (string? content)
    {:heading nil :marker nil :text nil}
    (let [[_ hashes after-hashes] (re-find #"^(#{1,6})\s+(.*)$" content)
          heading (when hashes (count hashes))
          rest1 (or after-hashes content)
          [_ marker after-marker] (re-find #"^([A-Z][A-Z-]*)\s+(.*)$" rest1)
          marker? (contains? workflow-markers marker)]
      {:heading heading
       :marker (when marker? marker)
       :text (if marker? after-marker rest1)})))

(defn block-label
  "A safe display string for a block that has no renderable content, so a
  missing or deleted ancestor degrades to a marker instead of an empty row."
  [e]
  (let [c (:block/content e)]
    (if (and (string? c) (not (string/blank? c))) c nil)))
