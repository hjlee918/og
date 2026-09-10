(ns frontend.util.f28-reforder
  "F28 source-page group ordering — the pure decisions behind ONE selectable
  order for a page's linked-references list.

  WHAT OG DOES, AND WHY THAT IS THE GAP.

  `frontend.components.block/->hiccup`, in the branch a page's linked references
  render through, orders the source-page groups with exactly one expression:

      (sort-by (comp :block/journal-day first) > blocks)

  `:block/journal-day` is a key only a journal page has; every ordinary page's
  is nil. In ClojureScript `(> nil nil)` is false both ways, so all ordinary
  pages compare EQUAL and the stable sort leaves them in the order
  `references*` handed over — which is `(group-by :block/page …)`'s hash-map
  seq order. That order is deterministic for one set of groups and it is not a
  property anybody chose. `(> 20260910 nil)` is true, so journals come first.

  OG offers no way to ask for a different one. Its only linked-reference
  configuration keys are `:ref/default-open-blocks-level` and
  `:ref/linked-references-collapsed-threshold`; the filter chooses WHICH pages
  appear and never in what order. Measured on screen before any of this was
  written — `f28-refpath/checks/reforder-baseline-checks.js`, against a build
  that does not contain this namespace: 8 groups drawn, journal first, the rest
  in neither title order, and 0 ordering controls of any kind.

  This namespace is PURE. It reads no database, renders nothing, persists
  nothing and never touches a graph file. It decides three things:

    * whether this surface gets the control at all;
    * what one source page's TITLE compares as;
    * how a sequence of groups is ordered by that, including what happens when
      two compare equal.

  THE ORDER IS DEFINED, NOT DELEGATED. There is no `Intl.Collator`, no locale
  and no `localeCompare` here. A list must be in the same order on every machine
  and in every interface language, and a rule that changes with the reader's
  locale is not one this project can test. What the rule IS, and what follows
  from it, is `project-notes/F28_REFERENCE_ORDER_SPEC.md` §3."
  (:require [clojure.string :as string]
            [frontend.util.f28-refpath :as f28]))

;; ---------------------------------------------------------------------------
;; The three orders
;; ---------------------------------------------------------------------------

(def modes
  "The three orders, as data and in the order the control offers them.

  `:original` is FIRST and is the default because it is OG's own — this feature
  starts by changing nothing."
  [:original :title-asc :title-desc])

(def ^:const default-mode :original)

(defn mode?
  "True for one of the three orders and nothing else."
  [m]
  (boolean (some #{m} modes)))

(defn normalize-mode
  "The order to use for `m`, which is `:original` unless `m` is one of the
  three. A caller that has lost track of the value must fall back to OG's own
  order rather than to a guess."
  [m]
  (if (mode? m) m default-mode))

(defn mode-value
  "The string one order travels as through the DOM — the `<option>` value and
  `data-f28-order`. A check reads this rather than the translated words, which
  is the difference between testing this feature and testing the dictionary."
  [m]
  (name (normalize-mode m)))

(defn value->mode
  "The order a DOM value names, or `:original` when it names none."
  [v]
  (normalize-mode (first (filter #(= (name %) (str v)) modes))))

(def label-keys
  "The dictionary key for each order's own words, so the control renders no
  English of its own and follows the interface language like every other F28
  label."
  {:original :f28/order-original
   :title-asc :f28/order-title-asc
   :title-desc :f28/order-title-desc})

(defn label-key
  [m]
  (get label-keys (normalize-mode m)))

;; ---------------------------------------------------------------------------
;; Where the control belongs
;; ---------------------------------------------------------------------------

(def own-exclusion-reasons
  "The one reason that belongs to THIS feature and to no other.

  Listed as data so a test can assert the set has not silently grown: adding a
  surface to this feature means REMOVING a reason, which is a visible change
  rather than a quietly deleted `cond` clause."
  [:not-order-list])

(def exclusion-reasons
  "Every reason a list gets NO ordering control, in the order they are checked.

  The shared ones are the source-path slice's, in its order, minus the two it
  asks that this feature answers with its own."
  (into own-exclusion-reasons
        (remove #{:no-elision :not-source-path-list} f28/exclusion-reasons)))

(defn excluded-surface
  "The reason this list gets no ordering control, or nil when it belongs here.

  Takes plain booleans, so the caller's mapping from OG's `config` to this
  question is the only place OG's shape is known.

    :order-list?  the config was opted in by
                  `frontend.components.reference/references*` — the SAME
                  explicit opt-in the source-path, child-context and
                  reference-role slices read, because it is the same decision
                  about the same list.

  Every other flag is handed straight to
  `frontend.util.f28-refpath/excluded-surface` — the same surfaces, the same
  order, the same reasons. Restating them here is exactly how two features that
  are supposed to agree stop agreeing, and a test asserts the delegation."
  [{:keys [order-list?] :as surface}]
  (cond
    (not order-list?) :not-order-list
    :else             (f28/excluded-surface
                       (assoc surface :elided? true :source-path-list? true))))

(defn offer-control?
  "True when this list gets the ordering control. The complement of
  `excluded-surface`, kept as its own name because that is what the caller
  asks."
  [surface]
  (nil? (excluded-surface surface)))

;; ---------------------------------------------------------------------------
;; What one title compares as
;; ---------------------------------------------------------------------------

(defn sort-key
  "The comparison key for one source page's title: NFC, then lower-cased.

  NEITHER STEP IS THIS SLICE'S INVENTION. Both are OG's own mandate for
  `:block/name`: `logseq.graph-parser.util/page-name-sanity-lc` lower-cases and
  then `page-name-sanity` ends in `(.normalize \"NFC\")`.

  NFC is load-bearing rather than decorative. macOS hands out decomposed Hangul
  routinely, and a decomposed `하` is `U+1112 U+1161`, which sorts BEFORE a
  composed `가` (`U+AC00`) — so without this step a Korean list is silently
  wrong, and wrong in a way that looks like a correct list on screen because
  the two forms render identically.

  Lower-casing is `clojure.string/lower-case`, which is locale-independent
  `toLowerCase`. Without it `Banana` (`U+0042`) sorts before `apple`
  (`U+0061`).

  A page with no title at all keys as \"\" and sorts first ascending, rather
  than throwing or being dropped from the list."
  [title]
  (string/lower-case (.normalize (str (or title "")) "NFC")))

(defn code-points
  "One string as its sequence of Unicode CODE POINTS.

  Not code units. Comparing UTF-16 code units places an astral character — an
  emoji, `U+1F300`+, whose surrogates begin `U+D83C` — before a BMP character
  above `U+DFFF`, which is the wrong way round. Titles in this project carry
  emoji, so the difference is reachable rather than theoretical."
  [s]
  (let [s (str s)
        n (.-length s)]
    (loop [i 0
           acc (transient [])]
      (if (< i n)
        (let [cp (.codePointAt s i)]
          (recur (+ i (if (> cp 0xFFFF) 2 1)) (conj! acc cp)))
        (persistent! acc)))))

(defn compare-code-points
  "Compare two strings by code-point sequence: the first differing code point
  decides, and if one is a prefix of the other the shorter is smaller.

  Returns -1, 0 or 1."
  [a b]
  (let [x (code-points a)
        y (code-points b)
        n (min (count x) (count y))]
    (loop [i 0]
      (if (< i n)
        (let [xa (nth x i)
              yb (nth y i)]
          (if (== xa yb)
            (recur (inc i))
            (if (< xa yb) -1 1)))
        (compare (count x) (count y))))))

(defn compare-titles
  "Compare two source-page titles under the rule above. Returns -1, 0 or 1.

  BETWEEN TWO DISTINCT SOURCE PAGES THIS CANNOT RETURN 0, and that is provable
  rather than hopeful: `sort-key` is `page-name-sanity-lc` minus
  `remove-boundary-slashes`, and `page-name-sanity-lc` IS `:block/name`, which
  is unique per page. Two groups are two different `:block/page` entities, so
  two groups have two different keys.

  It is defined for 0 anyway — see `order-groups` — because a rule that is only
  correct while an invariant holds is a rule nobody can rely on later."
  [a b]
  (compare-code-points (sort-key a) (sort-key b)))

;; ---------------------------------------------------------------------------
;; Ordering the groups
;; ---------------------------------------------------------------------------

(defn order-groups
  "Reorder a sequence of source-page groups, or hand back exactly what OG built.

  `entries`  the groups, in the order OG produced them
  `mode`     one of `modes`
  `title-fn` how to read one entry's source-page title

  `:original` returns `entries` ITSELF — not a re-sort that happens to agree
  with OG, not a reconstruction of OG's expression. That is what makes
  \"switch back to Original\" restore OG's own order: it never stopped being
  OG's own order.

  TIES KEEP OG'S ORDER, IN BOTH DIRECTIONS. `cljs.core/sort` is
  `goog.array/stableSort`, so groups whose keys compare equal keep the relative
  order they were handed. Descending negates the comparison and 0 negates to 0,
  so descending is NOT the ascending list reversed: the reader asked for a
  different title order, not for OG's order to be turned upside down
  underneath it."
  [entries mode title-fn]
  (let [mode (normalize-mode mode)]
    (if (= :original mode)
      entries
      (let [sign (if (= :title-desc mode) -1 1)]
        (sort (fn [a b] (* sign (compare-titles (title-fn a) (title-fn b))))
              entries)))))
