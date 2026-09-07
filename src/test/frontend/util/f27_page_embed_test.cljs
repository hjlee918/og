(ns frontend.util.f27-page-embed-test
  "F27 page-embed slice — the pure decision and the bounded walk.

  These tests are about two things only: which `{{embed [[Page]]}}` may offer an
  excerpt and why not when it may not, and that the top-level walk terminates —
  on well-formed data, on a cycle, on a chain that is too long, and on a step
  that refuses. The rendering, the reading and the guards inside an excerpt are
  covered by `frontend.db.f27-page-test` and by the live UI scenario."
  (:require [cljs.test :refer [deftest is testing]]
            [frontend.util.f27-embed :as f27e]
            [frontend.util.f27-page-embed :as f27pe]))

;; ---------------------------------------------------------------------------
;; Identity
;; ---------------------------------------------------------------------------

(deftest page-key-is-distinct-from-a-block-identity
  (testing "a page named like a uuid never collides with the block of that uuid"
    (let [u "7f273000-0000-4000-8000-000000000001"]
      (is (not= u (f27pe/page-key u)))
      (is (f27pe/page-key? (f27pe/page-key u)))
      (is (not (f27pe/page-key? u)))))

  (testing "one identity per page, however the name was spelled"
    (is (= (f27pe/page-key "Deep Work") (f27pe/page-key "  deep work  ")))
    (is (= (f27pe/page-key "집중 노트") (f27pe/page-key "집중 노트")))
    (is (not= (f27pe/page-key "Deep Work") (f27pe/page-key "Deep Works"))))

  (testing "multiword and Korean names survive as identities"
    (is (some? (f27pe/page-key "Deep Work")))
    (is (some? (f27pe/page-key "집중 노트")))
    (is (some? (f27pe/page-key "A, B"))))

  (testing "a blank argument has no identity, so nothing is looked up"
    (is (nil? (f27pe/page-key "")))
    (is (nil? (f27pe/page-key "   ")))
    (is (nil? (f27pe/page-key nil)))))

;; ---------------------------------------------------------------------------
;; Surface classification
;; ---------------------------------------------------------------------------

(def ^:private base
  {:kind :page
   :id (f27pe/page-key "Deep Work")
   :entity? true
   :file? true
   :read-error? false
   :level 0
   :compact? false
   :trail #{}
   :ledger (f27e/new-ledger)})

(deftest an-ordinary-page-embed-may-be-excerpted
  (is (= :may-excerpt (f27pe/surface-outcome base))))

(deftest a-non-page-argument-is-left-exactly-as-it-was
  (is (= :not-page (f27pe/surface-outcome (assoc base :kind :block))))
  (is (= :not-page (f27pe/surface-outcome (assoc base :kind :url))))
  (is (= :not-page (f27pe/surface-outcome (assoc base :kind :none)))))

(deftest the-three-failures-read-differently
  (testing "a read failure is never an absent page and never an empty one"
    (is (= :error (f27pe/surface-outcome (assoc base :read-error? true)))))
  (testing "nothing in the graph carries the name"
    (is (= :missing (f27pe/surface-outcome (assoc base :entity? false)))))
  (testing "a name that is only ever linked is NOT a page that can be read"
    (is (= :uncreated (f27pe/surface-outcome (assoc base :file? false)))))
  (testing "a blank argument outranks everything but the kind"
    (is (= :unnamed (f27pe/surface-outcome (assoc base :id nil))))))

(deftest an-entity-alone-is-never-the-existence-test
  ;; Writing `{{embed [[Ghost]]}}` makes `Ghost` an entity by itself, so a
  ;; planner that trusted `some?` would offer an excerpt of every name anyone
  ;; ever typed in brackets.
  (is (= :uncreated (f27pe/surface-outcome (assoc base :entity? true :file? false)))))

(deftest a-repeat-is-reported-as-a-repeat
  (testing "the page this block lives on"
    (is (= :repeat (f27pe/surface-outcome (assoc base :trail #{(:id base)})))))
  (testing "a page already offered in this body"
    (is (= :repeat (f27pe/surface-outcome
                    (assoc base :ledger (f27e/record (f27e/new-ledger) (:id base)))))))
  (testing "and it outranks depth, because it explains what the reader sees"
    (is (= :repeat (f27pe/surface-outcome (assoc base :trail #{(:id base)} :level 3))))))

(deftest a-bounded-or-compact-surface-never-expands
  (is (= :closed (f27pe/surface-outcome (assoc base :level 1))))
  (is (= :closed (f27pe/surface-outcome (assoc base :compact? true))))
  (testing "which is what a page embed INSIDE an excerpt or an expansion gets"
    (is (= :closed (f27pe/surface-outcome (assoc base :level 5))))))

(deftest the-offer-budget-is-shared-with-block-embeds
  (testing "four block embeds spend the whole budget a page embed would use"
    (let [full (reduce f27e/record (f27e/new-ledger)
                       ["blk-1" "blk-2" "blk-3" "blk-4"])]
      (is (f27e/full? full))
      (is (= :budget (f27pe/surface-outcome (assoc base :ledger full))))))

  (testing "and three block embeds leave exactly one offer for a page"
    (let [three (reduce f27e/record (f27e/new-ledger) ["blk-1" "blk-2" "blk-3"])]
      (is (= :may-excerpt (f27pe/surface-outcome (assoc base :ledger three))))
      (testing "which the page then spends, closing the next one"
        (let [after (f27e/record three (:id base))]
          (is (= :budget (f27pe/surface-outcome
                          (assoc base :id (f27pe/page-key "Other") :ledger after)))))))))

(deftest an-absent-page-is-said-so-even-on-a-closed-surface
  ;; The block contract reports `:unavailable` ahead of depth for the same
  ;; reason: "there is no such page" explains the chip, "shown closed" does not.
  (is (= :uncreated (f27pe/surface-outcome (assoc base :file? false :level 2))))
  (is (= :error (f27pe/surface-outcome (assoc base :read-error? true :compact? true)))))

;; ---------------------------------------------------------------------------
;; The final outcome
;; ---------------------------------------------------------------------------

(deftest an-empty-page-and-a-broken-chain-never-read-the-same
  (testing "a page with no readable top-level block is empty"
    (is (= :empty (f27pe/excerpt-outcome
                   :may-excerpt {:state :ok :blocks [] :walk {:stopped :end}}))))

  (testing "a walk that hit its step bound having read nothing is a READ FAILURE"
    (is (= :error (f27pe/excerpt-outcome
                   :may-excerpt {:state :ok :blocks [] :walk {:stopped :steps}}))))

  (testing "so is a cycle, and so is a step that refused"
    (is (= :error (f27pe/excerpt-outcome
                   :may-excerpt {:state :ok :blocks [] :walk {:stopped :cycle}})))
    (is (= :error (f27pe/excerpt-outcome
                   :may-excerpt {:state :ok :blocks [] :walk {:stopped :candidates}}))))

  (testing "and so is an outline whose first link is broken"
    (is (= :error (f27pe/excerpt-outcome
                   :may-excerpt {:state :ok :blocks [] :walk {:stopped :orphaned}}))))

  (testing "and so is a read that threw"
    (is (= :error (f27pe/excerpt-outcome
                   :may-excerpt {:state :error :blocks [] :walk {:stopped :error}}))))

  (testing "anything read at all is an excerpt, even if the walk then broke"
    (is (= :expand (f27pe/excerpt-outcome
                    :may-excerpt {:state :ok :blocks [{:block :a}] :walk {:stopped :cycle}})))))

(deftest a-surface-that-already-decided-is-not-second-guessed
  (doseq [o [:not-page :unnamed :error :missing :uncreated :repeat :closed :budget]]
    (is (= o (f27pe/excerpt-outcome o {:state :ok :blocks [] :walk {:stopped :end}}))
        (str o " survives the outline read"))))

(deftest only-expand-offers-the-control
  (is (f27pe/expandable? :expand))
  (doseq [o [:not-page :unnamed :error :missing :uncreated :repeat :closed :budget :empty]]
    (is (not (f27pe/expandable? o)) (str o " offers no control"))))

;; ---------------------------------------------------------------------------
;; Pagination arithmetic
;; ---------------------------------------------------------------------------

(deftest pagination-never-exceeds-what-may-be-retained
  (is (= f27pe/blocks-per-request (f27pe/wanted 0)))
  (is (= f27pe/blocks-per-request (f27pe/wanted f27pe/blocks-per-request)))
  (is (= 10 (f27pe/next-wanted 5)))
  (is (= 15 (f27pe/next-wanted 10)))
  (is (= 20 (f27pe/next-wanted 15)))
  (testing "and the cap holds however often the control is pressed"
    (is (= f27pe/max-page-blocks (f27pe/next-wanted 20)))
    (is (= f27pe/max-page-blocks (f27pe/next-wanted 999)))
    (is (= f27pe/max-page-blocks (f27pe/wanted 999))))
  (testing "four presses reach the cap from a fresh excerpt"
    (is (= f27pe/max-page-blocks
           (->> (iterate f27pe/next-wanted f27pe/blocks-per-request)
                (take 5)
                last))))
  (testing "the control disappears exactly at the cap"
    (is (f27pe/more-retainable? 5))
    (is (f27pe/more-retainable? 15))
    (is (not (f27pe/more-retainable? 20)))
    (is (not (f27pe/more-retainable? 999)))))

;; ---------------------------------------------------------------------------
;; The bounded walk
;; ---------------------------------------------------------------------------

(defn- chain-step
  "A step over a well-formed chain given as a vector of `{:id .. :skip? ..}`."
  [nodes]
  (let [by-left (into {} (map-indexed
                          (fn [i n] [(if (zero? i) :page (:id (nth nodes (dec i))))
                                     n])
                          nodes))]
    (fn [prev] (get by-left prev))))

(defn- ids [w] (mapv :id (:blocks w)))

(deftest a-well-formed-chain-is-followed-in-order
  (let [nodes (mapv (fn [i] {:id (str "b" i)}) (range 10))
        w (f27pe/walk-top-level :page 5 (chain-step nodes))]
    (is (= ["b0" "b1" "b2" "b3" "b4"] (ids w)))
    (is (true? (:more? w)) "the lookahead found a sixth")
    (is (= :want (:stopped w)))))

(deftest the-end-of-a-page-is-the-end
  (let [nodes (mapv (fn [i] {:id (str "b" i)}) (range 3))
        w (f27pe/walk-top-level :page 5 (chain-step nodes))]
    (is (= ["b0" "b1" "b2"] (ids w)))
    (is (false? (:more? w)) "nothing follows, and the excerpt must not claim it does")
    (is (= :end (:stopped w)))
    (is (not (f27pe/walk-failed? w)))))

(deftest an-empty-page-reads-as-empty-and-not-as-a-failure
  (let [w (f27pe/walk-top-level :page 5 (fn [_] nil))]
    (is (= [] (:blocks w)))
    (is (= :end (:stopped w)))
    (is (not (f27pe/walk-failed? w)))
    (is (= :empty (f27pe/excerpt-outcome :may-excerpt {:state :ok :blocks [] :walk w})))))

(deftest skipped-blocks-are-stepped-over-and-never-counted
  (testing "the page's properties block, and blocks with nothing readable"
    (let [nodes [{:id "props" :skip? true}
                 {:id "b0"} {:id "blank" :skip? true} {:id "b1"} {:id "b2"}]
          w (f27pe/walk-top-level :page 5 (chain-step nodes))]
      (is (= ["b0" "b1" "b2"] (ids w)))
      (is (= :end (:stopped w)))
      ;; Five blocks stepped on, plus the step that discovers the end.
      (is (= 6 (:steps w)) "each skipped block still costs a step")
      (is (= 5 (:visited w)) "and each was stepped on")))

  (testing "a page consisting only of skipped blocks is empty, not broken"
    (let [nodes [{:id "props" :skip? true} {:id "blank" :skip? true}]
          w (f27pe/walk-top-level :page 5 (chain-step nodes))]
      (is (= [] (:blocks w)))
      (is (= :end (:stopped w)))
      (is (= 2 (:visited w)) "the chain WAS walked; it simply held nothing to show")
      (is (not (f27pe/walk-failed? w))))))

(deftest a-chain-with-no-head-is-distinguishable-from-an-empty-page
  ;; The walker cannot tell these apart on its own — both end immediately — so
  ;; it reports how many blocks it stepped on and the reader asks the one extra
  ;; question. Without `:visited` the distinction would be impossible.
  (let [w (f27pe/walk-top-level :page 5 (fn [_] nil))]
    (is (zero? (:visited w)))
    (is (= :end (:stopped w))))

  (testing "and once the reader marks it orphaned, it is a failure"
    (let [w (assoc (f27pe/walk-top-level :page 5 (fn [_] nil)) :stopped :orphaned)]
      (is (f27pe/walk-failed? w))
      (is (= :error (f27pe/excerpt-outcome :may-excerpt
                                           {:state :ok :blocks [] :walk w}))))))

(deftest a-cycle-stops-the-walk-and-is-reported-as-one
  (testing "a chain that points back at a block already walked"
    (let [step (fn [prev] (case prev
                            :page {:id "a"}
                            "a" {:id "b"}
                            "b" {:id "a"}
                            nil))
          w (f27pe/walk-top-level :page 10 step)]
      (is (= ["a" "b"] (ids w)))
      (is (= :cycle (:stopped w)))
      (is (f27pe/walk-failed? w))
      (is (false? (:more? w)) "a broken chain is never 'there is more'")))

  (testing "a block that claims the PAGE itself, which seeds the visited set"
    (let [step (fn [prev] (case prev :page {:id :page} nil))
          w (f27pe/walk-top-level :page 10 step)]
      (is (= [] (:blocks w)))
      (is (= :cycle (:stopped w)))
      (is (= :error (f27pe/excerpt-outcome :may-excerpt
                                           {:state :ok :blocks [] :walk w}))
          "and with nothing read it is a read failure, not an empty page")))

  (testing "a block pointing at itself"
    (let [step (fn [prev] (case prev :page {:id "a"} "a" {:id "a"} nil))
          w (f27pe/walk-top-level :page 10 step)]
      (is (= ["a"] (ids w)))
      (is (= :cycle (:stopped w))))))

(deftest a-chain-that-never-ends-stops-at-the-step-bound
  ;; Every id is distinct, so the visited set never fires; only the step bound
  ;; can stop this, and it must.
  (let [step (fn [prev] {:id (str "n" (if (= :page prev) 0 (inc (js/parseInt (subs prev 1)))))})
        w (f27pe/walk-top-level :page f27pe/max-page-blocks step)]
    (is (= f27pe/max-page-blocks (count (:blocks w))))
    (is (<= (:steps w) f27pe/max-walk-steps)))

  (testing "an endless run of SKIPPED blocks also stops, having read nothing"
    (let [n (volatile! 0)
          step (fn [_] {:id (str "s" (vswap! n inc)) :skip? true})
          w (f27pe/walk-top-level :page 5 step)]
      (is (= [] (:blocks w)))
      (is (= :steps (:stopped w)))
      (is (= f27pe/max-walk-steps (:steps w)))
      (is (f27pe/walk-failed? w))
      (is (= :error (f27pe/excerpt-outcome :may-excerpt {:state :ok :blocks [] :walk w}))
          "and it is a read failure, never a successfully empty page"))))

(deftest a-step-that-refuses-stops-the-walk
  (testing "with nothing read it is a read failure"
    (let [w (f27pe/walk-top-level :page 5 (fn [_] :refused))]
      (is (= [] (:blocks w)))
      (is (= :candidates (:stopped w)))
      (is (f27pe/walk-failed? w))
      (is (= :error (f27pe/excerpt-outcome :may-excerpt {:state :ok :blocks [] :walk w})))))

  (testing "with something read the excerpt stands and says it stopped"
    (let [step (fn [prev] (if (= :page prev) {:id "a"} :refused))
          w (f27pe/walk-top-level :page 5 step)]
      (is (= ["a"] (ids w)))
      (is (= :candidates (:stopped w)))
      (is (= :expand (f27pe/excerpt-outcome :may-excerpt
                                            {:state :ok :blocks (:blocks w) :walk w}))))))

(deftest the-walk-never-retains-more-than-the-cap
  (let [nodes (mapv (fn [i] {:id (str "b" i)}) (range 100))
        w (f27pe/walk-top-level :page 999 (chain-step nodes))]
    (is (= f27pe/max-page-blocks (count (:blocks w)))
        "a caller asking for more than may be retained gets the cap")
    (is (true? (:more? w)))
    (is (<= (:steps w) f27pe/max-walk-steps))))

(deftest the-lookahead-is-a-fact-and-never-a-count
  (let [nodes (mapv (fn [i] {:id (str "b" i)}) (range 500))
        w (f27pe/walk-top-level :page 5 (chain-step nodes))]
    (is (true? (:more? w)))
    (is (= 6 (:steps w))
        "five blocks and one lookahead — the other 494 are never touched")))
