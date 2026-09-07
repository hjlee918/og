(ns frontend.db.f27-page-test
  "F27 page-embed slice — the BOUNDED read, against a real parsed graph.

  Two jobs:

  1. that a page embed's argument resolves the way OG resolves it, for the names
     this project actually has to handle — multiword, Korean, a name containing
     a comma, a namespaced name — using the REAL parser rather than an assumed
     tokenisation;
  2. that the excerpt's cost is what the contract says it is, MEASURED, by
     counting the index slices and the datoms actually realised while an excerpt
     is filled from a 12,401-block page.

  The second is the reason this file exists. The design review's first draft
  claimed a reverse-reference lookup was one index seek and the excerpt cost 42
  of them regardless of the data. Both were wrong, and a number nobody counts is
  not evidence."
  (:require [cljs.test :refer [deftest is testing use-fixtures]]
            [clojure.string :as string]
            [datascript.core :as d]
            [frontend.db.conn :as conn]
            [frontend.db.f27-page :as f27p]
            [frontend.db.model :as model]
            [frontend.db.utils :as db-utils]
            [frontend.test.helper :as test-helper :refer [load-test-files]]
            [frontend.util.f27-inert :as f27i]
            [frontend.util.f27-page-embed :as f27pe]
            [logseq.graph-parser.mldoc :as gp-mldoc]))

(use-fixtures :each {:before test-helper/start-test-db!
                     :after test-helper/destroy-test-db!})

(def ^:private repo test-helper/test-db)

(defn- macro-target-of
  "What `{{embed …}}` REALLY parses to, through OG's own inline parser."
  [s]
  (let [node (first (gp-mldoc/inline->edn s (gp-mldoc/default-config :markdown)))
        {:keys [name arguments]} (second node)]
    (f27i/macro-target name arguments)))

(defn- contents [ex]
  (mapv #(some-> (:block %) :block/content string/trim) (:blocks ex)))

;; ---------------------------------------------------------------------------
;; 1. What the parser actually hands us
;; ---------------------------------------------------------------------------

(deftest page-arguments-resolve-through-the-real-parser
  (testing "a multiword name arrives whole, not split on its spaces"
    (is (= {:kind :page :value "Deep Work"} (macro-target-of "{{embed [[Deep Work]]}}"))))

  (testing "a Korean name arrives whole"
    (is (= {:kind :page :value "집중 노트"} (macro-target-of "{{embed [[집중 노트]]}}"))))

  (testing "a name containing a comma is ONE argument, not two"
    ;; Macro arguments look comma-separated, so this is the case a hand-rolled
    ;; split would get wrong. mldoc does not split inside `[[…]]`.
    (is (= {:kind :page :value "A, B"} (macro-target-of "{{embed [[A, B]]}}"))))

  (testing "a namespaced name keeps its slashes"
    (is (= {:kind :page :value "a/b/c"} (macro-target-of "{{embed [[a/b/c]]}}"))))

  (testing "a blank argument names no page"
    (is (= "" (:value (macro-target-of "{{embed [[]]}}"))))
    (is (nil? (f27pe/page-key (:value (macro-target-of "{{embed [[]]}}"))))))

  (testing "and a block argument is still a block, untouched by this slice"
    (is (= :block (:kind (macro-target-of
                          "{{embed ((7f273000-0000-4000-8000-000000000001))}}"))))))

;; ---------------------------------------------------------------------------
;; 2. Resolution: missing, uncreated, empty, present
;; ---------------------------------------------------------------------------

(deftest page-lookup-separates-the-states-that-must-not-be-confused
  (load-test-files
   [{:file/path "pages/deep work.md" :file/content "- focus is a practice\n"}
    {:file/path "pages/집중 노트.md" :file/content "- 한국어 최상위 블록\n"}
    {:file/path "pages/linker.md"
     :file/content "- see [[Ghost Page]] and {{embed [[Macro Ghost]]}}\n"}
    {:file/path "pages/bare.md" :file/content "-\n"}
    {:file/path "pages/props.md" :file/content "type:: note\n"}])

  (testing "a page written as a file is there to be read"
    (let [l (f27p/page-lookup repo "Deep Work")]
      (is (true? (:entity? l)))
      (is (true? (:file? l)))))

  (testing "a multiword and a Korean name resolve through OG's own sanitiser"
    (is (true? (:file? (f27p/page-lookup repo "deep WORK"))))
    (is (true? (:file? (f27p/page-lookup repo "집중 노트")))))

  (testing "a name that is only LINKED is an entity and is not a page"
    ;; This is the trap `some?` falls into, and the reason `:file?` exists.
    (let [l (f27p/page-lookup repo "Ghost Page")]
      (is (true? (:entity? l)) "the parser records the reference")
      (is (false? (:file? l)) "and that is not a page anyone has written")))

  (testing "an EMBED's own argument creates the entity too — so it can never be the test"
    (let [l (f27p/page-lookup repo "Macro Ghost")]
      (is (true? (:entity? l)))
      (is (false? (:file? l)))))

  (testing "a name nothing in the graph mentions is not there at all"
    (is (false? (:entity? (f27p/page-lookup repo "nobody has ever written this")))))

  (testing "a blank name is looked up as nothing"
    (is (false? (:entity? (f27p/page-lookup repo ""))))
    (is (false? (:entity? (f27p/page-lookup repo nil)))))

  (testing "a page whose only block is empty is EMPTY, not missing and not broken"
    (let [ex (f27p/excerpt repo "bare" 5)]
      (is (= :ok (:state ex)))
      (is (= [] (:blocks ex)))
      (is (= :end (:stopped (:walk ex))))
      (is (not (f27pe/walk-failed? (:walk ex))))))

  (testing "a page that carries only properties is empty too, its pre-block skipped"
    (let [ex (f27p/excerpt repo "props" 5)]
      (is (= :ok (:state ex)))
      (is (= [] (:blocks ex)))
      (is (= :end (:stopped (:walk ex))))))

  (testing "the excerpt reports the lookup's own state without reading an outline"
    (is (= :uncreated (:state (f27p/excerpt repo "Ghost Page" 5))))
    (is (= :missing (:state (f27p/excerpt repo "nobody has ever written this" 5))))))

(deftest no-page-is-created-by-previewing-one
  (load-test-files [{:file/path "pages/linker.md"
                     :file/content "- {{embed [[Never Written]]}}\n"}])
  (let [before (count (d/datoms (conn/get-db repo) :aevt :block/name))]
    (dotimes [_ 5]
      (f27p/page-lookup repo "Never Written")
      (f27p/excerpt repo "Never Written" 20)
      (f27p/excerpt repo "Also Never Mentioned" 20))
    (is (= before (count (d/datoms (conn/get-db repo) :aevt :block/name)))
        "reading a page embed adds no page to the graph")
    (is (false? (:file? (f27p/page-lookup repo "Never Written"))))))

;; ---------------------------------------------------------------------------
;; 3. Order, pagination and children
;; ---------------------------------------------------------------------------

(deftest top-level-blocks-come-back-in-outline-order
  (load-test-files
   [{:file/path "pages/ordered.md"
     :file/content (str "type:: note\n"
                        "- first\n"
                        "\t- a child of first\n"
                        "\t\t- a grandchild that must never be read\n"
                        "- 두 번째\n"
                        "- third\n"
                        "\t- a child of third\n"
                        "- fourth\n"
                        "- fifth\n"
                        "- sixth\n")}])

  (testing "in the order the file has them, the properties block skipped"
    (let [ex (f27p/excerpt repo "ordered" 5)]
      (is (= :ok (:state ex)))
      (is (= ["first" "두 번째" "third" "fourth" "fifth"] (contents ex)))
      (is (true? (:more? ex)) "a sixth exists and the excerpt says so")))

  (testing "children are reported as existing and are never among the blocks"
    (let [ex (f27p/excerpt repo "ordered" 5)]
      (is (= [true false true false false] (mapv :children? (:blocks ex))))
      (is (not-any? #(string/includes? (or % "") "child") (contents ex)))
      (is (not-any? #(string/includes? (or % "") "grandchild") (contents ex)))))

  (testing "asking for more retains more, in the same order"
    (let [ex (f27p/excerpt repo "ordered" 10)]
      (is (= ["first" "두 번째" "third" "fourth" "fifth" "sixth"] (contents ex)))
      (is (false? (:more? ex)) "nothing follows the sixth")
      (is (= :end (:stopped (:walk ex))))))

  (testing "a page shorter than one request is complete, not 'more follows'"
    (is (false? (:more? (f27p/excerpt repo "ordered" 20))))))

(deftest the-retention-cap-holds-and-nothing-past-it-is-read
  (load-test-files
   [{:file/path "pages/many.md"
     :file/content (string/join (for [i (range 60)] (str "- top " i "\n")))}])
  (let [ex (f27p/excerpt repo "many" f27pe/max-page-blocks)]
    (is (= f27pe/max-page-blocks (count (:blocks ex))))
    (is (true? (:more? ex)))
    (is (= "top 0" (first (contents ex))))
    (is (= "top 19" (last (contents ex))))
    (is (= (inc f27pe/max-page-blocks) (:steps (:walk ex)))
        "twenty blocks and one lookahead; the other forty are never stepped on"))

  (testing "a caller that asks past the cap still gets the cap"
    (is (= f27pe/max-page-blocks (count (:blocks (f27p/excerpt repo "many" 999)))))))


;; ---------------------------------------------------------------------------
;; 4. What it actually costs — MEASURED
;; ---------------------------------------------------------------------------

(def ^:private big-tops 400)
(def ^:private big-kids 30)

(defn- page-of
  "A page of `tops` top-level blocks, each with `kids` children."
  [tops kids]
  (string/join
   (for [i (range tops)]
     (str "- 최상위 " i "\n"
          (string/join (for [j (range kids)]
                         (str "\t- child " i "-" j "\n")))))))

(defn- counting-seq
  "`s`, one element at a time, counting each element as the CALLER takes it.

  `lazy-seq`/`cons` is deliberately unchunked. `map` over an index slice is
  not: taking its first element realises a whole chunk, so a `map`-based
  counter reports the chunk, not the consumption. That is why `:datoms` below
  varies between runs while the work does not — see
  `asking-whether-children-exist-builds-nothing`."
  [counter s]
  (lazy-seq
   (when-let [c (seq s)]
     (vswap! counter inc)
     (cons (first c) (counting-seq counter (rest c))))))

(defn- measured
  "Run `f` counting `d/datoms` calls and two different things about the datoms.

  `:slices`   how many index scans were started — deterministic.
  `:consumed` how many datoms the CALLER actually took — deterministic, and the
              number that answers \"did this walk the children?\".
  `:datoms`   how many the underlying chunked seq realised on the way. This is
              an implementation artifact of datascript's index chunking: a
              caller that takes one datom can realise 1, 4, 8 or 16 of them
              depending on where the datom sits in its index node. Reported
              because it is informative, NEVER asserted as a fixed bound."
  [f]
  (let [slices (volatile! 0)
        realized (volatile! 0)
        consumed (volatile! 0)
        orig d/datoms]
    (with-redefs [d/datoms (fn [& args]
                             (vswap! slices inc)
                             (counting-seq consumed
                                           (map (fn [x] (vswap! realized inc) x) (apply orig args))))]
      (let [v (f)]
        {:value v :slices @slices :datoms @realized :consumed @consumed}))))

(deftest the-page-is-big-enough-for-the-measurement-to-mean-something
  (load-test-files [{:file/path "pages/big.md" :file/content (page-of big-tops big-kids)}])
  (let [page (db-utils/entity repo [:block/name "big"])]
    (is (= 12400 (model/get-page-blocks-count repo (:db/id page))))))

(deftest a-five-block-excerpt-does-not-read-the-page
  (load-test-files [{:file/path "pages/big.md" :file/content (page-of big-tops big-kids)}])
  (let [page (db-utils/entity repo [:block/name "big"])
        m (measured #(f27p/top-level-excerpt repo page f27pe/blocks-per-request))
        ex (:value m)]
    (println "F27-COST five-block excerpt of a 12,400-block page:"
             (pr-str {:slices (:slices m) :datoms (:datoms m)
                      :steps (:steps (:walk ex))}))
    (is (= 5 (count (:blocks ex))))
    (is (true? (:more? ex)))
    (is (= ["최상위 0" "최상위 1" "최상위 2" "최상위 3" "최상위 4"] (contents ex)))

    (testing "the walk is six steps: five blocks and one lookahead"
      (is (= 6 (:steps (:walk ex))))
      (is (= 6 (:visited (:walk ex)))))

    ;; Six sibling steps plus five child questions. Exact, so that a change that
    ;; starts reading more fails here rather than drifting unnoticed.
    (testing "eleven index scans"
      (is (= 11 (:slices m))))

    ;; The datom count is NOT asserted as an equality. Each scan is a slice of a
    ;; sorted set, and how much of the underlying node a lazy consumer touches
    ;; shifts with the size of the index itself. What is invariant, and what
    ;; matters, is that it stays a small constant while the page does not.
    (testing "and the datoms realised are a rounding error against the page"
      (is (< (:datoms m) 100)
          (str "measured " (:datoms m) " datoms realised for a 12,400-block page"))
      (is (< (:datoms m) (/ 12400 100)))
      (is (< (/ (:datoms m) (:slices m)) 10)
          "no single scan ran away"))))

(deftest the-cost-does-not-grow-with-the-page
  ;; The claim is specifically that cost is independent of the page's LENGTH.
  ;; Both pages have identically shaped top-level blocks — 30 children each —
  ;; and differ only in how many of them there are: 8 against 400.
  (load-test-files [{:file/path "pages/short.md" :file/content (page-of 8 big-kids)}
                    {:file/path "pages/big.md" :file/content (page-of big-tops big-kids)}])
  (let [short (db-utils/entity repo [:block/name "short"])
        big (db-utils/entity repo [:block/name "big"])
        ms (measured #(f27p/top-level-excerpt repo short f27pe/blocks-per-request))
        mb (measured #(f27p/top-level-excerpt repo big f27pe/blocks-per-request))]
    (is (= 5 (count (:blocks (:value ms)))))
    (is (= 5 (count (:blocks (:value mb)))))
    (println "F27-COST same excerpt, 248-block page vs 12,400-block page:"
             (pr-str {:short {:slices (:slices ms) :datoms (:datoms ms)}
                      :big {:slices (:slices mb) :datoms (:datoms mb)}}))
    (is (= 11 (:slices ms) (:slices mb))
        "the same number of index scans on a 248-block page and a 12,400-block one")
    ;; Fifty times the page, and the reading stays the same small constant. The
    ;; two counts are not identical — a bigger index means a lazy consumer
    ;; touches a little more of the node it lands in — and that difference is
    ;; bounded, which is the honest form of this claim.
    (is (and (< (:datoms ms) 100) (< (:datoms mb) 100))
        (str "datoms realised: " (:datoms ms) " on 248 blocks, "
             (:datoms mb) " on 12,400"))
    (is (< (- (:datoms mb) (:datoms ms)) 50)
        "and the difference is a constant, not a proportion of the page")))

(deftest the-cost-follows-the-outline-shape-not-the-page-size
  ;; Stated honestly rather than hidden: what the excerpt reads DOES depend on
  ;; how many blocks claim the same `:block/left`, because that is what a step
  ;; scans. A page whose top-level blocks have no children costs less.
  (load-test-files [{:file/path "pages/flat.md"
                     :file/content (page-of 40 0)}
                    {:file/path "pages/deep.md"
                     :file/content (page-of 40 big-kids)}])
  (let [flat (db-utils/entity repo [:block/name "flat"])
        deep (db-utils/entity repo [:block/name "deep"])
        mf (measured #(f27p/top-level-excerpt repo flat f27pe/blocks-per-request))
        md (measured #(f27p/top-level-excerpt repo deep f27pe/blocks-per-request))]
    (println "F27-COST outline shape, 40 childless tops vs 40 tops of 30 children:"
             (pr-str {:flat {:slices (:slices mf) :datoms (:datoms mf)}
                      :with-children {:slices (:slices md) :datoms (:datoms md)}}))
    (is (= (:slices mf) (:slices md)) "the same number of scans either way")
    (is (<= (:datoms mf) (:datoms md))
        (str "flat " (:datoms mf) " vs with-children " (:datoms md)))
    (testing "and both are small constants, not fractions of the page"
      (is (< (:datoms mf) 100))
      (is (< (:datoms md) 100)))))

(deftest the-full-cap-is-still-bounded
  (load-test-files [{:file/path "pages/big.md" :file/content (page-of big-tops big-kids)}])
  (let [page (db-utils/entity repo [:block/name "big"])
        m (measured #(f27p/top-level-excerpt repo page f27pe/max-page-blocks))]
    (println "F27-COST twenty-block excerpt (the cap) of a 12,400-block page:"
             (pr-str {:slices (:slices m) :datoms (:datoms m)}))
    (is (= f27pe/max-page-blocks (count (:blocks (:value m)))))
    ;; 21 sibling steps + 20 child questions.
    (is (= 41 (:slices m)))
    (is (< (:datoms m) 400) (str "measured " (:datoms m) " datoms realised"))
    (testing "still under five per cent of the page, at the largest excerpt allowed"
      (is (< (:datoms m) (/ 12400 20))))
    (testing "and it is four times the five-block cost, not four hundred"
      (is (< (:datoms m) (* 10 57))))))

;; A small, deterministic fixture for the existence probe alone: one block with
;; a single child, one with two hundred, and one with none. Two hundred is not a
;; stress number — it is a number the OLD eager lookup could not answer without
;; building two hundred entities, which is the whole discrimination.
(def ^:private probe-kids 200)

(defn- probe-page []
  (str "- one child\n\t- the only child\n"
       "- many children\n"
       (string/join (for [j (range probe-kids)] (str "\t- child " j "\n")))
       "- no children at all\n"))

(deftest asking-whether-children-exist-builds-nothing
  ;; WHAT THIS ASSERTS, and why it is not a number that drifts.
  ;;
  ;; The requirement is that asking "are there children?" must not collect the
  ;; children. The measurement that used to stand for it — datoms realised
  ;; against a fixed bound of 8 — was not a measurement of that: `map` over a
  ;; datascript index slice is CHUNKED, so taking one datom realises whatever
  ;; the chunk holds. Observed 1, 4, 8 and 16 for identical work, so the test
  ;; failed roughly two runs in five while nothing was wrong. Raising the bound
  ;; to 16 would have kept a number that measures datascript's node fill rather
  ;; than this code's behaviour.
  ;;
  ;; What is deterministic, and what the requirement actually says:
  ;;   * ONE index scan, started and stopped;
  ;;   * ONE datom taken from it — or none, when there are no children;
  ;;   * the SAME cost for one child and for two hundred, which is what
  ;;     "does not collect them" means;
  ;;   * and the contrast, measured on the same fixture, with the reverse
  ;;     lookup this deliberately does not use.
  (load-test-files [{:file/path "pages/probe.md" :file/content (probe-page)}])
  (let [db (conn/get-db repo)
        blocks (:blocks (f27p/excerpt repo "probe" 3))
        [one many none] (mapv :block blocks)
        m1 (measured #(f27p/has-children? db (:db/id one)))
        mn (measured #(f27p/has-children? db (:db/id many)))
        m0 (measured #(f27p/has-children? db (:db/id none)))]
    (println "F27-COST child-existence question, 1 vs" probe-kids "children vs none:"
             (pr-str {:one {:slices (:slices m1) :consumed (:consumed m1) :datoms (:datoms m1)}
                      :many {:slices (:slices mn) :consumed (:consumed mn) :datoms (:datoms mn)}
                      :none {:slices (:slices m0) :consumed (:consumed m0) :datoms (:datoms m0)}}))

    (testing "the fixture really is what the measurement claims"
      (is (= ["one child" "many children" "no children at all"]
             (mapv string/trim (contents {:blocks blocks}))))
      (is (= probe-kids (count (:block/_parent many)))
          "two hundred children really are there to be collected"))

    (testing "the answer is right"
      (is (true? (:value m1)))
      (is (true? (:value mn)))
      (is (false? (:value m0))))

    (testing "one index scan, whatever the number of children"
      (is (= 1 (:slices m1)))
      (is (= 1 (:slices mn)))
      (is (= 1 (:slices m0))))

    (testing "one datom taken — and none when there is nothing to take"
      (is (= 1 (:consumed m1)) (str "took " (:consumed m1) " datom(s) for one child"))
      (is (= 1 (:consumed mn)) (str "took " (:consumed mn) " datom(s) for " probe-kids " children"))
      (is (= 0 (:consumed m0)) (str "took " (:consumed m0) " datom(s) for no children")))

    (testing "and therefore the cost does not grow with the children — the requirement itself"
      (is (= (:slices m1) (:slices mn)))
      (is (= (:consumed m1) (:consumed mn))))

    ;; THE REGRESSION, and how it fires.
    ;;
    ;; `(:block/_parent e)` does not go through `d/datoms` at all: datascript's
    ;; `-lookup-backwards` calls `db/-search` and then
    ;; `(reduce #(conj %1 (entity db (:e %2))) #{} datoms)` — an Entity built for
    ;; EVERY child, eagerly, with no early stop available. Its measured
    ;; signature is therefore `{:slices 0 :consumed 0}`: it performs none of the
    ;; bounded scan this contract requires.
    ;;
    ;; So restoring it breaks the assertions above directly — `(= 1 (:slices
    ;; mn))` and `(= 1 (:consumed mn))` both become 0. Verified by swapping the
    ;; implementation and running this test, not assumed.
    (testing "the reverse-reference lookup this deliberately does not use collects every child"
      (let [fresh (db-utils/entity db (:db/id many))
            eager (measured #(some? (:block/_parent fresh)))]
        (println "F27-COST the reverse lookup, for contrast:"
                 (pr-str {:slices (:slices eager) :consumed (:consumed eager)
                          :entities-built (count (:block/_parent fresh))}))
        (is (true? (:value eager)))
        (is (= probe-kids (count (:block/_parent fresh)))
            (str probe-kids " entities materialised merely to answer 'are there any'"))
        (is (zero? (:slices eager))
            "it performs none of the bounded scan the probe performs — which is what the assertions above detect")))))

(deftest an-excerpt-never-pulls-the-page
  (load-test-files [{:file/path "pages/big.md" :file/content (page-of big-tops big-kids)}])
  (let [page (db-utils/entity repo [:block/name "big"])
        pulled (volatile! 0)
        orig db-utils/pull-many]
    (with-redefs [db-utils/pull-many (fn [& args]
                                       (let [r (apply orig args)]
                                         (vswap! pulled + (count r))
                                         r))]
      (f27p/top-level-excerpt repo page f27pe/max-page-blocks))
    (is (zero? @pulled) "an excerpt pulls nothing; it walks entities lazily")))

;; ---------------------------------------------------------------------------
;; 5. Malformed data
;; ---------------------------------------------------------------------------

(defn- top-level-ids [page-eid]
  (->> (d/datoms (conn/get-db repo) :avet :block/page page-eid)
       (map #(db-utils/entity repo (:e %)))
       (filter #(= page-eid (:db/id (:block/parent %))))
       (map :db/id)
       sort
       vec))

(deftest an-outline-with-no-first-link-is-a-failure-not-an-empty-page
  ;; This is the malformed shape a real DataScript graph can actually take.
  ;; `:block/left` is single-valued, so a page's chain cannot loop back on
  ;; itself; what it CAN do is lose its head, and then the walk finds nothing at
  ;; all — which must not read as "this page is empty".
  (load-test-files [{:file/path "pages/headless.md"
                     :file/content "- one\n- two\n- three\n"}])
  (let [page (db-utils/entity repo [:block/name "headless"])
        page-eid (:db/id page)
        conn* (conn/get-db repo false)
        [b1 b2 b3] (top-level-ids page-eid)]
    (is (= :ok (:state (f27p/excerpt repo "headless" 5))) "it reads fine to begin with")
    (is (= 3 (count (:blocks (f27p/excerpt repo "headless" 5)))))

    ;; Nothing claims the page as its left any more.
    (d/transact! conn* [{:db/id b1 :block/left b3}])
    (let [m (measured #(f27p/excerpt repo "headless" f27pe/max-page-blocks))
          ex (:value m)]
      (is (= [] (:blocks ex)))
      (is (= :orphaned (:stopped (:walk ex))))
      (is (f27pe/walk-failed? (:walk ex)))
      (is (= :error (f27pe/excerpt-outcome :may-excerpt ex))
          "a broken outline is a read failure, never a successfully empty page")
      (is (false? (:more? ex)))
      (is (<= (:slices m) 4) (str "and it is decided in " (:slices m) " scans")))
    (is (= [b1 b2 b3] (top-level-ids page-eid)) "the blocks are all still there")))

(deftest a-genuinely-empty-page-is-still-reported-as-empty
  ;; The guard above must not turn every empty page into a failure.
  (load-test-files [{:file/path "pages/nothing.md" :file/content "-\n"}
                    {:file/path "pages/onlyprops.md" :file/content "type:: note\n"}])
  (doseq [n ["nothing" "onlyprops"]]
    (let [ex (f27p/excerpt repo n f27pe/max-page-blocks)]
      (is (= [] (:blocks ex)) n)
      (is (not (f27pe/walk-failed? (:walk ex))) (str n " is empty, not broken"))
      (is (= :empty (f27pe/excerpt-outcome :may-excerpt ex)) n))))

(deftest a-page-whose-blocks-all-claim-one-left-is-refused-not-walked
  (load-test-files
   [{:file/path "pages/fan.md"
     :file/content (string/join (for [i (range 12)] (str "- top " i "\n")))}])
  (let [page (db-utils/entity repo [:block/name "fan"])
        page-eid (:db/id page)
        conn* (conn/get-db repo false)
        blocks (top-level-ids page-eid)]
    (is (= 12 (count blocks)))
    ;; Every block claims the page as its left: twelve candidates for one step,
    ;; above `max-step-candidates`.
    (d/transact! conn* (mapv (fn [id] {:db/id id :block/left page-eid}) blocks))
    (let [m (measured #(f27p/excerpt repo "fan" f27pe/max-page-blocks))
          ex (:value m)]
      (is (= :candidates (:stopped (:walk ex))))
      (is (= [] (:blocks ex)))
      (is (= :error (f27pe/excerpt-outcome :may-excerpt ex))
          "and it is a read failure, never a successfully empty page")
      (is (<= (:datoms m) 40)
          (str "the refusal is decided without reading them all: " (:datoms m))))))

(deftest a-chain-that-is-too-long-stops-at-the-step-bound
  ;; 200 top-level blocks: more than `max-walk-steps` can reach, so the walk
  ;; must stop on its bound rather than following the whole outline.
  (load-test-files
   [{:file/path "pages/long.md"
     :file/content (string/join (for [i (range 200)] (str "- top " i "\n")))}])
  (let [ex (f27p/excerpt repo "long" f27pe/max-page-blocks)]
    (is (= f27pe/max-page-blocks (count (:blocks ex)))
        "the cap is reached before the step bound, which is the point of the margin")
    (is (<= (:steps (:walk ex)) f27pe/max-walk-steps))
    (is (true? (:more? ex)))))
