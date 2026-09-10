(ns frontend.util.f28-refctx
  "F28 child context — the pure decisions behind disclosing what is written
  UNDER a linked reference.

  OG's linked-references list already shows a reference's own children, and
  shows them well: `frontend.db.model/get-page-referenced-blocks` selects on
  `:block/path-refs`, which a block inherits from every ancestor, so the result
  set holds the blocks that name the page and their descendants, and the
  ordinary outline renderer draws them in the right hierarchy and the right
  order. That was measured before this namespace existed and it is not this
  feature's to change.

  Where it STOPS is this feature's subject.
  `frontend.modules.outliner.tree/non-consecutive-blocks->vec-tree` numbers a
  reference's own subtree from 1, and `editor-handler/block-default-collapsed?`
  collapses a `:ref?` row once `:block/level` reaches
  `state/get-ref-open-blocks-level` — 2 by default. `block-children` renders
  nothing for a collapsed row. Measured in the packaged application: the whole
  section drew `:block/level` `[nil 1 2]` and nothing else, 20 blocks sat behind
  4 collapsed rows and none of them was drawn, they were ABSENT from the page
  rather than hidden on it, nothing said how much was behind, and of the 53 fold
  controls in the section 0 could take focus.

  This namespace is PURE. It reads no database, renders nothing and persists
  nothing. The caller injects a `children-fn` and does the walking through
  `frontend.util.f27-children/build-plan`, which already owns every property
  that matters — immediate-children-only fetches, bounded batches with explicit
  continuation, a cycle guard on the active trail, a depth safeguard, a shared
  visible-row safeguard, and probe outcomes that stay distinguishable from an
  ordinary leaf.

  Three things live here, and each is tested without a renderer:

    * WHERE THE CONTROL BELONGS IS A NAMED DECISION, and it is the source-path
      slice's own decision. `excluded-surface` DELEGATES every shared exclusion
      to `frontend.util.f28-refpath/excluded-surface` rather than restating it,
      so the two features cannot drift apart, and adds only the two conditions
      that are its own.

    * A CLOSED CONTROL ASKS NOTHING NEW. `withheld?` is decided from
      `collapsed?` and `has-children?`, both of which `block-container-inner`
      has already computed for its own rendering — it combines them into its
      `data-collapsed` attribute — so deciding whether the control exists costs
      no walk, no probe and no second query.

    * A DISCLOSED DESCENDANT IS PLAIN TEXT. `plain-row` reduces one block to a
      bounded label with its heading level and task marker beside it as
      structure. No asset, macro, embed or reference is ever rendered here, for
      the reason limit L1 of the source-path specification gives: a second rich
      renderer inside a new surface is the exact defect the F27 boundary
      corrections found."
  (:require [clojure.string :as string]
            [frontend.util.f27-children :as f27ch]
            [frontend.util.f27-crystal :as f27cr]
            [frontend.util.f28-refpath :as f28]))

;; ---------------------------------------------------------------------------
;; Constants
;; ---------------------------------------------------------------------------

(def ^:const max-label-chars
  "Display bound for one disclosed descendant.

  A disclosed row says WHAT is written under a reference, compactly; a long
  block that pushed its siblings off the panel would defeat the disclosure it
  belongs to. The same bound the source-path panel uses for a step, so the two
  panels are legible together on one screen."
  80)

;; ---------------------------------------------------------------------------
;; Where the control belongs
;; ---------------------------------------------------------------------------

(def own-exclusion-reasons
  "The two reasons that belong to THIS feature and to no other.

  Everything else is inherited. Listed as data so a test can assert the set has
  not silently grown: adding a surface to this feature means REMOVING a reason,
  which is a visible change rather than a quietly deleted `cond` clause."
  [:nothing-withheld :not-context-list])

(def exclusion-reasons
  "Every reason a row gets NO control, in the order they are checked.

  The shared ones are the source-path slice's, in its order, minus the two it
  asks that this feature replaces with its own."
  (into own-exclusion-reasons
        (remove #{:no-elision :not-source-path-list} f28/exclusion-reasons)))

(defn excluded-surface
  "The reason this row gets no control, or nil when the control belongs here.

  Takes plain booleans, so the caller's mapping from OG's `config` and its own
  render state to this question is the only place OG's shape is known.

    :withheld?     THIS list has collapsed this row and it has children, so
                   there is context on the page's own outline that the list is
                   not drawing. Both halves are values `block-container-inner`
                   has already computed for its own rendering
    :context-list? the config was opted in by
                   `frontend.components.reference/references*`

  Every other flag is handed straight to
  `frontend.util.f28-refpath/excluded-surface` — the same surfaces, the same
  order, the same reasons — with its own two questions answered so that only the
  shared rules can speak. Restating them here is exactly how two features that
  are supposed to agree stop agreeing."
  [{:keys [withheld? context-list?] :as surface}]
  (cond
    (not withheld?)     :nothing-withheld
    (not context-list?) :not-context-list
    :else               (f28/excluded-surface
                         (assoc surface :elided? true :source-path-list? true))))

(defn offer-control?
  "True when this row gets the control. The complement of `excluded-surface`,
  kept as its own name because that is what the caller asks."
  [surface]
  (nil? (excluded-surface surface)))

(defn withheld?
  "Whether this list is holding back context that is written under this row.

  Both halves come from `block-container-inner`'s own locals: `collapsed?` is
  what it passes to `block-children`, and `has-children?` is the
  `:block/_parent` existence check it already performs for `haschild`. So a
  CLOSED control performs no walk, no probe and no query of its own — its
  existence is decided from what OG has already worked out.

  A row OG is drawing in full is not withholding anything, and neither is a
  collapsed row with nothing under it. Both are left exactly as they are."
  [{:keys [collapsed? has-children?]}]
  (boolean (and collapsed? has-children?)))

;; ---------------------------------------------------------------------------
;; One row's plain label
;; ---------------------------------------------------------------------------

(defn plain-row
  "One block's content as the panel says it: bounded plain text, with its
  block-level structure beside it rather than echoed into it.

  Returns {:heading level-or-nil :marker \"TODO\"-or-nil :text label :empty? bool}.

  `:empty?` is a state and not a blank row: a block somebody wrote and left
  empty is a real part of an outline, and a panel that drew nothing for it would
  silently lose a level of the hierarchy."
  [content]
  (let [{:keys [heading marker text]} (f28/step-prefix content)
        label (f27cr/preview-label (or text content) max-label-chars)]
    {:heading heading
     :marker marker
     :text label
     :empty? (string/blank? label)}))

(defn row-key
  "A stable key for one disclosed row.

  The row's PATH, which `build-plan` builds from node identities down from the
  collapsed row — so two siblings reading exactly the same words stay two rows,
  and a row keeps its key when a sibling above it is expanded."
  [row]
  (str "d-" (string/join ">" (map str (:path row)))))

;; ---------------------------------------------------------------------------
;; The panel's identity
;; ---------------------------------------------------------------------------

(defn panel-id
  "A DOM id for one row's panel, stable across renders and unique on the page.

  The row is identified by the list it belongs to and its own block, so two
  lists on one page cannot collide and neither can two rows of one group."
  [list-id block-id]
  (str "f28-ctx-"
       (string/replace (str list-id "-" block-id) #"[^A-Za-z0-9_-]" "_")))

(defn toggle-id
  "The DOM id of the control that opens one panel, derived from the panel's own
  id — so returning focus after a collapse can only ever reach THIS row's
  control, and two open panels cannot move each other's focus."
  [panel-id']
  (str panel-id' "-toggle"))

;; ---------------------------------------------------------------------------
;; Turning one walk into what the panel shows
;; ---------------------------------------------------------------------------

(defn disclosure
  "Turn one `f27-children/build-plan` result into what this panel shows.

  Returns:
    :rows       the plan's rows, in render order, unchanged
    :root       the plan's info for the collapsed row itself
    :total      children the collapsed row is known to have
    :shown      how many of them actually reached a row
    :remaining  total - shown
    :status     from `f27-children/children-summary`: :error, :unavailable,
                :none, :partial or :ok
    :continue?  whether asking for more can reach anything
    :capped?    the shared visible-row safeguard is holding something back
    :behind     descendants known to exist behind rows no control can open

  Nothing is recomputed here that the plan already decided; this is the one
  place the component reads it from, so the panel and its controls cannot
  disagree about what the same walk found."
  [plan]
  (let [root (get-in plan [:info []])]
    {:rows (:rows plan)
     :root root
     :total (or (:total root) 0)
     :shown (or (:shown-count root) 0)
     :remaining (or (:remaining root) 0)
     :status (:summary root)
     :continue? (boolean (f27ch/can-continue? root plan))
     :capped? (boolean (f27ch/plan-hiding-anything? plan))
     :behind (f27ch/plan-withheld-behind-rows plan)}))
