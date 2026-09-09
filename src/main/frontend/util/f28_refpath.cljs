(ns frontend.util.f28-refpath
  "F28 first slice — the pure decisions behind the SOURCE-PATH disclosure in a
  page's linked-references list.

  OG groups linked references by source page and then by the referencing block's
  parent, and renders one breadcrumb per group through
  `frontend.components.block/breadcrumb` with `:level-limit 3`. That function
  reads `level-limit + 1` ancestors, shows the nearest three, and emits a bare
  `⋯` when a fourth came back. Measured in the application: the marker has no
  role, no tabindex, no title and no label, pressing it does nothing, nothing in
  the whole section can take focus, and the elided ancestors are ABSENT from the
  page rather than hidden on it.

  This namespace is PURE. It reads no database, renders nothing and persists
  nothing. The caller injects a `parent-fn` and does the walking through
  `frontend.util.f27-context/load-ancestors`, which already owns the three
  properties that matter — bounded batches with explicit continuation, a
  visited-identity guard that stops a cycle before it recurses, and a failed
  lookup that stays distinguishable from reaching the top.

  Three things live here, and each is tested without a renderer:

    * WHERE THE CONTROL BELONGS IS A NAMED DECISION. `excluded-surface` answers
      with the REASON a surface is excluded rather than with a bare false, so
      every exclusion in the specification is a separate falsifiable test and an
      accidental widening cannot hide behind one boolean.

    * WHAT IS DISCLOSED IS WHAT OG DID NOT SHOW. `disclosure` subtracts the
      levels the breadcrumb already renders, so the panel never repeats a step
      that is already on screen and never claims to have shown one it has not.

    * AN INCOMPLETE PATH NEVER SPEAKS AS A COMPLETE ONE. A cycle, a read failure
      and the hard cap are three different answers, each withdrawing the
      continuation control for its own reason, and none of them is
      `:complete`."
  (:require [frontend.util.f27-context :as f27c]
            [frontend.util.f27-outgoing :as f27o]))

;; ---------------------------------------------------------------------------
;; Constants
;; ---------------------------------------------------------------------------

(def ^:const og-visible-levels
  "How many ancestors OG's linked-reference breadcrumb already shows.

  `frontend.components.block/breadcrumb` defaults `:level-limit` to 3 and every
  call site passes 3 or nothing. Named here so the subtraction below is one
  fact in one place rather than a literal repeated beside each use, and so a
  test can state the coupling instead of assuming it."
  3)

(def ^:const batch
  "Ancestor levels added per press, above what OG already shows."
  8)

(def ^:const max-step-chars
  "Display bound for one path step. A step names a position, not a block: the
  reader is looking for WHERE, and a long ancestor that pushed the rest of the
  path off the row would defeat the disclosure it belongs to."
  80)

;; ---------------------------------------------------------------------------
;; Where the control belongs
;; ---------------------------------------------------------------------------

(def exclusion-reasons
  "Every reason a surface gets NO control, in the order they are checked.

  Listed as data so a test can assert the set has not silently grown or shrunk:
  adding a surface to this feature means REMOVING a reason from here, which is a
  visible change rather than a quietly deleted `cond` clause."
  [:no-elision :not-source-path-list :f27-panel :mobile :preview :slide :sidebar
   :block-refs-list :embed :query :html-export :whiteboard])

(defn excluded-surface
  "The reason this surface gets no control, or nil when the control belongs here.

  Takes plain booleans, so the caller's mapping from OG's `config` to this
  question is the only place OG's shape is known.

    :elided?           OG's own breadcrumb elided ancestors, so there is a path
                       to disclose. Only `breadcrumb` knows this — it is the
                       function that computes `more?` — which is why the control
                       is handed to it as a closure and invoked at the `:more`
                       marker and nowhere else. A reference whose whole path OG
                       already shows gains nothing at all
    :source-path-list? the config was opted in by
                       `frontend.components.reference/references*`
    :f27-panel?        rendering inside an F27 panel body
    :mobile?           mobile or native platform
    :preview?          inside a hover preview or a page preview
    :slide?            presentation mode
    :sidebar?          the right sidebar's copy of the list
    :block-refs-list?  `block-linked-references`, which renders under any block
                       on any surface; not this slice
    :embed?            a block or page embed surface
    :query?            a custom query's grouped results, which reach the same
                       `breadcrumb-with-container`
    :html-export?      HTML export output
    :whiteboard?       a whiteboard surface

  Order matters only for which reason is REPORTED; any true flag excludes."
  [{:keys [elided? source-path-list? f27-panel? mobile? preview? slide? sidebar?
           block-refs-list? embed? query? html-export? whiteboard?]}]
  (cond
    (not elided?)           :no-elision
    (not source-path-list?) :not-source-path-list
    f27-panel?              :f27-panel
    mobile?                 :mobile
    preview?                :preview
    slide?                  :slide
    sidebar?                :sidebar
    block-refs-list?        :block-refs-list
    embed?                  :embed
    query?                  :query
    html-export?            :html-export
    whiteboard?             :whiteboard
    :else                   nil))

(defn offer-control?
  "True when this surface gets the control. The complement of
  `excluded-surface`, kept as its own name because that is what the caller
  asks."
  [surface]
  (nil? (excluded-surface surface)))

(defn surface-allows?
  "True when everything EXCEPT the elision rule permits the control here.

  The caller and `breadcrumb` know different halves of the question. The caller
  knows which surface it is; only `breadcrumb` knows whether it elided anything,
  because it is the function that computes `more?`. So the caller asks this,
  hands the control to `breadcrumb` as a closure, and `breadcrumb` invokes it at
  the `:more` marker and nowhere else — which is the other half.

  Asking this instead of `offer-control?` is what keeps a closed control free:
  no ancestor walk and no second query is needed to find out whether OG cut the
  path, because OG has already worked that out for its own rendering."
  [surface]
  (offer-control? (assoc surface :elided? true)))

;; ---------------------------------------------------------------------------
;; How far up to read
;; ---------------------------------------------------------------------------

(defn request-limit
  "How many ancestor levels to load for the `n`th press, counting from 1.

  The walk must cover the levels OG already shows as well as the ones being
  disclosed, because it starts from the referencing block, not from the point
  where OG stopped. Capped at `f27-context/hard-cap`, which is also where
  `load-ancestors` caps itself; naming it here keeps the two from disagreeing."
  [n]
  (min f27c/hard-cap (+ og-visible-levels (* batch (max 1 (or n 1))))))

(defn next-press
  "The press number after `n`, or nil when continuing cannot reach anything.

  Four separate reasons to withhold it, and the last is the one a status alone
  would miss: when this press already asked for the hard cap, the next press
  would ask for the same number and read the same levels again."
  [n {:keys [more? cycle? error? capped?]}]
  (let [n (max 1 (or n 1))]
    (when (and more? (not cycle?) (not error?) (not capped?)
               (< (request-limit n) f27c/hard-cap))
      (inc n))))

;; ---------------------------------------------------------------------------
;; What to disclose
;; ---------------------------------------------------------------------------

(defn status
  "The ONE thing the panel says about how far the path was read.

  Four of these five withdraw the continuation control, each for its own reason,
  and none of them may be described as a complete path:

    :complete   the walk reached the source page; nothing is missing
    :partial    more ancestry exists and can be requested
    :cycle      the parent chain revisited an identity and stopped
    :unreadable a parent lookup failed; what is above is unknown
    :capped     the hard cap stopped the walk and ancestry still remains

  `:unreadable` outranks `:cycle` and `:capped`: a failed read means the walk
  cannot describe what it met, so it must not name a more specific cause."
  [{:keys [more? cycle? error? capped?]}]
  (cond
    error?  :unreadable
    cycle?  :cycle
    capped? :capped
    more?   :partial
    :else   :complete))

(defn disclosure
  "Turn one `load-ancestors` result into the steps this panel shows.

  `loaded`  the map `frontend.util.f27-context/load-ancestors` returned, whose
            `:ancestors` are NEAREST FIRST and may end with the source page
  `shown`   how many block ancestors OG's breadcrumb is already displaying
            (`og-visible-levels`, unless a caller is asked for something else)

  Returns:
    :steps      the ancestors OG did NOT show, OUTERMOST FIRST — the reading
                order of a path, and the order the panel renders
    :page       the source page entity if the walk reached it, else nil
    :hidden     how many steps that is
    :visible    how many block ancestors were left to OG
    :depth      block ancestors loaded in total
    :status     from `status`, above
    :continue?  whether asking for more can reach anything
    :complete?  the whole path from the source page down is now on screen

  A walk that loaded no more than OG already shows discloses NOTHING and says
  so, rather than repeating the three steps already on the row: that is what
  makes `:hidden` 0 with `:status` `:partial` a meaningful state — more exists,
  and this press did not reach it."
  ([loaded] (disclosure loaded og-visible-levels))
  ([loaded shown]
   (let [shown (max 0 (or shown 0))
         ancestors (vec (:ancestors loaded))
         page (first (filter f27c/page-entity? ancestors))
         blocks (vec (remove f27c/page-entity? ancestors))
         elided (vec (drop shown blocks))
         st (status loaded)]
     {:steps (f27c/display-order elided)
      :page page
      :hidden (count elided)
      :visible (min shown (count blocks))
      :depth (count blocks)
      :status st
      :continue? (= st :partial)
      :complete? (= st :complete)})))

(defn step-prefix
  "The block-level structure of one path step, kept out of its text.

  A heading ancestor whose content begins `## ` and a task ancestor beginning
  `TODO ` would otherwise read as literal `##` and `TODO` in a plain label. Same
  split `frontend.util.f27-context` already makes for a context line, reused so
  the two surfaces describe an ancestor the same way."
  [content]
  (f27c/split-block-prefix content))

(defn step-key
  "A stable key for one rendered step.

  Position is part of it on purpose: a path may legitimately contain the same
  identity twice only in a broken outline, but it very often contains the same
  TEXT twice — the fixture's four `같은 이름 Same Name` levels are exactly that —
  and a key made from text alone would collapse them into one row."
  [idx e]
  (str idx "-" (or (:block/uuid e) (:db/id e) "?")))

;; ---------------------------------------------------------------------------
;; Where a disclosed step goes
;;
;; The first slice deliberately left every disclosed step INERT (limit L5): the
;; reader could see where a reference sat and could not go there. This is the
;; other half, and it is the half where guessing would do real damage — so the
;; decision is pure, and it is made from IDENTITY alone.
;;
;; Three rules, each its own falsifiable test:
;;
;;   * a step travels on its `:block/uuid` and on nothing else. Not its text,
;;     not its position in the panel, not the page it was read from. A path may
;;     legitimately contain several levels reading exactly the same words — the
;;     fixture's `같은 이름 Same Name` chain is precisely that — so a
;;     destination found by label would be a coin toss between them;
;;
;;   * the identity is RE-RESOLVED at the moment of activation, and the answer
;;     that decides is the fresh one. The panel's steps were read when the panel
;;     last rendered, which may be some time ago and is not kept current by
;;     anything (L4);
;;
;;   * anything other than "this exact block is there now" REFUSES. It does not
;;     fall back to the page, to a parent, to a block with the same text, or to
;;     creating what is missing. `route-handler/redirect-to-page!` creates a
;;     page when it is handed a name that does not resolve — which is why a name
;;     is never what this hands it.
;; ---------------------------------------------------------------------------

(defn step-identity
  "The stable identity one disclosed step travels on, or nil when it has none.

  `:block/uuid` and nothing else. `:db/id` is a datascript-internal number that
  does not survive a re-index and means nothing outside the current database
  value, so a step carrying only that one is not offered as a destination at
  all rather than being sent somewhere plausible."
  [e]
  (:block/uuid e))

(defn navigable-step?
  "True when this step can be offered as a destination.

  Asked while RENDERING, so a step with no stable identity is drawn as the
  plain label it always was instead of as a control that would refuse when it
  was pressed."
  [e]
  (some? (step-identity e)))

(defn readable-block?
  "True when a freshly resolved entity is a block somebody actually wrote.

  **Added 2026-09-09 after supervisor review.** `navigation` accepted any
  non-page entity whose identity matched, so `{:block/uuid captured :db/id 123}`
  reached `:open`. Entity existence is not proof of a readable source block: OG
  can retain an identity-only entity for a reference nobody has written, and
  transacting a lookup ref that resolves to nothing CREATES exactly that. The
  promise this control makes — *it opens its existing source block* — was
  therefore not kept for a placeholder.

  `frontend.util.f27-outgoing/readable-target?` is the convention the F27 work
  already settled on for this question, and it decides the same half here: an
  entity with `:block/content` PRESENT. This adds one thing to it — the content
  must be a STRING — because an absent field and a field holding something that
  is not text are the same fact for a reader, and neither is a block to open.

  A block somebody wrote and left EMPTY keeps its content as `\"\"`, which is
  present and is a string, so it stays openable. That distinction is the whole
  point: `\"\"` is a real position in the outline with nothing written at it,
  and the panel already has a sentence for a step with no text."
  [e]
  (boolean (and (f27o/readable-target? e)
                (string? (:block/content e)))))

(def navigation-refusals
  "Every reason activating a step does NOT navigate, in the order checked.

  Data rather than a bare `false`, for the same reason `exclusion-reasons` is:
  each one is a separate test, and each one gets its own sentence on screen. A
  refusal that cannot say why it refused is indistinguishable from a control
  that is simply broken."
  [:no-identity :unreadable :missing :mismatch :page :placeholder])

(defn navigation
  "What activating one disclosed step must do.

  `captured` is the identity the step was rendered with. `lookup` is what the
  caller got when it re-resolved THAT identity just now — the caller performs
  it, because only the caller may touch a database:

    {:found entity-or-nil}   the lookup answered; nil means nothing is there
    {:error true}            the lookup could not be performed at all

  Answers:

    {:action :open  :uuid …}      go to this block, by identity
    {:action :refuse :reason …}   say so, and do nothing else

  `:unreadable` and `:missing` are kept apart on purpose, the same way
  `load-ancestors` keeps a failed lookup apart from reaching the top: 'this
  block is gone' and 'this could not be checked' are different facts about the
  reader's notes, and a refusal that merges them tells them something that may
  not be true.

  `:mismatch` cannot arise from a lookup by `:block/uuid` alone and is kept
  anyway: it is the difference between 'the caller proved the destination' and
  'the caller looked something up', so a future caller resolving by another
  route is refused here rather than trusted.

  `:page` is the same kind of guard. `disclosure` separates the source page out
  of the steps, so a page cannot reach this; if one ever does, the honest answer
  is that this control does not know where it would be sending the reader.

  `:placeholder` is the one this function got wrong until 2026-09-09: a matching
  identity was taken as proof of a block. It is not — see `readable-block?`."
  [captured lookup]
  (let [fresh (:found lookup)]
    (cond
      (nil? captured)                     {:action :refuse :reason :no-identity}
      (:error lookup)                     {:action :refuse :reason :unreadable}
      (nil? fresh)                        {:action :refuse :reason :missing}
      (not= captured (:block/uuid fresh)) {:action :refuse :reason :mismatch}
      (f27c/page-entity? fresh)           {:action :refuse :reason :page}
      (not (readable-block? fresh))       {:action :refuse :reason :placeholder}
      :else                               {:action :open :uuid (:block/uuid fresh)})))

(defn opened
  "The identity `navigation` decided to open, or nil when it refused.

  Named so a caller cannot navigate by reading `:uuid` off a refusal that never
  set one."
  [decision]
  (when (= :open (:action decision)) (:uuid decision)))

(defn refused
  "The reason `navigation` refused, or nil when it did not."
  [decision]
  (when (= :refuse (:action decision)) (:reason decision)))

(defn refusal-placement
  "Where the panel must say that a step could not be opened.

  **Added 2026-09-09 after supervisor review.** The refusal was recorded against
  a step's RENDER KEY, which is `position-identity`. Two redraws break that, and
  both are ordinary:

    * the second press of a deep path prepends the outer levels, so every step
      shifts position and the same block's key changes;
    * a walk that fails higher up returns fewer steps, so the refused row leaves
      the panel altogether.

  In either case the message silently disappeared, and a reader who pressed
  something was told nothing at all. Keyed by IDENTITY instead:

    nil               nothing has been refused
    {:on-step uuid}   a rendered step carries that identity — say it there
    {:on-panel true}  it does not — say it for the panel, because the row going
                      away is not a reason to stop explaining what happened

  A refusal with no identity at all also lands on the panel: it cannot be
  attached to a row, and dropping it would be the same silence."
  [refusal steps]
  (when (:reason refusal)
    (let [u (:uuid refusal)]
      (if (and u (some #(= u (:block/uuid %)) steps))
        {:on-step u}
        {:on-panel true}))))

(defn refusal-on-step?
  "True when this step is the one that refused. Asked once per rendered row, so
  the comparison lives here rather than being spelled out in a hiccup body."
  [placement e]
  (boolean (and (:on-step placement)
                (= (:on-step placement) (:block/uuid e)))))
