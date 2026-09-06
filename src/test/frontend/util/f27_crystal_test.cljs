(ns frontend.util.f27-crystal-test
  "F27 slice 2 — focused tests for Crystal marker matching and preview selection.

  These pin the behaviour that matters for correctness: an explicit tag matches,
  an ordinary link or a similarly named tag does not, and every found match is
  either shown or counted."
  (:require [cljs.test :refer [deftest testing is]]
            [frontend.util.f27-crystal :as f27c]))

;; A stand-in for OG's own tag extractor, matching its shape:
;; a "Tag" node is ["Tag" [["Plain" "name"]]].
(defn- get-tag [node]
  (->> (second node)
       (map (fn [[elem value]] (case elem "Plain" value "Link" (:full_text value) "")))
       (apply str)))
(defn- tag-node [name] ["Tag" [["Plain" name]]])
(defn- link-node [name] ["Link" {:url ["Page_ref" name]}])

(deftest normalize-and-identity
  (testing "blank or missing markers never match anything"
    (is (nil? (f27c/normalize-tag nil)))
    (is (nil? (f27c/normalize-tag "")))
    (is (nil? (f27c/normalize-tag "   ")))
    (is (false? (f27c/same-tag? nil "결정")))
    (is (false? (f27c/same-tag? "결정" nil))))
  (testing "identity is case-insensitive and trimmed, like OG page names"
    (is (true? (f27c/same-tag? "Decision" "decision")))
    (is (true? (f27c/same-tag? "  결정 " "결정"))))
  (testing "EXACT identity, never substring"
    (is (false? (f27c/same-tag? "design" "designer")))
    (is (false? (f27c/same-tag? "결정" "결정사항")))
    (is (false? (f27c/same-tag? "tag" "my-tag")))))

(deftest inline-tags-come-only-from-tag-nodes
  (testing "an explicit #tag node is recognised"
    (is (= #{"결정"} (f27c/tags-from-ast [(tag-node "결정")] get-tag))))
  (testing "an ordinary [[page link]] to the same name is NOT a Crystal"
    (is (= #{} (f27c/tags-from-ast [(link-node "결정")] get-tag)))
    (is (false? (f27c/block-tagged? "결정"
                                    (f27c/tags-from-ast [(link-node "결정")] get-tag)
                                    #{}))))
  (testing "plain text that merely contains a hash is not a tag node"
    (is (= #{} (f27c/tags-from-ast [["Plain" "see #결정 in the docs"]] get-tag)))
    (is (= #{} (f27c/tags-from-ast [["Code" "#결정"]] get-tag)))
    (is (= #{} (f27c/tags-from-ast [["Inline_Hiccup" "#결정"]] get-tag))))
  (testing "mixed content keeps only the tag nodes"
    (is (= #{"결정"} (f27c/tags-from-ast [["Plain" "text"] (link-node "other") (tag-node "결정")] get-tag))))
  (testing "degenerate input always yields an empty set, never nil"
    (is (= #{} (f27c/tags-from-ast nil get-tag)))
    (is (= #{} (f27c/tags-from-ast [] get-tag)))
    (is (= #{} (f27c/tags-from-ast [(tag-node "x")] nil))
        "a missing extractor must not be reported as 'no tags found' by a different type")))

(deftest tags-property-is-an-explicit-marker
  (testing "a tags:: property counts as explicit"
    (is (= #{"결정"} (f27c/tags-from-properties {:tags ["결정"]})))
    (is (= #{"결정"} (f27c/tags-from-properties {:tags "결정"})))
    (is (= #{"a" "b"} (f27c/tags-from-properties {:tags ["A" "B"]}))))
  (testing "absent or blank properties yield nothing"
    (is (= #{} (f27c/tags-from-properties nil)))
    (is (= #{} (f27c/tags-from-properties {})))
    (is (= #{} (f27c/tags-from-properties {:tags [""]})))))

(deftest block-tagged-requires-an-explicit-marker
  (testing "matches via inline tag or via property"
    (is (true? (f27c/block-tagged? "결정" #{"결정"} #{})))
    (is (true? (f27c/block-tagged? "결정" #{} #{"결정"}))))
  (testing "no configured marker means nothing is ever a Crystal"
    (is (false? (f27c/block-tagged? nil #{"결정"} #{"결정"})))
    (is (false? (f27c/block-tagged? "" #{"결정"} #{}))))
  (testing "a similarly named tag does not match"
    (is (false? (f27c/block-tagged? "결정" #{"결정사항"} #{}))))
  (testing "nil sets are safe"
    (is (false? (f27c/block-tagged? "결정" nil nil)))))

(deftest preview-text-is-single-line-and-unicode-safe
  (testing "newlines and runs of whitespace collapse"
    (is (= "a b c" (f27c/preview-text "a\n  b\n\tc" 60))))
  (testing "truncation is by codepoint, so Korean and emoji are not split"
    (let [out (f27c/preview-text "한국어 결정 사항 매우 긴 텍스트 🌟 계속" 8)]
      (is (= 9 (count (vec out))) "8 codepoints plus the ellipsis")
      (is (re-find #"…$" out))))
  (testing "short text is unchanged and non-strings are safe"
    (is (= "짧은 글" (f27c/preview-text "짧은 글" 60)))
    (is (nil? (f27c/preview-text nil 10)))))

(deftest select-previews-accounts-for-every-match
  (testing "under the cap everything is shown"
    (let [ms [{:uuid "a"} {:uuid "b"}]
          r (f27c/select-previews ms)]
      (is (= 2 (count (:previews r))))
      (is (= 0 (:remainder r)))))
  (testing "over the cap the remainder is stated exactly"
    (let [ms (mapv (fn [i] {:uuid (str i)}) (range 7))
          r (f27c/select-previews ms)]
      (is (= f27c/max-previews (count (:previews r))))
      (is (= (- 7 f27c/max-previews) (:remainder r)))
      (is (= (+ (count (:previews r)) (:remainder r)) (:total r))
          "every unique match is either previewed or counted in the remainder")))
  (testing "the same block matched twice in a chain is shown once and counted"
    (let [r (f27c/select-previews [{:uuid "a"} {:uuid "a"} {:uuid "b"}])]
      (is (= 2 (count (:previews r))))
      (is (= 1 (:duplicates r)))))
  (testing "empty and nil inputs are safe"
    (is (= 0 (:total (f27c/select-previews []))))
    (is (= 0 (:total (f27c/select-previews nil))))
    (is (= 0 (:total (f27c/select-previews [nil nil]))))))

(deftest traversal-bound-is-declared
  (testing "ancestor traversal is bounded, not open-ended"
    (is (pos? f27c/max-ancestor-depth))
    (is (<= f27c/max-ancestor-depth 20))))
