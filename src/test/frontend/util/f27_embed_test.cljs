(ns frontend.util.f27-embed-test
  "F27 block-embed slice — focused tests for the pure decision behind an
  EXPANDABLE `{{embed}}`.

  What these pin:

    * only a BLOCK embed is ever expandable — a page embed keeps the
      presentation it already has, so a slice that does not implement page
      embeds cannot accidentally change one;
    * a target that is already being rendered above this point is a REPEAT and
      stops there, so no amount of self-embedding or mutual embedding recurses;
    * the same target embedded twice in one body says so the second time;
    * a bounded or compact surface never offers the control, which is what keeps
      a nested embed inert and the row breadcrumb a one-line path;
    * an unresolvable target is said in words and never as an identifier;
    * the per-body cap means what it says."
  (:require [cljs.test :refer [deftest testing is]]
            [frontend.util.f27-embed :as e]))

(def ^:private host "7f271000-0000-4000-8000-000000000000")
(def ^:private target "7f271000-0000-4000-8000-000000000001")
(def ^:private other "7f271000-0000-4000-8000-000000000002")

(defn- plan
  "One `{{embed}}` on the surface a reader explicitly opened, unless overridden."
  [m]
  (e/plan-embed (merge {:kind :block
                        :resolved? true
                        :id target
                        :level 0
                        :compact? false
                        :trail #{host}
                        :ledger (e/new-ledger)}
                       m)))

;; ---------------------------------------------------------------------------
;; What is expandable at all
;; ---------------------------------------------------------------------------

(deftest only-the-embed-macro-is-claimed
  (is (true? (e/embed-macro? "embed")))
  (is (true? (e/embed-macro? "EMBED")))
  (is (true? (e/embed-macro? " embed ")))
  (testing "every other macro keeps the presentation it already has"
    (is (false? (e/embed-macro? "query")))
    (is (false? (e/embed-macro? "youtube")))
    (is (false? (e/embed-macro? "renderer")))
    (is (false? (e/embed-macro? "embedded")))
    (is (false? (e/embed-macro? nil)))))

(deftest an-ordinary-block-embed-on-an-opened-surface-is-expandable
  (is (= :expand (plan {})))
  (is (true? (e/expandable? (plan {})))))

(deftest a-page-embed-is-left-exactly-as-it-is
  (testing "this slice implements block embeds only; a page embed must not
            change presentation at all"
    (is (= :not-block (plan {:kind :page :id "Deep Work"})))
    (is (= :not-block (plan {:kind :url :id "https://example.invalid/x"})))
    (is (= :not-block (plan {:kind :none :id nil})))
    (is (false? (e/expandable? (plan {:kind :page :id "Deep Work"}))))))

;; ---------------------------------------------------------------------------
;; The cases that must stop
;; ---------------------------------------------------------------------------

(deftest a-target-already-being-rendered-above-is-a-repeat-and-is-not-opened
  (testing "a block that embeds itself — the host seeds the trail, so this is a
            repeat by construction rather than a special case"
    (is (= :repeat (plan {:id host}))))
  (testing "and a target already on the trail from an enclosing expansion"
    (is (= :repeat (plan {:trail #{host target}}))))
  (testing "a repeat outranks the bounded surface it might also be on, because
            'this repeats' explains what the reader sees and 'shown closed' does not"
    (is (= :repeat (plan {:id host :level 1})))
    (is (= :repeat (plan {:id host :compact? true})))))

(deftest the-same-target-embedded-twice-in-one-body-says-so-the-second-time
  (let [ledger (e/record (e/new-ledger) target)]
    (is (true? (e/offered? ledger target)))
    (is (= :repeat (plan {:ledger ledger})))
    (testing "a DIFFERENT target in the same body is still ordinary"
      (is (= :expand (plan {:id other :ledger ledger}))))))

(deftest a-bounded-or-compact-surface-never-offers-the-control
  (testing "inside a bounded reference preview, and inside an expanded embed —
            which is what keeps a nested embed inert"
    (is (= :closed (plan {:level 1})))
    (is (= :closed (plan {:level 5}))))
  (testing "and on a row's one-line breadcrumb"
    (is (= :closed (plan {:compact? true})))))

(deftest an-unresolvable-target-is-said-in-words-not-shown-as-an-identifier
  (is (= :unavailable (plan {:resolved? false})))
  (is (= :unavailable (plan {:id nil})))
  (is (= :unavailable (plan {:id "   "})))
  (testing "and being unresolvable outranks everything below it, so a missing
            target on a closed surface still reads as missing"
    (is (= :unavailable (plan {:resolved? false :level 1})))))

;; ---------------------------------------------------------------------------
;; The per-body cap
;; ---------------------------------------------------------------------------

(deftest one-body-offers-at-most-max-embeds-expandable-embeds
  (let [ids (map #(str "7f271000-0000-4000-8000-00000000001" %) (range 9))
        full (reduce e/record (e/new-ledger) (take e/max-embeds ids))]
    (is (= e/max-embeds (:offered full)))
    (is (true? (e/full? full)))
    (is (= :budget (plan {:id other :ledger full})))
    (testing "one below the cap is still expandable"
      (let [nearly (reduce e/record (e/new-ledger) (take (dec e/max-embeds) ids))]
        (is (false? (e/full? nearly)))
        (is (= :expand (plan {:id other :ledger nearly})))))
    (testing "a repeat is reported as a repeat even when the cap is also spent"
      (is (= :repeat (plan {:id (first ids) :ledger full}))))))

(deftest the-ledger-is-plain-data-and-tolerates-a-missing-identity
  (let [l (e/record (e/new-ledger) nil)]
    (is (= 1 (:offered l)))
    (testing "an anonymous target must not poison the set and make every later
              embed look like a repeat"
      (is (= #{} (:seen l)))
      (is (false? (e/offered? l nil)))
      (is (false? (e/offered? l target)))))
  (testing "and a nil ledger behaves like a fresh one rather than throwing"
    (is (false? (e/full? nil)))
    (is (false? (e/offered? nil target)))
    (is (= 1 (:offered (e/record nil target))))))

;; ---------------------------------------------------------------------------
;; The bounds are the ones the contract names
;; ---------------------------------------------------------------------------

(deftest the-bounds-are-small-finite-and-stated
  (is (= 420 e/max-embed-chars))
  (is (= 4 e/max-embeds))
  (is (pos-int? e/max-embed-chars))
  (is (pos-int? e/max-embeds)))
