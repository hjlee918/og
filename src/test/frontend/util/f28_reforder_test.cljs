(ns frontend.util.f28-reforder-test
  "Tests for the F28 source-page group ordering's pure decisions.

  Nothing here renders and nothing reads a database. What is tested is the part
  that is new: where the control belongs, what a title compares as, and what
  happens to groups that compare equal — including the cases the packaged run
  cannot construct, because OG's own page identity forbids two source pages
  from carrying the same title."
  (:require [cljs.test :refer [deftest testing is]]
            [frontend.util.f28-refpath :as f28]
            [frontend.util.f28-reforder :as ord]))

(def ^:private ok-surface {:order-list? true})

;; ---------------------------------------------------------------------------
;; The three orders
;; ---------------------------------------------------------------------------

(deftest there-are-exactly-three-orders-and-og-s-own-is-the-default
  (is (= [:original :title-asc :title-desc] ord/modes))
  (is (= :original ord/default-mode))
  (is (= :original (first ord/modes))))

(deftest an-unknown-order-falls-back-to-og-s-own-rather-than-to-a-guess
  (doseq [bad [nil :title :ascending "title-asc" 3 :desc]]
    (is (= :original (ord/normalize-mode bad))
        (str "normalize-mode of " (pr-str bad)))))

(deftest an-order-travels-through-the-dom-as-its-own-name
  (is (= "original" (ord/mode-value :original)))
  (is (= "title-asc" (ord/mode-value :title-asc)))
  (is (= "title-desc" (ord/mode-value :title-desc)))
  (testing "and comes back as the same order"
    (doseq [m ord/modes]
      (is (= m (ord/value->mode (ord/mode-value m))))))
  (testing "a value naming no order is OG's own order, never an error"
    (is (= :original (ord/value->mode "sideways")))
    (is (= :original (ord/value->mode nil)))))

(deftest every-order-has-its-own-words-and-none-are-written-here
  (doseq [m ord/modes]
    (is (keyword? (ord/label-key m)))
    (is (= "f28" (namespace (ord/label-key m)))))
  (is (= 3 (count (set (map ord/label-key ord/modes))))))

;; ---------------------------------------------------------------------------
;; Where the control belongs
;; ---------------------------------------------------------------------------

(deftest the-control-belongs-on-a-page-linked-reference-list
  (is (nil? (ord/excluded-surface ok-surface)))
  (is (true? (ord/offer-control? ok-surface))))

(deftest a-list-that-did-not-opt-in-gets-nothing
  (testing "the opt-in is explicit; a config reaching the same component by
            another route is not enough"
    (is (= :not-order-list (ord/excluded-surface (assoc ok-surface :order-list? false))))
    (is (false? (ord/offer-control? (assoc ok-surface :order-list? false))))))

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
      (is (= reason (ord/excluded-surface (assoc ok-surface flag true)))
          (str flag " must be excluded as " reason))
      (is (false? (ord/offer-control? (assoc ok-surface flag true)))))))

(deftest the-right-sidebars-copy-of-the-list-is-untouched
  (is (= :sidebar (ord/excluded-surface (assoc ok-surface :sidebar? true)))))

(deftest the-exclusion-reasons-are-the-shared-ones-plus-exactly-one
  (testing "the set is data so that widening it is a visible change"
    (is (= [:not-order-list] ord/own-exclusion-reasons))
    (is (= (into [:not-order-list]
                 (remove #{:no-elision :not-source-path-list} f28/exclusion-reasons))
           ord/exclusion-reasons))
    (testing "and the elision rule is answered here, never asked of the caller"
      (is (not (some #{:no-elision} ord/exclusion-reasons)))
      (is (nil? (ord/excluded-surface (assoc ok-surface :elided? false)))))))

;; ---------------------------------------------------------------------------
;; What a title compares as
;; ---------------------------------------------------------------------------

(deftest the-key-is-nfc-then-lower-case
  (is (= "banana source" (ord/sort-key "Banana Source")))
  (is (= "apple source" (ord/sort-key "apple source")))
  (testing "a decomposed Hangul title keys as the composed one"
    (is (= (ord/sort-key "하 출처") (ord/sort-key (.normalize "하 출처" "NFD")))))
  (testing "a missing title is empty rather than an error"
    (is (= "" (ord/sort-key nil)))
    (is (= "" (ord/sort-key "")))))

(deftest case-alone-does-not-decide-the-order
  (testing "without lower-casing, Banana (U+0042) and Zebra (U+005A) would both
            sort before apple (U+0061)"
    (is (neg? (ord/compare-titles "apple source" "Banana Source")))
    (is (neg? (ord/compare-titles "Banana Source" "Zebra Source")))
    (is (pos? (ord/compare-titles "Zebra Source" "apple source")))))

(deftest korean-titles-are-in-ga-na-da-order-and-follow-latin
  (is (neg? (ord/compare-titles "가 출처" "나 출처")))
  (is (neg? (ord/compare-titles "나 출처" "다 출처")))
  (is (neg? (ord/compare-titles "다 출처" "하 출처")))
  (testing "Latin before Hangul, because that is code-point order"
    (is (neg? (ord/compare-titles "zebra source" "가 출처")))))

(deftest a-decomposed-title-sorts-where-its-composed-form-does
  (testing "this is the whole reason NFC is in the key: decomposed Hangul is
            U+1112 U+1161 …, which without it sorts BEFORE a composed 가"
    (let [ha-nfd (.normalize "하 출처 Ha Source" "NFD")]
      (is (pos? (ord/compare-titles ha-nfd "가 출처 Ga Source")))
      (is (pos? (ord/compare-titles ha-nfd "다 출처 Da Source")))
      (is (neg? (ord/compare-titles "zebra source" ha-nfd))))))

(deftest comparison-is-by-code-point-not-by-utf-16-code-unit
  (testing "an emoji is astral, so its first code UNIT is U+D83D — which would
            place it before a BMP character above U+DFFF if units decided"
    (let [emoji "🍎"      ; U+1F34E
          bmp "豈"]   ; U+F900, a BMP character above the surrogate range
      (is (neg? (ord/compare-titles bmp emoji)))
      (is (pos? (ord/compare-titles emoji bmp)))))
  (testing "and one code point is one position, so a prefix is smaller"
    (is (neg? (ord/compare-titles "🍎" "🍎🍌")))
    (is (= 1 (count (ord/code-points "🍎"))))
    (is (= 2 (count (ord/code-points "🍎🍌"))))))

(deftest a-title-that-is-a-prefix-of-another-sorts-first
  (is (neg? (ord/compare-titles "source" "source page")))
  (is (pos? (ord/compare-titles "source page" "source")))
  (is (zero? (ord/compare-titles "source" "source"))))

;; ---------------------------------------------------------------------------
;; Ties — the cases the packaged run cannot construct
;;
;; Two DISTINCT source pages cannot tie, because `sort-key` is OG's own
;; `page-name-sanity-lc` minus `remove-boundary-slashes` and that IS
;; `:block/name`, which is unique per page. The rule is defined anyway, and it
;; is defined HERE, where a tie can be handed to it.
;; ---------------------------------------------------------------------------

(deftest identical-titles-compare-equal
  (is (zero? (ord/compare-titles "같은 이름 Same Name" "같은 이름 Same Name"))))

(deftest a-case-only-difference-compares-equal
  (is (zero? (ord/compare-titles "Same Name" "same name"))))

(deftest a-normalization-only-difference-compares-equal
  (is (zero? (ord/compare-titles "하 출처" (.normalize "하 출처" "NFD")))))

(deftest tied-groups-keep-ogs-own-order-in-both-directions
  (testing "descending negates the comparison, and 0 negates to 0, so a tie is
            NOT mirrored: the reader asked for a different title order, not for
            OG's order to be turned upside down underneath it"
    (let [entries [{:id :first :title "Tie"}
                   {:id :second :title "tie"}
                   {:id :third :title (.normalize "티" "NFD")}
                   {:id :fourth :title "티"}]
          f :title]
      (is (= [:first :second :third :fourth]
             (map :id (ord/order-groups entries :title-asc f))))
      (testing "the Latin tie still sorts before the Hangul tie, and each pair
                keeps its own arrival order"
        (is (= [:third :fourth :first :second]
               (map :id (ord/order-groups entries :title-desc f))))))))

;; ---------------------------------------------------------------------------
;; Ordering the groups
;; ---------------------------------------------------------------------------

(def ^:private groups
  "Entries shaped like `->hiccup`'s `[page blocks]` pairs, in an order chosen to
  be neither ascending nor descending."
  [[{:title "Zebra Source"} :z]
   [{:title "가 출처 Ga Source"} :ga]
   [{:title "apple source"} :apple]
   [{:title "하 출처 Ha Source"} :ha]
   [{:title "Banana Source"} :banana]])

(def ^:private title-fn (comp :title first))

(deftest the-original-order-is-ogs-own-sequence-itself
  (testing "not a re-sort that happens to agree with it — that is what makes
            switching back unable to drift"
    (is (identical? groups (ord/order-groups groups :original title-fn)))
    (is (identical? groups (ord/order-groups groups nil title-fn)))
    (is (identical? groups (ord/order-groups groups :nonsense title-fn)))))

(deftest ascending-is-title-order
  (is (= [:apple :banana :z :ga :ha]
         (map second (ord/order-groups groups :title-asc title-fn)))))

(deftest descending-is-the-negated-comparison
  (is (= [:ha :ga :z :banana :apple]
         (map second (ord/order-groups groups :title-desc title-fn)))))

(deftest ordering-never-adds-removes-or-duplicates-a-group
  (doseq [m ord/modes]
    (let [out (ord/order-groups groups m title-fn)]
      (is (= (count groups) (count out)) (str m " must keep every group"))
      (is (= (set (map second groups)) (set (map second out)))
          (str m " must keep exactly the same groups")))))

(deftest ordering-is-idempotent
  (testing "asking for the same order twice gives the same answer"
    (doseq [m ord/modes]
      (let [once (ord/order-groups groups m title-fn)
            twice (ord/order-groups once m title-fn)]
        (is (= (map second once) (map second twice))
            (str m " must be idempotent"))))))

(deftest switching-back-restores-ogs-order-because-the-caller-re-derives
  (testing "`order-groups` is a function OF the sequence it is handed, and
            `:original` hands that sequence back — it is NOT an undo of a
            previous sort. What makes switching back RESTORE OG's order is that
            the caller re-derives from OG's own sequence on every render:
            `->hiccup` computes `(sort-by (comp :block/journal-day first) >)`
            afresh and passes THAT in each time. This states the property the
            way the caller actually uses it, because the first version of this
            test asserted the other thing and was wrong."
    (doseq [visited [:title-asc :title-desc :title-asc :original :title-desc]]
      (ord/order-groups groups visited title-fn))
    (is (identical? groups (ord/order-groups groups :original title-fn)))
    (is (= (map second groups)
           (map second (ord/order-groups groups :original title-fn))))))

(deftest a-group-with-no-title-sorts-first-ascending-rather-than-vanishing
  (let [with-nil (conj (vec groups) [{:title nil} :untitled])]
    (is (= :untitled (second (first (ord/order-groups with-nil :title-asc title-fn)))))
    (is (= :untitled (second (last (ord/order-groups with-nil :title-desc title-fn)))))
    (is (= (count with-nil) (count (ord/order-groups with-nil :title-asc title-fn))))))

(deftest ordering-reads-the-title-and-nothing-else
  (testing "the entries are opaque to the rule: only `title-fn` sees inside
            them, so nothing about a group's position, size or contents can
            reach the order"
    (let [a [{:title "b"} {:rows 99 :collapsed true}]
          b [{:title "a"} {:rows 1 :collapsed false}]]
      (is (= [b a] (ord/order-groups [a b] :title-asc title-fn)))
      (is (= [a b] (ord/order-groups [a b] :title-desc title-fn))))))
