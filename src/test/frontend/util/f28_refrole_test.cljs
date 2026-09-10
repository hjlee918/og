(ns frontend.util.f28-refrole-test
  "Tests for the F28 reference-role labels' pure decisions.

  Nothing here renders and nothing reads a database. What is tested is the part
  that is new: where labels belong, and which of the two roles a row has — and,
  above all, the things the role must NOT be derived from."
  (:require [cljs.test :refer [deftest testing is]]
            [frontend.util.f28-refpath :as f28]
            [frontend.util.f28-refrole :as role]))

;; ---------------------------------------------------------------------------
;; Fixtures
;;
;; The shape is the child-context fixture's, named the same way, so a failure
;; here and a failure in the packaged run point at the same case.
;; ---------------------------------------------------------------------------

(def ^:private anchor-id 100)
(def ^:private alias-id 101)

;; The page's own identity set: `db/page-alias-set` returns the page and its
;; aliases, and this is the SAME set `references*` filters `top-level-blocks`
;; with.
(def ^:private page-ids #{anchor-id alias-id})

(def ^:private ok-surface
  {:role-list? true :page-known? true})

;; ---------------------------------------------------------------------------
;; Where labels belong
;; ---------------------------------------------------------------------------

(deftest labels-belong-on-a-page-linked-reference-list
  (is (nil? (role/excluded-surface ok-surface)))
  (is (true? (role/label-rows? ok-surface))))

(deftest a-list-that-did-not-opt-in-gets-nothing
  (testing "the opt-in is explicit; a config reaching the same component by
            another route is not enough"
    (is (= :not-role-list (role/excluded-surface (assoc ok-surface :role-list? false))))
    (is (false? (role/label-rows? (assoc ok-surface :role-list? false))))))

(deftest a-list-that-did-not-say-which-page-it-is-gets-nothing
  (testing "without the page's identity there is no predicate, and a guess
            would be worse than silence"
    (is (= :unknown-page (role/excluded-surface (assoc ok-surface :page-known? false))))
    (is (false? (role/label-rows? (assoc ok-surface :page-known? false))))))

(deftest every-shared-surface-rule-is-the-source-path-slices-own
  (testing "each excluded surface reports the SHARED reason, which proves the
            delegation rather than a copy that happens to agree today"
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
      (is (= reason (role/excluded-surface (assoc ok-surface flag true)))
          (str "surface " flag))
      (is (false? (role/label-rows? (assoc ok-surface flag true)))))))

(deftest the-right-sidebars-copy-of-the-list-is-untouched
  (testing "protected as it is (RP3); this feature adds nothing there"
    (is (= :sidebar (role/excluded-surface (assoc ok-surface :sidebar? true))))))

(deftest the-exclusion-reasons-are-the-shared-ones-plus-exactly-two
  (testing "adding a surface means REMOVING a reason, which is visible"
    (is (= [:not-role-list :unknown-page] role/own-exclusion-reasons))
    (is (= (into role/own-exclusion-reasons
                 (remove #{:no-elision :not-source-path-list} f28/exclusion-reasons))
           role/exclusion-reasons))
    (testing "and the two the source-path slice asks that this one replaces are
              gone rather than duplicated"
      (is (not (contains? (set role/exclusion-reasons) :no-elision)))
      (is (not (contains? (set role/exclusion-reasons) :not-source-path-list))))))

;; ---------------------------------------------------------------------------
;; The role itself
;; ---------------------------------------------------------------------------

(deftest a-block-that-names-the-page-is-a-direct-mention
  (is (true? (role/direct-mention? [anchor-id 7] page-ids)))
  (is (= :direct (role/row-role {:ref-ids [anchor-id 7] :page-ids page-ids}))))

(deftest a-block-that-names-an-alias-of-the-page-is-a-direct-mention
  (testing "the predicate is `page-alias-set` membership, which is what
            references* counts"
    (is (true? (role/direct-mention? [alias-id] page-ids)))
    (is (= :direct (role/row-role {:ref-ids [alias-id] :page-ids page-ids})))))

(deftest a-block-that-names-nothing-of-this-page-is-context
  (is (false? (role/direct-mention? [7 8] page-ids)))
  (is (= :context (role/row-role {:ref-ids [7 8] :page-ids page-ids}))))

(deftest a-block-with-no-refs-at-all-is-context
  (is (= :context (role/row-role {:ref-ids [] :page-ids page-ids})))
  (is (= :context (role/row-role {:ref-ids nil :page-ids page-ids}))))

(deftest a-nil-ref-id-is-not-a-match
  (testing "`build-refs-data-value` removes nils for the same reason: a missing
            id must not collide with a missing page id"
    (is (false? (role/direct-mention? [nil] page-ids)))
    (is (false? (role/direct-mention? [nil] #{nil})))))

(deftest without-the-pages-identity-the-role-is-unknown-rather-than-context
  (testing "'this is context' and 'nobody said which page this is' are
            different facts, and merging them would label every row wrongly"
    (is (nil? (role/direct-mention? [anchor-id] nil)))
    (is (nil? (role/direct-mention? [anchor-id] #{})))
    (is (nil? (role/row-role {:ref-ids [anchor-id] :page-ids nil})))
    (is (nil? (role/row-role {:ref-ids [anchor-id] :page-ids #{}})))
    (is (nil? (role/describe {:role (role/row-role {:ref-ids [anchor-id]
                                                    :page-ids nil})})))))

;; ---------------------------------------------------------------------------
;; What the role is NOT derived from — the point of the whole namespace
;; ---------------------------------------------------------------------------

(deftest a-child-that-also-mentions-the-page-is-never-labelled-context
  (testing "the fixture's `mixedRef`: a child of a mention that names the page
            itself. Drawn as a child, it is still a direct mention"
    (let [mixed-ref {:ref-ids [anchor-id] :page-ids page-ids}]
      (is (= :direct (role/row-role mixed-ref)))
      (is (not= :context (role/row-role mixed-ref)))
      (testing "and the sentence says it is drawn again, without the role
                changing"
        (is (= {:role :direct
                :text-key :f28/role-direct
                :why-key :f28/role-direct-again-why}
               (role/describe {:role (role/row-role mixed-ref) :nested? true})))))))

(deftest the-same-block-drawn-twice-gets-the-same-role-both-times
  (testing "§1 measured a block drawn once as its own result and once as
            context under its parent. The role is the BLOCK's, so the two
            appearances cannot disagree however they are drawn"
    (let [block {:ref-ids [anchor-id] :page-ids page-ids}]
      (is (= (role/row-role block) (role/row-role block)))
      (is (= :direct (role/row-role block)))
      (testing "the same holds for a context block drawn in two places"
        (let [ctx {:ref-ids [9] :page-ids page-ids}]
          (is (= :context (role/row-role ctx) (role/row-role ctx))))))))

(deftest depth-and-position-cannot-reach-the-role
  (testing "`row-role` takes no depth, level, parent or `:ref-query-child?`;
            extra keys are ignored rather than consulted"
    (doseq [extra [{} {:level 1} {:level 9} {:nested? true} {:nested? false}
                   {:ref-query-child? true} {:parent 1}]]
      (is (= :direct (role/row-role (merge {:ref-ids [anchor-id] :page-ids page-ids} extra)))
          (str "direct, with " extra))
      (is (= :context (role/row-role (merge {:ref-ids [9] :page-ids page-ids} extra)))
          (str "context, with " extra)))))

(deftest the-rows-text-cannot-reach-the-role
  (testing "content is not an input at all: a block whose text reads like the
            page name but refs nothing is context, and a block with no legible
            page name but a ref is a mention"
    (is (= :context (role/row-role {:ref-ids [] :page-ids page-ids
                                    :content "anchor page in a code fence"})))
    (is (= :direct (role/row-role {:ref-ids [anchor-id] :page-ids page-ids
                                   :content "no page name here at all"})))))

(deftest the-name-a-page-is-registered-under-cannot-reach-the-role
  (testing "the case the first packaged run failed on, at unit scale. The
            fixture names its anchor page `맥락 대상 Context Anchor`; OG
            registers it under `:block/name` \"맥락 대상 context anchor\" — the
            `page-name-sanity-lc` mandate — and `data-refs-self` carries that
            canonical form. A comparison against the display-case name
            disagreed with every mention row on case alone. None of it can
            reach the role, which reads ids, and a page is itself however its
            name is cased"
    (is (= :direct (role/row-role {:ref-ids [anchor-id] :page-ids page-ids}))))
  (testing "and a genuinely different page — the fixture's filter page, whose
            canonical name shares nothing with the anchor's — is context on
            THIS page's list, however many of its rows name it"
    (let [filter-page-id 300
          an-unrelated-page-id 301]
      (is (= :context (role/row-role {:ref-ids [filter-page-id]
                                      :page-ids page-ids})))
      (is (= :context (role/row-role {:ref-ids [filter-page-id
                                                an-unrelated-page-id]
                                      :page-ids page-ids})))
      (is (false? (role/direct-mention? [filter-page-id] page-ids))))))

;; ---------------------------------------------------------------------------
;; What the label says
;; ---------------------------------------------------------------------------

(deftest each-role-has-a-compact-word-and-a-sentence
  (is (= {:role :direct
          :text-key :f28/role-direct
          :why-key :f28/role-direct-why}
         (role/describe {:role :direct})))
  (is (= {:role :context
          :text-key :f28/role-context
          :why-key :f28/role-context-why}
         (role/describe {:role :context}))))

(deftest a-context-row-has-one-sentence-however-it-is-drawn
  (testing "a context row is nested by construction, so `nested?` changes
            nothing for it"
    (is (= (role/describe {:role :context})
           (role/describe {:role :context :nested? true})))))

(deftest there-are-exactly-two-roles
  (is (= [:direct :context] role/roles))
  (is (every? some? (map #(role/describe {:role %}) role/roles)))
  (is (nil? (role/describe {:role :something-else}))))
