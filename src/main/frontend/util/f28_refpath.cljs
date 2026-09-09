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
  (:require [frontend.util.f27-context :as f27c]))

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
