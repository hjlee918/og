(ns frontend.util.f27-context-test
  "F27 slice 3 — focused tests for bounded ancestor loading.

  These pin the two properties that matter: ancestry is loaded in bounded
  batches with honest continuation, and a cycle terminates instead of hanging."
  (:require [cljs.test :refer [deftest testing is]]
            [frontend.util.f27-context :as ctx]))

(defn- chain
  "Build a parent-fn from a uuid->parent-uuid map."
  [m]
  (fn [uuid]
    (when-let [p (get m uuid)]
      {:block/uuid p :block/content (str "block " p)})))

;; a → b → c → d → e (a is deepest/nearest, e is outermost)
(def linear (chain {"a" "b" "b" "c" "c" "d" "d" "e"}))

(deftest loads-full-chain-when-within-limit
  (let [{:keys [ancestors more? cycle? depth]} (ctx/load-ancestors linear "a" 10)]
    (is (= ["b" "c" "d" "e"] (map :block/uuid ancestors)) "nearest first")
    (is (= 4 depth))
    (is (false? more?))
    (is (false? cycle?))))

(deftest batches-and-reports-more-honestly
  (testing "a limit smaller than the chain reports more? without loading it"
    (let [{:keys [ancestors more? depth]} (ctx/load-ancestors linear "a" 2)]
      (is (= ["b" "c"] (map :block/uuid ancestors)))
      (is (= 2 depth))
      (is (true? more?) "the interface must be able to say more exists")))
  (testing "continuation loads the next batch with NO level omitted"
    (let [first-pass (ctx/load-ancestors linear "a" 2)
          second-pass (ctx/load-ancestors linear "a" 4)]
      (is (= ["b" "c"] (map :block/uuid (:ancestors first-pass))))
      (is (= ["b" "c" "d" "e"] (map :block/uuid (:ancestors second-pass)))
          "the continued load is a superset in the same order — nothing skipped")
      (is (false? (:more? second-pass)))))
  (testing "a limit exactly equal to the chain length reports no more"
    (is (false? (:more? (ctx/load-ancestors linear "a" 4))))))

(deftest top-level-block-has-no-ancestors
  (let [{:keys [ancestors more? depth]} (ctx/load-ancestors (chain {}) "solo" 8)]
    (is (= [] ancestors))
    (is (= 0 depth))
    (is (false? more?))))

(deftest cycle-guard-terminates
  (testing "a self-parenting block stops immediately and is reported"
    (let [{:keys [ancestors cycle?]} (ctx/load-ancestors (chain {"a" "a"}) "a" 20)]
      (is (true? cycle?))
      (is (= [] ancestors))))
  (testing "a longer cycle stops at the repeat rather than looping"
    (let [{:keys [ancestors cycle?]} (ctx/load-ancestors (chain {"a" "b" "b" "c" "c" "a"}) "a" 50)]
      (is (true? cycle?))
      (is (= ["b" "c"] (map :block/uuid ancestors))
          "each distinct ancestor appears once, then the walk stops")))
  (testing "a cycle detected exactly at the batch boundary is reported as a cycle, not as more"
    (let [{:keys [cycle? more?]} (ctx/load-ancestors (chain {"a" "b" "b" "a"}) "a" 1)]
      (is (true? cycle?))
      (is (false? more?) "a repeat must never be advertised as further real context"))))

(def ^:private empty-result
  {:ancestors [] :more? false :cycle? false :depth 0 :capped? false :error? false})

(deftest degenerate-input-is-safe
  (is (= empty-result (ctx/load-ancestors nil "a" 5)))
  (is (= empty-result (ctx/load-ancestors linear nil 5))))

;; ---------------------------------------------------------------------------
;; The hard cap.
;;
;; Two distinct situations must not be conflated: a chain that STOPS exactly at
;; the cap (nothing was truncated) and a chain that CONTINUES past it (the cap
;; is hiding real ancestry and continuation cannot reach it).
;; ---------------------------------------------------------------------------

(defn- chain-of
  "A parent-fn producing exactly `n` ancestors above \"a\", then the top."
  [n]
  (fn [u]
    (let [i (if (= u "a") 0 (js/parseInt (subs u 1) 10))]
      (when (< i n) {:block/uuid (str "p" (inc i)) :block/content (str "level " (inc i))}))))

(deftest a-chain-ending-exactly-at-the-cap-is-not-reported-as-truncated
  (let [{:keys [depth more? capped? error? cycle?]}
        (ctx/load-ancestors (chain-of ctx/hard-cap) "a" 10000)]
    (is (= ctx/hard-cap depth) "every level up to the cap is loaded")
    (is (false? more?) "there is genuinely nothing above")
    (is (false? capped?)
        "the cap must not claim to be hiding context when the chain simply ends there")
    (is (false? error?))
    (is (false? cycle?))))

(deftest a-chain-one-past-the-cap-is-reported-as-truncated
  (let [{:keys [depth more? capped?]}
        (ctx/load-ancestors (chain-of (inc ctx/hard-cap)) "a" 10000)]
    (is (= ctx/hard-cap depth))
    (is (true? more?) "ancestry really does remain above")
    (is (true? capped?) "and the cap is why it cannot be loaded")))

(deftest an-unbounded-chain-is-still-bounded-and-says-so
  (let [endless (fn [u] {:block/uuid (str u "x") :block/content "c"})
        {:keys [depth more? capped?]} (ctx/load-ancestors endless "a" 10000)]
    (is (= ctx/hard-cap depth))
    (is (true? more?))
    (is (true? capped?))))

(deftest a-request-beyond-the-cap-is-clamped-not-honoured
  (testing "asking for more than the cap can never load more than the cap"
    (let [endless (fn [u] {:block/uuid (str u "x")})
          first-pass (ctx/load-ancestors endless "a" ctx/hard-cap)
          beyond (ctx/load-ancestors endless "a" (+ ctx/hard-cap 8))]
      (is (= ctx/hard-cap (:depth first-pass)))
      (is (= ctx/hard-cap (:depth beyond))
          "continuation past the cap cannot advance, so it must not be offered")
      (is (true? (:capped? beyond))))))

;; ---------------------------------------------------------------------------
;; Lookup failure is not completion.
;;
;; `parent-fn` reads the database and can fail. A failure that came back as nil
;; would be indistinguishable from reaching the top, and the panel would then
;; present a chain it never actually finished walking as complete.
;; ---------------------------------------------------------------------------

(defn- failing-after
  "A parent-fn over `linear` that throws once the walk reaches `bad`."
  [bad]
  (fn [u]
    (if (= u bad)
      (throw (js/Error. "simulated read failure"))
      (linear u))))

(deftest a-failure-during-traversal-is-reported-and-keeps-what-loaded
  (let [{:keys [ancestors more? cycle? capped? error? depth]}
        (ctx/load-ancestors (failing-after "c") "a" 8)]
    (is (true? error?) "the failure must be visible to the caller")
    (is (= ["b" "c"] (map :block/uuid ancestors))
        "context loaded before the failure is retained, not discarded")
    (is (= 2 depth))
    (is (false? more?) "an unknown remainder must not be advertised as more context")
    (is (false? cycle?))
    (is (false? capped?))))

(deftest a-failure-on-the-very-first-step-yields-no-context-but-an-error
  (let [{:keys [ancestors error?]} (ctx/load-ancestors (failing-after "a") "a" 8)]
    (is (true? error?))
    (is (= [] ancestors))))

(deftest a-failure-during-the-continuation-peek-is-reported-too
  (testing "the peek that decides whether more exists can fail like any other read"
    ;; limit 2 loads b and c, then peeks from "c" — which is the call that throws.
    (let [{:keys [ancestors more? error?]} (ctx/load-ancestors (failing-after "c") "a" 2)]
      (is (true? error?) "a failed peek must not be reported as 'nothing above'")
      (is (= ["b" "c"] (map :block/uuid ancestors)) "the loaded batch is kept")
      (is (false? more?)))))

(deftest a-successful-walk-never-reports-an-error
  (is (false? (:error? (ctx/load-ancestors linear "a" 10))))
  (is (false? (:error? (ctx/load-ancestors linear "a" 2))))
  (is (false? (:error? (ctx/load-ancestors (chain {}) "solo" 8))))
  (is (false? (:error? (ctx/load-ancestors (chain {"a" "a"}) "a" 8)))
      "a cycle is a known outcome, not a read failure"))

(deftest error-and-completion-are-never-claimed-together
  (testing "no result may look finished while an error occurred"
    (doseq [[label res] [["mid-walk" (ctx/load-ancestors (failing-after "c") "a" 8)]
                         ["at-peek" (ctx/load-ancestors (failing-after "c") "a" 2)]
                         ["first-step" (ctx/load-ancestors (failing-after "a") "a" 8)]]]
      (is (true? (:error? res)) label)
      (is (false? (:cycle? res)) label)
      (is (false? (:capped? res)) label))))

(deftest display-order-is-outermost-first
  (let [{:keys [ancestors]} (ctx/load-ancestors linear "a" 10)]
    (is (= ["e" "d" "c" "b"] (map :block/uuid (ctx/display-order ancestors)))
        "the reader sees the chain top-down")))

(deftest context-rows-separates-the-page
  (let [src-page {:block/name "src page" :block/original-name "Src Page"}
        b1 {:block/uuid "b1"} b2 {:block/uuid "b2"}
        self {:block/uuid "self"}
        {:keys [page ancestors] :as rows} (ctx/context-rows [b1 b2 src-page] self)]
    (is (= "src page" (:block/name page)) "the page is lifted out of the ancestor list")
    (is (= ["b2" "b1"] (map :block/uuid ancestors)) "remaining ancestors stay outermost-first")
    (is (= self (:self rows)))))

(deftest block-label-degrades-safely
  (is (= "text" (ctx/block-label {:block/content "text"})))
  (is (nil? (ctx/block-label {:block/content "   "})))
  (is (nil? (ctx/block-label {})))
  (is (nil? (ctx/block-label nil))))

(deftest page-entity-detection
  (is (true? (ctx/page-entity? {:block/name "p"})))
  (is (false? (ctx/page-entity? {:block/uuid "b"})))
  (is (false? (ctx/page-entity? nil))))

;; ---------------------------------------------------------------------------
;; Block-level markup vs inline text.
;;
;; The context line renders through OG's INLINE renderer. A heading's leading
;; `##` and a task's leading `TODO` are block-level constructs an inline
;; renderer echoes as literal characters, so they are split off and shown as
;; structure. These pin the split, including the cases that must NOT split.
;; ---------------------------------------------------------------------------

(deftest splits-heading-markup-off-the-inline-text
  (is (= {:heading 2 :marker nil :text "Section title"}
         (ctx/split-block-prefix "## Section title")))
  (is (= 1 (:heading (ctx/split-block-prefix "# One"))))
  (is (= 6 (:heading (ctx/split-block-prefix "###### Six"))))
  (testing "seven hashes is not a heading level OG has"
    (is (nil? (:heading (ctx/split-block-prefix "####### Seven")))))
  (testing "a hash with no space is a TAG, never a heading"
    (is (= {:heading nil :marker nil :text "#decision and more"}
           (ctx/split-block-prefix "#decision and more")))
    (is (nil? (:heading (ctx/split-block-prefix "#[[project alpha]] note"))))))

(deftest splits-task-markers-off-the-inline-text
  (is (= {:heading nil :marker "TODO" :text "write the report"}
         (ctx/split-block-prefix "TODO write the report")))
  (is (= "DONE" (:marker (ctx/split-block-prefix "DONE shipped it"))))
  (is (= "IN-PROGRESS" (:marker (ctx/split-block-prefix "IN-PROGRESS halfway"))))
  (testing "a heading that is also a task splits both"
    (is (= {:heading 3 :marker "TODO" :text "nested case"}
           (ctx/split-block-prefix "### TODO nested case"))))
  (testing "an ordinary capitalised word is NOT a task marker"
    (is (= {:heading nil :marker nil :text "API design notes"}
           (ctx/split-block-prefix "API design notes")))
    (is (nil? (:marker (ctx/split-block-prefix "TODOS are not TODO")))))
  (testing "a marker with nothing after it is left as plain text"
    (is (= {:heading nil :marker nil :text "TODO"}
           (ctx/split-block-prefix "TODO")))))

(deftest split-preserves-inline-markup-for-the-renderer
  (testing "emphasis, tags, links and emoji are left for the inline renderer"
    (is (= "**bold** and *em* #tag [[link]] 🌟 한국어"
           (:text (ctx/split-block-prefix "## **bold** and *em* #tag [[link]] 🌟 한국어")))))
  (testing "degenerate input is safe"
    (is (= {:heading nil :marker nil :text nil} (ctx/split-block-prefix nil)))
    (is (= {:heading nil :marker nil :text ""} (ctx/split-block-prefix "")))))
