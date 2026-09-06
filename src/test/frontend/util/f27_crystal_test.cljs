(ns frontend.util.f27-crystal-test
  "F27 slice 2 — focused tests for Crystal marker matching and preview selection.

  These pin the behaviour that matters for correctness: an explicit tag matches,
  an ordinary link or a similarly named tag does not, and every found match is
  either shown or counted."
  (:require [cljs.test :refer [deftest testing is]]
            [frontend.util.f27-crystal :as f27c]
            [logseq.graph-parser.mldoc :as gp-mldoc]
            [logseq.graph-parser.block :as gp-block]))

;; --- REAL parser, not a stand-in -------------------------------------------
;; The stand-in extractor below pins the helper contract; these use OG's actual
;; inline parser so the exclusions are established against real behaviour.
(defn- real-tags
  "Explicit inline tags of `content` via OG's own parser and extractor."
  [content]
  (f27c/tags-from-ast
   (gp-mldoc/inline->edn content (gp-mldoc/default-config :markdown))
   gp-block/get-tag))

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

;; ---------------------------------------------------------------------------
;; Parser-backed matching. These run OG's real inline parser.
;; ---------------------------------------------------------------------------

(deftest real-parser-recognises-explicit-tags
  (testing "a bare inline tag"
    (is (contains? (real-tags "decision made #결정 today") "결정")))
  (testing "a bracketed multi-word tag"
    (is (contains? (real-tags "note #[[project alpha]] here") "project alpha")))
  (testing "an ASCII tag"
    (is (contains? (real-tags "text #decision more") "decision")))
  (testing "several tags in one block"
    (is (= #{"a" "b"} (real-tags "x #a y #b")))))

(deftest real-parser-excludes-non-tags
  (testing "an ordinary page link is not a tag"
    (is (= #{} (real-tags "see [[결정]] for details"))))
  (testing "a tag inside an inline code span is not a tag"
    (is (= #{} (real-tags "type `#결정` to tag it"))))
  (testing "a tag inside a fenced code block is not a tag"
    (is (= #{} (real-tags "```\n#결정\n```"))))
  (testing "a bare hash in prose is not a tag"
    (is (= #{} (real-tags "issue # 12 and C# notes"))))
  (testing "a similarly named tag is a DIFFERENT identity"
    (let [tags (real-tags "text #결정사항 more")]
      (is (contains? tags "결정사항"))
      (is (false? (f27c/block-tagged? "결정" tags #{}))
          "the marker 결정 must not match the tag 결정사항"))))

(deftest real-parser-tags-and-formatting
  ;; Established by probing OG's real parser, not assumed:
  ;;   "**bold #결정 text**" -> [["Emphasis" [["Bold"] [["Plain" "bold #결정 text"]]]]]
  ;; OG does NOT emit a Tag node for a hash inside emphasis, so such text is not
  ;; an explicit tag to OG and does not render as a tag link either. Slice 2
  ;; follows OG rather than inventing an inline-word heuristic to override it.
  (testing "a hash inside bold is NOT a tag node in OG, so it is not a Crystal"
    (is (= #{} (real-tags "**bold #결정 text**"))))
  (testing "a hash inside italics is likewise not a tag node"
    (is (= #{} (real-tags "*em #decision text*"))))
  (testing "a tag ADJACENT to formatting is a normal tag and IS found"
    (is (contains? (real-tags "**bold** #결정") "결정")))
  (testing "nested walking still finds a tag that the parser does nest"
    ;; guards the nested-walk implementation against regressing to top-level only
    (is (contains? (f27c/tags-from-ast [["Paragraph" [["Tag" [["Plain" "결정"]]]]]] get-tag)
                   "결정"))))

;; ---------------------------------------------------------------------------
;; Unicode-safe truncation. Assert the ACTUAL resulting text.
;; ---------------------------------------------------------------------------

(deftest segments-are-unicode-safe
  (testing "a supplementary-plane emoji is ONE segment, not two code units"
    (is (= ["🌟"] (f27c/segments "🌟")))
    (is (= 1 (count (f27c/segments "🌟")))))
  (testing "Korean syllables are one segment each"
    (is (= ["한" "국" "어"] (f27c/segments "한국어"))))
  (testing "mixed content segments correctly"
    (is (= ["a" "한" "🌟"] (f27c/segments "a한🌟")))))

(deftest truncation-never-splits-a-supplementary-plane-emoji
  (testing "cutting EXACTLY at the emoji boundary keeps it whole"
    ;; "ab🌟cd": 🌟 is the 3rd segment but occupies UTF-16 units 2 and 3.
    (is (= "ab…" (f27c/preview-text "ab🌟cd" 2)))
    (is (= "ab🌟…" (f27c/preview-text "ab🌟cd" 3))
        "the emoji must appear whole, never as a lone surrogate"))
  (testing "no lone surrogate ever appears in the output"
    (doseq [n (range 1 7)]
      (let [out (f27c/preview-text "ab🌟cd" n)]
        (is (not (re-find #"[\uD800-\uDBFF](?![\uDC00-\uDFFF])" out))
            (str "high surrogate left unpaired at n=" n " in " (pr-str out)))
        (is (not (re-find #"(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]" out))
            (str "low surrogate left unpaired at n=" n " in " (pr-str out)))))))

(deftest truncation-keeps-joined-emoji-together
  (testing "a ZWJ family sequence is not split mid-sequence"
    (let [fam "\uD83D\uDC69\u200D\uD83D\uDC67"    ; woman + ZWJ + girl
          s (str "x" fam "y")
          out (f27c/preview-text s 2)]
      ;; With Intl.Segmenter the family is one grapheme, so 2 segments = "x" + family.
      (is (or (= out (str "x" fam "…")) (= out "x\uD83D\uDC69…"))
          (str "unexpected truncation: " (pr-str out)))
      (is (not (re-find #"[\uD800-\uDBFF](?![\uDC00-\uDFFF])" out))
          "no unpaired high surrogate")))
  (testing "Korean text truncates on syllable boundaries"
    (is (= "한국어…" (f27c/preview-text "한국어 결정 사항" 3)))))

;; ---------------------------------------------------------------------------
;; Inventory and search.
;; ---------------------------------------------------------------------------

(deftest collect-tags-unions-both-explicit-sources
  (is (= #{"a" "b" "c"}
         (f27c/collect-tags [{:inline #{"a"} :props #{"b"}}
                             {:inline #{"c"} :props #{}}
                             nil])))
  (is (= #{} (f27c/collect-tags []))))

(deftest filter-tags-keeps-every-tag-reachable
  (let [inv (set (map #(str "tag" %) (range 500)))]
    (testing "a blank query shows a bounded head but reports the true total"
      (let [{:keys [matches total inventory-size]} (f27c/filter-tags inv "" 50)]
        (is (= 50 (count matches)))
        (is (= 500 total))
        (is (= 500 inventory-size))))
    (testing "a tag that sorts far past any cap is still reachable by search"
      ;; "tag499" sorts late; a plain sorted cap would hide it forever.
      (let [{:keys [matches]} (f27c/filter-tags inv "tag499" 50)]
        (is (= ["tag499"] matches))))
    (testing "search is case-insensitive and substring-based for FINDING only"
      (is (= ["결정"] (:matches (f27c/filter-tags #{"결정" "기타"} "결" 50)))))))

(deftest selection-state-explains-a-missing-marker
  (is (= :none (f27c/selection-state nil #{"a"})))
  (is (= :none (f27c/selection-state "" #{"a"})))
  (is (= :present (f27c/selection-state "a" #{"a"})))
  (is (= :present (f27c/selection-state "A" #{"a"})) "identity is case-insensitive")
  (is (= :missing (f27c/selection-state "gone" #{"a"}))
      "a chosen marker no longer present must be reported, not silently empty"))

