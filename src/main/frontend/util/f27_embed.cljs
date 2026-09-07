(ns frontend.util.f27-embed
  "F27 block-embed slice — the pure decision behind an EXPANDABLE `{{embed}}`.

  The problem this exists for: the dynamic-boundary batch made `{{embed}}` inert
  inside an F27 panel, because OG's own embed renderer renders the target block
  AND ITS CHILDREN through the ordinary block pipeline with `:link-depth`
  incremented — the recursive substitution these panels exist to stop, plus
  every renderer the panel has already declined to run. That was the right
  boundary, and it stays. But it is not presentation: the reader can see that
  something is embedded and where it lives, and never what it says.

  This namespace decides ONE thing: whether a particular `{{embed}}`, on a
  particular surface, may offer a control that shows the target block's own
  text — and, when it may not, WHY, so the chip can say so instead of being
  silently ordinary.

  It renders nothing, reads no database and no filesystem, and executes nothing.
  Resolution and rendering belong to the caller; this only classifies and
  bounds. The safety argument for the expanded content is deliberately NOT in
  here: expansion re-uses the panel's existing guarded renderer one level down,
  so every guard already written — closed reference chips, compact assets, inert
  macros, inert markup, no children — applies to it without a new rule."
  (:require [clojure.string :as string]))

(def ^:const max-embed-chars
  "Characters of displayed text one EXPANDED embed may show.

  Deliberately the same number this contract already allows a whole body to
  quote automatically (`f27-body/max-body-chars`). A reader who explicitly opens
  one embed gets that whole allowance for that one target.

  It is a separate allowance, not a share of the body's preview budget. Those
  bound different things: the preview budget bounds what a body shows on its
  own, and this bounds what one deliberate action may show. Neither may exceed
  itself, and both say so on screen when they bite."
  420)

(def ^:const max-embeds
  "Expandable embeds offered per rendered body.

  A block quoting six embeds is legitimate; six expandable regions in one panel
  row is not reading. Beyond this an embed is still named, and still offers its
  source — it simply cannot be opened in place."
  4)

;; ---------------------------------------------------------------------------
;; Per-body bookkeeping. A plain map, threaded by the caller through a volatile
;; it owns, exactly like the preview budget — and deliberately SEPARATE from it,
;; so nothing here can change what the existing preview bound does.
;; ---------------------------------------------------------------------------

(defn new-ledger
  "A fresh record of the embeds one rendered body has offered.

  :offered  how many expandable embeds this body has already offered
  :seen     the targets it has offered, so a second copy of one block says so"
  []
  {:offered 0 :seen #{}})

(defn offered?
  "Has this body already offered an expandable embed of `id`?"
  [ledger id]
  (boolean (and id (contains? (:seen (or ledger (new-ledger))) id))))

(defn full?
  "Has this body offered as many expandable embeds as it may?"
  [ledger]
  (>= (:offered (or ledger (new-ledger)) 0) max-embeds))

(defn record
  "Note that this body has offered an expandable embed of `id`."
  [ledger id]
  (let [ledger (or ledger (new-ledger))]
    (cond-> (update ledger :offered (fnil inc 0))
      (and id (not (string/blank? (str id)))) (update :seen conj id))))

;; ---------------------------------------------------------------------------
;; Classification
;; ---------------------------------------------------------------------------

(defn embed-macro?
  "True for the macro this slice claims, and only that one."
  [name]
  (= "embed" (some-> name str string/trim string/lower-case)))

(defn plan-embed
  "How ONE `{{embed}}` inside an F27 panel body must be presented.

  `kind`      what the macro's argument points at — `:block`, `:page`, `:url`
              or `:none`, as the inert boundary already classifies it
  `resolved?` whether the caller could resolve a `:block` argument to a block
  `id`        that target's identity as a string, or nil
  `level`     0 while rendering the block's own text, ≥ 1 inside a preview or
              inside an expanded embed
  `compact?`  true on a one-line surface such as a row's breadcrumb
  `trail`     identities already being rendered above this point, INCLUDING the
              host block, so a self-embed is a repeat by construction
  `ledger`    this body's record of the embeds it has already offered

  Returns one of:
    :not-block    the argument is not a block; presentation is unchanged
    :unavailable  nothing to show and nowhere to go; say so, never as an id
    :repeat       already being rendered above, or already offered in this body
    :closed       a bounded or compact surface; named, never expandable here
    :budget       this body already offers as many embeds as it may
    :expand       offer the control

  The order matters, and it is the order the body contract already uses:
  a repeat is reported as a repeat even when it is also too deep, because
  'this repeats' explains what the reader is seeing and 'shown closed' does not.
  A page embed keeps the presentation it already has, so a slice that does not
  implement page embeds cannot accidentally change one."
  [{:keys [kind resolved? id level compact? trail ledger]}]
  (cond
    (not= :block kind) :not-block
    (not resolved?) :unavailable
    (or (nil? id) (string/blank? (str id))) :unavailable
    (contains? (or trail #{}) id) :repeat
    (offered? ledger id) :repeat
    (or (pos? (or level 0)) (boolean compact?)) :closed
    (full? ledger) :budget
    :else :expand))

(defn expandable?
  "True for the one outcome that offers the control."
  [outcome]
  (= :expand outcome))
