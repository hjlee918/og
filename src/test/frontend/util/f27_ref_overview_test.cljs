(ns frontend.util.f27-ref-overview-test
  "F27 slice 1 — focused tests for the pure incoming-reference overview helpers.

  These cover only the behaviour this slice changes. They exercise no database,
  no rendering and no graph."
  (:require [cljs.test :refer [deftest testing is]]
            [frontend.util.f27-ref-overview :as f27]))

(defn- ref-block [uuid] {:block/uuid uuid})

(deftest dedupe-refs-preserves-incoming-order
  (testing "duplicates collapse to their first appearance, order preserved"
    (let [refs [(ref-block "a") (ref-block "b") (ref-block "a") (ref-block "c")]]
      (is (= ["a" "b" "c"] (map :block/uuid (f27/dedupe-refs refs))))))

  (testing "nils are removed rather than rendered"
    (is (= ["a"] (map :block/uuid (f27/dedupe-refs [nil (ref-block "a") nil])))))

  (testing "an empty or nil collection is safe"
    (is (= [] (f27/dedupe-refs [])))
    (is (= [] (f27/dedupe-refs nil))))

  (testing "a referencing block with no uuid is kept, not silently dropped"
    (is (= 2 (count (f27/dedupe-refs [(ref-block "a") {:block/content "no uuid"}]))))))

(deftest split-rows-reports-what-is-withheld
  (testing "a short list is shown in full with nothing hidden"
    (let [refs (mapv ref-block ["a" "b" "c"])]
      (is (= {:shown refs :hidden 0 :total 3} (f27/split-rows refs)))))

  (testing "a long list is capped and the remainder is reported exactly"
    (let [refs (mapv (comp ref-block str) (range 25))
          {:keys [shown hidden total]} (f27/split-rows refs)]
      (is (= f27/max-rows (count shown)))
      (is (= (- 25 f27/max-rows) hidden))
      (is (= 25 total))
      (is (= (+ (count shown) hidden) total)
          "every reference is either shown or counted as hidden — none vanish")))

  (testing "exactly at the cap nothing is hidden"
    (let [refs (mapv (comp ref-block str) (range f27/max-rows))]
      (is (= 0 (:hidden (f27/split-rows refs))))))

  (testing "an explicit limit is honoured"
    (let [refs (mapv (comp ref-block str) (range 5))]
      (is (= 2 (count (:shown (f27/split-rows refs 2)))))
      (is (= 3 (:hidden (f27/split-rows refs 2))))))

  (testing "an empty list produces no rows and no remainder"
    (is (= {:shown [] :hidden 0 :total 0} (f27/split-rows [])))))

(deftest row-key-is-stable-and-nil-safe
  (testing "uuid drives the key"
    (is (= "f27-ref-abc" (f27/row-key (ref-block "abc") 0))))
  (testing "a missing uuid degrades to an ordinal key instead of colliding on nil"
    (is (= "f27-ref-idx-3" (f27/row-key {} 3)))
    (is (not= (f27/row-key {} 0) (f27/row-key {} 1)))))

(deftest ref-id-extracts-db-id-from-reverse-reference-stubs
  (testing "reverse-reference stubs arrive as {:db/id N}, not realised entities"
    (is (= 42 (f27/ref-id {:db/id 42}))))
  (testing "a bare integer id is accepted"
    (is (= 7 (f27/ref-id 7))))
  (testing "no id is nil rather than an error"
    (is (nil? (f27/ref-id {})))
    (is (nil? (f27/ref-id nil)))))

(deftest renderable-guards-missing-identity
  (is (true? (f27/renderable? (ref-block "a"))))
  (is (false? (f27/renderable? {})))
  (is (false? (f27/renderable? nil))))

(deftest truncate-middle-handles-long-and-unicode-labels
  (testing "short labels are untouched"
    (is (= "short" (f27/truncate-middle "short" 20))))
  (testing "long labels keep both ends"
    (let [out (f27/truncate-middle "abcdefghijklmnopqrstuvwxyz" 11)]
      (is (<= (count out) 11))
      (is (re-find #"^abcde" out))
      (is (re-find #"vwxyz$" out))))
  (testing "Korean and emoji labels are handled without throwing"
    (is (string? (f27/truncate-middle "한국어 페이지 이름이 아주 길어지는 경우 🌟" 11)))
    (is (= "한국어" (f27/truncate-middle "한국어" 20))))
  (testing "non-string and nil input is safe"
    (is (nil? (f27/truncate-middle nil 10)))
    (is (= 42 (f27/truncate-middle 42 10)))))

(deftest blank-label-detection
  (is (true? (f27/blank-label? nil)))
  (is (true? (f27/blank-label? "")))
  (is (true? (f27/blank-label? "   ")))
  (is (false? (f27/blank-label? "페이지"))))

;; ---------------------------------------------------------------------------
;; Integrated row preparation.
;;
;; These exercise resolution AND rendering preparation together, which a test of
;; ref-id alone cannot cover: an unresolvable database-id stub and a resolved
;; entity carrying no :block/uuid must be COUNTED as unavailable, never silently
;; dropped and never reported as displayed.
;; ---------------------------------------------------------------------------

(defn- resolver
  "Fake database resolver: id -> entity, nil when the id resolves to nothing."
  [m]
  (fn [id] (get m id)))

(deftest prepare-rows-accounts-for-unresolvable-stubs
  (testing "a stub whose id resolves to nothing is counted unavailable, not dropped"
    (let [raw [{:db/id 1} {:db/id 2}]
          r   (f27/prepare-rows raw (resolver {1 {:block/uuid "a"}}) 10)]
      (is (= 2 (:total r)))
      (is (= 1 (:displayed r)))
      (is (= 1 (:unavailable r)))
      (is (= 0 (:capped r)))
      (is (true? (f27/accounting-balances? r))
          "total must equal displayed + capped + duplicates + unavailable"))))

(deftest prepare-rows-accounts-for-resolved-entity-without-uuid
  (testing "an entity that resolves but carries no :block/uuid renders nothing and is counted unavailable"
    (let [raw [{:db/id 1} {:db/id 2}]
          r   (f27/prepare-rows raw (resolver {1 {:block/uuid "a"}
                                               2 {:block/content "resolved but no uuid"}}) 10)]
      (is (= 2 (:total r)))
      (is (= 1 (:displayed r)))
      (is (= 1 (:unavailable r)))
      (is (every? f27/renderable? (:rows r))
          "no invisible row may appear in :rows")
      (is (true? (f27/accounting-balances? r))))))

(deftest prepare-rows-separates-capped-from-unavailable
  (testing "capping and unavailability are different categories and both are reported"
    (let [ok  (into {} (map (fn [i] [i {:block/uuid (str "u" i)}]) (range 1 16)))
          raw (concat (map (fn [i] {:db/id i}) (range 1 16))
                      [{:db/id 999} {:db/id 998}])
          r   (f27/prepare-rows raw (resolver ok) 10)]
      (is (= 17 (:total r)))
      (is (= 10 (:displayed r)))
      (is (= 5 (:capped r)) "15 renderable, 10 shown, 5 capped")
      (is (= 2 (:unavailable r)) "two ids resolve to nothing")
      (is (true? (f27/accounting-balances? r))))))

(deftest prepare-rows-counts-repeat-references-separately
  (testing "a repeat reference from an already listed block is its own category"
    (let [raw [{:db/id 1} {:db/id 1} {:db/id 2}]
          r   (f27/prepare-rows raw (resolver {1 {:block/uuid "a"} 2 {:block/uuid "b"}}) 10)]
      (is (= 3 (:total r)))
      (is (= 2 (:displayed r)))
      (is (= 1 (:duplicates r)))
      (is (= 0 (:unavailable r)))
      (is (true? (f27/accounting-balances? r))))))

(deftest prepare-rows-handles-already-realised-entities
  (testing "entries that already carry a uuid need no resolution"
    (let [raw [{:block/uuid "a"} {:block/uuid "b"}]
          r   (f27/prepare-rows raw (resolver {}) 10)]
      (is (= 2 (:displayed r)))
      (is (= 0 (:unavailable r)))
      (is (true? (f27/accounting-balances? r))))))

(deftest prepare-rows-degenerate-inputs
  (testing "empty, nil and all-unavailable inputs stay balanced"
    (is (true? (f27/accounting-balances? (f27/prepare-rows [] (resolver {}) 10))))
    (is (true? (f27/accounting-balances? (f27/prepare-rows nil (resolver {}) 10))))
    (let [r (f27/prepare-rows [{:db/id 1} {:db/id 2}] (resolver {}) 10)]
      (is (= 0 (:displayed r)))
      (is (= 2 (:unavailable r)))
      (is (true? (f27/accounting-balances? r)))))
  (testing "a nil resolver does not throw; everything is simply unavailable"
    (let [r (f27/prepare-rows [{:db/id 1}] nil 10)]
      (is (= 1 (:unavailable r)))
      (is (true? (f27/accounting-balances? r))))))

(deftest prepare-rows-never-reports-an-invisible-row-as-displayed
  (testing ":displayed always equals the number of rows that can actually render"
    (let [raw [{:db/id 1} {:db/id 2} {:db/id 3} nil]
          r   (f27/prepare-rows raw (resolver {1 {:block/uuid "a"} 3 {}}) 10)]
      (is (= (:displayed r) (count (filter f27/renderable? (:rows r)))))
      (is (= 1 (:displayed r)))
      (is (= 2 (:unavailable r)) "id 2 unresolvable, id 3 resolved without uuid"))))

