(ns frontend.util.f27-inert-test
  "F27 dynamic-boundary batch — focused tests for the pure decision behind an
  inert placeholder.

  What these pin:

    * a macro is named and, where it points at something this project can
      already navigate to, that target is offered — a block, a page or an
      address — without the macro being run;
    * a macro that points at nothing offers nothing, rather than a control that
      cannot work;
    * no label is ever a raw identifier, and every label is bounded;
    * inline HTML and Hiccup are reduced to TEXT, bounded, never to markup."
  (:require [cljs.test :refer [deftest testing is]]
            [clojure.string :as string]
            [frontend.util.f27-inert :as i]))

;; ---------------------------------------------------------------------------
;; What a macro points at
;; ---------------------------------------------------------------------------

(deftest an-embed-of-a-block-offers-that-block
  (let [t (i/macro-target "embed" ["((7f271000-0000-4000-8000-000000000001))"])]
    (is (= :block (:kind t)))
    (is (= "7f271000-0000-4000-8000-000000000001" (:value t)))))

(deftest an-embed-of-a-page-offers-that-page
  (let [t (i/macro-target "embed" ["[[Deep Work]]"])]
    (is (= :page (:kind t)))
    (is (= "Deep Work" (:value t))))
  (testing "a Korean page name is no different"
    (is (= "연구 노트" (:value (i/macro-target "embed" ["[[연구 노트]]"]))))))

(deftest a-remote-media-macro-offers-its-address-and-nothing-else
  (doseq [n ["youtube" "video" "vimeo" "bilibili" "tweet" "twitter"]]
    (let [t (i/macro-target n ["https://example.invalid/watch?v=abc"])]
      (is (= :url (:kind t)) n)
      (is (= "https://example.invalid/watch?v=abc" (:value t)) n)))
  (testing "an address is offered as an address, never fetched to be classified"
    (is (= :url (:kind (i/macro-target "youtube" ["http://example.invalid/x"]))))))

(deftest a-macro-that-points-at-nothing-offers-nothing
  (testing "a query is a program, not a destination"
    (is (= :none (:kind (i/macro-target "query" ["(page \"Deep Work\")"])))))
  (testing "a plugin renderer names no target this panel can reach"
    (is (= :none (:kind (i/macro-target "renderer" [":my-plugin"])))))
  (testing "an unknown macro with no arguments"
    (is (= :none (:kind (i/macro-target "whatever" []))))
    (is (= :none (:kind (i/macro-target "whatever" nil)))))
  (testing "a bare word is not an address and is not navigated to"
    (is (= :none (:kind (i/macro-target "youtube" ["dQw4w9WgXcQ"])))))
  (testing "a non-http scheme is not offered as an external address"
    (is (= :none (:kind (i/macro-target "video" ["file:///etc/passwd"]))))
    (is (= :none (:kind (i/macro-target "video" ["javascript:alert(1)"]))))))

;; ---------------------------------------------------------------------------
;; What a placeholder reads as
;; ---------------------------------------------------------------------------

(deftest a-placeholder-label-is-readable-and-bounded
  (testing "the macro's own arguments, as a person reads them"
    (is (= "(page \"Deep Work\")" (i/macro-label "query" ["(page \"Deep Work\")"] 40))))
  (testing "a raw identifier never becomes a label"
    (let [l (i/macro-label "embed" ["((7f271000-0000-4000-8000-000000000001))"] 40)]
      (is (not (re-find #"7f271000" (str l))))))
  (testing "several arguments read as one line"
    (is (= "a, b" (i/macro-label "x" ["a" "b"] 40))))
  (testing "a long argument is cut on user-perceived characters"
    (let [l (i/macro-label "x" [(apply str (repeat 200 "가"))] 40)]
      (is (= 41 (count l)))
      (is (string/ends-with? l "…"))))
  (testing "no arguments is nil, so the caller shows the macro's name alone"
    (is (nil? (i/macro-label "embed" [] 40)))
    (is (nil? (i/macro-label "embed" nil 40)))))

(deftest markup-is-reduced-to-text-and-bounded
  (testing "the markup is what is shown, as text"
    (is (= "<b>hello</b>" (i/markup-label "<b>hello</b>" 40))))
  (testing "an image tag is text here too — it is never a tag that could load"
    (is (= "<img src=\"https://example.invalid/x.png\">"
           (i/markup-label "<img src=\"https://example.invalid/x.png\">" 60))))
  (testing "a long fragment is cut, so a placeholder cannot become the content"
    (let [l (i/markup-label (str "<div>" (apply str (repeat 500 "x")) "</div>") 40)]
      (is (= 41 (count l)))))
  (testing "several lines collapse to one"
    (is (= "<b> a </b>" (i/markup-label "<b>\n a \n</b>" 40))))
  (testing "nothing readable is nil, not an empty placeholder"
    (is (nil? (i/markup-label "   " 40)))
    (is (nil? (i/markup-label nil 40)))))

;; ---------------------------------------------------------------------------
;; Which nodes the boundary claims at all
;; ---------------------------------------------------------------------------

(deftest the-boundary-claims-exactly-the-dynamic-nodes
  (testing "the four that reach a renderer or innerHTML"
    (is (= :macro (i/node-kind ["Macro" {:name "embed" :arguments ["x"]}])))
    (is (= :html (i/node-kind ["Inline_Html" "<b>x</b>"])))
    (is (= :hiccup (i/node-kind ["Inline_Hiccup" "[:b \"x\"]"])))
    (is (= :html (i/node-kind ["Export_Snippet" "html" "<b>x</b>"]))))
  (testing "an export snippet that is not html is left to OG"
    (is (nil? (i/node-kind ["Export_Snippet" "latex" "\\alpha"]))))
  (testing "ordinary text and formatting are never claimed"
    (doseq [n [["Plain" "hello"]
               ["Emphasis" [["Bold"] [["Plain" "x"]]]]
               ["Code" "x"]
               ["Link" {:url ["Search" "../assets/x.png"]}]
               ["Tag" [["Plain" "핵심"]]]
               ["Break_Line"]]]
      (is (nil? (i/node-kind n)) (pr-str n))))
  (testing "malformed input is not claimed either"
    (is (nil? (i/node-kind nil)))
    (is (nil? (i/node-kind "Macro")))
    (is (nil? (i/node-kind [])))))
