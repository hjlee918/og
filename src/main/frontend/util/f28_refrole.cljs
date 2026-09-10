(ns frontend.util.f28-refrole
  "F28 reference roles — WHY a row is in a page's linked-references list.

  This is row 8 of `project-notes/F28_CHILD_CONTEXT_SPEC.md` §1, recorded there
  as a measured finding and deliberately left unfixed by that slice: in the
  packaged application a counted reference and a child drawn beneath it are
  rendered IDENTICALLY — same classes, same bullet — and the only thing that
  tells them apart is `data-refs-self`, which is not visible.

  Two different things are on that list and OG says which is which nowhere:

    * a DIRECT mention — the block's own `:block/refs` names this page (or one
      of its aliases). `frontend.components.reference/references*` selects
      exactly these into `top-level-blocks` and counts them into the heading;
    * a CONTEXT row — the block reached the list through `:block/path-refs`,
      which it inherits from an ancestor. `get-page-referenced-blocks` selects
      on `path-refs`, so a mention's descendants come with it and are attached
      as `:block/children`. They are drawn so the mention can be read in its
      surroundings; they are not counted and they name nothing.

  THE ROLE IS A PROPERTY OF THE BLOCK, NOT OF WHERE IT IS DRAWN.

  That distinction is the whole point of this namespace, so it is stated as a
  rule rather than left to a caller:

    * NOT indentation. A direct mention can be drawn as a child — the fixture's
      `mixedRef` is one, and §1 measured it being drawn TWICE, once as its own
      result with a breadcrumb and once as context under its parent. Both
      appearances are the same block, so both carry the same role;
    * NOT the row's text. Whether a page name is legible in a block's content
      says nothing: a tag, an alias, a property value and a link all produce a
      ref, and a page name inside a code fence produces none;
    * NOT whether the row appears twice. Appearing twice is a consequence of
      being a mention with a mention above it, not evidence of anything;
    * NOT `:ref-query-child?`, which is `block-children`'s marker for the
      rendering position and is exactly the inference this namespace exists to
      avoid.

  It is decided by the ONE predicate OG itself uses to build the list:

      (some page-ids (map :db/id (:block/refs block)))

  where `page-ids` is `frontend.db/page-alias-set` for the page whose list this
  is — the same set `references*` filters `ref-blocks` with to produce the
  count. So a labelled row and a counted row can never disagree.

  This namespace is PURE. It reads no database, renders nothing, persists
  nothing, and never touches a graph file. It decides two questions and nothing
  else: whether this surface gets labels at all, and which of the two roles one
  row has."
  (:require [frontend.util.f28-refpath :as f28]))

;; ---------------------------------------------------------------------------
;; Where the labels belong
;; ---------------------------------------------------------------------------

(def own-exclusion-reasons
  "The two reasons that belong to THIS feature and to no other.

  Listed as data so a test can assert the set has not silently grown: adding a
  surface to this feature means REMOVING a reason, which is a visible change
  rather than a quietly deleted `cond` clause."
  [:not-role-list :unknown-page])

(def exclusion-reasons
  "Every reason a row gets NO label, in the order they are checked.

  The shared ones are the source-path slice's, in its order, minus the two it
  asks that this feature replaces with its own."
  (into own-exclusion-reasons
        (remove #{:no-elision :not-source-path-list} f28/exclusion-reasons)))

(defn excluded-surface
  "The reason this row gets no role label, or nil when labels belong here.

  Takes plain booleans, so the caller's mapping from OG's `config` to this
  question is the only place OG's shape is known.

    :role-list?   the config was opted in by
                  `frontend.components.reference/references*` — the SAME
                  explicit opt-in the source-path and child-context slices read,
                  because it is the same decision about the same list;
    :page-known?  the list said which page it is about. Without the page's own
                  identity set there is no predicate, and a label that guessed
                  would be worse than no label at all.

  Every other flag is handed straight to
  `frontend.util.f28-refpath/excluded-surface` — the same surfaces, the same
  order, the same reasons — with its own two questions answered so that only the
  shared rules can speak. Restating them here is exactly how two features that
  are supposed to agree stop agreeing, and a test asserts the delegation."
  [{:keys [role-list? page-known?] :as surface}]
  (cond
    (not role-list?)  :not-role-list
    (not page-known?) :unknown-page
    :else             (f28/excluded-surface
                       (assoc surface :elided? true :source-path-list? true))))

(defn label-rows?
  "True when the rows of this list carry role labels. The complement of
  `excluded-surface`, kept as its own name because that is what the caller
  asks."
  [surface]
  (nil? (excluded-surface surface)))

;; ---------------------------------------------------------------------------
;; One row's role
;; ---------------------------------------------------------------------------

(def roles
  "The two roles, as data. There are exactly two, and a third would be a
  specification change rather than a new branch in a `case`."
  [:direct :context])

(defn direct-mention?
  "Does this block name this page itself?

  `ref-ids` are the `:db/id`s of the block's OWN `:block/refs`; `page-ids` is
  the page's alias set. This is `references*`'s own `top-level-blocks`
  predicate, moved somewhere it can be tested and reused rather than restated.

  nil when the question cannot be asked — no page identity — so the caller can
  keep 'this is context' apart from 'nobody said which page this is'."
  [ref-ids page-ids]
  (when (seq page-ids)
    (let [pages (set page-ids)]
      (boolean (some #(contains? pages %) (remove nil? ref-ids))))))

(defn row-role
  "Which of the two reasons this row is on the list, or nil when unknown.

  Depends on the block's refs and the page's identity, and on NOTHING else —
  not on the row's depth, its text, its position in the tree, or how many times
  it is drawn. Two appearances of one block therefore always agree, which is the
  property the child-context slice's `mixedRef` case exists to check."
  [{:keys [ref-ids page-ids]}]
  (case (direct-mention? ref-ids page-ids)
    true  :direct
    false :context
    nil))

;; ---------------------------------------------------------------------------
;; What the row says
;; ---------------------------------------------------------------------------

(defn describe
  "The dictionary keys for one row's label, or nil when there is nothing to say.

  Returns {:role :direct|:context :text-key k :why-key k}.

  `:text-key` is the compact word on screen. `:why-key` is the sentence that
  explains it, carried as a `title` so it costs no keyboard stop and no extra
  row.

  `nested?` selects a longer sentence for the one case that genuinely needs it:
  a DIRECT mention drawn underneath another mention. That row is counted once
  and drawn twice, and a reader who has just seen it above deserves to be told
  so. It changes the SENTENCE only — never the role — which is why it is read
  from the caller's rendering position while `row-role` above refuses to look at
  it at all. A context row is nested by construction, so it has one sentence."
  [{:keys [role nested?]}]
  (case role
    :direct  {:role :direct
              :text-key :f28/role-direct
              :why-key (if nested? :f28/role-direct-again-why :f28/role-direct-why)}
    :context {:role :context
              :text-key :f28/role-context
              :why-key :f28/role-context-why}
    nil))
