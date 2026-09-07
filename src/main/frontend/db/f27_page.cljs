(ns frontend.db.f27-page
  "F27 page-embed slice — the BOUNDED read behind an excerpt of a page.

  This namespace exists so the cost of a page excerpt is a measurable fact
  rather than a claim. Every read here is an `avet` range scan consumed lazily
  and stopped as soon as the answer is known, with an explicit candidate bound,
  and `frontend.db.f27-page-test` asserts the actual number of index slices and
  datoms realised against a 12,401-block fixture page.

  It reads. It never writes, never creates a page, renders nothing and executes
  nothing.

  Why not the obvious functions:

  * `model/get-page-blocks-no-cache` pulls EVERY block of the page. Showing five
    of them behind that is precisely the unbounded fetch hidden behind a display
    limit this batch forbids — measured at 12,401 blocks pulled for a five-block
    excerpt.

  * `model/get-page-blocks-count` counts `(d/datoms db :avet :block/page …)`,
    a full scan of the page. That is why an excerpt reports that more blocks
    exist and never how many.

  * `model/get-by-parent-&-left` reads `(:block/_left node)`. A DataScript
    reverse-reference lookup on a non-component attribute runs
    `(-search db [nil :block/left eid])` and then EAGERLY reduces the result into
    a `PersistentHashSet` of Entity objects. It is a range scan plus an
    allocation per match, with no candidate bound — not the single seek the
    design review first claimed.

  * `some?` on `(:block/_parent block)` is the same shape, and there the match
    set is every direct child: measured at a 30-entity set built merely to
    answer whether any child exists.

  Both `:block/left` and `:block/parent` carry `:db/index true` in
  `logseq.db.schema`, so the `avet` scans below hit exactly the matching datoms."
  (:require [clojure.string :as string]
            [datascript.core :as d]
            [frontend.db.conn :as conn]
            [frontend.db.utils :as db-utils]
            [frontend.util.f27-page-embed :as f27pe]
            [frontend.util.property :as property]
            [logseq.graph-parser.util :as gp-util]))

(defn page-lookup
  "Resolve a page NAME, and say precisely what was found.

  Returns `{:entity e :entity? bool :file? bool}`, or `{:error true}` when the
  lookup threw — three answers, because a read failure, an absent page and an
  empty page must never be presented as the same thing.

  `:entity?` is deliberately NOT the existence test. Writing `[[Ghost]]`
  anywhere — including inside the very `{{embed}}` being rendered — makes
  `Ghost` a page entity, so every page embed's argument resolves to something.
  `:file?` is what separates a page from a name somebody wrote in brackets: in a
  file graph a page's blocks come from its file.

  The name is sanitised with OG's own `page-name-sanity-lc` — the same function
  `page-key` uses and the same value `:block/name` holds — so a multiword or
  Korean name written `[[집중 노트]]` resolves exactly as OG resolves it."
  [repo page-name]
  (try
    (let [n (some-> page-name str string/trim not-empty gp-util/page-name-sanity-lc)]
      (if (or (nil? n) (= "" n))
        {:entity nil :entity? false :file? false}
        (let [e (db-utils/entity repo [:block/name n])]
          {:entity e
           :entity? (some? e)
           :file? (some? (:db/id (:block/file e)))})))
    (catch :default _
      {:error true})))

(defn- candidates
  "The blocks that claim `left-eid` as their `:block/left`, at most one more than
  `max-step-candidates` of them, as datoms.

  Lazily consumed: `take` stops the `avet` scan rather than reading a chain's
  whole fan-out, and reading one past the bound is how the caller can tell
  'within bounds' from 'too many to answer'. A nil `left-eid` reads nothing."
  [db left-eid]
  (when left-eid
    (take (inc f27pe/max-step-candidates)
          (d/datoms db :avet :block/left left-eid))))

(defn- skip?
  "Should this top-level block be stepped over rather than shown?

  Two reasons, both of them 'OG's own outline does not show this as a block':

  * the page's PROPERTIES block. `:block/pre-block?` marks it, and OG renders it
    as the page's properties rather than as a row.
  * a block with no readable text. A page written as a bare `-` consists of
    exactly one of these, and a row reading '(no readable text)' would be noise
    rather than content."
  [e]
  (or (boolean (:block/pre-block? e))
      (let [c (:block/content e)]
        (or (not (string? c))
            (string/blank? c)
            (string/blank? (str (property/remove-built-in-properties
                                 (or (:block/format e) :markdown) c)))))))

(defn top-level-step
  "A `walk-top-level` step for ONE page: the next TOP-LEVEL block after `prev-id`.

  A top-level block is one whose `:block/parent` is the page itself. The first
  is the block whose `:block/left` is the page, so the walk starts with the
  page's own id and never special-cases its first step.

  Returns `{:id .. :skip? .. :block ..}`, nil at the chain's end, or `:refused`
  when more than `max-step-candidates` blocks claim the same left — malformed
  data, which is reported rather than walked."
  [db page-eid]
  (fn [prev-id]
    (let [ds (candidates db prev-id)]
      (if (> (count ds) f27pe/max-step-candidates)
        :refused
        (some (fn [d]
                (let [e (db-utils/entity db (:e d))]
                  (when (and e
                             (= page-eid (:db/id (:block/parent e)))
                             ;; A page is its own left and parent seed; it must
                             ;; never be walked into as one of its own blocks.
                             (not= page-eid (:db/id e)))
                    {:id (:db/id e)
                     :skip? (skip? e)
                     :block e})))
              ds)))))

(defn has-children?
  "Whether `eid` has at least one direct child, WITHOUT building them.

  One `avet` scan on `:block/parent`, stopped at the first datom. No subtree is
  walked, no child count is taken and no Entity is allocated — the excerpt
  reports that children exist, never how many, because counting them is
  unbounded and traversing them is what this whole contract refuses."
  [db eid]
  (boolean (and eid (first (d/datoms db :avet :block/parent eid)))))

(defn has-any-block?
  "Whether the page has at least one block of ANY kind, at any depth.

  One `avet` scan on `:block/page`, stopped at the first datom — deliberately
  not `model/get-page-blocks-count`, which counts the whole page.

  Asked once, and only when the top-level walk produced no head at all. A page
  whose blocks exist but whose outline has no first link is a BROKEN OUTLINE,
  and without this question it would be indistinguishable from an empty page —
  which is precisely the failure-reported-as-success this contract forbids."
  [db page-eid]
  (boolean (and page-eid (first (d/datoms db :avet :block/page page-eid)))))

(defn top-level-excerpt
  "The first `want` top-level blocks of an ALREADY RESOLVED page, plus whether
  more exist.

  This is the whole read an open excerpt performs, and it is deliberately
  separate from `page-lookup`: the lookup is what every page embed does, on
  every surface, and this is what only a chip the reader has opened does. A
  caller that has not established the page exists cannot reach it.

  Returns `{:state :ok|:error :blocks [{:block .. :children? ..}] :more? bool
            :walk {..}}`.

  `:state` is never inferred from an empty result: a walk that stopped on a
  bound or a cycle is reported through `:walk`, and the caller turns that into a
  read failure rather than an empty page."
  [repo page want]
  (try
    (let [db (conn/get-db repo)
          page-eid (:db/id page)
          walk (f27pe/walk-top-level page-eid want (top-level-step db page-eid))
          ;; The chain produced no head at all. Only now is it worth one more
          ;; scan to ask whether the page nevertheless HAS blocks — if it does,
          ;; the outline is broken, not empty. Asked here and nowhere else, so a
          ;; page that reads normally never pays for it.
          walk (if (and (zero? (:visited walk 0))
                        (= :end (:stopped walk))
                        (has-any-block? db page-eid))
                 (assoc walk :stopped :orphaned)
                 walk)]
      {:state :ok
       :blocks (mapv (fn [{:keys [block id]}]
                       {:block block
                        :children? (has-children? db id)})
                     (:blocks walk))
       :more? (boolean (:more? walk))
       :walk walk})
    (catch :default _
      {:state :error :blocks [] :more? false :walk {:stopped :error}})))

(defn excerpt
  "`page-lookup` and `top-level-excerpt` together, for a caller that has neither.

  Returns the lookup's own `:state` — `:missing`, `:uncreated` or `:error` —
  without reading any outline, and otherwise the excerpt."
  [repo page-name want]
  (let [{:keys [entity entity? file? error]} (page-lookup repo page-name)]
    (cond
      error {:state :error}
      (not entity?) {:state :missing}
      (not file?) {:state :uncreated :page entity}
      :else (assoc (top-level-excerpt repo entity want) :page entity))))
