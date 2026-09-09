(ns frontend.util.f28-refpath-test
  "Tests for the F28 source-path disclosure's pure decisions.

  Nothing here renders, and nothing reads a database: the ancestor walk itself
  belongs to `frontend.util.f27-context`, which has its own tests. What is
  tested here is the part that is new — where the control belongs, how far up to
  read, and turning one walk result into steps the panel may honestly show."
  (:require [cljs.test :refer [deftest testing is]]
            [frontend.util.f27-context :as f27c]
            [frontend.util.f28-refpath :as f28]))

;; ---------------------------------------------------------------------------
;; Fixtures
;; ---------------------------------------------------------------------------

(defn- blk
  ([n] (blk n (str "level " n)))
  ([n content] {:db/id (+ 1000 n)
                :block/uuid (str "u" n)
                :block/content content}))

(def ^:private page {:db/id 1 :block/uuid "p" :block/name "source page"
                     :block/original-name "Source Page"})

(defn- nearest-first
  "Ancestors as `load-ancestors` returns them: nearest parent first."
  [& xs]
  (vec xs))

(def ^:private ok-surface
  {:elided? true :source-path-list? true})

;; ---------------------------------------------------------------------------
;; Where the control belongs
;; ---------------------------------------------------------------------------

(deftest the-control-belongs-on-a-page-linked-reference-list-with-an-elided-path
  (is (nil? (f28/excluded-surface ok-surface)))
  (is (true? (f28/offer-control? ok-surface))))

(deftest a-path-og-showed-completely-gets-nothing
  (testing "the control exists only where OG's own breadcrumb elided something"
    (is (= :no-elision (f28/excluded-surface (assoc ok-surface :elided? false))))
    (is (false? (f28/offer-control? (assoc ok-surface :elided? false))))))

(deftest the-surface-question-and-the-elision-question-are-separate
  (testing "the caller knows the surface; only `breadcrumb` knows whether it cut
            the path, so the caller may ask WITHOUT paying for a second walk"
    (is (true? (f28/surface-allows? (assoc ok-surface :elided? false))))
    (is (true? (f28/surface-allows? (dissoc ok-surface :elided?)))))
  (testing "every other exclusion still refuses, whatever the elision says"
    (doseq [flag [:sidebar? :query? :preview? :embed? :mobile? :whiteboard?
                  :html-export? :slide? :f27-panel? :block-refs-list?]]
      (is (false? (f28/surface-allows? (assoc ok-surface flag true))) (str flag)))
    (is (false? (f28/surface-allows? (assoc ok-surface :source-path-list? false))))))

(deftest a-list-that-did-not-opt-in-gets-nothing
  (testing "the opt-in is explicit; a config reaching the same component by
            another route is not enough"
    (is (= :not-source-path-list
           (f28/excluded-surface (assoc ok-surface :source-path-list? false))))))

(deftest every-excluded-surface-is-its-own-named-reason
  (doseq [[flag reason] {:f27-panel? :f27-panel
                         :mobile? :mobile
                         :preview? :preview
                         :slide? :slide
                         :sidebar? :sidebar
                         :block-refs-list? :block-refs-list
                         :embed? :embed
                         :query? :query
                         :html-export? :html-export
                         :whiteboard? :whiteboard}]
    (testing (str flag)
      (is (= reason (f28/excluded-surface (assoc ok-surface flag true))))
      (is (false? (f28/offer-control? (assoc ok-surface flag true)))))))

(deftest the-set-of-exclusions-has-not-silently-changed
  (testing "adding a surface means REMOVING a reason here, which is visible"
    (is (= [:no-elision :not-source-path-list :f27-panel :mobile :preview :slide
            :sidebar :block-refs-list :embed :query :html-export :whiteboard]
           f28/exclusion-reasons))
    (is (= (count f28/exclusion-reasons) (count (set f28/exclusion-reasons))))))

(deftest every-reason-in-the-list-is-reachable
  (testing "a reason nothing can produce is a rule that is not enforced"
    (let [produced (set (for [r f28/exclusion-reasons]
                          (case r
                            :no-elision (f28/excluded-surface (assoc ok-surface :elided? false))
                            :not-source-path-list
                            (f28/excluded-surface (assoc ok-surface :source-path-list? false))
                            (f28/excluded-surface
                             (assoc ok-surface (keyword (str (name r) "?")) true)))))]
      (is (= (set f28/exclusion-reasons) produced)))))

;; ---------------------------------------------------------------------------
;; How far up to read
;; ---------------------------------------------------------------------------

(deftest the-first-press-covers-what-og-shows-plus-one-batch
  (is (= (+ f28/og-visible-levels f28/batch) (f28/request-limit 1)))
  (is (= (+ f28/og-visible-levels (* 2 f28/batch)) (f28/request-limit 2))))

(deftest a-press-number-below-one-is-treated-as-the-first
  (is (= (f28/request-limit 1) (f28/request-limit 0)))
  (is (= (f28/request-limit 1) (f28/request-limit nil)))
  (is (= (f28/request-limit 1) (f28/request-limit -5))))

(deftest a-request-never-exceeds-the-hard-cap
  (is (= f27c/hard-cap (f28/request-limit 1000))))

(deftest continuation-is-offered-only-when-it-can-reach-something
  (is (= 2 (f28/next-press 1 {:more? true})))
  (testing "nothing further above"
    (is (nil? (f28/next-press 1 {:more? false}))))
  (testing "a cycle, a read failure and the cap each withdraw it"
    (is (nil? (f28/next-press 1 {:more? true :cycle? true})))
    (is (nil? (f28/next-press 1 {:more? true :error? true})))
    (is (nil? (f28/next-press 1 {:more? true :capped? true}))))
  (testing "a press that already asked for the cap cannot ask for more"
    (is (nil? (f28/next-press 1000 {:more? true})))))

;; ---------------------------------------------------------------------------
;; What is disclosed
;; ---------------------------------------------------------------------------

(deftest what-og-already-shows-is-not-repeated
  (let [loaded {:ancestors (nearest-first (blk 7) (blk 6) (blk 5) (blk 4)
                                          (blk 3) (blk 2) (blk 1) page)
                :more? false :cycle? false :error? false :capped? false}
        d (f28/disclosure loaded)]
    (testing "seven block ancestors, three of them already on the row"
      (is (= 7 (:depth d)))
      (is (= 3 (:visible d)))
      (is (= 4 (:hidden d))))
    (testing "the steps are the four OG did not show, OUTERMOST first"
      (is (= ["level 1" "level 2" "level 3" "level 4"]
             (map :block/content (:steps d)))))
    (testing "the page is separated out rather than shown as an ancestor"
      (is (= "source page" (:block/name (:page d))))
      (is (not-any? f27c/page-entity? (:steps d))))
    (is (= :complete (:status d)))
    (is (true? (:complete? d)))
    (is (false? (:continue? d)))))

(deftest a-path-og-showed-entirely-discloses-nothing
  (let [loaded {:ancestors (nearest-first (blk 3) (blk 2) (blk 1) page)
                :more? false}
        d (f28/disclosure loaded)]
    (is (= 0 (:hidden d)))
    (is (= [] (:steps d)))
    (is (= 3 (:visible d)))
    (is (true? (:complete? d)))))

(deftest a-shallower-path-than-og-shows-reports-what-it-has
  (let [loaded {:ancestors (nearest-first (blk 2) (blk 1) page) :more? false}
        d (f28/disclosure loaded)]
    (is (= 2 (:visible d)))
    (is (= 0 (:hidden d)))
    (is (= 2 (:depth d)))))

(deftest a-walk-that-reached-no-further-than-og-says-more-remains
  (testing "hidden 0 with more still above is a real state, not a complete path"
    (let [loaded {:ancestors (nearest-first (blk 3) (blk 2) (blk 1)) :more? true}
          d (f28/disclosure loaded)]
      (is (= 0 (:hidden d)))
      (is (= :partial (:status d)))
      (is (false? (:complete? d)))
      (is (true? (:continue? d))))))

(deftest more-ancestry-above-what-was-loaded-is-continuable
  (let [loaded {:ancestors (apply nearest-first (map blk (range 11 0 -1)))
                :more? true}
        d (f28/disclosure loaded)]
    (is (= 11 (:depth d)))
    (is (= 8 (:hidden d)))
    (is (= :partial (:status d)))
    (is (true? (:continue? d)))
    (is (false? (:complete? d)))
    (testing "the outermost loaded level leads the disclosure"
      (is (= "level 1" (:block/content (first (:steps d))))))))

(deftest a-cycle-stops-and-is-not-called-complete
  (let [d (f28/disclosure {:ancestors (nearest-first (blk 3) (blk 2) (blk 1))
                           :more? false :cycle? true})]
    (is (= :cycle (:status d)))
    (is (false? (:complete? d)))
    (is (false? (:continue? d)))))

(deftest an-unreadable-ancestor-is-not-called-complete-and-not-called-a-cycle
  (let [d (f28/disclosure {:ancestors (nearest-first (blk 4) (blk 3) (blk 2) (blk 1))
                           :error? true :cycle? true :capped? true :more? true})]
    (testing "a failed read outranks every more specific cause"
      (is (= :unreadable (:status d))))
    (is (false? (:complete? d)))
    (is (false? (:continue? d)))
    (testing "what was already loaded is still shown"
      (is (= 1 (:hidden d))))))

(deftest the-cap-is-its-own-answer
  (let [d (f28/disclosure {:ancestors (apply nearest-first (map blk (range 5 0 -1)))
                           :more? true :capped? true})]
    (is (= :capped (:status d)))
    (is (false? (:complete? d)))
    (is (false? (:continue? d)))))

(deftest an-empty-walk-is-safe
  (doseq [loaded [{} {:ancestors []} {:ancestors nil :more? false}]]
    (let [d (f28/disclosure loaded)]
      (is (= 0 (:hidden d)))
      (is (= 0 (:depth d)))
      (is (= [] (:steps d)))
      (is (nil? (:page d))))))

(deftest the-caller-may-state-how-many-og-showed
  (testing "the subtraction is a parameter, not a hidden constant"
    (let [loaded {:ancestors (apply nearest-first (map blk (range 6 0 -1)))
                  :more? false}]
      (is (= 6 (:hidden (f28/disclosure loaded 0))))
      (is (= 3 (:hidden (f28/disclosure loaded 3))))
      (is (= 0 (:hidden (f28/disclosure loaded 99))))
      (is (= 6 (:visible (f28/disclosure loaded 99))))))
  (testing "a negative or missing count is treated as zero"
    (let [loaded {:ancestors (nearest-first (blk 2) (blk 1)) :more? false}]
      (is (= 2 (:hidden (f28/disclosure loaded -1))))
      (is (= 2 (:hidden (f28/disclosure loaded nil)))))))

;; ---------------------------------------------------------------------------
;; Rendering decisions that stay pure
;; ---------------------------------------------------------------------------

(deftest a-heading-or-task-ancestor-shows-its-structure-not-its-markup
  (let [h (f28/step-prefix "## 조상 제목")
        t (f28/step-prefix "TODO 조상 할 일")]
    (is (= 2 (:heading h)))
    (is (= "조상 제목" (:text h)))
    (is (= "TODO" (:marker t)))
    (is (= "조상 할 일" (:text t))))
  (testing "an ordinary ancestor keeps its text exactly"
    (let [p (f28/step-prefix "그냥 평범한 조상 — plain")]
      (is (nil? (:heading p)))
      (is (nil? (:marker p)))
      (is (= "그냥 평범한 조상 — plain" (:text p))))))

(deftest steps-that-share-their-text-still-get-distinct-keys
  (testing "the four identical `같은 이름` levels must not collapse into one row"
    (let [same (blk 1 "같은 이름 Same Name")
          keys' (map-indexed f28/step-key (repeat 4 same))]
      (is (= 4 (count (set keys')))))))

(deftest a-step-with-no-identity-still-gets-a-key
  (is (string? (f28/step-key 0 {})))
  (is (not= (f28/step-key 0 {}) (f28/step-key 1 {}))))

;; ---------------------------------------------------------------------------
;; The coupling to OG's own breadcrumb, stated rather than assumed
;; ---------------------------------------------------------------------------

(deftest og-visible-levels-matches-the-breadcrumbs-own-limit
  (testing "`breadcrumb` defaults `:level-limit` to 3; this feature subtracts
            exactly that many, and the coupling is asserted rather than hoped"
    (is (= 3 f28/og-visible-levels)))
  (testing "the walk asks for more than OG reads, which is the whole point:
            OG reads level-limit + 1 and therefore never learns the depth"
    (is (> (f28/request-limit 1) (inc f28/og-visible-levels)))))

;; ---------------------------------------------------------------------------
;; Where a disclosed step goes
;;
;; The first slice left every step inert. These are the rules that let one be
;; opened without ever guessing where the reader meant to go.
;; ---------------------------------------------------------------------------

(deftest a-step-travels-on-its-identity-and-on-nothing-else
  (let [e (assoc (blk 1 "L1 · 조상") :block/uuid "u-one")]
    (is (= "u-one" (f28/step-identity e)))
    (is (true? (f28/navigable-step? e))))
  (testing "a step with no `:block/uuid` is not offered as a destination at all,
            because `:db/id` does not survive a re-index"
    (is (nil? (f28/step-identity {:db/id 42 :block/content "L1"})))
    (is (false? (f28/navigable-step? {:db/id 42 :block/content "L1"})))
    (is (false? (f28/navigable-step? {})))))

(deftest the-fresh-lookup-is-what-decides
  (testing "the block is there now: go to it, by the identity that was proved"
    (let [d (f28/navigation "u-one" {:found {:block/uuid "u-one" :db/id 7}})]
      (is (= :open (:action d)))
      (is (= "u-one" (f28/opened d)))
      (is (nil? (f28/refused d)))))
  (testing "the destination opened is the FRESH entity's identity, not the
            captured one — they are equal by the check above, and reading it off
            the entity is what makes that true rather than assumed"
    (is (= "u-one" (:uuid (f28/navigation "u-one" {:found {:block/uuid "u-one"}}))))))

(deftest a-destination-that-is-gone-refuses-and-says-which-kind-of-gone
  (testing "nothing is there now"
    (let [d (f28/navigation "u-one" {:found nil})]
      (is (= :refuse (:action d)))
      (is (= :missing (f28/refused d)))
      (is (nil? (f28/opened d)))))
  (testing "the lookup itself could not be performed — a DIFFERENT fact, kept
            apart the same way `load-ancestors` keeps a failed lookup apart from
            reaching the top of the outline"
    (let [d (f28/navigation "u-one" {:error true})]
      (is (= :unreadable (f28/refused d)))
      (is (nil? (f28/opened d)))))
  (testing "a lookup that answered with something else is refused, never followed"
    (is (= :mismatch (f28/refused (f28/navigation "u-one"
                                                  {:found {:block/uuid "u-two"}})))))
  (testing "a page is refused too: `disclosure` never puts one in the steps, and
            a control that does not know what it would open does not open it"
    (is (= :page (f28/refused (f28/navigation "u-one"
                                              {:found {:block/uuid "u-one"
                                                       :block/name "source page"}})))))
  (testing "a step with no identity refuses before any lookup is even considered"
    (is (= :no-identity (f28/refused (f28/navigation nil {:found {:block/uuid "u-one"}}))))
    (is (= :no-identity (f28/refused (f28/navigation nil {:error true}))))))

(deftest identical-text-never-decides-a-destination
  (testing "four levels reading exactly the same words are four different
            destinations; only the identity separates them, and the decision
            never reads the text at all"
    (let [same "같은 이름 Same Name"
          levels (map-indexed (fn [i _] {:block/uuid (str "u-same-" i)
                                         :block/content same})
                              (range 4))]
      (doseq [e levels]
        (is (= (:block/uuid e)
               (f28/opened (f28/navigation (f28/step-identity e) {:found e})))))
      (testing "and a lookup answering with a DIFFERENT block of the same text
                is refused rather than accepted as close enough"
        (is (= :mismatch
               (f28/refused (f28/navigation "u-same-0"
                                            {:found {:block/uuid "u-same-3"
                                                     :block/content same}}))))))))

(deftest every-refusal-reason-is-declared
  (testing "the reasons are data, so a new one cannot be added without also
            being listed — which is what keeps each of them a separate test and
            a separate sentence on screen"
    (is (= #{:no-identity :unreadable :missing :mismatch :page}
           (set f28/navigation-refusals)))
    (doseq [r f28/navigation-refusals]
      (is (keyword? r)))))

(deftest a-refusal-carries-no-destination-to-read-by-accident
  (doseq [lookup [{:found nil} {:error true} {:found {:block/uuid "other"}}]]
    (let [d (f28/navigation "u-one" lookup)]
      (is (nil? (f28/opened d)))
      (is (nil? (:uuid d))))))
