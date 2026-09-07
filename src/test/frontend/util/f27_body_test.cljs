(ns frontend.util.f27-body-test
  "F27 readable-context batch — focused tests for the panel body contract.

  These pin the properties the user's walkthrough proved were missing:

    * a mutual reference pair is reported as a REPEAT and never expanded again,
      so no amount of it can produce runaway text or a depth-warning wall;
    * a self-reference is the same case, by construction;
    * exactly ONE reference-preview level is expanded automatically;
    * an unresolvable reference is a distinct, honest outcome;
    * output on reference-heavy text is bounded — whatever comes back measures
      no larger than the budget, formatted content included — the bound is
      reported rather than hidden, and measuring and cutting agree on graphemes
      so a Korean syllable or a joined emoji is never split;
    * ordinary references still produce a readable label, never an identifier."
  (:require [cljs.test :refer [deftest testing is]]
            [clojure.string :as string]
            [frontend.util.f27-body :as b]
            [logseq.graph-parser.mldoc :as gp-mldoc]))

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
;; Bounding, over the AST and against REAL parser output.
;;
;; The rule under test: whatever `take-nodes` returns must itself measure no
;; larger than the budget it was given. Nothing is exempt — not a formatted
;; node, not the first node, not a node whose size could not be measured. An
;; earlier version returned an oversized opening node whole and called it
;; truncated; a supervisor fed it one bold node of 5,000 characters with a
;; budget of 160 and got all 5,000 back.
;; ---------------------------------------------------------------------------

(defn- ast
  "Real parser output, not a hand-written stand-in."
  [s]
  (gp-mldoc/inline->edn s (gp-mldoc/default-config :markdown)))

(defn- within?
  "The decisive assertion: what came back is no larger than what was allowed."
  [result budget]
  (<= (b/displayed-length (:nodes result)) budget))

(deftest take-nodes-keeps-what-fits
  (let [nodes (ast "hello world")
        r (b/take-nodes nodes 100)]
    (is (= nodes (:nodes r)))
    (is (false? (:truncated? r)))
    (is (= 11 (:used r)))))

(deftest a-long-plain-run-is-cut-to-the-budget
  (let [r (b/take-nodes (ast (apply str (repeat 5000 "a"))) 160)]
    (is (true? (:truncated? r)))
    (is (<= (:used r) 160))
    (is (within? r 160) "the returned nodes measure no more than the budget")))

;; --- the supervisor's reproduction -----------------------------------------

(deftest long-leading-emphasis-is-shortened-not-emitted-whole
  (let [nodes (ast (str "**" (apply str (repeat 5000 "b")) "**"))
        r (b/take-nodes nodes 160)]
    (is (= 1 (count nodes)) "one bold node")
    (is (= "Emphasis" (ffirst nodes)))
    (is (= 5000 (b/displayed-length nodes)) "5,000 characters went in")
    (is (true? (:truncated? r)))
    (is (<= (:used r) 160))
    (is (within? r 160)
        "REGRESSION: this returned all 5,000 characters with :used 5000")
    (testing "and it is still bold — the markup is preserved, not discarded"
      (let [out (first (:nodes r))]
        (is (= "Emphasis" (first out)))
        (is (= ["Bold"] (first (second out))))))))

(deftest long-leading-emphasis-nested-inside-emphasis-is-also-shortened
  (let [nodes (ast (str "**bold then *" (apply str (repeat 3000 "c")) "* end**"))
        r (b/take-nodes nodes 160)]
    (is (true? (:truncated? r)))
    (is (within? r 160))
    (is (= "Emphasis" (ffirst (:nodes r))))))

(deftest long-leading-code-is-cut-and-stays-code
  (let [nodes (ast (str "`" (apply str (repeat 4000 "d")) "`"))
        r (b/take-nodes nodes 160)]
    (is (= "Code" (ffirst nodes)))
    (is (true? (:truncated? r)))
    (is (within? r 160))
    (is (= "Code" (ffirst (:nodes r))) "a cut code span is still a code span")))

(deftest a-long-leading-link-is-not-emitted-at-all
  ;; A link is ATOMIC: half a link points somewhere else. It is refused, and the
  ;; caller falls back to a compact label with a source control.
  (let [nodes (ast (str "[" (apply str (repeat 2000 "e")) "](https://example.com)"))
        r (b/take-nodes nodes 160)]
    (is (= "Link" (ffirst nodes)))
    (is (empty? (:nodes r)) "nothing of it is shown rather than all of it")
    (is (true? (:truncated? r)))
    (is (zero? (:used r)))
    (is (within? r 160))))

(deftest an-oversized-node-never-slips-through-at-any-budget
  (doseq [src [(str "**" (apply str (repeat 5000 "b")) "**")
               (str "`" (apply str (repeat 5000 "c")) "`")
               (str "[" (apply str (repeat 5000 "d")) "](https://example.com)")
               (str "~~" (apply str (repeat 5000 "e")) "~~")
               (apply str (repeat 5000 "f"))]
          budget [0 1 24 160 420]]
    (let [r (b/take-nodes (ast src) budget)]
      (is (within? r budget)
          (str "budget " budget " on " (subs src 0 (min 6 (count src))) "…")))))

;; --- zero and small remainders ---------------------------------------------

(deftest a-zero-budget-emits-nothing
  (let [r (b/take-nodes (ast "**bold** and plain") 0)]
    (is (empty? (:nodes r)))
    (is (zero? (:used r)))
    (is (true? (:truncated? r)))))

(deftest a-small-remainder-emits-only-what-it-allows
  (doseq [budget (range 1 12)]
    (let [r (b/take-nodes (ast "a longer sentence with **bold** in it") budget)]
      (is (within? r budget) (str "budget " budget))
      (is (<= (:used r) budget)))))

(deftest the-body-stops-expanding-before-the-remainder-is-useless
  (testing "a remainder too small for a preview closes the body instead"
    (let [nearly (b/spend (b/new-budget) (- b/max-body-chars (dec b/min-preview-chars)) false)]
      (is (true? (b/budget-spent? nearly)))
      (is (= :budget (ref-plan {:budget nearly})))))
  (testing "a remainder that can still hold one is not closed"
    (let [ok (b/spend (b/new-budget) (- b/max-body-chars b/min-preview-chars) false)]
      (is (false? (b/budget-spent? ok)))
      (is (>= (b/preview-allowance ok) b/min-preview-chars)))))

;; --- several references sharing the 420-character body allowance ------------

(deftest previews-share-one-body-allowance
  (let [one (ast (apply str (repeat 500 "g")))]
    (loop [budget (b/new-budget), n 0, total 0]
      (if (or (b/budget-spent? budget) (> n 10))
        (do (is (<= total b/max-body-chars)
                (str "all previews together emitted " total " characters"))
            (is (<= n b/max-expansions)
                (str n " previews expanded")))
        (let [allowance (b/preview-allowance budget)
              r (b/take-nodes one allowance)]
          (is (within? r allowance))
          (recur (b/spend budget (:used r) (:truncated? r)) (inc n) (+ total (:used r))))))))

(deftest the-shared-allowance-is-never-exceeded-by-formatted-targets
  (let [bold (ast (str "**" (apply str (repeat 5000 "h")) "**"))]
    (loop [budget (b/new-budget), total 0, n 0]
      (if (or (b/budget-spent? budget) (> n 10))
        (is (<= total b/max-body-chars)
            (str "four formatted previews together emitted " total " characters"))
        (let [allowance (b/preview-allowance budget)
              r (b/take-nodes bold allowance)]
          (recur (b/spend budget (:used r) (:truncated? r)) (+ total (:used r)) (inc n)))))))

;; --- accounting for nodes whose display is not their payload ----------------

(deftest a-block-reference-is-charged-what-its-chip-actually-shows
  ;; Its payload label is EMPTY, so a payload-only measurement reads zero and
  ;; lets an unlimited number of them through. What renders is a compact label.
  (let [nodes (ast "((7f271000-0000-4000-8000-000000000001))")
        m (second (first nodes))]
    (is (= "Link" (ffirst nodes)))
    (is (= ["Block_ref" "7f271000-0000-4000-8000-000000000001"] (:url m)))
    (is (empty? (:label m)) "the parser gives it no label at all")
    (is (= b/max-label-chars (b/displayed-length nodes))
        "charged the compact-label bound, not zero")))

(deftest a-page-reference-is-charged-the-name-it-displays
  (let [nodes (ast "[[Some Page]]")]
    (is (= (count "Some Page") (b/displayed-length nodes)))))

(deftest a-labelled-reference-is-charged-the-label-it-displays
  (let [nodes (ast "[my label](((7f271000-0000-4000-8000-000000000001)))")]
    (is (= (count "my label") (b/displayed-length nodes)))))

(deftest an-unmodelled-payload-map-has-no-proven-size
  (testing "a map with no label and no simple destination is UNMEASURABLE"
    ;; It used to be charged an arbitrary minimum of 40. A minimum is not a
    ;; maximum: a macro renders whatever it expands to, and none of that is in
    ;; the node, so any finite charge lets it through a budget that size.
    (is (b/unmeasurable? (b/displayed-length ["Some_Future_Node" {:opaque "x"}]))))
  (testing "and a node deeper than the walk limit is unmeasurable too"
    (is (b/unmeasurable? (b/displayed-length ["Plain" "x"] b/walk-limit)))))

;; --- unknown size is not a proven upper bound -------------------------------
;;
;; These read what actually came back, not what the estimator says about it: the
;; estimator is the thing under suspicion. `retained` concatenates every string
;; the emitted nodes carry, so a payload that slipped through whole is counted
;; where it would actually reach a renderer.

(defn- retained
  "Every string the emitted nodes actually carry — read out of the RESULT."
  [x]
  (cond
    (string? x) x
    (map? x) (apply str (map retained (vals x)))
    (coll? x) (apply str (map retained x))
    :else ""))

(defn- retained-count
  "How many of one payload character survived into the emitted nodes."
  [nodes ch]
  (count (filter #(= ch %) (retained nodes))))

(defn- wrap
  "`n` nested bold wrappers around one node, in OG's own Emphasis shape."
  [n node]
  (nth (iterate (fn [x] ["Emphasis" [["Bold"] [x]]]) node) n))

(deftest a-subtree-too-deep-to-measure-is-refused-not-emitted-whole
  ;; The supervisor's reproduction: ["Plain" "x" x5000] inside 40 Emphasis
  ;; wrappers, budget 160. `displayed-length` stopped walking at its depth limit
  ;; and answered 40; 40 fits 160, so the whole unmeasured subtree was taken.
  (let [payload (apply str (repeat 5000 "x"))
        deep (wrap 40 ["Plain" payload])
        r (b/take-nodes [deep] 160)]
    (is (b/unmeasurable? (b/displayed-length deep))
        "its size was never established, so no budget can hold it")
    (is (true? (:truncated? r)))
    (is (<= (:used r) 160))
    (is (not (string/includes? (retained (:nodes r)) payload))
        "REGRESSION: the whole 5,000-character subtree was emitted")
    (is (<= (retained-count (:nodes r) \x) 160)
        "characters actually retained, counted in the result")
    (is (within? r 160))))

(deftest a-measurable-nesting-depth-is-still-shortened-normally
  ;; The refusal above must not become a blanket refusal of nested formatting.
  (let [payload (apply str (repeat 5000 "x"))
        shallow (wrap 3 ["Plain" payload])
        r (b/take-nodes [shallow] 160)]
    (is (false? (b/unmeasurable? (b/displayed-length shallow))))
    (is (true? (:truncated? r)))
    (is (= 160 (retained-count (:nodes r) \x)))
    (is (= "Emphasis" (ffirst (:nodes r))) "and it is still bold")
    (is (within? r 160))))

(deftest an-unknown-node-is-refused-rather-than-charged-a-guessed-minimum
  (testing "a payload map that carries none of the text it renders"
    (let [node ["Macro" {:name "big" :arguments []}]
          r (b/take-nodes [node] 160)]
      (is (b/unmeasurable? (b/displayed-length node)))
      (is (empty? (:nodes r)) "not emitted at all")
      (is (true? (:truncated? r)))))
  (testing "text before an unknown node is still emitted, and the cut reported"
    (let [r (b/take-nodes [["Plain" "readable text"]
                           ["Macro" {:name "big" :arguments []}]
                           ["Plain" " more"]] 160)]
      (is (= [["Plain" "readable text"]] (:nodes r)))
      (is (true? (:truncated? r)))
      (is (= 13 (:used r)))))
  (testing "an unmeasurable node cannot be admitted by a large budget either"
    (doseq [budget [0 24 160 420 100000]]
      (let [r (b/take-nodes [["Macro" {:name "big" :arguments []}]] budget)]
        (is (empty? (:nodes r)) (str "budget " budget))))))

(deftest an-unmeasurable-node-inside-a-shortened-wrapper-is-also-refused
  (let [node ["Emphasis" [["Bold"] [["Plain" "start "]
                                    ["Macro" {:name "big" :arguments []}]]]]
        r (b/take-nodes [node] 160)]
    (is (b/unmeasurable? (b/displayed-length node)))
    (is (empty? (:nodes r))
        "the wrapper has no proven size either, so it is refused whole")
    (is (true? (:truncated? r)))))

(deftest a-graph-local-asset-is-charged-what-its-chip-shows
  ;; Inside a bounded preview an asset becomes a compact chip showing the FILE's
  ;; name, capped at `max-label-chars`. Charging the author's alt text — often
  ;; empty, and never what the chip shows — is an under-charge of exactly the
  ;; class the limiter correction removed.
  (testing "the alt text is not what is charged"
    (is (= b/max-label-chars (b/displayed-length (ast "![집중](../assets/집중 노트.png)")))))
  (testing "and neither is the path, when the author wrote no alt text"
    (is (= b/max-label-chars (b/displayed-length (ast "![](../assets/pic.png)")))))
  (testing "a plain link to an attachment is the same node to the budget"
    (is (= b/max-label-chars (b/displayed-length (ast "[report](../assets/report.pdf)")))))
  (testing "so one preview cannot be filled with asset chips"
    (let [r (b/take-nodes (ast (apply str (repeat 20 "![](../assets/pic.png) "))) 160)]
      (is (within? r 160))
      (is (true? (:truncated? r)))))
  (testing "a remote link is still charged the label it renders"
    ;; Nothing is fetched for it, and what reaches the screen is the author's
    ;; own label, so the existing charge is already what it displays.
    (is (= (count "remote pic")
           (b/displayed-length (ast "![remote pic](https://example.com/a.png)"))))))

(deftest many-block-references-cannot-all-be-emitted
  (let [nodes (ast (apply str (repeat 20 "((7f271000-0000-4000-8000-000000000001)) ")))
        r (b/take-nodes nodes 160)]
    (is (within? r 160))
    (is (true? (:truncated? r)))
    (is (< (count (:nodes r)) (count nodes))
        "twenty reference chips do not all fit in one preview")))

;; --- Unicode: measured and cut the same way --------------------------------

(deftest measurement-and-cutting-agree-on-graphemes
  (is (= 3 (b/text-size "집중력")))
  (is (= 2 (b/text-size "📖📚")))
  (is (= 1 (b/text-size "👨‍👩‍👧")) "a ZWJ family is one user-perceived character")
  (testing "the budget is spent in the same units the cut uses"
    (let [r (b/take-nodes (ast "집중력 실험입니다") 3)]
      (is (= [["Plain" "집중력"]] (:nodes r)))
      (is (= 3 (:used r)))
      (is (within? r 3)))))

(deftest truncation-respects-korean-and-joined-emoji
  (testing "Korean syllables are whole"
    (is (= [["Plain" "집중력"]] (:nodes (b/take-nodes (ast "집중력 실험입니다") 3)))))
  (testing "an emoji is not split into surrogate halves"
    (let [out (second (first (:nodes (b/take-nodes (ast "📖📚 notes") 2))))]
      (is (= "📖📚" out))
      (is (not= out (subs "📖📚 notes" 0 2)) "the naive cut yields half an emoji")))
  (testing "a joined emoji sequence is kept together"
    (let [out (second (first (:nodes (b/take-nodes (ast "👨‍👩‍👧 가족 사진") 1))))]
      (is (= "👨‍👩‍👧" out))))
  (testing "bold Korean is shortened without losing its emphasis"
    (let [r (b/take-nodes (ast (str "**" (apply str (repeat 500 "한")) "**")) 10)]
      (is (= "Emphasis" (ffirst (:nodes r))))
      (is (within? r 10))
      (is (= 10 (b/text-size (second (first (nth (second (first (:nodes r))) 1)))))))))

(deftest cuttable-node-detection-is-exact
  (is (true? (b/cuttable-node? ["Plain" "x"])))
  (is (true? (b/cuttable-node? ["Spaces" " "])))
  (is (true? (b/cuttable-node? ["Code" "x"])) "a code span is one run of text")
  (is (false? (b/cuttable-node? ["Emphasis" [["Bold"] []]])) "shortened by recursion, not by cutting")
  (is (false? (b/cuttable-node? ["Plain" 42])))
  (is (false? (b/cuttable-node? nil))))

(deftest nothing-in-nothing-claimed
  (is (= {:nodes [] :used 0 :truncated? false} (b/take-nodes [] 100)))
  (is (= {:nodes [] :used 0 :truncated? false} (b/take-nodes nil 100))))

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
