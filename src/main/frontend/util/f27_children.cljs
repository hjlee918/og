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
      an unresolvable node, a cycle on the active trail, the depth safeguard,
      the visible-node safeguard, and children deliberately not shown yet are
      all different states, and a growth control is offered for exactly one of
      them.

  Two properties were added by the slice-4 correction batch and matter just as
  much:

    * a probe's OUTCOME reaches the row it belongs to, so a read that failed on
      a collapsed child cannot masquerade as an ordinary leaf;
    * every count describes children that were actually EMITTED, and one shared
      capacity rule governs every growth control, so no control is ever offered
      where clicking it would add nothing."
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

(def ^:const max-probe-retries
  "How many times a reader may retry one node's failed children probe before the
  panel stops offering the retry and offers the source instead. Bounded so a
  persistently failing read cannot become an endless button."
  3)

(defn probe-retry-allowed?
  "Whether a failed probe may be retried again. A retry re-reads the database on
  the next render; the bound keeps that from being unlimited."
  [attempts]
  (< (max 0 (or attempts 0)) max-probe-retries))

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
    :budget — the visible-node safeguard leaves no room for a child row

  A control is offered for :ok only. The other three are explained instead, so
  no control is ever left that cannot progress.

  `used` is the number of rows already emitted BEFORE this node's own row, so
  after this row is emitted the plan holds `used + 1`. Opening this node can
  therefore add a row only while `used + 1 < max-visible`. Comparing `used`
  itself against the safeguard — as slice 4 did — left the very last row that
  fits still carrying an expansion control whose click could add nothing.

  `open?` is whether the reader has ALREADY opened this node. An open node keeps
  `:ok` even with no room left, so its COLLAPSE control survives: collapsing is
  exactly what frees capacity again, and taking the control away would strand
  the reader at the limit."
  ([key trail depth used] (descend-state key trail depth used false))
  ([key trail depth used open?]
   (cond
     (and key (contains? (set trail) key)) :cycle
     (>= (or depth 0) max-depth) :depth
     (and (not open?) (>= (inc (max 0 (or used 0))) max-visible)) :budget
     :else :ok)))

(defn probe-state
  "What one node's OWN children probe established, as carried to its visible row.

    :ok          — the probe succeeded and found children
    :none        — the probe succeeded and found none
    :error       — the probe FAILED; whether it has children is unknown
    :unavailable — the node itself could not be resolved
    :unknown     — it was not probed (a cycle stops descent by identity alone)

  Slice 4 kept only `:has-children?` from this probe, so a probe that threw or
  found nothing to resolve produced exactly the same row as an ordinary leaf:
  the failure had no way to reach the screen, and no control existed to reveal
  it. The outcome is now carried to the row itself."
  [res]
  (cond
    (nil? res) :unknown
    (:error? res) :error
    (:missing? res) :unavailable
    (pos? (or (:total res) 0)) :ok
    :else :none))

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
  an affordance that reveals nothing — and so the probe's OUTCOME can be shown
  on that node's own visible row. The probe is skipped only for a cycle, whose
  descent is refused by identity and already marked. Its result is reused when
  the node is open, so an open node is never queried twice.

  COUNTS DESCRIBE WHAT WAS EMITTED, not what was requested. The shared
  visible-row safeguard can stop a node's children part-way through its batch;
  slice 4 still reported the batch it asked for, so a node that rendered nothing
  could claim `:shown-count 1, :remaining 0, :summary :ok`. Every count below is
  taken after the children were actually emitted.

  Returns
    :rows       [{:path :entity :depth :descend :open? :has-children?
                  :probe :child-count} ...] in render order, where :probe is
                that node's own children probe outcome and :child-count how many
                children it is known to have (nil when unknown)
    :info       {path -> {:total :shown-count :remaining :more? :withheld
                          :ordered? :unordered :error? :missing? :summary}} for
                each node whose children were expanded
    :visible    number of descendant rows
    :truncated? the visible-node safeguard stopped the walk"
  [children-fn root-uuid {:keys [open limits]}]
  (let [open (or open #{})
        limits (or limits {})]
    (letfn [(walk [uuid path depth trail acc pre]
              (let [res (or pre (fetch children-fn uuid))
                    limit (get limits path default-batch)
                    batch (take-batch (:children res) limit)
                    ;; Emit first, then count. `emitted` is this node's OWN
                    ;; children that actually reached a row — never the batch
                    ;; size, which the shared safeguard may cut short.
                    [acc' emitted]
                    (reduce
                     (fn [[a n] child]
                       (if (>= (count (:rows a)) max-visible)
                         (reduced [(assoc a :truncated? true) n])
                         (let [k (node-key child)
                               cpath (conj path k)
                               d (inc depth)
                               used (count (:rows a))
                               want-open? (contains? open cpath)
                               ds (descend-state k trail d used want-open?)
                               open? (and want-open? (= ds :ok))
                               probe (when (not= ds :cycle) (fetch children-fn k))
                               pstate (probe-state probe)
                               a' (update a :rows conj
                                          {:path cpath
                                           :entity child
                                           :depth d
                                           :descend ds
                                           :open? open?
                                           :probe pstate
                                           ;; Only a probe that actually
                                           ;; answered carries a count. A failed
                                           ;; or unresolvable one leaves it nil:
                                           ;; zero would assert "no children",
                                           ;; which is exactly what is unknown.
                                           :child-count (when (#{:ok :none} pstate)
                                                          (:total probe))
                                           :has-children? (= pstate :ok)})]
                           [(if open?
                              (walk k cpath d (conj trail k) a' probe)
                              a')
                            (inc n)])))
                     [acc 0]
                     (:shown batch))
                    total (:total batch)
                    info (merge (select-keys res [:ordered? :unordered :error? :missing?])
                                {:total total
                                 :shown-count emitted
                                 :remaining (- total emitted)
                                 :more? (> total emitted)
                                 ;; Requested by this node's own batch but left
                                 ;; unrendered because the shared safeguard ran
                                 ;; out of room, as distinct from children the
                                 ;; batch never asked for.
                                 :withheld (max 0 (- (:shown-count batch) emitted))
                                 :summary (children-summary
                                           {:error? (:error? res)
                                            :missing? (:missing? res)
                                            :total total
                                            :shown-count emitted})})]
                (assoc-in acc' [:info path] info)))]
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

(defn plan-withheld-behind-rows
  "Children KNOWN to exist behind rendered nodes that the shared capacity
  safeguard will not let the reader open.

  A collapsed node at capacity holds real, counted children that no control can
  reach. Reporting only `:more?` from the expanded levels missed exactly that
  case: with every immediate child visible and the last of them owning a
  grandchild, nothing said the grandchild existed."
  [{:keys [rows]}]
  (reduce + 0 (keep (fn [r]
                      (when (= :budget (:descend r))
                        (let [n (:child-count r)]
                          (when (and (number? n) (pos? n)) n))))
                    rows)))

(defn plan-hiding-anything?
  "Whether the capacity safeguard is actually withholding descendants right now,
  as opposed to merely having been reached with nothing left to show. Only then
  is it honest to say the limit is hiding something and offer the source."
  [{:keys [truncated? info] :as plan}]
  (boolean (or truncated?
               (pos? (plan-withheld-behind-rows plan))
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
  node exists AND that the plan has room for another row — otherwise the control
  would be present but unable to progress.

  `capacity` is the PLAN, so continuation and expansion consult one shared
  capacity rule rather than each keeping its own idea of what still fits. A
  boolean is still accepted for the plain 'no room' case."
  [{:keys [more? error? missing?]} capacity]
  (let [full? (if (map? capacity) (plan-at-capacity? capacity) (boolean capacity))]
    (boolean (and more? (not error?) (not missing?) (not full?)))))

(defn can-expand?
  "Whether a row may carry an expansion control.

  The SAME capacity rule as `can-continue?`, reached through `:descend`: a node
  that cannot descend is never offered a control, so one growth affordance can
  never be live where another is correctly withheld. An already-open node keeps
  its control, which is how a branch is collapsed to give capacity back."
  [row]
  (boolean (and (= :ok (:descend row)) (:has-children? row))))

(defn branch-continuations
  "Where each node's continuation control belongs in the flat row order.

  Slice 4 rendered every nested 'Show more children' together after the whole
  flattened tree, with identical labels and nothing tying one to its branch. A
  continuation belongs at ITS OWN branch boundary: immediately after the last
  row of that node's subtree.

  Returns {row-index [path ...]}, innermost branch first, for every branch that
  closes at that row. The caller decides which of those paths actually earns a
  control; this only says where one would go. The root path `[]` is never
  included — its boundary is the end of the tree."
  [{:keys [rows]}]
  (let [rows (vec rows)
        n (count rows)
        inside? (fn [pre p] (and p
                                 (>= (count p) (count pre))
                                 (= pre (subvec (vec p) 0 (count pre)))))]
    (into {}
          (for [i (range n)
                :let [p (vec (:path (nth rows i)))
                      nxt (when (< (inc i) n) (:path (nth rows (inc i))))
                      closing (vec (for [c (range (count p) 0 -1)
                                         :let [pre (subvec p 0 c)]
                                         :when (not (inside? pre nxt))]
                                     pre))]
                :when (seq closing)]
            [i closing]))))

(defn node-label
  "A safe display string for a descendant, so a node deleted between the query
  and the render degrades to a marker instead of an empty row."
  [e]
  (let [c (:block/content e)]
    (when (and (string? c) (not (string/blank? c))) c)))
