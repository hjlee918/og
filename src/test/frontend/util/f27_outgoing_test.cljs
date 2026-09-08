(ns frontend.util.f27-outgoing-test
  "F27 outgoing first slice — focused tests for *Links in this block*.

  What these pin:

    * the three shapes OG parses an inline block reference into are claimed, and
      NOTHING else is — an `{{embed}}`, a page reference, a tag, an `id:` link,
      an address, a query, inline HTML and Hiccup all yield no link, so this
      slice cannot claim a link the author did not write as one;
    * the order is the order the reference appears in the text;
    * repeats are deduplicated, counted, and never a second row;
    * every claimed occurrence is accounted for in exactly one category;
    * both walk bounds stop the scan AND say that they did;
    * a self-reference is a self-reference before it is anything else;
    * an unresolvable target is `:unavailable` rather than a row with a control
      that cannot work.

  Most cases parse REAL markdown through OG's own parser rather than asserting
  a hand-written AST, because the whole safety argument of this slice is that
  what is listed is what OG parsed."
  (:require [cljs.test :refer [deftest testing is]]
            [clojure.string :as string]
            [frontend.util.f27-body :as f27b]
            [frontend.util.f27-outgoing :as o]
            [logseq.graph-parser.mldoc :as gp-mldoc]))

(def ^:private a "7f270000-0000-4000-8000-0000000000a1")
(def ^:private b "7f270000-0000-4000-8000-0000000000b2")
(def ^:private c "7f270000-0000-4000-8000-0000000000c3")
(def ^:private host "7f270000-0000-4000-8000-0000000000d4")

(defn- nth-id
  "A distinct, well-formed identity for the cap and accounting cases.
  `format` is not in ClojureScript's core, so the padding is explicit."
  [i]
  (let [s (str i)
        pad (apply str (repeat (- 12 (count s)) "0"))]
    (str "7f270000-0000-4000-8000-" pad s)))

(defn- ast
  ([s] (ast s :markdown))
  ([s fmt] (gp-mldoc/inline->edn s (gp-mldoc/default-config fmt))))

(defn- ids
  "The identities extracted from real markup, in source order."
  ([s] (ids s :markdown))
  ([s fmt] (mapv :id (:links (o/collect (:hits (o/scan (ast s fmt))))))))

;; ---------------------------------------------------------------------------
;; What is claimed — over OG's own parse
;; ---------------------------------------------------------------------------

(deftest a-bare-inline-reference-is-claimed
  (is (= [a] (ids (str "before ((" a ")) after")))
      "((uuid)) written in running text is one outgoing link")
  (is (= [["Link" {:url ["Block_ref" a] :label [] :full_text (str "((" a "))")
                   :metadata ""}]]
         (ast (str "((" a "))")))
      "the shape this slice claims, as OG's own parser produces it"))

(deftest a-labelled-reference-is-claimed
  (let [links (:links (o/collect (:hits (o/scan (ast (str "[my words](((" a "))))"))))))]
    (is (= [a] (mapv :id links)))
    (is (true? (:labelled? (first links)))
        "the author wrote their own label, and that is recorded")))

(deftest an-unlabelled-reference-is-not-labelled
  (let [links (:links (o/collect (:hits (o/scan (ast (str "((" a "))"))))))]
    (is (= [a] (mapv :id links)))
    (is (false? (:labelled? (first links))))))

(deftest a-reference-og-did-not-parse-as-one-is-not-listed
  (testing "measured against OG's real parse, not assumed"
    (is (= [] (ids (str "**bold ((" a ")) still bold**")))
        "inside emphasis OG's parser leaves the text alone, so there is no
         reference there to list — the panel renders the same characters")
    (is (= [] (ids (str "`((" a "))` in code")))
        "a code span is code")
    (is (= [] (ids (str "[[((" a "))]]")))
        "this parses as a PAGE reference whose name is that text; claiming it
         would report a page link the author wrote as a block reference")))

(deftest a-reference-is-found-in-org-format-too
  (is (= [a] (ids (str "org ((" a ")) ref") :org))
      "the parse, not the file format, is what this slice reads"))

(deftest korean-and-emoji-text-around-a-reference-is-irrelevant-to-extraction
  (is (= [a b]
         (ids (str "한국어 문장 ((" a ")) 그리고 🎯 이모지 ((" b "))")))
      "extraction is over the AST, so multi-byte text neither hides nor invents a link"))

;; ---------------------------------------------------------------------------
;; What is NOT claimed
;; ---------------------------------------------------------------------------

(deftest an-embed-macro-is-not-an-inline-block-reference
  (is (= [] (ids (str "{{embed ((" a "))}}")))
      "an embed is a macro and the block-embed feature's own surface")
  (is (= [] (ids (str "{{embed [[Some Page]]}}")))))

(deftest a-page-reference-or-tag-is-not-a-block-reference
  (is (= [] (ids "see [[Deep Work]] and #focus")))
  (is (= [] (ids "[link text]([[Deep Work]])"))))

(deftest an-address-is-not-a-block-reference
  (is (= [] (ids "https://example.com/((not-a-ref))")))
  (is (= [] (ids "[a link](https://example.com)")))
  (is (= [a] (ids (str "![alt](../assets/x.png) then ((" a "))")))
      "an asset link is a Search link too; only the real reference is listed"))

(deftest an-id-protocol-link-is-not-claimed-by-this-slice
  (is (= [] (ids (str "[words](id:" a ")")))
      "an id: link is a URL form, and arbitrary URLs are out of this slice")
  (is (= [] (ids (str "[[id:" a "][words]]") :org))
      "the org spelling of the same thing is a Complex url, and is not one either"))

(deftest a-query-renderer-html-or-hiccup-is-not-a-block-reference
  (is (= [] (ids "{{query (todo NOW)}}")))
  (is (= [] (ids "{{renderer :slot-x}}")))
  (is (= [] (ids "<b>markup</b>")))
  (is (= [] (ids "[:span \"hiccup\"]"))))

(deftest plain-text-produces-no-links
  (is (= [] (ids "just words, nothing referenced")))
  (is (= [] (ids "")))
  (is (= [] (ids "`((not a real ref))` in code"))))

;; ---------------------------------------------------------------------------
;; Order, dedup, accounting
;; ---------------------------------------------------------------------------

(deftest links-are-listed-in-source-order
  (is (= [c a b]
         (ids (str "first ((" c ")) then ((" a ")) then ((" b "))")))
      "source order, not identity order and not database order"))

(deftest positions-are-assigned-in-source-order
  (let [links (:links (o/collect (:hits (o/scan (ast (str "((" c ")) ((" a "))"))))))]
    (is (= [0 1] (mapv :order links)))))

(deftest a-repeated-identity-is-one-row-that-counts-its-repeats
  (let [collected (o/collect (:hits (o/scan (ast (str "((" a ")) ((" b ")) ((" a "))")))))]
    (is (= [a b] (mapv :id (:links collected))) "the first occurrence keeps the position")
    (is (= 1 (:repeats (first (:links collected)))))
    (is (= 0 (:repeats (second (:links collected)))))
    (is (= 3 (:found collected)))
    (is (= 2 (:distinct collected)))
    (is (o/accounting-balances? collected))))

(deftest identity-is-compared-case-insensitively
  (let [collected (o/collect (:hits (o/scan (ast (str "((" a ")) ((" (string/upper-case a) "))")))))]
    (is (= 1 (count (:links collected)))
        "one target written in two cases is one target")
    (is (= 1 (:repeats (first (:links collected)))))))

(deftest a-malformed-identifier-is-counted-and-never-listed
  (let [collected (o/collect [{:id "   " :labelled? false}
                              {:id a :labelled? false}])]
    (is (= [a] (mapv :id (:links collected))))
    (is (= 1 (:malformed collected)))
    (is (= 2 (:found collected)))
    (is (o/accounting-balances? collected))))

(deftest accounting-balances-for-every-shape-of-input
  (doseq [hits [[]
                [{:id a}]
                [{:id a} {:id a} {:id a}]
                [{:id a} {:id nil} {:id b} {:id ""}]
                (mapv (fn [i] {:id (nth-id i)}) (range 40))]]
    (is (o/accounting-balances? (o/collect hits))
        (str "every occurrence accounted for: " (pr-str hits)))))

(deftest identities-beyond-the-retention-cap-are-counted-not-retained
  (let [hits (mapv (fn [i] {:id (nth-id i)}) (range (+ o/max-links 7)))
        collected (o/collect hits)]
    (is (= o/max-links (count (:links collected))))
    (is (= 7 (:over-cap collected)))
    (is (o/accounting-balances? collected))))

;; ---------------------------------------------------------------------------
;; The walk bounds
;; ---------------------------------------------------------------------------

(deftest the-node-bound-stops-the-scan-and-says-so
  (let [wide (vec (cons "Wide" (repeat (* 2 o/max-scan-nodes) ["Plain" "x"])))
        r (o/scan wide)]
    (is (true? (:truncated? r)) "a bound that bit is reported, never silent")
    (is (<= (:visited r) (inc o/max-scan-nodes)))))

(deftest the-depth-bound-stops-the-scan-and-says-so
  (let [deep (reduce (fn [acc _] ["Emphasis" [["Bold"] [acc]]])
                     ["Block_reference" a]
                     (range (* 2 f27b/walk-limit)))
        r (o/scan deep)]
    (is (true? (:truncated? r)))
    (is (= [] (:hits r))
        "nothing below the depth bound is claimed, because nothing there was reached")))

(deftest a-scan-that-completed-is-not-reported-as-truncated
  (let [r (o/scan (ast (str "((" a ")) and ((" b "))")))]
    (is (false? (:truncated? r)))
    (is (= 2 (count (:hits r))))))

;; ---------------------------------------------------------------------------
;; Pagination
;; ---------------------------------------------------------------------------

(deftest a-freshly-opened-section-asks-for-one-request
  (is (= o/links-per-request (o/wanted 0)))
  (is (= o/links-per-request (o/wanted nil))))

(deftest continuation-advances-and-then-stops-at-the-retention-cap
  (is (= (* 2 o/links-per-request) (o/next-wanted o/links-per-request)))
  (is (= o/max-links (o/next-wanted o/max-links)))
  (is (true? (o/more-retainable? 0)))
  (is (false? (o/more-retainable? o/max-links)))
  (is (false? (o/more-retainable? (* 10 o/max-links)))
      "a caller cannot ask for more than may ever be retained"))

(deftest a-page-distinguishes-what-continuation-can-and-cannot-reach
  (let [hits (mapv (fn [i] {:id (nth-id i)}) (range (+ o/max-links 3)))
        collected (o/collect hits)
        page (o/page-of collected 0)]
    (is (= o/links-per-request (:shown-count page)))
    (is (= (- o/max-links o/links-per-request) (:remaining page))
        "retained but not shown yet — a continuation CAN reach these")
    (is (= 3 (:beyond-cap page))
        "never retained — a continuation can NEVER reach these")
    (is (true? (o/can-continue? page)))
    (is (true? (o/cap-hiding-anything? page)))))

(deftest no-continuation-is-offered-when-there-is-nothing-left-to-reveal
  (let [collected (o/collect [{:id a} {:id b}])
        page (o/page-of collected 0)]
    (is (= 2 (:shown-count page)))
    (is (= 0 (:remaining page)))
    (is (false? (o/can-continue? page)))
    (is (false? (o/cap-hiding-anything? page)))))

;; ---------------------------------------------------------------------------
;; Section state — empty, missing, capped and failed are four different things
;; ---------------------------------------------------------------------------

(deftest a-failed-read-is-never-reported-as-empty
  (is (= :error (o/section-state {:error? true :text "((x))" :collected (o/collect [])})))
  (is (= :error (o/section-state {:error? true :text nil :collected (o/collect [])}))
      "a failure outranks every other answer, because what the block holds is unknown"))

(deftest a-block-with-no-text-says-so-rather-than-claiming-emptiness
  (is (= :no-text (o/section-state {:text nil :collected (o/collect [])})))
  (is (= :no-text (o/section-state {:text "   " :collected (o/collect [])}))))

(deftest text-with-no-reference-is-a-genuine-empty
  (is (= :empty (o/section-state {:text "just words" :collected (o/collect [])}))))

(deftest text-whose-only-reference-was-unusable-is-empty-with-the-count-stated
  (let [collected (o/collect [{:id nil}])]
    (is (= :empty (o/section-state {:text "x" :collected collected})))
    (is (= 1 (:malformed collected))
        "the count is available to be said beside the empty answer")))

(deftest at-least-one-link-is-ready
  (is (= :ready (o/section-state {:text "x" :collected (o/collect [{:id a}])}))))

;; ---------------------------------------------------------------------------
;; One link's outcome
;; ---------------------------------------------------------------------------

(deftest a-self-reference-is-a-self-reference-before-it-is-anything-else
  (is (= :self (o/plan-link {:id host :host host :resolved? true})))
  (is (= :self (o/plan-link {:id (string/upper-case host) :host host :resolved? true}))
      "identity is normalised, so a self-reference cannot hide behind its spelling")
  (is (= :self (o/plan-link {:id host :host host :resolved? false}))
      "still a self-reference: expanding it would render the block inside its own context"))

(deftest a-parser-stub-is-not-a-readable-target
  (testing "the parser creates an entity for every identity anything refers to"
    (is (false? (o/readable-target? {:block/uuid a}))
        "a link to a block nobody has written resolves to a stub carrying only
         its identity; `some?` of that lookup answers true and must not be used")
    (is (false? (o/readable-target? nil)))
    (is (false? (o/readable-target? {:block/uuid a :block/_refs [{:db/id 1}]}))
        "being referred to is not being written"))
  (testing "a real block is readable, including one somebody left blank"
    (is (true? (o/readable-target? {:block/uuid a :block/content "words"})))
    (is (true? (o/readable-target? {:block/uuid a :block/content ""}))
        "an empty block exists and simply has no readable text — a different
         sentence from 'this target could not be found'")))

(deftest an-unresolvable-target-is-unavailable
  (is (= :unavailable (o/plan-link {:id a :host host :resolved? false})))
  (is (= :unavailable (o/plan-link {:id nil :host host :resolved? true})))
  (is (= :unavailable (o/plan-link {:id "  " :host host :resolved? true}))))

(deftest an-ordinary-resolved-target-is-shown
  (is (= :show (o/plan-link {:id a :host host :resolved? true})))
  (is (= :show (o/plan-link {:id a :host nil :resolved? true}))
      "an anonymous host cannot make every link look like a self-reference"))

(deftest only-a-shown-link-may-be-expanded
  (is (true? (o/expandable? :show)))
  (is (false? (o/expandable? :self)))
  (is (false? (o/expandable? :unavailable))))

;; ---------------------------------------------------------------------------
;; Bounds are what the specification says they are
;; ---------------------------------------------------------------------------

(deftest the-bounds-are-the-published-ones
  (testing "changing one of these changes the contract, so it changes here first"
    (is (= 5 o/links-per-request))
    (is (= 20 o/max-links))
    (is (= 420 o/max-target-chars))
    (is (= f27b/max-body-chars o/max-target-chars)
        "one opened target gets the same allowance one deliberate embed gets")))
