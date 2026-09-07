(ns frontend.util.f27-inert
  "F27 dynamic-boundary batch — the pure decision behind an inert placeholder.

  The problem this exists for: F27 panel bodies render a block's text with OG's
  own inline renderer, and the media hooks added by the asset slice cover
  ordinary image and media LINKS. They do not cover everything `inline`
  dispatches. Three shapes still reached code that renders rather than reads:

    * `[\"Macro\" …]` reaches `macro-cp`, which is a renderer of programs:
      `{{embed}}` renders another block or page recursively, `{{query}}` runs a
      query, `{{youtube}}`/`{{vimeo}}`/`{{bilibili}}`/`{{video}}`/`{{tweet}}`
      each mount a remote player, and `{{renderer}}` hands the slot to a plugin;
    * `[\"Inline_Html\" …]` and `[\"Export_Snippet\" \"html\" …]` reach
      `dangerouslySetInnerHTML` with sanitised HTML;
    * `[\"Inline_Hiccup\" …]` is read as data and then also set as inner HTML.

  Sanitising HTML is not the same as declining to render it: a sanitiser decides
  which tags survive, not whether anything is loaded or executed. And deferring
  the embed FEATURE cannot mean running OG's unrestricted embed renderer inside
  the panel meanwhile.

  So inside an F27 panel each of those becomes an inert placeholder: named,
  bounded, and — where it points at something this project can already navigate
  to — carrying that one control. This namespace decides WHAT it points at and
  WHAT it reads as. It renders nothing, executes nothing and reads nothing.

  Every macro is claimed, not a chosen list of dangerous ones. A panel is a
  bounded reading surface; a macro is by definition something whose output is
  produced by code, and an allow-list would have to be re-audited every time OG
  gained a macro."
  (:require [clojure.string :as string]
            [frontend.util.f27-crystal :as f27c]
            [frontend.util.f27-inbound :as f27in]
            [logseq.graph-parser.util.block-ref :as block-ref]
            [logseq.graph-parser.util.page-ref :as page-ref]))

(def ^:const max-badge-name-chars
  "Longest macro name that may appear inside a placeholder's badge.

  The badge reads `{{embed}}`, so the name is part of it. A macro name longer
  than this is cut: a badge is chrome, and chrome that can grow without bound is
  the thing these panels exist to avoid."
  16)

;; ---------------------------------------------------------------------------
;; Which nodes the boundary claims
;; ---------------------------------------------------------------------------

(defn node-kind
  "`:macro`, `:html`, `:hiccup`, or nil for a node this boundary does not claim.

  nil is the common answer, and it means \"let OG render it exactly as it always
  has\". Only the shapes that reach a renderer or `innerHTML` are claimed, so
  ordinary text, emphasis, code, tags, links and line breaks are untouched.

  An `Export_Snippet` that is not html is left alone: OG renders nothing for it
  today, and turning silence into a placeholder is a display change, not a
  boundary."
  [node]
  (when (and (vector? node) (string? (first node)))
    (case (first node)
      "Macro" :macro
      "Inline_Html" :html
      "Inline_Hiccup" :hiccup
      "Export_Snippet" (when (= "html" (second node)) :html)
      nil)))

;; ---------------------------------------------------------------------------
;; What a macro points at
;; ---------------------------------------------------------------------------

(def ^:private external-re
  "An address this panel may offer as a link. `http` and `https` only: a
  `file:` or `javascript:` argument is not something a reading panel hands the
  reader a control for."
  #"(?i)^https?://\S+$")

(defn macro-target
  "What ONE macro points at, as something this project can already navigate to.

  Returns `{:kind :block|:page|:url|:none :value s}`.

  `:block` and `:page` come from an `{{embed}}`'s own argument, written in the
  syntax OG's parser already defines, so the placeholder can offer the target
  the embed would have shown — which is the honest substitute for rendering it.
  `:url` is offered as an ordinary external link, the same way F27 already
  presents remote media: named, never loaded.

  `:none` is the answer whenever the argument is not a destination — a query is
  a program, a plugin renderer names a slot, a bare video id names nothing this
  panel can reach. A control that cannot work is worse than no control."
  [_name arguments]
  (let [a (some-> (first arguments) str string/trim)]
    (cond
      (string/blank? a) {:kind :none :value nil}

      (block-ref/block-ref? a)
      {:kind :block :value (block-ref/get-block-ref-id a)}

      (page-ref/page-ref? a)
      {:kind :page :value (page-ref/get-page-name a)}

      (re-find external-re a)
      {:kind :url :value a}

      :else {:kind :none :value nil})))

;; ---------------------------------------------------------------------------
;; What a placeholder reads as
;; ---------------------------------------------------------------------------

(defn macro-label
  "The macro's own arguments, as a person reads them, bounded to `max-len`.

  Inline reference markup is reduced first, through the same helper every other
  compact F27 label uses, so a `{{embed ((uuid))}}` never puts 36 characters of
  identifier on screen. nil when there is nothing to read, and the caller then
  shows the macro's name alone rather than an empty placeholder."
  [_name arguments max-len]
  (let [joined (->> arguments (keep identity) (map str) (string/join ", "))]
    (when-not (string/blank? joined)
      (let [s (f27c/preview-text (f27in/plain-label joined) max-len)]
        (when-not (string/blank? s) s)))))

(defn markup-label
  "One HTML or Hiccup fragment as TEXT, collapsed to a line and bounded.

  The fragment itself is what is shown, because that is what the note says and
  a reader is entitled to see it. It is shown as characters: nothing here
  produces markup, so nothing can load, execute or lay out. nil when there is
  nothing readable."
  [s max-len]
  (when (string? s)
    (let [out (f27c/preview-text s max-len)]
      (when-not (string/blank? out) out))))
