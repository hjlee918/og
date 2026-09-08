(ns frontend.util.f27-inline
  "F27 inline-context first slice — the pure decisions behind the control that
  sits beside an ordinary inline block reference and opens the TARGET's existing
  safe F27 context without navigating away.

  This namespace is PURE. It reads no database, renders nothing, executes
  nothing and persists nothing. Resolution, rendering and focus belong to the
  caller.

  Three properties matter and are all tested:

    * WHERE THE CONTROL BELONGS IS A NAMED DECISION. `excluded-surface` answers
      with the reason a surface is excluded rather than with a bare false, so
      every exclusion in the specification is a separate, falsifiable test and
      an accidental widening cannot hide behind one boolean.

    * STATE CANNOT REACH THE WRONG TARGET. Panel state is keyed by graph, host
      block and target. `panel-state` reports CLOSED whenever the stored key is
      not the current one, so a component instance reused for a different
      reference can never display state that belonged to another.

    * A TARGET THAT CANNOT BE READ IS SAID TO BE UNREADABLE. The parser creates
      an entity for every identity anything refers to, so the existence test is
      `:block/content`, never `some?` of a lookup — the same fact the outgoing
      slice recorded, for the same reason."
  (:require [clojure.string :as string]))

;; ---------------------------------------------------------------------------
;; Identity
;; ---------------------------------------------------------------------------

(defn ident
  "One identity in the single form every key comparison uses.

  Identities arrive both as parsed strings from the AST and as uuid objects from
  an entity; a key that mixed the two would isolate state it should share and
  share state it should isolate."
  [x]
  (let [s (some-> x str string/trim string/lower-case)]
    (when-not (string/blank? s) s)))

(defn panel-key
  "The identity of ONE panel: this graph, this host block, this target.

  Returns nil when there is no target, because a panel with no target has no
  identity to guard and must never be treated as open.

  The host is part of the key on purpose. The same target referenced from two
  different blocks is two panels, and a component instance reused across them
  must not carry one's open state into the other."
  [{:keys [repo host target]}]
  (when-let [t (ident target)]
    (string/join "|" [(or (ident repo) "-") (or (ident host) "-") t])))

;; ---------------------------------------------------------------------------
;; Where the control belongs
;; ---------------------------------------------------------------------------

(def exclusion-reasons
  "Every reason a surface may be excluded, in the order they are checked.

  Listed as data so a test can assert that the set has not silently grown or
  shrunk: adding a surface to the feature means removing a reason from here,
  which is a visible change rather than a quietly deleted `cond` clause."
  [:no-identity :f27-panel :inline-panel :mobile :preview :slide :sidebar
   :embed :block-ref :query :html-export :whiteboard :annotation])

(defn excluded-surface
  "The reason this surface gets NO control, or nil when the control belongs here.

  Takes plain booleans, so the caller's mapping from OG's `config` to this
  question is the only place OG's shape is known, and every rule below is
  testable without a renderer.

    :identity?     the reference text parses as a block identity
    :f27-panel?    rendering inside an F27 panel body (`:f27/ref-render` set)
    :inline-panel? rendering inside THIS feature's own panel
    :mobile?       mobile or native platform
    :preview?      inside a hover preview or a page preview
    :slide?        presentation mode
    :sidebar?      the right sidebar
    :embed?        a block or page embed surface
    :block-ref?    inside another reference's rendered content
    :query?        a custom-query result
    :html-export?  HTML export output
    :whiteboard?   a whiteboard surface, or a whiteboard-shape block
    :annotation?   a PDF annotation block

  Order matters only for which reason is REPORTED; any true flag excludes."
  [{:keys [identity? f27-panel? inline-panel? mobile? preview? slide? sidebar?
           embed? block-ref? query? html-export? whiteboard? annotation?]}]
  (cond
    (not identity?) :no-identity
    f27-panel?      :f27-panel
    inline-panel?   :inline-panel
    mobile?         :mobile
    preview?        :preview
    slide?          :slide
    sidebar?        :sidebar
    embed?          :embed
    block-ref?      :block-ref
    query?          :query
    html-export?    :html-export
    whiteboard?     :whiteboard
    annotation?     :annotation
    :else           nil))

(defn offer-control?
  "True when this surface gets the control. The complement of `excluded-surface`,
  kept as its own name because that is what the caller asks."
  [surface]
  (nil? (excluded-surface surface)))

;; ---------------------------------------------------------------------------
;; Per-occurrence, per-target state
;; ---------------------------------------------------------------------------

(def closed
  "The state of a panel that is not open. Also what a mismatched key reads as."
  {:open? false :context? false})

(defn panel-state
  "What `stored` means for the panel identified by `k`.

  Component-local state already gives every mounted occurrence its own atom.
  This is the second line of defence: if an instance is reused for a DIFFERENT
  reference — another graph, another host block, another target — the stored key
  no longer matches and the panel reads as closed. Stale state can never be
  displayed against the wrong target.

  A nil key is closed, because a panel with no target identity has nothing to
  be open about."
  [stored k]
  (if (and k (= k (:key stored)))
    {:open? (boolean (:open? stored)) :context? (boolean (:context? stored))}
    closed))

(defn toggle-panel
  "Open a closed panel, or close an open one.

  Closing also closes the second disclosure, so re-opening starts at the first
  one rather than restoring a depth the reader did not ask for again."
  [stored k]
  (let [{:keys [open?]} (panel-state stored k)]
    (if open?
      {:key k :open? false :context? false}
      {:key k :open? true :context? false})))

(defn toggle-context
  "Open or close the SECOND disclosure. Meaningless while the panel is closed,
  and a no-op there rather than a state that could render context with no panel
  around it."
  [stored k]
  (let [{:keys [open? context?]} (panel-state stored k)]
    (if open?
      {:key k :open? true :context? (not context?)}
      (panel-state stored k))))

(defn close-panel
  "Close everything for `k`. Used by Escape, by Close, and by the panel's own
  repeated action at its end."
  [_stored k]
  {:key k :open? false :context? false})

(defn open?
  "True when the panel for `k` is open at all."
  [stored k]
  (:open? (panel-state stored k)))

(defn context-open?
  "True when the SECOND disclosure for `k` is open."
  [stored k]
  (:context? (panel-state stored k)))

;; ---------------------------------------------------------------------------
;; What the panel may say about its target
;; ---------------------------------------------------------------------------

(defn target-state
  "How the opened panel must present its target.

  `identity?` the reference carries a parseable block identity
  `readable?` the caller resolved it to a READABLE block — `:block/content`
              present, never `some?` of an entity lookup. Transacting a lookup
              ref that resolves to nothing CREATES an entity carrying that
              identity alone, so `some?` answers true for a block nobody has
              written.

  Returns:
    :no-identity  nothing to open; the caller offers no control at all
    :unavailable  said in words, with no control that cannot work, and no page
                  or block created
    :ready        the overview, and the second disclosure"
  [{:keys [identity? readable?]}]
  (cond
    (not identity?) :no-identity
    (not readable?) :unavailable
    :else           :ready))

(defn expandable?
  "True for the one state whose context may be opened."
  [state]
  (= :ready state))

(defn escape-key?
  "True for the key event name that closes the panel. Named here so the
  component and its test agree on one spelling, including the legacy one older
  runtimes still emit."
  [k]
  (contains? #{"Escape" "Esc"} k))
