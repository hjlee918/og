(ns frontend.util.f28-refctx-test
  "Tests for the F28 child-context disclosure's pure decisions.

  Nothing here renders, and nothing reads a database: the descendant walk itself
  belongs to `frontend.util.f27-children`, which has its own tests. What is
  tested here is the part that is new — where the control belongs, when a row
  has anything withheld at all, and turning one walk result into rows the panel
  may honestly show."
  (:require [cljs.test :refer [deftest testing is]]
            [frontend.util.f27-children :as f27ch]
            [frontend.util.f28-refctx :as ctx]
            [frontend.util.f28-refpath :as f28]))

;; ---------------------------------------------------------------------------
;; Fixtures
;; ---------------------------------------------------------------------------

(defn- blk
  ([n] (blk n (str "child " n)))
  ([n content] {:db/id (+ 2000 n)
                :block/uuid (str "c" n)
                :block/content content}))

(def ^:private ok-surface
  {:withheld? true :context-list? true})

(defn- children-fn
  "A `build-plan` children-fn over a plain {uuid -> [entities]} map."
  [m]
  (fn [uuid]
    (if (contains? m uuid)
      (let [kids (get m uuid)] {:raw kids :ordered kids})
      {:raw [] :ordered []})))

;; ---------------------------------------------------------------------------
;; Where the control belongs
;; ---------------------------------------------------------------------------

(deftest the-control-belongs-on-a-page-linked-reference-row-that-og-stopped-at
  (is (nil? (ctx/excluded-surface ok-surface)))
  (is (true? (ctx/offer-control? ok-surface))))

(deftest a-row-og-is-already-drawing-in-full-gets-nothing
  (testing "the control exists only where THIS list has withheld something"
    (is (= :nothing-withheld (ctx/excluded-surface (assoc ok-surface :withheld? false))))
    (is (false? (ctx/offer-control? (assoc ok-surface :withheld? false))))))

(deftest a-list-that-did-not-opt-in-gets-nothing
  (testing "the opt-in is explicit; a config reaching the same component by
            another route is not enough"
    (is (= :not-context-list (ctx/excluded-surface (assoc ok-surface :context-list? false))))
    (is (false? (ctx/offer-control? (assoc ok-surface :context-list? false))))))

(deftest withheld-needs-both-halves-and-og-computes-both
  (testing "a collapsed row with no children, and an expanded row with children,
            are both rows this feature must leave alone"
    (is (true? (ctx/withheld? {:collapsed? true :has-children? true})))
    (is (false? (ctx/withheld? {:collapsed? true :has-children? false})))
    (is (false? (ctx/withheld? {:collapsed? false :has-children? true})))
    (is (false? (ctx/withheld? {:collapsed? false :has-children? false})))
    (is (false? (ctx/withheld? {})))))

(deftest every-shared-surface-exclusion-is-the-source-path-slices-own
  (testing "delegation, not restatement: a surface excluded from one feature is
            excluded from the other, and cannot drift"
    (doseq [flag [:sidebar? :query? :preview? :embed? :mobile? :whiteboard?
                  :html-export? :slide? :f27-panel? :block-refs-list?]]
      (is (false? (ctx/offer-control? (assoc ok-surface flag true))) (str flag))
      (is (= (f28/excluded-surface {:elided? true :source-path-list? true flag true})
             (ctx/excluded-surface (assoc ok-surface flag true)))
          (str "reason for " flag " must be the same one")))))

(deftest the-reason-list-is-data-so-a-silent-widening-is-visible
  (testing "adding a surface to this feature means REMOVING a reason from here"
    (is (= [:nothing-withheld :not-context-list] ctx/own-exclusion-reasons))
    (testing "and every shared reason is inherited, minus the two that are
              replaced by this feature's own"
      (is (= (set (remove #{:no-elision :not-source-path-list} f28/exclusion-reasons))
             (set (remove (set ctx/own-exclusion-reasons) ctx/exclusion-reasons))))))
  (testing "every reason is actually reachable"
    (is (= :nothing-withheld (ctx/excluded-surface {})))
    (is (= :not-context-list (ctx/excluded-surface {:withheld? true})))
    (is (= :sidebar (ctx/excluded-surface (assoc ok-surface :sidebar? true))))))

;; ---------------------------------------------------------------------------
;; One row's plain label
;; ---------------------------------------------------------------------------

(deftest a-disclosed-descendant-is-plain-text-with-its-structure-beside-it
  (testing "a heading's level and a task's marker are structure, not characters"
    (let [r (ctx/plain-row "## 제목 Heading")]
      (is (= 2 (:heading r)))
      (is (= "제목 Heading" (:text r)))
      (is (false? (:empty? r))))
    (let [r (ctx/plain-row "TODO 할 일 do the thing")]
      (is (= "TODO" (:marker r)))
      (is (= "할 일 do the thing" (:text r)))))
  (testing "a block that says nothing is a state, not a blank row"
    (is (true? (:empty? (ctx/plain-row ""))))
    (is (true? (:empty? (ctx/plain-row "   "))))
    (is (true? (:empty? (ctx/plain-row nil))))))

(deftest a-label-is-bounded-and-is-never-cut-mid-character
  (let [long-korean (apply str (repeat 200 "가"))
        r (ctx/plain-row long-korean)]
    (is (<= (count (:text r)) (inc ctx/max-label-chars)))
    (is (re-find #"…$" (:text r))))
  (testing "an emoji sequence survives truncation whole"
    (let [r (ctx/plain-row (apply str (repeat 60 "👩‍👩‍👧‍👦")))]
      (is (string? (:text r)))
      (is (not (re-find #"�" (:text r)))))))

(deftest a-label-reduces-markup-rather-than-rendering-it
  (testing "an image link, a macro and a page link are reduced to what a person
            reads — the panel never becomes a second renderer"
    (let [r (ctx/plain-row "![그림 picture](../assets/x.png) and {{query (todo TODO)}} and [[어떤 페이지]]")]
      (is (string? (:text r)))
      (is (not (re-find #"<img" (:text r))))
      (is (nil? (:heading r))))))

;; ---------------------------------------------------------------------------
;; Turning one walk into what the panel shows
;; ---------------------------------------------------------------------------

(deftest a-row-with-nothing-under-it-discloses-nothing-and-says-so
  (let [plan (f27ch/build-plan (children-fn {}) "root" {})
        d (ctx/disclosure plan)]
    (is (= :none (:status d)))
    (is (= 0 (:total d)))
    (is (empty? (:rows d)))
    (is (false? (:continue? d)))))

(deftest the-immediate-children-are-disclosed-in-the-order-they-were-given
  (let [kids [(blk 1) (blk 2) (blk 3)]
        plan (f27ch/build-plan (children-fn {"root" kids}) "root" {})
        d (ctx/disclosure plan)]
    (is (= :ok (:status d)))
    (is (= 3 (:total d) (:shown d)))
    (is (= 0 (:remaining d)))
    (is (= ["c1" "c2" "c3"] (map (comp :block/uuid :entity) (:rows d))))
    (is (false? (:continue? d)))))

(deftest more-children-than-one-batch-are-counted-and-continued-honestly
  (let [kids (mapv blk (range 1 13))
        plan (f27ch/build-plan (children-fn {"root" kids}) "root" {})
        d (ctx/disclosure plan)]
    (is (= :partial (:status d)))
    (is (= 12 (:total d)))
    (is (= f27ch/default-batch (:shown d)))
    (is (= (- 12 f27ch/default-batch) (:remaining d)))
    (is (true? (:continue? d)))
    (testing "and the continuation really reaches the rest"
      (let [plan2 (f27ch/build-plan (children-fn {"root" kids}) "root"
                                    {:limits {[] (f27ch/continue-limit f27ch/default-batch)}})
            d2 (ctx/disclosure plan2)]
        (is (= :ok (:status d2)))
        (is (= 12 (:shown d2)))
        (is (= 0 (:remaining d2)))
        (is (false? (:continue? d2)))))))

(deftest a-failed-read-is-never-reported-as-a-childless-block
  (let [boom (fn [_] (throw (js/Error. "no")))
        d (ctx/disclosure (f27ch/build-plan boom "root" {}))]
    (is (= :error (:status d)))
    (is (false? (:continue? d)))
    (is (not= :none (:status d)))))

(deftest a-node-that-cannot-be-resolved-is-its-own-answer
  (let [d (ctx/disclosure (f27ch/build-plan (fn [_] {:missing? true}) "root" {}))]
    (is (= :unavailable (:status d)))
    (is (false? (:continue? d)))))

(deftest a-cycle-stops-before-it-recurses-and-is-marked-on-the-row
  (let [self (blk 1)
        ;; the child's own children include the root again
        m {"root" [self] "c1" [{:db/id 2000 :block/uuid "root" :block/content "root"}]}
        plan (f27ch/build-plan (children-fn m) "root" {:open #{["c1"]}})
        d (ctx/disclosure plan)]
    (is (= :ok (:status d)))
    (is (some #(= :cycle (:descend %)) (:rows d))
        "the row that would revisit the trail is marked, not followed")))

(deftest the-depth-safeguard-is-reached-rather-than-crossed
  (let [chain (into {} (for [n (range 1 9)]
                         [(if (= n 1) "root" (str "c" (dec n))) [(blk n)]]))
        open (set (for [n (range 1 9)] (mapv #(str "c" %) (range 1 (inc n)))))
        plan (f27ch/build-plan (children-fn chain) "root" {:open open})
        d (ctx/disclosure plan)]
    (is (<= (apply max (map :depth (:rows d))) (inc f27ch/max-depth)))
    (is (some #(= :depth (:descend %)) (:rows d))
        "the deepest row that may not be opened says why")))

(deftest every-count-the-panel-shows-balances
  (doseq [n [0 1 9 10 11 25]]
    (let [kids (mapv blk (range 1 (inc n)))
          d (ctx/disclosure (f27ch/build-plan (children-fn {"root" kids}) "root" {}))]
      (is (= (:total d) (+ (:shown d) (:remaining d)))
          (str n " children: shown + remaining must be every child")))))

(deftest a-rows-key-is-its-path-so-two-identical-labels-are-two-rows
  (let [same [(blk 1 "같은 이름") (blk 2 "같은 이름")]
        plan (f27ch/build-plan (children-fn {"root" same}) "root" {})
        d (ctx/disclosure plan)
        keys' (map ctx/row-key (:rows d))]
    (is (= 2 (count (distinct keys'))) "two rows reading the same must stay two rows")))

;; ---------------------------------------------------------------------------
;; The panel's identity
;; ---------------------------------------------------------------------------

(deftest a-panels-id-is-derived-from-its-own-row-so-two-rows-cannot-collide
  (let [a (ctx/panel-id "page name" "uuid-a")
        b (ctx/panel-id "page name" "uuid-b")]
    (is (not= a b))
    (is (= a (ctx/panel-id "page name" "uuid-a")) "stable across renders"))
  (testing "and it is usable as a DOM id whatever the list is called"
    (is (re-matches #"[A-Za-z0-9_-]+" (ctx/panel-id "한글 페이지 / with spaces" "u")))
    (is (re-matches #"[A-Za-z0-9_-]+" (ctx/panel-id nil nil)))))

(deftest a-panel-and-its-control-name-each-other
  (let [pid (ctx/panel-id "p" "u")]
    (is (= (str pid "-toggle") (ctx/toggle-id pid)))
    (is (not= pid (ctx/toggle-id pid)))))
