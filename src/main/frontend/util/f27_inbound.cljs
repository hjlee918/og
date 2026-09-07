(ns frontend.util.f27-inbound
  "F27 slice 5 — pure helpers for chained INBOUND-reference exploration.

  Slice 1 shows one compact row per block that REFERENCES the target. Slice 5
  lets the reader take the next step: pick one of those referencing blocks and
  ask the same question about IT — which blocks reference *that* one — then
  follow another step or go Back.

  DIRECTION. Every value here describes blocks that REFER TO a selected block.
  It is not the links contained inside that block (outgoing references are never
  followed), and it is not its children (slice 4, kept separate).

  This namespace is PURE. The caller injects the reads; nothing here touches the
  database, renders, writes a graph file, or persists anything.

  Five properties matter and are all tested:

    * ONE LEVEL AT A TIME. A step describes exactly one block's direct inbound
      references. Nothing here fetches a second level, chases a reference
      automatically, or walks the graph.
    * ACCOUNTING IS PRESERVED. Every raw inbound entry is displayed, held back
      by a limit, counted as a repeat, or counted as unresolvable. The invariant
      is asserted by `accounting-balances?`, so an entry can never be silently
      dropped.
    * ORDER IS DETERMINISTIC. `(:block/_refs e)` yields a SET, whose iteration
      order is an implementation detail; the order here is a function of the
      blocks' own attributes instead.
    * THE TRAIL IS THE CYCLE TEST. A repeat of an identity ALREADY ON THE PATH
      being walked is a cycle boundary and is never opened again. The same block
      reached along a different path is not a cycle and stays explorable.
    * EVERY STOPPING CONDITION IS DISTINGUISHABLE. Loading, a successful empty
      answer, a block with no identity to look up, a block that no longer
      resolves, a failed read, and results deliberately not shown yet are six
      different states, and a growth control is offered for exactly one of them."
  (:require [clojure.string :as string]))

(def ^:const default-batch
  "Inbound-reference rows rendered per level before continuation is required."
  10)

(def ^:const max-shown
  "Rendered result rows retained for ONE exploration level. A safeguard against
  a heavily referenced block filling the panel. Entries beyond this are counted
  and named, and the reader is sent to the source rather than offered a control
  that cannot reach them."
  50)

(def ^:const max-trail
  "Retained navigation history, counting the origin row as the first step. The
  explorer refuses to go deeper rather than dropping the oldest step, so Back
  always restores what the reader actually walked."
  8)

(def ^:const max-retries
  "How many times a reader may retry one level's failed read before the offer is
  replaced by source navigation. Bounded so a persistently failing read cannot
  become an endless button."
  3)

(defn retry-allowed?
  [attempts]
  (< (max 0 (or attempts 0)) max-retries))

;; --- identity ---------------------------------------------------------------

(defn step-key
  "Stable identity for one block on the trail or in a result list.

  Prefers the block uuid; falls back to the datascript id so a block without a
  uuid is still distinguishable rather than colliding with every other such
  block. Returns nil when neither is present — such a row is never treated as
  matching anything on the trail, because an unknown identity is not evidence of
  a repeat."
  [e]
  (when e
    (or (:block/uuid e)
        (some-> (:db/id e) (->> (str "db-"))))))

(defn source-page-label
  "Display name of the page a referring block lives on, or nil.

  This is the block's OWN source page — where the reference was written — not
  the page of the block being referenced."
  [e]
  (let [p (:block/page e)]
    (or (:block/original-name p) (:block/name p))))

;; --- deterministic order ----------------------------------------------------

(defn order-key
  "Sort key for one resolved referring block.

  `(:block/_refs e)` is a SET. Its iteration order is an implementation detail
  of the database and is not guaranteed to be the same for two reads of the same
  data, so rendering it directly would let the same graph produce different
  orders. This key is derived from the block's own attributes, so the order is a
  function of the data.

  Source page first, because that is what the reader is scanning for; then the
  database id, which orders blocks within a page by creation; then the uuid
  string, so two entries can never compare equal by accident. Blocks with no
  resolvable page sort after those that have one instead of being interleaved
  unpredictably."
  [e]
  [(if (source-page-label e) 0 1)
   (or (source-page-label e) "")
   (or (:db/id e) 0)
   (str (:block/uuid e))])

(defn order-results
  "Deterministic order for a collection of resolved referring blocks."
  [entities]
  (vec (sort-by order-key (remove nil? entities))))

;; --- resolution and accounting ---------------------------------------------

(defn renderable?
  "True when a resolved referring block carries enough identity for a row to
  render. Rows that fail this are counted as unavailable, never dropped."
  [e]
  (some? (:block/uuid e)))

(defn prepare-results
  "Resolve, account for and order ONE block's direct inbound references.

  `raw` is the collection exactly as `(:block/_refs entity)` yields it — reverse
  reference stubs of the form {:db/id N}, or already realised entities. It is
  the same basis the reference badge counts, so the panel's total and the badge
  can never silently disagree. `resolve-fn` maps a database id to an entity or
  nil.

  Returns a map that accounts for EVERY raw entry:

    :total       raw inbound entries — the badge's own basis
    :unique      renderable, de-duplicated entries in deterministic order,
                 RETAINED up to `max-shown`
    :unique-count (count :unique)
    :over-cap    renderable, de-duplicated entries beyond `max-shown`, which are
                 counted and named but not retained: continuation cannot reach
                 them, so no control is offered for them
    :duplicates  repeat references from a block already listed
    :unavailable entries whose block could not be resolved at all, or which
                 resolved without a :block/uuid. These render no row and are
                 never presented as displayed.

  The invariant :total = :unique-count + :over-cap + :duplicates + :unavailable
  holds for every input."
  ([raw resolve-fn] (prepare-results raw resolve-fn max-shown))
  ([raw resolve-fn cap]
   (let [raw (vec (remove nil? raw))
         total (count raw)
         cap (max 0 (or cap max-shown))
         resolve-one (fn [r]
                       (if (:block/uuid r)
                         r
                         (when-let [id (or (:db/id r) (when (integer? r) r))]
                           (when resolve-fn (resolve-fn id)))))
         {:keys [uniq dup unavail]}
         (reduce (fn [acc r]
                   (let [e (resolve-one r)]
                     (if (renderable? e)
                       (let [id (:block/uuid e)]
                         (if (contains? (:seen acc) id)
                           (update acc :dup inc)
                           (-> acc (update :seen conj id) (update :uniq conj e))))
                       (update acc :unavail inc))))
                 {:seen #{} :uniq [] :dup 0 :unavail 0}
                 raw)
         ordered (order-results uniq)
         retained (vec (take cap ordered))]
     {:total total
      :unique retained
      :unique-count (count retained)
      :over-cap (max 0 (- (count ordered) (count retained)))
      :duplicates dup
      :unavailable unavail})))

(defn accounting-balances?
  "True when every raw inbound entry is accounted for in exactly one category."
  [{:keys [total unique-count over-cap duplicates unavailable]}]
  (= total (+ (or unique-count 0) (or over-cap 0)
              (or duplicates 0) (or unavailable 0))))

;; --- bounded pagination -----------------------------------------------------

(defn page-limit
  "Clamp a requested display limit to the per-level retention cap."
  [n]
  (min max-shown (max 0 (or n default-batch))))

(defn next-limit
  "The limit a continuation moves to. Kept as a function so a caller cannot
  offer a continuation that does not advance."
  [current]
  (page-limit (+ (page-limit current) default-batch)))

(defn page-of
  "The rows one level actually renders, with honest remainders.

  Two remainders are reported and they are NOT the same thing:

    :remaining  retained entries not shown yet — a continuation CAN reach these
    :beyond-cap entries that exist but were not retained at all, because the
                per-level cap stopped them — a continuation can NEVER reach
                these, so the reader is sent to the source instead

  Collapsing the two would offer a control that silently fails to reach part of
  what it claims to show."
  [prepared limit]
  (let [unique (vec (:unique prepared))
        limit (page-limit limit)
        shown (vec (take limit unique))]
    {:shown shown
     :shown-count (count shown)
     :retained (count unique)
     :remaining (- (count unique) (count shown))
     :more? (> (count unique) (count shown))
     :beyond-cap (or (:over-cap prepared) 0)}))

(defn page-balances?
  "Every retained entry is either shown or counted as remaining."
  [{:keys [retained shown-count remaining]}]
  (= retained (+ (or shown-count 0) (or remaining 0))))

(defn can-continue?
  "Whether a 'Show more' control may be rendered for one level.

  Only when there are retained entries it can actually reveal. At the per-level
  cap there are none left to retain, so the control is withheld and the limit is
  explained instead — an inert continuation is worse than an honest stop."
  [page]
  (boolean (and page (pos? (or (:remaining page) 0)))))

(defn cap-hiding-anything?
  "Whether the per-level cap is actually withholding entries right now, as
  opposed to merely having been reached with nothing left behind it."
  [page]
  (boolean (and page (pos? (or (:beyond-cap page) 0)))))

;; --- the active trail -------------------------------------------------------

(defn trail-keys
  [trail]
  (into #{} (keep :key) trail))

(defn on-trail?
  "Whether `k` already appears on the ACTIVE trail — the path from the origin
  row down to the level now on screen.

  This is the ONLY cycle test. Two separate paths that both reach the same block
  are not a cycle: the reader who walks B → D → X and the reader who walks
  B → E → X has not revisited anything, and X stays explorable in both. Only a
  repeat on the path being walked is refused."
  [trail k]
  (boolean (and k (contains? (trail-keys trail) k))))

(defn trail-full?
  "Whether the retained navigation history is at its bound. The explorer refuses
  to go deeper rather than discarding the oldest step, so Back always restores
  what the reader actually walked."
  [trail]
  (>= (count (or trail [])) max-trail))

(defn new-step
  "One exploration level, before its read has answered.

  `:status` starts at `:loading` — the read has been asked for and has not
  answered — or `:no-identity` when the block carries no uuid to look up at all.
  Those are different situations and the reader is told which."
  [entity req]
  (let [u (:block/uuid entity)]
    {:key (step-key entity)
     :uuid u
     :entity entity
     :req req
     :limit default-batch
     :attempts 0
     :status (if u :loading :no-identity)
     :result nil
     :probes {}}))

(defn push-step
  "Append a step, unless the history bound is reached. At the bound the trail is
  returned unchanged; callers must also withhold the control, and do."
  [trail step]
  (let [t (vec (or trail []))]
    (if (trail-full? t) t (conj t step))))

(defn pop-step
  "Back one level. The origin step is never popped: the explorer always shows at
  least the level the reader opened it on, and closing it is a separate action."
  [trail]
  (let [t (vec (or trail []))]
    (if (<= (count t) 1) t (subvec t 0 (dec (count t))))))

(defn truncate-trail
  "Jump back to step `i`, discarding everything after it. Used by the path
  breadcrumb; `pop-step` is the same thing for the immediately previous step."
  [trail i]
  (let [t (vec (or trail []))]
    (if (and (int? i) (<= 0 i) (< i (count t)))
      (subvec t 0 (inc i))
      t)))

(defn current-step
  [trail]
  (last (vec (or trail []))))

(defn can-go-back?
  [trail]
  (> (count (vec (or trail []))) 1))

;; --- level and row states ---------------------------------------------------

(defn level-state
  "What one exploration level's read established. Six outcomes, kept distinct.

    :loading     — the read has been asked for and has not answered yet
    :no-identity — the selected block carries no uuid; there is nothing to look
                   up, and this is not a failure and not an empty answer
    :unavailable — the block no longer resolves, so it cannot be asked
    :error       — the read FAILED; whether references exist is UNKNOWN
    :empty       — the read succeeded and found no inbound reference at all
    :partial     — inbound references exist and some are deliberately not shown
    :ok          — inbound references exist and all of them are displayed

  `:empty` and `:error` are the pair that matters most: a failed read is not
  evidence that nothing refers to the block."
  [step page]
  (let [{:keys [status result]} step]
    (case status
      :no-identity :no-identity
      :unavailable :unavailable
      :error :error
      :loading :loading
      :loaded (cond
                (nil? result) :loading
                (zero? (or (:total result) 0)) :empty
                (or (pos? (or (:remaining page) 0))
                    (pos? (or (:beyond-cap page) 0))) :partial
                :else :ok)
      :loading)))

(defn probe-state
  "What one result row's OWN inbound probe established, as carried to its row.

    :ok          — the probe succeeded and found inbound references
    :none        — the probe succeeded and found none
    :error       — the probe FAILED; whether it has any is unknown
    :unavailable — the block itself could not be resolved
    :unknown     — it was not probed, which happens only for a cycle boundary,
                   whose descent is already refused by identity

  `:none` and `:error` must never be shown the same way: a row that could not be
  read is not a row known to be a dead end."
  [res]
  (cond
    (nil? res) :unknown
    (:error? res) :error
    (:missing? res) :unavailable
    (pos? (or (:total res) 0)) :ok
    :else :none))

(defn row-relation
  "Why one result row can or cannot become the next exploration step.

    :cycle  — its identity is already on the ACTIVE trail. It is shown once,
              marked, and offered the source and Back; it is never loaded again.
    :trail  — the retained-history bound is reached, so no row may be opened
    :ok / :none / :error / :unavailable — this row's own probe outcome

  The cycle test comes first, so a repeat is named as a repeat even at the
  history bound, and `:unknown` never reaches a row: a cycle row is not probed,
  and `:cycle` is what it reports."
  [k trail probe]
  (cond
    (on-trail? trail k) :cycle
    (trail-full? trail) :trail
    :else (probe-state probe)))

(defn can-explore?
  "Whether a result row may carry a control that takes the next step. Exactly
  one relation earns one, so no control is ever offered where activating it
  could not open a level."
  [relation]
  (= :ok relation))

(defn probe-count
  "How many inbound references a row is KNOWN to have, or nil when that is
  unknown. Nil rather than zero: zero would assert 'nothing references this',
  which is exactly what a failed or unresolvable probe did not establish."
  [probe]
  (when (#{:ok :none} (probe-state probe))
    (:total probe)))

;; --- applying a read that has come back -------------------------------------

(defn accepts-result?
  "Whether an answer that has come back still belongs to the level on screen.

  A reader who presses Back, or takes another step, while a read is in flight
  must not have the old answer land on the new level. Each level carries the
  request id it was created with, and only that id is accepted."
  [trail req]
  (= req (:req (current-step trail))))

(defn apply-result
  "Fold a completed read into the current level, or drop it.

  `outcome` is merged into the level — {:status :loaded :result ... :probes ...}
  or {:status :error} — but only when it answers the level now on screen. An
  answer for a level the reader has already left is discarded rather than
  overwriting a newer one."
  [trail req outcome]
  (let [t (vec (or trail []))
        i (dec (count t))]
    (if (and (>= i 0) (accepts-result? t req))
      (assoc t i (merge (nth t i) outcome))
      t)))

(defn set-limit
  "Raise the current level's display limit. Pure: the entries were retained by
  the level's own read, so continuation reveals more of what is already held
  rather than starting another read."
  [trail limit]
  (let [t (vec (or trail []))
        i (dec (count t))]
    (if (>= i 0)
      (assoc t i (assoc (nth t i) :limit (page-limit limit)))
      t)))

(defn reload-step
  "Put the current level back into `:loading` under a fresh request id, keeping
  its place on the trail and its display limit.

  The old request id is abandoned, so an answer still in flight for it is
  dropped by `apply-result` instead of racing the new one."
  [trail req]
  (let [t (vec (or trail []))
        i (dec (count t))]
    (if (>= i 0)
      (assoc t i (assoc (nth t i)
                        :status (if (:uuid (nth t i)) :loading :no-identity)
                        :result nil :probes {} :req req))
      t)))

(defn mark-retry
  "Count one retry of the current level's failed read and reload it. The count
  is what keeps the retry offer bounded rather than endless."
  [trail req]
  (let [t (reload-step trail req)
        i (dec (count t))]
    (if (>= i 0)
      (assoc t i (update (nth t i) :attempts (fnil inc 0)))
      t)))

;; --- display ----------------------------------------------------------------

(defn block-label
  "A safe display string for a referring block, so one deleted between the read
  and the render degrades to a marker instead of an empty row."
  [e]
  (let [c (:block/content e)]
    (when (and (string? c) (not (string/blank? c))) c)))

(def ^:private block-ref-re
  "`((uuid))` — an inline reference to another block."
  #"\(\(\s*[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\s*\)\)")

(def ^:private md-image-re
  "`![alt](path)` — a markdown image. The leading `!` is the only thing that
  distinguishes it from a link, and it is exactly the character the link
  reduction below used to leave stranded in a label."
  #"!\[([^\[\]]*)\]\(([^()]*)\)")

(def ^:private md-link-re #"\[([^\[\]]*)\]\(([^()]*)\)")
(def ^:private page-ref-re #"\[\[([^\[\]]+)\]\]")

(def ^:const block-ref-marker
  "What an inline block reference is reduced to in a compact label. One
  character, so it says a reference is there without spending the whole label
  saying it."
  "↗")

(defn- image-name
  "What a markdown image is reduced to in a compact label.

  The author's own alt text, or — when they wrote none, which is the common
  case — the file's own name, percent-decoded so a Korean or spaced filename
  reads as it was given. A live run showed a Crystal chip reading
  `!wide diagram and after the …`, and an image written with no alt text
  reducing to a bare `!` that named nothing.

  `frontend.util.f27-assets` owns the richer naming used for a RENDERED asset
  chip; this is the reduction of raw markup inside a compact label, and it
  cannot call that namespace without a require cycle. The two agree on the only
  thing that matters here: a name is never a path and never markup."
  [alt href]
  (let [alt (string/trim (or alt ""))]
    (if-not (string/blank? alt)
      alt
      (let [p (string/replace (or href "") #"[?#].*$" "")
            base (when-not (string/ends-with? p "/") (last (string/split p #"/")))
            base (try (js/decodeURIComponent (or base "")) (catch :default _ base))]
        (string/trim (or base ""))))))

(defn plain-label
  "A readable compact label for a block: a path breadcrumb entry, or a control's
  accessible name.

  A REFERRING block contains a reference by definition, so its raw text always
  carries `((uuid))` — 38 characters of identifier that fill a short label
  completely and push out the words a reader would recognise. `\"B refers to the
  target ((6a9c0000-0000-4…\"` names nothing.

  Inline reference markup is therefore reduced to what a person reads: a page
  reference keeps its page name, a markdown link keeps its link text, an image
  becomes its alt text or its file's name, and a block reference — whose target
  text is not available to a pure function — becomes a single marker.

  This affects ONLY compact labels. The block itself is never altered, and the
  row's own text is still rendered in full by OG's inline renderer, block
  references included."
  [content]
  (when (string? content)
    (-> content
        (string/replace block-ref-re block-ref-marker)
        ;; Images first: `![alt](path)` is also a link with a `!` in front of
        ;; it, so reducing links first leaves the `!` behind.
        (string/replace md-image-re (fn [[_ alt href]] (image-name alt href)))
        (string/replace md-link-re "$1")
        (string/replace page-ref-re "$1"))))
