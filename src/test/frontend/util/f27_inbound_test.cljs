(ns frontend.util.f27-inbound-test
  "F27 slice 5 — focused tests for chained inbound-reference exploration.

  Every read is injected, so direction, ordering, cycles, both safeguards and
  every failure path are exercised against focused doubles rather than a live
  database. The doubles also record what they were asked for, which is how the
  no-mutation and one-level-at-a-time properties are checked rather than
  asserted."
  (:require [cljs.test :refer [deftest testing is]]
            [frontend.util.f27-inbound :as f27in]))

;; --- doubles ----------------------------------------------------------------

(defn- blk
  "One block, as the panel sees it: a uuid, a db id, its own source page, and
  its text."
  [uuid page & [content id]]
  (cond-> {:block/uuid uuid
           :block/content (or content (str "block " uuid))
           :db/id (or id (+ 100 (hash uuid)))}
    page (assoc :block/page {:block/original-name page :block/name (str page)})))

(defn- stub
  "A reverse-reference entry exactly as `(:block/_refs e)` yields it."
  [e]
  {:db/id (:db/id e)})

(defn- graph
  "A resolve-fn over db id -> entity, recording every id it was asked for."
  [entities *calls]
  (let [by-id (into {} (map (juxt :db/id identity)) entities)]
    (fn [id] (swap! *calls conj id) (get by-id id))))

(defn- probe [n] {:total n})
(def ^:private probe-error {:error? true})
(def ^:private probe-missing {:missing? true})

(defn- step-for
  ([e] (step-for e 1))
  ([e req] (f27in/new-step e req)))

(defn- loaded
  "A step that has answered, with `prepared` as its result."
  [e prepared & [limit]]
  (assoc (step-for e)
         :status :loaded
         :result prepared
         :limit (or limit f27in/default-batch)))

;; --- direction and identity -------------------------------------------------
;;
;; B references A; C references B. The overview for A lists B, and the reader
;; asks what references B.

(def a-block (blk "a" "Page A" "the target" 1))
(def b-block (blk "b" "Page B" "B references [[A]]" 2))
(def c-block (blk "c" "Page C" "C references ((b))" 3))

(deftest asking-about-b-yields-c-not-a
  (testing "the results are blocks that REFER TO the selected block"
    (let [*calls (atom [])
          prepared (f27in/prepare-results [(stub c-block)]
                                          (graph [a-block b-block c-block] *calls))
          page (f27in/page-of prepared f27in/default-batch)]
      (is (= ["c"] (mapv :block/uuid (:shown page)))
          "C references B, so C is the result of asking about B")
      (is (not (contains? (set (mapv :block/uuid (:shown page))) "a"))
          "A is what B points AT; it is never an inbound result for B")
      (is (= 1 (:total prepared)))
      (is (= 1 (:shown-count page))))))

(deftest a-result-carries-its-own-source-identity
  (let [prepared (f27in/prepare-results [(stub c-block)]
                                        (graph [c-block] (atom [])))
        row (first (:unique prepared))]
    (is (= "c" (:block/uuid row)))
    (is (= "Page C" (f27in/source-page-label row))
        "the source page is the referring block's OWN page, not the target's")
    (is (= "C references ((b))" (f27in/block-label row)))
    (is (= "c" (f27in/step-key row)))))

(deftest one-level-is-fetched-at-a-time
  (testing "preparing a level resolves only that level's own entries"
    (let [*calls (atom [])
          _ (f27in/prepare-results [(stub c-block)] (graph [a-block b-block c-block] *calls))]
      (is (= [(:db/id c-block)] @*calls)
          "only the entry actually listed was resolved; nothing was followed"))))

(deftest an-already-realised-entry-is-not-re-resolved
  (let [*calls (atom [])
        prepared (f27in/prepare-results [c-block] (graph [c-block] *calls))]
    (is (= [] @*calls) "an entry that already carries a uuid needs no lookup")
    (is (= 1 (:unique-count prepared)))
    (is (identical? c-block (first (:unique prepared)))
        "the entity is passed through untouched — nothing is rebuilt or written")))

;; --- accounting -------------------------------------------------------------

(deftest every-raw-entry-is-accounted-for
  (let [gone {:db/id 999}
        prepared (f27in/prepare-results
                  [(stub c-block) (stub c-block) gone (blk "d" "Page D" nil 4)]
                  (graph [c-block] (atom [])))]
    (is (= 4 (:total prepared)))
    (is (= 2 (:unique-count prepared)) "C and D render")
    (is (= 1 (:duplicates prepared)) "the repeat of C is counted, not dropped")
    (is (= 1 (:unavailable prepared)) "the unresolvable stub is counted, not dropped")
    (is (true? (f27in/accounting-balances? prepared)))))

(deftest an-entity-without-a-uuid-is-unavailable-not-displayed
  (let [prepared (f27in/prepare-results [{:db/id 7}] (fn [_] {:db/id 7 :block/content "x"}))]
    (is (= 1 (:total prepared)))
    (is (= 0 (:unique-count prepared)))
    (is (= 1 (:unavailable prepared)))
    (is (true? (f27in/accounting-balances? prepared)))))

(deftest accounting-balances-for-an-empty-answer
  (let [prepared (f27in/prepare-results [] (fn [_] nil))]
    (is (= 0 (:total prepared)))
    (is (= [] (:unique prepared)))
    (is (true? (f27in/accounting-balances? prepared)))
    (is (= :empty (f27in/level-state (loaded b-block prepared)
                                    (f27in/page-of prepared 10))))))

(deftest nils-in-the-raw-collection-are-ignored-not-counted
  (let [prepared (f27in/prepare-results [nil (stub c-block) nil]
                                        (graph [c-block] (atom [])))]
    (is (= 1 (:total prepared)) "a nil is not an inbound reference to account for")
    (is (true? (f27in/accounting-balances? prepared)))))

;; --- deterministic order ----------------------------------------------------

(deftest order-does-not-depend-on-input-order
  (let [x (blk "x" "Bravo" nil 20)
        y (blk "y" "Alpha" nil 30)
        z (blk "z" "Alpha" nil 10)
        want ["z" "y" "x"]                ; Alpha before Bravo; within Alpha, by db id
        one (f27in/prepare-results [x y z] (fn [_] nil))
        other (f27in/prepare-results [z x y] (fn [_] nil))
        third (f27in/prepare-results [y z x] (fn [_] nil))]
    (is (= want (mapv :block/uuid (:unique one))))
    (is (= want (mapv :block/uuid (:unique other))))
    (is (= want (mapv :block/uuid (:unique third)))
        "the same set always renders in the same order, whatever order it arrives in")))

(deftest blocks-with-no-resolvable-page-sort-after-those-that-have-one
  (let [pageless (blk "p" nil nil 1)
        paged (blk "q" "Zulu" nil 2)
        prepared (f27in/prepare-results [pageless paged] (fn [_] nil))]
    (is (= ["q" "p"] (mapv :block/uuid (:unique prepared))))))

(deftest korean-and-emoji-page-names-order-and-render
  (let [ko (blk "k1" "회의 노트" "회의에서 나온 이야기 ✨" 5)
        emoji (blk "k2" "🌱 아이디어" "씨앗 아이디어 🌱" 6)
        prepared (f27in/prepare-results [emoji ko] (fn [_] nil))
        labels (mapv f27in/source-page-label (:unique prepared))]
    (is (= 2 (count labels)))
    (is (= (set ["회의 노트" "🌱 아이디어"]) (set labels))
        "both non-ASCII page names survive resolution and ordering")
    (is (= "회의에서 나온 이야기 ✨" (f27in/block-label ko))
        "Korean text and an emoji are returned unchanged, not stripped or escaped")
    (is (= prepared (f27in/prepare-results [ko emoji] (fn [_] nil)))
        "and their order is deterministic too")))

;; --- pagination -------------------------------------------------------------

(defn- many [n]
  (mapv #(blk (str "n" %) "Page" nil (+ 1000 %)) (range n)))

(deftest a-page-shows-one-batch-and-states-the-exact-remainder
  (let [prepared (f27in/prepare-results (many 25) (fn [_] nil))
        page (f27in/page-of prepared f27in/default-batch)]
    (is (= f27in/default-batch (:shown-count page)))
    (is (= 25 (:retained page)))
    (is (= 15 (:remaining page)))
    (is (true? (f27in/page-balances? page)))
    (is (true? (f27in/can-continue? page)))
    (is (= :partial (f27in/level-state (loaded b-block prepared) page)))))

(deftest continuation-advances-and-then-stops-exactly
  (let [prepared (f27in/prepare-results (many 25) (fn [_] nil))]
    (is (= 20 (f27in/next-limit 10)))
    (is (= 30 (f27in/next-limit 20)))
    (let [page (f27in/page-of prepared 30)]
      (is (= 25 (:shown-count page)) "never more than exist")
      (is (= 0 (:remaining page)))
      (is (false? (f27in/can-continue? page))
          "no continuation once everything retained is on screen")
      (is (= :ok (f27in/level-state (loaded b-block prepared) page))))))

(deftest the-limit-never-exceeds-the-per-level-cap
  (is (= f27in/max-shown (f27in/page-limit (* 10 f27in/max-shown))))
  (is (= f27in/max-shown (f27in/next-limit f27in/max-shown))
      "at the cap, continuation cannot raise the limit any further"))

(deftest at-the-per-level-cap-the-overflow-is-named-and-no-control-claims-it
  (let [n (+ f27in/max-shown 7)
        prepared (f27in/prepare-results (many n) (fn [_] nil))
        full (f27in/page-of prepared f27in/max-shown)]
    (is (= f27in/max-shown (:unique-count prepared)) "only the cap is retained")
    (is (= 7 (:over-cap prepared)) "the rest are counted, not forgotten")
    (is (true? (f27in/accounting-balances? prepared)))
    (is (= f27in/max-shown (:shown-count full)))
    (is (= 0 (:remaining full)))
    (is (= 7 (:beyond-cap full)))
    (is (false? (f27in/can-continue? full))
        "a continuation here could not reach the overflow, so none is offered")
    (is (true? (f27in/cap-hiding-anything? full))
        "and the reader is told the cap is withholding something")
    (is (= :partial (f27in/level-state (loaded b-block prepared) full)))))

(deftest exactly-at-the-cap-with-nothing-behind-it-hides-nothing
  (let [prepared (f27in/prepare-results (many f27in/max-shown) (fn [_] nil))
        page (f27in/page-of prepared f27in/max-shown)]
    (is (= 0 (:over-cap prepared)))
    (is (false? (f27in/cap-hiding-anything? page))
        "reaching the cap is not the same as withholding something at it")
    (is (= :ok (f27in/level-state (loaded b-block prepared) page)))))

(deftest a-mid-page-boundary-still-offers-a-continuation-that-advances
  (let [prepared (f27in/prepare-results (many (dec f27in/max-shown)) (fn [_] nil))
        page (f27in/page-of prepared (- f27in/max-shown 2))]
    (is (true? (f27in/can-continue? page)))
    (is (= 1 (:remaining page)))
    (let [after (f27in/page-of prepared (f27in/next-limit (- f27in/max-shown 2)))]
      (is (= (dec f27in/max-shown) (:shown-count after)))
      (is (false? (f27in/can-continue? after))))))

;; --- level states -----------------------------------------------------------

(deftest loading-is-not-empty
  (let [s (step-for b-block)]
    (is (= :loading (:status s)))
    (is (= :loading (f27in/level-state s nil))
        "a read that has been asked for and not answered is not an empty answer")))

(deftest a-block-with-no-identity-says-so
  (let [s (f27in/new-step {:block/content "no uuid"} 1)]
    (is (= :no-identity (:status s)))
    (is (= :no-identity (f27in/level-state s nil)))
    (is (nil? (:uuid s)) "there is nothing to look up, so no read is scheduled")))

(deftest a-failed-read-is-distinguishable-from-an-empty-one
  (let [empty-prepared (f27in/prepare-results [] (fn [_] nil))
        ok (loaded b-block empty-prepared)
        failed (assoc (step-for b-block) :status :error)]
    (is (= :empty (f27in/level-state ok (f27in/page-of empty-prepared 10))))
    (is (= :error (f27in/level-state failed nil)))
    (is (not= (f27in/level-state ok (f27in/page-of empty-prepared 10))
              (f27in/level-state failed nil))
        "a failure must never be presented as 'nothing references this'")))

(deftest a-block-that-no-longer-resolves-is-its-own-state
  (let [gone (assoc (step-for b-block) :status :unavailable)]
    (is (= :unavailable (f27in/level-state gone nil)))
    (is (not= :error (f27in/level-state gone nil)))
    (is (not= :empty (f27in/level-state gone nil)))))

(deftest the-retry-offer-is-bounded
  (is (true? (f27in/retry-allowed? 0)))
  (is (true? (f27in/retry-allowed? (dec f27in/max-retries))))
  (is (false? (f27in/retry-allowed? f27in/max-retries)))
  (is (false? (f27in/retry-allowed? (inc f27in/max-retries)))))

(deftest a-retry-counts-and-reloads-without-losing-the-place
  (let [trail [(assoc (step-for b-block 1) :status :error :limit 20)]
        after (f27in/mark-retry trail 2)
        s (f27in/current-step after)]
    (is (= 1 (count after)) "the trail keeps its shape")
    (is (= :loading (:status s)))
    (is (= 1 (:attempts s)))
    (is (= 2 (:req s)) "under a fresh request id, so the old answer is abandoned")
    (is (= 20 (:limit s)) "and the display limit the reader had chosen survives")
    (is (= 2 (:attempts (f27in/current-step (f27in/mark-retry after 3)))))))

(deftest reloading-a-block-with-no-identity-stays-no-identity
  (let [trail [(f27in/new-step {:block/content "no uuid"} 1)]
        after (f27in/reload-step trail 2)]
    (is (= :no-identity (:status (f27in/current-step after)))
        "a reload cannot invent an identity to wait on")))

;; --- probes on result rows --------------------------------------------------

(deftest a-probe-that-failed-is-not-a-dead-end
  (is (= :ok (f27in/probe-state (probe 3))))
  (is (= :none (f27in/probe-state (probe 0))))
  (is (= :error (f27in/probe-state probe-error)))
  (is (= :unavailable (f27in/probe-state probe-missing)))
  (is (= :unknown (f27in/probe-state nil))))

(deftest an-unanswered-probe-carries-no-count
  (is (= 3 (f27in/probe-count (probe 3))))
  (is (= 0 (f27in/probe-count (probe 0))))
  (is (nil? (f27in/probe-count probe-error))
      "zero would assert 'nothing references this', which is what is unknown")
  (is (nil? (f27in/probe-count probe-missing)))
  (is (nil? (f27in/probe-count nil))))

(deftest only-a-row-with-references-of-its-own-earns-a-step-control
  (let [trail [(step-for b-block)]]
    (is (true? (f27in/can-explore? (f27in/row-relation "c" trail (probe 2)))))
    (is (false? (f27in/can-explore? (f27in/row-relation "c" trail (probe 0)))))
    (is (false? (f27in/can-explore? (f27in/row-relation "c" trail probe-error))))
    (is (false? (f27in/can-explore? (f27in/row-relation "c" trail probe-missing))))
    (is (= :none (f27in/row-relation "c" trail (probe 0))))
    (is (= :error (f27in/row-relation "c" trail probe-error)))
    (is (= :unavailable (f27in/row-relation "c" trail probe-missing)))))

;; --- the trail, and cycles --------------------------------------------------

(deftest a-step-is-pushed-and-back-restores-the-previous-level
  (let [t0 [(step-for b-block 1)]
        t1 (f27in/push-step t0 (step-for c-block 2))]
    (is (= 2 (count t1)))
    (is (= "c" (:key (f27in/current-step t1))))
    (is (true? (f27in/can-go-back? t1)))
    (let [back (f27in/pop-step t1)]
      (is (= 1 (count back)))
      (is (= "b" (:key (f27in/current-step back))))
      (is (= t0 back) "Back restores the previous level exactly as it was")
      (is (false? (f27in/can-go-back? back))))))

(deftest back-at-the-origin-keeps-the-origin
  (let [t [(step-for b-block 1)]]
    (is (= t (f27in/pop-step t))
        "the explorer always shows the level it was opened on; closing is separate")))

(deftest the-path-can-be-truncated-to-any-earlier-step
  (let [t (-> [(step-for a-block 1)]
              (f27in/push-step (step-for b-block 2))
              (f27in/push-step (step-for c-block 3)))]
    (is (= ["a"] (mapv :key (f27in/truncate-trail t 0))))
    (is (= ["a" "b"] (mapv :key (f27in/truncate-trail t 1))))
    (is (= ["a" "b" "c"] (mapv :key (f27in/truncate-trail t 2))))
    (is (= ["a" "b" "c"] (mapv :key (f27in/truncate-trail t 9)))
        "an out-of-range jump changes nothing rather than emptying the path")
    (is (= ["a" "b" "c"] (mapv :key (f27in/truncate-trail t -1))))))

(deftest a-self-reference-is-a-cycle-boundary
  (testing "a block that references itself appears once, marked, and is not reopened"
    (let [trail [(step-for b-block 1)]
          relation (f27in/row-relation "b" trail (probe 1))]
      (is (= :cycle relation))
      (is (false? (f27in/can-explore? relation))
          "opening it would walk straight back onto the path being walked"))))

(deftest a-mutual-reference-is-a-cycle-boundary-on-the-second-step
  (testing "B <- C and C <- B: walking B → C, B shows as a cycle, not another load"
    (let [t0 [(step-for b-block 1)]
          t1 (f27in/push-step t0 (step-for c-block 2))]
      (is (= :ok (f27in/row-relation "c" t0 (probe 1)))
          "C is explorable from B")
      (is (= :cycle (f27in/row-relation "b" t1 (probe 1)))
          "B is already on the trail, so it is a boundary, not a step")
      (is (= :ok (f27in/row-relation "d" t1 (probe 1)))
          "an unrelated block at the same level is unaffected"))))

(deftest a-shared-node-on-separate-paths-is-not-a-cycle
  (testing "X reached via D and X reached via E are two paths, not a repeat"
    (let [origin (step-for b-block 1)
          via-d (-> [origin]
                    (f27in/push-step (step-for (blk "d" "Page D" nil 40) 2))
                    (f27in/push-step (step-for (blk "x" "Page X" nil 50) 3)))
          via-e (-> [origin]
                    (f27in/push-step (step-for (blk "e" "Page E" nil 60) 2))
                    (f27in/push-step (step-for (blk "x" "Page X" nil 50) 3)))]
      (is (= ["b" "d" "x"] (mapv :key via-d)))
      (is (= ["b" "e" "x"] (mapv :key via-e)))
      (is (= :ok (f27in/row-relation "x" (f27in/truncate-trail via-e 1) (probe 1)))
          "X is explorable from E even though another path also reached it")
      (is (= :cycle (f27in/row-relation "d" via-d (probe 1)))
          "only a repeat ON THIS PATH is refused"))))

(deftest a-row-with-no-identity-is-never-treated-as-a-repeat
  (let [trail [(step-for b-block 1)]]
    (is (false? (f27in/on-trail? trail nil))
        "an unknown identity is not evidence of a cycle")
    (is (= :none (f27in/row-relation nil trail (probe 0))))))

(deftest the-navigation-history-is-bounded-and-back-still-works
  (let [full (reduce (fn [t i]
                       (f27in/push-step t (step-for (blk (str "s" i) "P" nil i) i)))
                     [(step-for b-block 0)]
                     (range 1 f27in/max-trail))]
    (is (= f27in/max-trail (count full)))
    (is (true? (f27in/trail-full? full)))
    (is (= :trail (f27in/row-relation "brand-new" full (probe 5)))
        "at the bound no row is opened, and the reason is named")
    (is (false? (f27in/can-explore? (f27in/row-relation "brand-new" full (probe 5)))))
    (is (= :cycle (f27in/row-relation "b" full (probe 5)))
        "a repeat is still named a repeat at the bound, not merely 'too deep'")
    (let [refused (f27in/push-step full (step-for (blk "over" "P" nil 999) 99))]
      (is (= full refused) "the oldest step is never discarded to make room"))
    (is (= (dec f27in/max-trail) (count (f27in/pop-step full)))
        "and Back still restores what the reader actually walked")))

;; --- a read that comes back late --------------------------------------------

(deftest an-answer-for-a-level-the-reader-has-left-is-dropped
  (let [t0 [(step-for b-block 1)]
        t1 (f27in/push-step t0 (step-for c-block 2))
        ;; the reader presses Back while the read for C is still in flight
        back (f27in/pop-step t1)
        late (f27in/apply-result back 2 {:status :loaded :result {:total 99}})]
    (is (= back late) "C's answer does not land on B")
    (is (= :loading (:status (f27in/current-step late)))
        "and B is left in the state it was actually in")))

(deftest an-answer-for-the-level-on-screen-is-applied
  (let [t [(step-for b-block 1)]
        prepared (f27in/prepare-results [(stub c-block)] (graph [c-block] (atom [])))
        done (f27in/apply-result t 1 {:status :loaded :result prepared :probes {"c" (probe 0)}})
        s (f27in/current-step done)]
    (is (= :loaded (:status s)))
    (is (= 1 (:total (:result s))))
    (is (= :ok (f27in/level-state s (f27in/page-of (:result s) 10))))))

(deftest a-retry-abandons-the-request-id-it-replaced
  (let [t [(assoc (step-for b-block 1) :status :error)]
        retried (f27in/mark-retry t 2)
        stale (f27in/apply-result retried 1 {:status :loaded :result {:total 5}})]
    (is (= retried stale) "the answer to the attempt that failed cannot land")
    (is (= :loading (:status (f27in/current-step stale))))
    (let [fresh (f27in/apply-result retried 2 {:status :loaded :result {:total 5}})]
      (is (= :loaded (:status (f27in/current-step fresh)))))))

;; --- limits are pure --------------------------------------------------------

(deftest raising-the-limit-reads-nothing
  (let [*calls (atom [])
        prepared (f27in/prepare-results (mapv stub (many 25))
                                        (graph (many 25) *calls))
        t [(loaded b-block prepared)]
        before (count @*calls)
        raised (f27in/set-limit t (f27in/next-limit 10))]
    (is (= before (count @*calls))
        "continuation reveals more of what the level already retained")
    (is (= 20 (:limit (f27in/current-step raised))))
    (is (= 20 (:shown-count (f27in/page-of prepared 20))))))

(deftest back-reads-nothing
  (let [*calls (atom [])
        prepared (f27in/prepare-results [(stub c-block)] (graph [c-block] *calls))
        t1 (f27in/push-step [(loaded b-block prepared)] (step-for c-block 2))
        before (count @*calls)
        back (f27in/pop-step t1)]
    (is (= before (count @*calls))
        "the retained history is what makes Back instant and read-free")
    (is (= :loaded (:status (f27in/current-step back)))
        "and the level it restores still holds the answer it already had")))

;; --- read-only --------------------------------------------------------------

(deftest nothing-here-mutates-what-it-is-given
  (testing "preparation and paging return the same entities they were handed"
    (let [entities [c-block (blk "d" "Page D" "다른 블록 🌱" 4)]
          snapshot (mapv identity entities)
          prepared (f27in/prepare-results entities (fn [_] nil))
          page (f27in/page-of prepared f27in/default-batch)]
      (is (= snapshot entities) "the input collection is untouched")
      (is (every? (fn [e] (some #(identical? e %) entities)) (:shown page))
          "the rows ARE the entities read, not copies built by this code")
      (is (= (mapv :block/content snapshot)
             (mapv :block/content (sort-by :db/id (:shown page))))
          "and their content is passed through unchanged"))))

(deftest a-throwing-resolve-fn-is-the-callers-problem-not-a-silent-zero
  (testing "prepare-results does not swallow a read failure into an empty answer"
    (is (thrown? js/Error
                 (f27in/prepare-results [{:db/id 1}]
                                        (fn [_] (throw (js/Error. "db down")))))
        "the caller catches it and reports :error; it must not look like :empty")))

;; --- compact labels ---------------------------------------------------------

(deftest a-label-does-not-spend-itself-on-an-identifier
  (testing "a referring block is mostly ((uuid)) by definition"
    (let [raw "B refers to the target ((6a9c0000-0000-4000-8000-0000000005f0))"]
      (is (= (str "B refers to the target " f27in/block-ref-marker)
             (f27in/plain-label raw))
          "38 characters of identifier become one marker, so the words survive")
      (is (not (re-find #"6a9c0000" (f27in/plain-label raw)))))))

(deftest a-label-keeps-the-names-a-person-reads
  (is (= "see 회의 노트 for more" (f27in/plain-label "see [[회의 노트]] for more"))
      "a page reference keeps its page name, Korean included")
  (is (= "the manual" (f27in/plain-label "[the manual](https://example.invalid/x)"))
      "a markdown link keeps its link text, not its url")
  (is (= "tagged #씨앗 ✨" (f27in/plain-label "tagged #씨앗 ✨"))
      "a tag and an emoji are already readable and are left alone"))

(deftest a-label-with-several-references-reduces-each-one
  (let [raw "M refers to N ((6a9c0000-0000-4000-8000-0000000005a2)) and to the target ((6a9c0000-0000-4000-8000-0000000005f0))"]
    (is (= (str "M refers to N " f27in/block-ref-marker " and to the target " f27in/block-ref-marker)
           (f27in/plain-label raw)))))

(deftest a-label-leaves-text-that-only-looks-like-a-reference
  (is (= "(( not a ref ))" (f27in/plain-label "(( not a ref ))"))
      "only a well-formed uuid reference is reduced")
  (is (nil? (f27in/plain-label nil)))
  (is (= "" (f27in/plain-label ""))))
