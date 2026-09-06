(ns frontend.util.f27-children
  "F27 slice 4 — pure helpers for expandable descendant context.

  Slice 3 lets one incoming-reference row expand UPWARD to its ancestors. Slice 4
  lets the same row expand DOWNWARD: the children of THAT referencing block, and
  progressively deeper descendants, without leaving the overview.

  This namespace is PURE. The caller injects a `children-fn` that returns the
  immediate children of one node; nothing here reads the database, renders,
  writes a graph file, or persists anything.

  Three properties matter and are all tested:

    * only IMMEDIATE children are ever requested — the plan walks one level at a
      time along paths the reader actually opened, never fetching a subtree;
    * siblings are never silently omitted or reordered — when OG's left-order
      walk cannot account for every sibling, completeness wins and the loss of
      order is DISCLOSED rather than papered over with an arbitrary sort;
    * every stopping condition is distinguishable — no children, a failed query,
      a cycle on the active trail, the depth safeguard, the visible-node
      safeguard, and children deliberately not shown yet are six different
      states, and a continuation control is offered for exactly one of them."
  (:require [clojure.string :as string]))

(def ^:const default-batch
  "Children rendered per node before continuation is required."
  10)

(def ^:const max-depth
  "How many levels below the referencing block may be opened. The overview is a
  compact aid, not an outliner; past this the reader is sent to the source."
  5)

(def ^:const max-visible
  "Total descendant rows one referencing row may render, across all open
  branches. A safeguard against a wide-and-deep outline filling the panel."
  200)

(defn node-key
  "Stable identity for a child. Prefers the block uuid; falls back to the
  datascript id so a node without a uuid is still distinguishable rather than
  colliding with every other such node."
  [e]
  (when e
    (or (:block/uuid e) (some-> (:db/id e) (->> (str "db-"))))))

(defn resolve-children
  "Reconcile the raw sibling set with OG's left-order walk.

  OG orders siblings by walking the `:block/left` linked list from the parent.
  When that chain is broken the walk returns FEWER blocks than exist, and
  `sort-by-left` would silently drop the rest while `try-sort-by-left` would
  silently fall back to an arbitrary order. Neither is acceptable here.

  This keeps EVERY child and reports whether the canonical order was actually
  established:

    :children  every child, in canonical order when it could be determined
    :total     how many children exist
    :ordered?  false when the order walk could not account for all of them
    :unordered how many the order walk missed

  Completeness is preferred over a guessed order, and the loss is disclosed."
  [raw ordered]
  (let [raw (vec (remove nil? raw))
        ordered (vec (remove nil? ordered))
        raw-keys (set (keep node-key raw))
        ordered-keys (set (keep node-key ordered))
        complete? (and (= (count ordered) (count raw))
                       (= raw-keys ordered-keys))]
    {:children (if complete? ordered raw)
     :total (count raw)
     :ordered? complete?
     :unordered (if complete? 0 (max 0 (- (count raw) (count ordered))))}))

(defn take-batch
  "Bounded rendering batch with honest continuation.

  Invariant: :total = :shown-count + :remaining, so the panel can always explain
  the difference between what exists and what is on screen."
  ([children] (take-batch children default-batch))
  ([children limit]
   (let [children (vec (remove nil? children))
         limit (max 0 (or limit default-batch))
         shown (vec (take limit children))]
     {:shown shown
      :shown-count (count shown)
      :total (count children)
      :remaining (- (count children) (count shown))
      :more? (> (count children) (count shown))})))

(defn batch-balances?
  "Every child is either shown or counted as remaining."
  [{:keys [total shown-count remaining]}]
  (= total (+ shown-count remaining)))

(defn descend-state
  "Whether one node may reveal its own children, and if not, why.

    :ok     — it may be opened
    :cycle  — its identity already appears on the ACTIVE TRAIL, so opening it
              would revisit an ancestor of itself
    :depth  — the depth safeguard is reached
    :budget — the visible-node safeguard is reached

  A control is offered for :ok only. The other three are explained instead, so
  no control is ever left that cannot progress."
  [key trail depth used]
  (cond
    (and key (contains? (set trail) key)) :cycle
    (>= (or depth 0) max-depth) :depth
    (>= (or used 0) max-visible) :budget
    :else :ok))

(defn children-summary
  "How to describe one node's children query.

    :error       — the query FAILED. Distinct from :none: a failure is not
                   evidence that a block has no children.
    :unavailable — the node itself could not be resolved (deleted or missing).
                   Distinct from :error, which is a failure to ask, and from
                   :none, which is a successful answer of zero.
    :none        — queried successfully, genuinely no children
    :partial     — children exist and more remain unshown
    :ok          — children exist and all of them are shown"
  [{:keys [error? missing? total shown-count]}]
  (cond
    error? :error
    missing? :unavailable
    (not (pos? (or total 0))) :none
    (< (or shown-count 0) total) :partial
    :else :ok))

(def ^:private nothing
  {:children [] :total 0 :ordered? true :unordered 0 :error? false :missing? false})

(defn- fetch
  "Call `children-fn` for one node, turning every failure into an explicit
  result. A thrown query and a node that no longer exists must both stay
  distinguishable from a block that simply has no children.

  `children-fn` returns {:raw [...] :ordered [...]}, or {:missing? true} when
  the node itself could not be resolved."
  [children-fn uuid]
  (if (or (nil? children-fn) (nil? uuid))
    (assoc nothing :error? true)
    (try
      (let [res (children-fn uuid)]
        (if (:missing? res)
          (assoc nothing :missing? true)
          (assoc (resolve-children (:raw res) (:ordered res))
                 :error? false :missing? false)))
      (catch :default _
        (assoc nothing :error? true)))))

(defn build-plan
  "Flatten the currently OPEN part of the descendant tree into render rows.

  `children-fn` maps a uuid to {:raw [...] :ordered [...]} — the raw sibling set
  and OG's left-order walk of it — or {:missing? true}. It may throw; a failure
  is reported, never mistaken for a childless node.

  `open` is the set of open paths and `limits` maps a path to how many of that
  node's children to show. A path is the vector of node keys from the
  referencing block down, so state is addressed structurally rather than held in
  each rendered node — which keeps rendering a pure function of this map and
  lets the visible-node safeguard be counted exactly.

  QUERY SHAPE: every call asks for one node's IMMEDIATE children; no subtree is
  ever fetched. Each RENDERED node is probed once so the expansion control can
  appear only where there is something to expand — a control on a leaf would be
  an affordance that reveals nothing. That probe is skipped for nodes that
  cannot be opened anyway (cycle, depth, budget), and its result is reused when
  the node is open, so an open node is never queried twice.

  Returns
    :rows       [{:path :entity :depth :descend :open? :has-children?} ...]
                in render order
    :info       {path -> {:total :shown-count :remaining :more? :ordered?
                          :unordered :error? :missing? :summary}} for each
                node whose children were expanded
    :visible    number of descendant rows
    :truncated? the visible-node safeguard stopped the walk"
  [children-fn root-uuid {:keys [open limits]}]
  (let [open (or open #{})
        limits (or limits {})]
    (letfn [(walk [uuid path depth trail acc pre]
              (let [res (or pre (fetch children-fn uuid))
                    limit (get limits path default-batch)
                    batch (take-batch (:children res) limit)
                    info (merge (select-keys res [:ordered? :unordered :error? :missing?])
                                (select-keys batch [:total :shown-count :remaining :more?])
                                {:summary (children-summary
                                           {:error? (:error? res)
                                            :missing? (:missing? res)
                                            :total (:total batch)
                                            :shown-count (:shown-count batch)})})
                    acc (assoc-in acc [:info path] info)]
                (reduce
                 (fn [a child]
                   (if (>= (count (:rows a)) max-visible)
                     (assoc a :truncated? true)
                     (let [k (node-key child)
                           cpath (conj path k)
                           d (inc depth)
                           used (count (:rows a))
                           ds (descend-state k trail d used)
                           open? (and (contains? open cpath) (= ds :ok))
                           probe (when (= ds :ok) (fetch children-fn k))
                           a' (update a :rows conj
                                      {:path cpath
                                       :entity child
                                       :depth d
                                       :descend ds
                                       :open? open?
                                       :has-children? (boolean (pos? (:total probe 0)))})]
                       (if open?
                         (walk k cpath d (conj trail k) a' probe)
                         a'))))
                 acc
                 (:shown batch))))]
      (let [acc (walk root-uuid [] 0 #{root-uuid}
                      {:rows [] :info {} :truncated? false} nil)]
        (assoc acc :visible (count (:rows acc)))))))

(defn plan-balances?
  "The plan never renders more than the safeguard allows."
  [{:keys [rows]}]
  (<= (count rows) max-visible))

(defn plan-at-capacity?
  "True when the plan cannot render another descendant row.

  `:truncated?` alone is not enough: a plan that fills the safeguard EXACTLY
  has not truncated anything yet, but it still has no room, so a continuation
  offered on the strength of `:more?` would raise a limit and add nothing. That
  was a real dead control until this check existed."
  [{:keys [truncated? visible rows]}]
  (boolean (or truncated?
               (>= (or visible (count rows) 0) max-visible))))

(defn plan-hiding-anything?
  "Whether the safeguard is actually withholding descendants right now, as
  opposed to merely having been reached with nothing left to show. Only then is
  it honest to say the limit is hiding something and offer the source."
  [{:keys [truncated? info] :as plan}]
  (boolean (or truncated?
               (and (plan-at-capacity? plan)
                    (some :more? (vals info))))))

(defn continue-limit
  "Next limit for a node whose children are batched. Kept as a function so the
  caller cannot accidentally offer a continuation that does not advance."
  [current]
  (+ (max 0 (or current default-batch)) default-batch))

(defn can-continue?
  "Whether a 'Show more children' control may be rendered for a node.

  Requires that more children exist AND that the query succeeded AND that the
  node exists AND that the visible-node safeguard has not stopped the walk —
  otherwise the control would be present but unable to progress."
  [{:keys [more? error? missing?]} truncated?]
  (boolean (and more? (not error?) (not missing?) (not truncated?))))

(defn node-label
  "A safe display string for a descendant, so a node deleted between the query
  and the render degrades to a marker instead of an empty row."
  [e]
  (let [c (:block/content e)]
    (when (and (string? c) (not (string/blank? c))) c)))
