(ns frontend.util.f27-body-test
  "F27 readable-context batch — focused tests for the panel body contract.

  These pin the properties the user's walkthrough proved were missing:

    * a mutual reference pair is reported as a REPEAT and never expanded again,
      so no amount of it can produce runaway text or a depth-warning wall;
    * a self-reference is the same case, by construction;
    * exactly ONE reference-preview level is expanded automatically;
    * an unresolvable reference is a distinct, honest outcome;
    * output on reference-heavy text is bounded, the bound is reported rather
      than hidden, and truncation never splits a Korean syllable or an emoji;
    * ordinary references still produce a readable label, never an identifier."
  (:require [cljs.test :refer [deftest testing is]]
            [clojure.string :as string]
            [frontend.util.f27-body :as b]))

(defn- ref-plan
  "plan-ref with the defaults a body starts from, so each test states only what
  it is actually varying."
  [m]
  (b/plan-ref (merge {:id "a" :resolved? true :labelled? false
                      :level 0 :trail #{} :budget (b/new-budget)}
                     m)))

;; ---------------------------------------------------------------------------
;; The defect: Habit Loop ⇄ Routine
;; ---------------------------------------------------------------------------

(deftest mutual-pair-is-a-repeat-not-a-recursion
  (testing "rendering Habit Loop expands Routine once"
    (is (= :expand (ref-plan {:id "routine" :level 0 :trail #{"habit"}}))))
  (testing "the reference back to Habit Loop inside that preview is a REPEAT"
    ;; This is the whole defect: OG's renderer substituted Habit Loop's content
    ;; here, then Routine's inside that, until the depth ceiling printed a
    ;; warning in every branch.
    (is (= :repeat (ref-plan {:id "habit" :level 1 :trail #{"habit" "routine"}}))))
  (testing "a repeat is reported as a repeat even when it is ALSO too deep"
    ;; Cycle outranks depth deliberately: "this repeats" explains what the
    ;; reader is looking at; "too deep" does not.
    (is (= :repeat (ref-plan {:id "habit" :level 9 :trail #{"habit"}})))))

(deftest a-self-reference-needs-no-special-case
  (testing "the host block seeds the trail, so it is already a repeat"
    (let [trail (b/push-trail #{} "self")]
      (is (= :repeat (ref-plan {:id "self" :trail trail}))))))

(deftest a-finite-chain-stops-after-one-level
  (testing "A → B expands"
    (is (= :expand (ref-plan {:id "b" :level 0 :trail #{"a"}}))))
  (testing "B → C inside that preview is named, not followed"
    (is (= :depth (ref-plan {:id "c" :level 1 :trail #{"a" "b"}}))))
  (testing "the contract is one level, stated as a constant"
    (is (= 1 b/max-preview-level))))

;; ---------------------------------------------------------------------------
;; Honest outcomes
;; ---------------------------------------------------------------------------

(deftest unresolved-is-its-own-outcome
  (is (= :unresolved (ref-plan {:resolved? false})))
  (is (= :unresolved (ref-plan {:id nil})))
  (is (= :unresolved (ref-plan {:id "   "})))
  (testing "unavailability outranks the author's own label decision"
    (is (= :unresolved (ref-plan {:resolved? false :labelled? true})))))

(deftest an-authors-own-label-is-what-the-reader-reads
  (is (= :label (ref-plan {:labelled? true})))
  (testing "but a labelled reference that repeats is still a repeat"
    (is (= :repeat (ref-plan {:labelled? true :trail #{"a"}})))))

(deftest push-trail-ignores-nothing-useful-and-nothing-empty
  (is (= #{"a"} (b/push-trail #{} "a")))
  (is (= #{} (b/push-trail #{} nil)) "an anonymous host must not poison the trail")
  (is (= #{} (b/push-trail #{} "  ")))
  (is (= #{"a" "b"} (b/push-trail #{"a"} "b"))))

;; ---------------------------------------------------------------------------
;; Bounds — and saying so
;; ---------------------------------------------------------------------------

(deftest the-body-budget-is-spent-and-then-refuses
  (let [full (reduce (fn [acc _] (b/spend acc 10 false)) (b/new-budget)
                     (range b/max-expansions))]
    (is (false? (b/budget-spent? (b/new-budget))))
    (is (true? (b/budget-spent? full)))
    (is (= :budget (ref-plan {:budget full})))
    (testing "a refusal is recorded, so the body can say it happened"
      (is (true? (b/body-note-needed? (b/withhold full)))))))

(deftest a-character-budget-also-closes-the-body
  (let [heavy (b/spend (b/new-budget) b/max-body-chars false)]
    (is (true? (b/budget-spent? heavy)))
    (is (zero? (b/remaining-chars heavy)))
    (is (zero? (b/preview-allowance heavy)))))

(deftest an-unspent-body-says-nothing
  (is (false? (b/body-note-needed? (b/new-budget))))
  (is (false? (b/body-note-needed? (b/spend (b/new-budget) 10 false)))
      "a preview that fitted is not a limit worth explaining")
  (is (true? (b/body-note-needed? (b/spend (b/new-budget) 10 true)))
      "a preview that was cut short IS"))

(deftest preview-allowance-never-exceeds-either-bound
  (is (= b/max-preview-chars (b/preview-allowance (b/new-budget))))
  (let [nearly (b/spend (b/new-budget) (- b/max-body-chars 5) false)]
    (is (= 5 (b/preview-allowance nearly)))))

;; ---------------------------------------------------------------------------
;; Bounding over the AST, not over the markup
;; ---------------------------------------------------------------------------

(deftest take-nodes-keeps-what-fits
  (let [nodes [["Plain" "hello "] ["Plain" "world"]]
        r (b/take-nodes nodes 100)]
    (is (= nodes (:nodes r)))
    (is (false? (:truncated? r)))
    (is (= 11 (:used r)))))

(deftest take-nodes-cuts-a-plain-run-and-says-so
  (let [{:keys [nodes truncated?]} (b/take-nodes [["Plain" "abcdefghij"]] 4)]
    (is (= [["Plain" "abcd"]] nodes))
    (is (true? truncated?))))

(deftest take-nodes-never-splits-markup-in-half
  (testing "a structured node is taken whole or dropped, never bisected"
    (let [emphasis ["Emphasis" [["Bold"] [["Plain" "important words here"]]]]
          {:keys [nodes truncated?]} (b/take-nodes [["Plain" "abcd"] emphasis] 5)]
      (is (= [["Plain" "abcd"]] nodes) "the emphasis node was dropped, not cut")
      (is (true? truncated?)))))

(deftest take-nodes-never-renders-an-empty-preview
  (testing "one oversized structured node is taken anyway, and reported"
    (let [big ["Emphasis" [["Bold"] [["Plain" "a very long stretch of text"]]]]
          {:keys [nodes truncated?]} (b/take-nodes [big] 3)]
      (is (= [big] nodes))
      (is (true? truncated?))))
  (testing "nothing in, nothing claimed"
    (is (= {:nodes [] :used 0 :truncated? false} (b/take-nodes [] 100)))
    (is (= {:nodes [] :used 0 :truncated? false} (b/take-nodes nil 100)))))

(deftest truncation-respects-korean-and-emoji
  (testing "Korean syllables are whole"
    (let [{:keys [nodes]} (b/take-nodes [["Plain" "집중력 실험입니다"]] 3)]
      (is (= [["Plain" "집중력"]] nodes))))
  (testing "an emoji is not split into surrogate halves"
    (let [{:keys [nodes]} (b/take-nodes [["Plain" "📖📚 notes"]] 2)
          out (second (first nodes))]
      (is (= "📖📚" out))
      ;; The naive cut is (subs s 0 2), which yields half of one emoji.
      (is (not= out (subs "📖📚 notes" 0 2))))))

(deftest plain-node-detection-is-exact
  (is (true? (b/plain-node? ["Plain" "x"])))
  (is (true? (b/plain-node? ["Spaces" " "])))
  (is (false? (b/plain-node? ["Emphasis" [["Bold"] []]])))
  (is (false? (b/plain-node? ["Plain" 42])))
  (is (false? (b/plain-node? nil))))

;; ---------------------------------------------------------------------------
;; Labels — a reader's words, never an identifier
;; ---------------------------------------------------------------------------

(deftest compact-label-is-readable-or-nothing
  (is (= "Routine" (b/compact-label "Routine")))
  (is (nil? (b/compact-label nil)))
  (is (nil? (b/compact-label "   ")) "blank is nothing, not an empty chip")
  (testing "a long label is cut on grapheme boundaries with a visible ellipsis"
    (let [s (apply str (repeat 200 "가"))
          out (b/compact-label s)]
      (is (<= (count out) (inc b/max-label-chars)))
      (is (string/ends-with? out "…"))))
  (testing "multi-line block text collapses to one line"
    (is (= "first second" (b/compact-label "first\n  second")))))
