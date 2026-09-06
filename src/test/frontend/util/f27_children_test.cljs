(ns frontend.util.f27-children-test
  "F27 slice 4 — focused tests for expandable descendant context.

  The children query is injected, so ordering, failure, cycles and both
  safeguards are exercised against focused doubles rather than a live database."
  (:require [cljs.test :refer [deftest testing is]]
            [frontend.util.f27-children :as f27ch]))

;; --- doubles ----------------------------------------------------------------

(defn- blk [k & [content]]
  {:block/uuid k :block/content (or content (str "block " k))})

(defn- tree->fn
  "A children-fn over a uuid -> [child-uuid ...] map, in canonical order.

  Returns both shapes the real loader supplies: the raw sibling set and OG's
  left-order walk of it. Here they agree, so order is established."
  [m]
  (fn [uuid]
    (let [kids (mapv blk (get m uuid []))]
      {:raw kids :ordered kids})))

(defn- plan [children-fn root open limits]
  (f27ch/build-plan children-fn root {:open (set open) :limits (or limits {})}))

(defn- keys-at [p depth]
  (->> (:rows p) (filter #(= depth (:depth %))) (mapv (comp :block/uuid :entity))))

;; a → b, c, d ; c → c1, c2 ; c2 → c2x
(def simple (tree->fn {"a" ["b" "c" "d"] "c" ["c1" "c2"] "c2" ["c2x"]}))

;; --- children counts --------------------------------------------------------

(deftest a-block-with-no-children-says-none-not-error
  (let [p (plan (tree->fn {}) "a" #{} {})
        info (get-in p [:info []])]
    (is (= [] (:rows p)))
    (is (= 0 (:total info)))
    (is (= :none (:summary info)) "no children is a successful answer, not a failure")
    (is (false? (:error? info)))))

(deftest a-block-with-one-child-shows-it
  (let [p (plan (tree->fn {"a" ["only"]}) "a" #{} {})]
    (is (= ["only"] (keys-at p 1)))
    (is (= :ok (get-in p [:info [] :summary])))
    (is (false? (get-in p [:info [] :more?])))))

(deftest many-children-are-batched-with-an-exact-remainder
  (let [kids (mapv #(str "k" %) (range 25))
        p (plan (tree->fn {"a" kids}) "a" #{} {})
        info (get-in p [:info []])]
    (is (= f27ch/default-batch (count (keys-at p 1))) "only one batch is rendered")
    (is (= 25 (:total info)))
    (is (= (- 25 f27ch/default-batch) (:remaining info)))
    (is (true? (:more? info)))
    (is (= :partial (:summary info)))
    (is (true? (f27ch/batch-balances? info))
        "every child is either shown or counted as remaining")))

(deftest continuation-adds-a-batch-without-omitting-or-reordering
  (let [kids (mapv #(str "k" %) (range 25))
        f (tree->fn {"a" kids})
        first-pass (plan f "a" #{} {})
        second-pass (plan f "a" #{} {[] (f27ch/continue-limit f27ch/default-batch)})
        third-pass (plan f "a" #{} {[] 25})]
    (is (= (take 10 kids) (keys-at first-pass 1)))
    (is (= (take 20 kids) (keys-at second-pass 1))
        "the continued batch is a prefix-preserving superset — nothing skipped or resorted")
    (is (= kids (keys-at third-pass 1)))
    (is (false? (get-in third-pass [:info [] :more?])))
    (is (= :ok (get-in third-pass [:info [] :summary])))))

(deftest continuation-always-advances
  (testing "each continuation limit is strictly larger, so the control cannot stall"
    (is (< f27ch/default-batch (f27ch/continue-limit f27ch/default-batch)))
    (is (< 1 (f27ch/continue-limit 1)))
    (is (< 0 (f27ch/continue-limit 0)))
    (is (< 0 (f27ch/continue-limit nil)))))

;; --- ordering ---------------------------------------------------------------

(deftest siblings-keep-ogs-canonical-order
  (is (= ["b" "c" "d"] (keys-at (plan simple "a" #{} {}) 1)))
  (is (true? (get-in (plan simple "a" #{} {}) [:info [] :ordered?]))))

(deftest a-broken-left-chain-keeps-every-sibling-and-discloses-the-loss
  (testing "OG's order walk returning fewer siblings must not drop the rest"
    (let [f (fn [_] {:raw (mapv blk ["x" "y" "z"])
                     ;; the left chain breaks after the first block
                     :ordered (mapv blk ["x"])})
          p (plan f "a" #{} {})
          info (get-in p [:info []])]
      (is (= 3 (count (keys-at p 1))) "no sibling is silently omitted")
      (is (= #{"x" "y" "z"} (set (keys-at p 1))))
      (is (false? (:ordered? info)) "and the loss of canonical order is disclosed")
      (is (= 2 (:unordered info)))))
  (testing "a walk of the right length but the wrong members is not trusted either"
    (let [f (fn [_] {:raw (mapv blk ["x" "y"]) :ordered (mapv blk ["x" "q"])})
          {:keys [ordered? total]} (f27ch/resolve-children
                                    (mapv blk ["x" "y"]) (mapv blk ["x" "q"]))]
      (is (false? ordered?))
      (is (= 2 total))
      (is (some? f)))))

(deftest resolve-children-is-safe-on-degenerate-input
  (is (= {:children [] :total 0 :ordered? true :unordered 0}
         (f27ch/resolve-children nil nil)))
  (is (= 1 (:total (f27ch/resolve-children [(blk "a") nil] [(blk "a")]))))
  (testing "a child with no uuid still gets a distinct identity"
    (is (not= (f27ch/node-key {:db/id 1}) (f27ch/node-key {:db/id 2})))
    (is (nil? (f27ch/node-key nil)))
    (is (nil? (f27ch/node-key {})))))

;; --- nesting ----------------------------------------------------------------

(defn- counting-fn
  "A children-fn that records which nodes were asked about."
  [m asked]
  (fn [u]
    (swap! asked conj u)
    (let [kids (mapv blk (get m u []))]
      {:raw kids :ordered kids})))

(def ^:private nested-tree
  {"a" ["b" "c"] "b" ["b1"] "c" ["c1"] "b1" ["b1x"] "c1" ["c1x"]})

(deftest the-walk-never-fetches-a-subtree
  (testing "each rendered node is probed ONE level so its control is honest,
            and nothing beyond that is fetched while collapsed"
    (let [asked (atom [])]
      (plan (counting-fn nested-tree asked) "a" #{} {})
      (is (= ["a" "b" "c"] @asked)
          "the root's children are listed and each is probed once; b1 and c1 are never reached")
      (is (not-any? #{"b1" "c1" "b1x" "c1x"} @asked)
          "no grandchild is queried while every branch is collapsed")))
  (testing "each node is asked about at most once per render"
    (let [asked (atom [])]
      (plan (counting-fn nested-tree asked) "a" #{["b"]} {})
      (is (= (count @asked) (count (distinct @asked)))
          "an open node reuses its probe instead of querying twice"))))

(deftest opening-one-branch-descends-only-that-branch
  (let [asked (atom [])]
    (plan (counting-fn nested-tree asked) "a" #{["b"]} {})
    (is (= #{"a" "b" "c" "b1"} (set @asked))
        "opening b lists b's children and probes b1; c stays a probe only")
    (is (not (contains? (set @asked) "c1"))
        "the unopened sibling's children are never listed")))

(deftest the-expansion-control-is-offered-only-where-there-is-something-to-open
  (let [f (tree->fn {"a" ["leaf" "parent"] "parent" ["kid"]})
        rows (:rows (plan f "a" #{} {}))
        by-key (into {} (map (juxt (comp :block/uuid :entity) identity) rows))]
    (is (false? (:has-children? (get by-key "leaf")))
        "a leaf offers no control, so no affordance reveals nothing")
    (is (true? (:has-children? (get by-key "parent")))
        "a node with children does offer one"))
  (testing "a node that cannot be opened is not probed at all"
    (let [asked (atom [])
          f (counting-fn {"a" ["a"]} asked)]
      (plan f "a" #{} {})
      (is (= ["a"] @asked)
          "the cyclic child is marked, not probed — its control could not progress anyway"))))

(deftest nested-levels-render-in-order-with-correct-depths
  (let [p (plan simple "a" #{["c"] ["c" "c2"]} {})
        rows (mapv (juxt (comp :block/uuid :entity) :depth) (:rows p))]
    (is (= [["b" 1] ["c" 1] ["c1" 2] ["c2" 2] ["c2x" 3] ["d" 1]] rows)
        "depth-first in canonical order; a child follows its parent, siblings keep their place")
    (is (= 6 (:visible p)))))

(deftest each-child-expands-independently
  (let [f (tree->fn {"a" ["b" "c"] "b" ["b1" "b2"] "c" ["c1"]})]
    (is (= ["b" "b1" "b2" "c"] (mapv (comp :block/uuid :entity) (:rows (plan f "a" #{["b"]} {}))))
        "opening b leaves c collapsed")
    (is (= ["b" "c" "c1"] (mapv (comp :block/uuid :entity) (:rows (plan f "a" #{["c"]} {}))))
        "opening c leaves b collapsed")
    (is (= ["b" "b1" "b2" "c" "c1"]
           (mapv (comp :block/uuid :entity) (:rows (plan f "a" #{["b"] ["c"]} {}))))
        "both open at once")))

(deftest a-nested-nodes-batch-is-independent-of-its-parents
  (let [f (tree->fn {"a" (mapv #(str "p" %) (range 15))
                     "p0" (mapv #(str "q" %) (range 15))})
        p (plan f "a" #{["p0"]} {["p0"] 3})]
    (is (= 10 (count (keys-at p 1))) "the parent keeps the default batch")
    (is (= 3 (count (keys-at p 2))) "the child node honours its own limit")
    (is (= 12 (get-in p [:info ["p0"] :remaining])))))

;; --- honest stopping states -------------------------------------------------

(deftest a-failed-query-is-not-an-empty-block
  (let [boom (fn [_] (throw (js/Error. "query failed")))
        p (plan boom "a" #{} {})
        info (get-in p [:info []])]
    (is (true? (:error? info)))
    (is (= :error (:summary info)) "a failure must never be reported as 'no children'")
    (is (= [] (:rows p)))
    (is (false? (f27ch/can-continue? info false))
        "no continuation is offered for a query that failed")))

(deftest a-failure-deep-in-the-tree-keeps-the-rest
  (let [f (fn [u]
            (if (= u "b")
              (throw (js/Error. "boom"))
              (let [kids (mapv blk (get {"a" ["b" "c"]} u []))]
                {:raw kids :ordered kids})))
        p (plan f "a" #{["b"]} {})]
    (is (= ["b" "c"] (keys-at p 1)) "siblings loaded before the failure are retained")
    (is (= :error (get-in p [:info ["b"] :summary])))
    (is (= :ok (get-in p [:info [] :summary])) "the healthy level is still reported healthy")))

(deftest missing-and-deleted-nodes-do-not-crash-the-plan
  (let [f (fn [_] {:raw [nil (blk "ok") {:db/id 7}] :ordered nil})
        p (plan f "a" #{} {})]
    (is (= 2 (count (:rows p))) "nil entries are dropped; a node without a uuid is kept")
    (is (false? (get-in p [:info [] :ordered?]))))
  (testing "a node with no renderable content degrades to a marker"
    (is (= "text" (f27ch/node-label {:block/content "text"})))
    (is (nil? (f27ch/node-label {:block/content "   "})))
    (is (nil? (f27ch/node-label {})))
    (is (nil? (f27ch/node-label nil)))))

(deftest a-repeated-identity-on-the-active-trail-is-flagged-not-followed
  (testing "a node that is its own descendant cannot be opened"
    (let [f (tree->fn {"a" ["b"] "b" ["a"]})
          p (plan f "a" #{["b"] ["b" "a"]} {})
          rows (mapv (juxt (comp :block/uuid :entity) :depth :descend) (:rows p))]
      (is (= [["b" 1 :ok] ["a" 2 :cycle]] rows)
          "the repeat is rendered once, marked, and never descended into")))
  (testing "a longer loop stops at the repeat"
    (let [f (tree->fn {"a" ["b"] "b" ["c"] "c" ["b"]})
          p (plan f "a" #{["b"] ["b" "c"] ["b" "c" "b"]} {})]
      (is (= [:ok :ok :cycle] (mapv :descend (:rows p))))))
  (testing "the same block appearing under two DIFFERENT branches is not a cycle"
    ;; shared identity off the active trail is legitimate, and must still show
    (let [f (tree->fn {"a" ["b" "c"] "b" ["shared"] "c" ["shared"]})
          p (plan f "a" #{["b"] ["c"]} {})]
      (is (= [:ok :ok :ok :ok] (mapv :descend (:rows p))))))
  (testing "descend-state judges the trail directly"
    (is (= :cycle (f27ch/descend-state "x" #{"x"} 1 0)))
    (is (= :ok (f27ch/descend-state "x" #{"y"} 1 0)))
    (is (= :ok (f27ch/descend-state nil #{"x"} 1 0)) "a keyless node is not a cycle")))

(deftest the-depth-safeguard-stops-descent-and-offers-no-control
  (let [chain (into {} (for [i (range 12)] [(str "n" i) [(str "n" (inc i))]]))
        f (tree->fn (assoc chain "a" ["n0"]))
        open (set (for [i (range 12)] (into ["n0"] (mapv #(str "n" %) (range 1 (inc i))))))
        p (plan f "a" (conj open ["n0"]) {})
        deepest (last (:rows p))]
    (is (= f27ch/max-depth (:depth deepest))
        (str "descent stops at depth " f27ch/max-depth))
    (is (= :depth (:descend deepest))
        "the deepest node reports the depth safeguard, not :ok")
    (is (false? (:open? deepest)) "and is not opened, so no control can be offered")
    (is (every? #(<= (:depth %) f27ch/max-depth) (:rows p)))))

(deftest the-visible-node-safeguard-bounds-the-whole-subtree
  (let [wide (into {} (for [i (range 60)]
                        [(str "w" i) (mapv #(str "w" i "-" %) (range 40))]))
        f (tree->fn (assoc wide "a" (mapv #(str "w" %) (range 60))))
        open (set (for [i (range 60)] [(str "w" i)]))
        p (plan f "a" open (into {[] 60} (for [i (range 60)] [[(str "w" i)] 40])))]
    (is (= f27ch/max-visible (:visible p))
        (str "never more than " f27ch/max-visible " descendant rows"))
    (is (true? (:truncated? p)) "and the safeguard says it stopped the walk")
    (is (true? (f27ch/plan-balances? p)))
    (testing "no continuation is offered once the safeguard has stopped the walk"
      (is (false? (f27ch/can-continue? {:more? true :error? false} true))))))

(deftest continuation-is-offered-only-when-it-can-progress
  (is (true? (f27ch/can-continue? {:more? true :error? false} false)))
  (is (false? (f27ch/can-continue? {:more? false :error? false} false)) "nothing more to show")
  (is (false? (f27ch/can-continue? {:more? true :error? true} false)) "the query failed")
  (is (false? (f27ch/can-continue? {:more? true :error? false} true)) "safeguard reached")
  (is (false? (f27ch/can-continue? {} false))))

(deftest the-six-stopping-states-are-distinguishable
  (testing "children-summary separates a failure from an empty block"
    (is (= :error (f27ch/children-summary {:error? true :total 0 :shown-count 0})))
    (is (= :none (f27ch/children-summary {:error? false :total 0 :shown-count 0})))
    (is (= :partial (f27ch/children-summary {:error? false :total 5 :shown-count 2})))
    (is (= :ok (f27ch/children-summary {:error? false :total 2 :shown-count 2})))
    (is (= :error (f27ch/children-summary {:error? true :total 5 :shown-count 5}))
        "a failure outranks counts that happen to look finished"))
  (testing "descend-state separates cycle, depth and budget"
    (is (= :cycle (f27ch/descend-state "x" #{"x"} 0 0)))
    (is (= :depth (f27ch/descend-state "x" #{} f27ch/max-depth 0)))
    (is (= :budget (f27ch/descend-state "x" #{} 1 f27ch/max-visible)))
    (is (= :ok (f27ch/descend-state "x" #{} 1 0)))))

(deftest degenerate-plan-input-is-safe
  (is (= [] (:rows (f27ch/build-plan nil "a" {}))))
  (is (= :error (get-in (f27ch/build-plan nil "a" {}) [:info [] :summary]))
      "no query function is a failure to look, not an empty block")
  (is (= [] (:rows (f27ch/build-plan simple nil {}))))
  (testing "nil open/limits behave exactly like empty ones, rather than crashing"
    (is (= (:rows (f27ch/build-plan simple "a" {:open #{} :limits {}}))
           (:rows (f27ch/build-plan simple "a" {:open nil :limits nil}))
           (:rows (f27ch/build-plan simple "a" {}))))
    (is (= ["b" "c" "d"] (keys-at (f27ch/build-plan simple "a" {}) 1))
        "the root's own children are always shown; it is the branches that start closed")))

(deftest an-unresolvable-node-is-unavailable-not-empty-and-not-a-failure
  (let [gone (fn [_] {:missing? true})
        p (plan gone "a" #{} {})
        info (get-in p [:info []])]
    (is (= :unavailable (:summary info))
        "a node that no longer exists is not the same as one with no children")
    (is (true? (:missing? info)))
    (is (false? (:error? info)) "nor the same as a query that failed")
    (is (= [] (:rows p)))
    (is (false? (f27ch/can-continue? info false))))
  (testing "all five query outcomes are distinct"
    (is (= :error (f27ch/children-summary {:error? true})))
    (is (= :unavailable (f27ch/children-summary {:missing? true})))
    (is (= :none (f27ch/children-summary {:total 0})))
    (is (= :partial (f27ch/children-summary {:total 3 :shown-count 1})))
    (is (= :ok (f27ch/children-summary {:total 3 :shown-count 3})))
    (is (= :error (f27ch/children-summary {:error? true :missing? true}))
        "a failure to ask outranks an unresolved node")))

(deftest a-plan-that-exactly-fills-the-safeguard-offers-no-continuation
  (testing "filling the cap exactly is not :truncated?, but there is still no room"
    (let [kids (mapv #(str "k" %) (range (+ f27ch/max-visible 10)))
          f (tree->fn {"a" kids})
          p (plan f "a" #{} {[] f27ch/max-visible})
          info (get-in p [:info []])]
      (is (= f27ch/max-visible (:visible p)))
      (is (false? (:truncated? p))
          "nothing was cut short — the batch asked for exactly what fits")
      (is (true? (:more? info)) "yet 10 children remain unshown")
      (is (true? (f27ch/plan-at-capacity? p))
          "so the plan is at capacity and cannot render another row")
      (is (false? (f27ch/can-continue? info (f27ch/plan-at-capacity? p)))
          "a continuation here would raise the limit and add nothing")
      (is (true? (f27ch/plan-hiding-anything? p))
          "and the limit really is withholding descendants, so it is stated")))
  (testing "a plan under the cap still offers continuation"
    (let [kids (mapv #(str "k" %) (range 30))
          p (plan (tree->fn {"a" kids}) "a" #{} {[] 20})]
      (is (false? (f27ch/plan-at-capacity? p)))
      (is (true? (f27ch/can-continue? (get-in p [:info []]) (f27ch/plan-at-capacity? p))))))
  (testing "a plan that exactly fills the cap with nothing left does not claim to hide anything"
    (let [kids (mapv #(str "k" %) (range f27ch/max-visible))
          p (plan (tree->fn {"a" kids}) "a" #{} {[] f27ch/max-visible})]
      (is (true? (f27ch/plan-at-capacity? p)))
      (is (false? (:more? (get-in p [:info []]))))
      (is (false? (f27ch/plan-hiding-anything? p))
          "the limit was reached, but nothing is being withheld"))))
