(ns frontend.util.f27-page-embed
  "F27 page-embed slice — the pure decision behind an EXPANDABLE `{{embed [[Page]]}}`.

  The block-embed slice gave `{{embed ((block-id))}}` one control that shows the
  target block's own text, and deliberately left a page embed named and
  source-only. A reader who meets an embedded page in a panel can see THAT a page
  is embedded and where it lives, and never any part of what it says.

  OG's own page embed is the reason that was deferred: it renders the page
  through the ordinary block pipeline — every block, at every depth, with
  `:link-depth` incremented — which is the unbounded substitution these panels
  exist to stop.

  This namespace decides two things, and reads nothing to do either:

    * whether a particular `{{embed [[Page]]}}`, on a particular surface, may
      offer a control that shows an EXCERPT of the page — and, when it may not,
      WHY, so the chip can say so instead of being silently ordinary;
    * how far the page's top-level chain may be followed, given a `step` the
      caller supplies, so that malformed data cannot spin and a broken chain is
      never reported as an empty page.

  One measured fact shapes the outcomes below. Writing `{{embed [[Ghost]]}}`
  ITSELF makes `Ghost` exist as a page entity — the parser records the reference
  — so a page embed's own argument always resolves to something. `some?` is
  therefore never the existence test here, exactly as it was never the right
  test for a block embed. What separates a page from a name that is merely
  linked is whether the graph has a FILE for it.

  It renders nothing, reads no database and no filesystem, and executes nothing.
  Resolution and rendering belong to the caller. The safety argument for the
  excerpt's CONTENT is deliberately not in here: an excerpt re-uses the panel's
  existing guarded renderer one level down, so every guard already written —
  closed reference chips, compact assets, inert macros, inert markup, no
  children — applies to it without a new rule.

  `frontend.util.f27-embed` is not touched by this namespace. Block-embed
  planning keeps its exact signature, outcomes and precedence; the one thing the
  two share is the per-body ledger, because the four-offer budget is shared."
  (:require [clojure.string :as string]
            [frontend.util.f27-embed :as f27e]
            [logseq.graph-parser.util :as gp-util]))

;; ---------------------------------------------------------------------------
;; Bounds
;; ---------------------------------------------------------------------------

(def ^:const blocks-per-request
  "Top-level blocks added by ONE press of the control.

  Small on purpose: an excerpt is something a reader asks for a piece at a time,
  and a first press that produced twenty blocks would be a page view with extra
  steps."
  5)

(def ^:const max-page-blocks
  "Top-level blocks one excerpt may retain, ever.

  Beyond this the excerpt says so and offers the page. It is a retention bound,
  not a display bound: nothing past it is read, so there is no larger result
  being hidden behind a smaller rendering."
  20)

(def ^:const max-block-chars
  "Displayed characters EACH block in an excerpt may show.

  The same number the block-embed expansion allows one target, measured and cut
  by the same `displayed-length` / `take-nodes` — graphemes, formatting
  included, atomic nodes refused rather than half-emitted."
  420)

(def ^:const max-walk-steps
  "Steps the top-level walk may take before it gives up.

  `:block/left` is a linked list IN DATA, and data can be wrong. The visited-set
  below catches a chain that points back at itself; this catches the rest — a
  chain longer than any page's top level should be, and a run of pre-blocks that
  are skipped rather than retained.

  It is comfortably more than twice `max-page-blocks` plus its lookahead, so a
  well-formed page never reaches it, and a malformed one stops in bounded time
  and SAYS it stopped."
  64)

(def ^:const max-step-candidates
  "Blocks ONE step may consider before it gives up.

  A step asks which blocks claim a given block as their left. In a well-formed
  outline that is at most two — the next sibling and that block's own first
  child. Malformed data can make it any number, and a step that walked all of
  them would be an unbounded read hidden inside a bounded walk."
  8)

;; ---------------------------------------------------------------------------
;; Identity
;;
;; A page identity must never collide with a block identity: both share one
;; render trail and one ledger, and a page NAMED like a uuid would otherwise be
;; treated as the block with that uuid. The prefix is the whole mechanism.
;; ---------------------------------------------------------------------------

(def ^:private page-key-prefix "f27-page:")

(defn page-key
  "One page identity, in the single form the render trail and ledger compare.

  Built from OG's OWN `page-name-sanity-lc`, which is what `:block/name` holds,
  so a name written `[[Deep Work]]` in a note and the page entity it resolves to
  produce the same identity. Lower-casing alone would not: sanitising also
  normalises path form and boundary slashes, and a trail that compared two
  different spellings would never detect the repeat it exists for.

  nil for a blank name, which is what `{{embed [[]]}}` parses to — the caller
  says *(no page named)* rather than looking anything up."
  [name]
  (let [s (some-> name str string/trim not-empty gp-util/page-name-sanity-lc)]
    (when-not (string/blank? s)
      (str page-key-prefix s))))

(defn page-key?
  "True for an identity produced by `page-key`, and only that."
  [k]
  (boolean (and (string? k) (string/starts-with? k page-key-prefix))))

;; ---------------------------------------------------------------------------
;; Classification
;;
;; Two phases on purpose. Establishing that a page is EMPTY costs a read of the
;; page's outline, and that read must not happen on a surface that was never
;; going to offer an excerpt — a breadcrumb, a bounded preview, a repeat, or a
;; body that has spent its budget. Splitting the decision is what makes "the
;; probe runs only where an excerpt is offered" a fact about the code rather
;; than a promise about the caller.
;; ---------------------------------------------------------------------------

;; `excerpt-outcome` asks the walk section's question about what a stopped walk
;; means; the walk itself is defined below, next to the bounds it enforces.
(declare walk-failed?)

(defn surface-outcome
  "How ONE `{{embed [[Page]]}}` must be presented, BEFORE its outline is read.

  `kind`        what the macro's argument points at, as the inert boundary
                already classifies it — only `:page` is claimed here
  `id`          the page's identity from `page-key`, or nil for a blank name
  `entity?`     whether ANYTHING in the graph carries this page name. True even
                for a name that is only ever linked, including by this very
                embed, so it is never on its own a reason to show content
  `file?`       whether the graph has a file for it. In a file graph a page's
                blocks come from its file, so this is what separates a page
                from a name somebody wrote in brackets
  `read-error?` whether the lookup threw
  `level`       0 while rendering the block's own text, ≥ 1 inside a preview or
                inside an expanded embed
  `compact?`    true on a one-line surface such as a row's breadcrumb
  `trail`       identities already being rendered above this point, including
                the host block and the page it lives on
  `ledger`      this body's record of the embeds it has already offered —
                SHARED with block embeds, which is the whole point of it

  Returns:
    :not-page     not a page argument; presentation is unchanged
    :unnamed      `{{embed [[]]}}`; nothing to name and nowhere to go
    :error        the lookup threw; never reported as an empty page
    :missing      nothing in this graph carries the name. Not created to find
                  out — and, because an embed's own argument creates the entity,
                  a parsed graph reaches this only when reference extraction did
                  not happen at all
    :uncreated    the name exists as a link target and has no file. This is what
                  `{{embed [[a page nobody has written]]}}` actually is
    :repeat       the page this block lives on, an excerpt already open above,
                  or a second copy of one page in this body
    :closed       a bounded or compact surface; named, never expandable here
    :budget       this body already offers as many embeds as it may
    :may-excerpt  the surface allows an excerpt — read the outline now

  The precedence is the one the body contract already uses, with the same
  reasoning: something that is NOT THERE outranks something that repeats,
  because 'there is no such page' explains what the reader is seeing and 'shown
  above' does not; and a repeat outranks depth for the mirror-image reason."
  [{:keys [kind id entity? file? read-error? level compact? trail ledger]}]
  (cond
    (not= :page kind) :not-page
    (nil? id) :unnamed
    read-error? :error
    (not entity?) :missing
    (not file?) :uncreated
    (contains? (or trail #{}) id) :repeat
    (f27e/offered? ledger id) :repeat
    (or (pos? (or level 0)) (boolean compact?)) :closed
    (f27e/full? ledger) :budget
    :else :may-excerpt))

(defn excerpt-outcome
  "The final outcome, once the page's outline HAS been read.

  `surface` is `surface-outcome`'s answer and is returned unchanged unless it
  was `:may-excerpt`. `excerpt` is the result of `f27-page/top-level-excerpt`.

  Adds:
    :empty   the page has a file and its outline holds no readable top-level
             block — a page written as a bare `-`, or one carrying only
             properties
    :error   the read threw, or the walk stopped on a bound or a cycle WITHOUT
             reading anything. A broken chain is a read failure, NEVER an empty
             page: that is the whole reason `:stopped` is carried this far
    :expand  offer the control"
  [surface {:keys [state blocks walk] :as _excerpt}]
  (if (not= :may-excerpt surface)
    surface
    (cond
      (= :error state) :error
      (seq blocks) :expand
      (walk-failed? walk) :error
      :else :empty)))

(defn expandable?
  "True for the one outcome that offers the control."
  [outcome]
  (= :expand outcome))

;; ---------------------------------------------------------------------------
;; The bounded walk
;;
;; Pure: it is handed a `step`, so the reading is entirely the caller's, and the
;; termination argument is entirely here and entirely testable.
;; ---------------------------------------------------------------------------

(defn wanted
  "How many top-level blocks an excerpt showing `shown` of them has retained.

  Clamped to `max-page-blocks` at both ends, so a caller cannot ask for more
  than may ever be retained and a fresh excerpt always asks for one request."
  [shown]
  (-> (or shown 0) (max blocks-per-request) (min max-page-blocks)))

(defn next-wanted
  "How many `Show more` would retain, given how many are retained now."
  [shown]
  (min max-page-blocks (+ (wanted shown) blocks-per-request)))

(defn more-retainable?
  "May this excerpt retain more than it does?"
  [shown]
  (< (wanted shown) max-page-blocks))

(defn walk-top-level
  "Follow a page's top-level chain for at most `want` blocks, plus one lookahead.

  `start-id`  the page's own identity: the first top-level block's `left`
  `want`      how many blocks are wanted, at most `max-page-blocks`
  `step`      (fn [prev-id] -> {:id .. :skip? bool :block ..} or nil or :refused)

              ONE bounded read, entirely the caller's. `:refused` means the step
              itself hit its candidate bound and is the caller's way of saying
              'this chain is not answerable', which is not the same as its end.

              `:skip?` means 'step over this one and do not count it'. The
              caller decides why: the page's own properties block, which OG's
              outline does not show as a block either, or a block with no
              readable text, which a page written as a bare `-` consists of.

  Returns:
    :blocks   the wanted blocks, in the order the chain gave them, skipped
              blocks neither retained nor counted
    :more?    whether a further block was found beyond the wanted ones. The FACT
              only: the remainder is never counted, because counting it is
              unbounded
    :steps    how many steps were actually taken, INCLUDING the one that found
              the chain's end
    :visited  how many blocks were stepped on, skipped ones included. Zero means
              the chain had no head at all, which the caller can tell apart from
              an empty page — see `walk-failed?`
    :stopped  :end       the chain ended — this is the whole top level
              :want      the lookahead succeeded; there is more
              :steps     `max-walk-steps` was reached
              :cycle     an identity repeated
              :candidates a step refused

  `:steps`, `:cycle` and `:candidates` are failures and the caller must present
  them as such. A walk that stopped on one of them having read nothing is a READ
  FAILURE, not an empty page — that distinction is the reason this returns
  `:stopped` at all rather than just a vector."
  [start-id want step]
  (let [want (-> (or want 0) (max 0) (min max-page-blocks))]
    (letfn [(done [out steps seen stopped more?]
              {:blocks (vec (take want out))
               :more? more?
               :steps steps
               :visited seen
               :stopped stopped})]
      (loop [prev start-id
             visited #{start-id}
             seen 0
             steps 0
             out []]
        (cond
          ;; The lookahead succeeded: `want` are retained and one more exists.
          (> (count out) want) (done out steps seen :want true)

          (>= steps max-walk-steps) (done out steps seen :steps false)

          :else
          (let [nxt (step prev)
                steps (inc steps)]
            (cond
              (= :refused nxt) (done out steps seen :candidates false)

              (nil? nxt) (done out steps seen :end false)

              ;; The chain pointed at something already walked. `:block/left` is
              ;; single-valued, so a page's chain cannot normally return to
              ;; itself and this is a guard rather than an everyday case — but a
              ;; guard is what stops a walk spinning on data nobody predicted.
              (contains? visited (:id nxt)) (done out steps seen :cycle false)

              :else
              (recur (:id nxt)
                     (conj visited (:id nxt))
                     (inc seen)
                     steps
                     ;; A skipped block is stepped over and never counted, but it
                     ;; DOES cost a step — which is why the step bound has room
                     ;; for a run of them.
                     (if (:skip? nxt) out (conj out nxt))))))))))

(defn walk-failed?
  "Did this walk stop on anything other than the chain's honest end?

  `:orphaned` is added by the caller, which alone can ask the cheap question
  this walk cannot: the chain produced no head, yet the page HAS blocks. That is
  an outline whose first link is broken, and presenting it as an empty page
  would be exactly the failure-as-success this contract forbids."
  [{:keys [stopped]}]
  (contains? #{:steps :cycle :candidates :orphaned :error} stopped))
