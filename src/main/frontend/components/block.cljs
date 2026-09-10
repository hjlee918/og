(ns frontend.components.block
  (:refer-clojure :exclude [range])
  (:require-macros [hiccups.core])
  (:require ["/frontend/utils" :as utils]
            [cljs-bean.core :as bean]
            [cljs.core.match :refer [match]]
            [cljs.reader :as reader]
            [clojure.string :as string]
            [clojure.walk :as walk]
            [datascript.core :as d]
            [dommy.core :as dom]
            [frontend.commands :as commands]
            [frontend.components.block.macros :as block-macros]
            [frontend.components.datetime :as datetime-comp]
            [frontend.components.lazy-editor :as lazy-editor]
            [frontend.components.macro :as macro]
            [frontend.components.plugins :as plugins]
            [frontend.components.query.builder :as query-builder-component]
            [frontend.components.svg :as svg]
            [frontend.components.query :as query]
            [frontend.config :as config]
            [frontend.context.i18n :refer [t]]
            [frontend.date :as date]
            [frontend.db :as db]
            [frontend.db.model :as model]
            [frontend.db.f27-page :as f27p]
            [frontend.db-mixins :as db-mixins]
            [frontend.extensions.highlight :as highlight]
            [frontend.extensions.latex :as latex]
            [frontend.extensions.lightbox :as lightbox]
            [frontend.extensions.pdf.assets :as pdf-assets]
            [frontend.extensions.sci :as sci]
            [frontend.extensions.video.youtube :as youtube]
            [frontend.extensions.zotero :as zotero]
            [frontend.format.block :as block]
            [frontend.format.mldoc :as mldoc]
            [frontend.fs :as fs]
            [frontend.handler.assets :as assets-handler]
            [frontend.handler.block :as block-handler]
            [frontend.handler.dnd :as dnd]
            [frontend.handler.editor :as editor-handler]
            [frontend.handler.file-sync :as file-sync]
            [frontend.handler.notification :as notification]
            [frontend.handler.plugin :as plugin-handler]
            [frontend.handler.repeated :as repeated]
            [frontend.handler.route :as route-handler]
            [frontend.handler.ui :as ui-handler]
            [frontend.handler.whiteboard :as whiteboard-handler]
            [frontend.handler.export.common :as export-common-handler]
            [frontend.mobile.util :as mobile-util]
            [frontend.mobile.intent :as mobile-intent]
            [frontend.modules.outliner.tree :as tree]
            [frontend.security :as security]
            [frontend.shui :refer [get-shui-component-version make-shui-context]]
            [frontend.state :as state]
            [frontend.template :as template]
            [frontend.ui :as ui]
            [frontend.util :as util]
            [frontend.extensions.pdf.utils :as pdf-utils]
            [frontend.util.clock :as clock]
            [frontend.util.drawer :as drawer]
            [frontend.util.f27-ref-overview :as f27]
            [frontend.util.f27-assets :as f27a]
            [frontend.util.f27-body :as f27b]
            [frontend.util.f27-crystal :as f27c]
            [frontend.util.f27-context :as f27ctx]
            [frontend.util.f27-children :as f27ch]
            [frontend.util.f27-inbound :as f27in]
            [frontend.util.f27-inert :as f27i]
            [frontend.util.f27-embed :as f27e]
            [frontend.util.f27-page-embed :as f27pe]
            [frontend.util.f27-outgoing :as f27o]
            [frontend.util.f27-inline :as f27il]
            [frontend.util.f27-inline-watch :as f27w]
            [frontend.util.f28-refctx :as f28ctx]
            [frontend.util.f28-refpath :as f28]
            [frontend.util.property :as property]
            [frontend.util.text :as text-util]
            [goog.dom :as gdom]
            [goog.object :as gobj]
            [lambdaisland.glogi :as log]
            [logseq.graph-parser.block :as gp-block]
            [logseq.graph-parser.config :as gp-config]
            [logseq.graph-parser.mldoc :as gp-mldoc]
            [logseq.graph-parser.text :as text]
            [logseq.graph-parser.util :as gp-util]
            [logseq.graph-parser.util.block-ref :as block-ref]
            [logseq.graph-parser.util.page-ref :as page-ref]
            [logseq.graph-parser.whiteboard :as gp-whiteboard]
            [logseq.shui.core :as shui]
            [medley.core :as medley]
            [promesa.core :as p]
            [reitit.frontend.easy :as rfe]
            [rum.core :as rum]
            [shadow.loader :as loader]
            [datascript.impl.entity :as e]
            [logseq.common.path :as path]
            [electron.ipc :as ipc]))



;; local state
(defonce *dragging?
  (atom false))
(defonce *dragging-block
  (atom nil))
(defonce *drag-to-block
  (atom nil))
(def *move-to (atom nil))

;; TODO: dynamic
(defonce max-depth-of-links 5)
(defonce *blocks-container-id (atom 0))

;; TODO:
;; add `key`

(defn- remove-nils
  [col]
  (remove nil? col))

(defn vec-cat
  [& args]
  (->> (apply concat args)
       remove-nils
       vec))

(defn ->elem
  ([elem items]
   (->elem elem nil items))
  ([elem attrs items]
   (let [elem (keyword elem)]
     (if attrs
       (vec
        (cons elem
              (cons attrs
                    (seq items))))
       (vec
        (cons elem
              (seq items)))))))

(defn- join-lines
  [l]
  (string/trim (apply str l)))

(defn- string-of-url
  [url]
  (match url
    ["File" s]
    (-> (string/replace s "file://" "")
        ;; "file:/Users/ll/Downloads/test.pdf" is a normal org file link
        (string/replace "file:" ""))

    ["Complex" m]
    (let [{:keys [link protocol]} m]
      (if (= protocol "file")
        link
        (str protocol "://" link)))))

(defn- get-file-absolute-path
  [config path]
  (js/console.error "TODO: buggy path fn")
  (let [path (string/replace path "file:" "")
        block-id (:block/uuid config)
        current-file (and block-id
                          (:file/path (:block/file (:block/page (db/entity [:block/uuid block-id])))))]
    (when current-file
      (let [parts (string/split current-file #"/")
            parts-2 (string/split path #"/")
            current-dir (util/string-join-path (drop-last 1 parts))]
        (cond
          (if util/win32? (utils/win32 path) (util/starts-with? path "/"))
          path

          (and (not (util/starts-with? path ".."))
               (not (util/starts-with? path ".")))
          (str current-dir "/" path)

          :else
          (let [parts (loop [acc []
                             parts (reverse parts)
                             col (reverse parts-2)]
                        (if (empty? col)
                          acc
                          (let [[part parts] (case (first col)
                                               ".."
                                               [(first parts) (rest parts)]
                                               "."
                                               ["" parts]
                                               [(first col) (rest parts)])]
                            (recur (conj acc part)
                                   parts
                                   (rest col)))))
                parts (remove #(string/blank? %) parts)]
            (util/string-join-path (reverse parts))))))))

(rum/defcs asset-loader
  < rum/reactive
  (rum/local nil ::exist?)
  (rum/local false ::loading?)
  {:will-mount  (fn [state]
                  (let [src (first (:rum/args state))]
                    (if (and (gp-config/local-protocol-asset? src)
                             (file-sync/current-graph-sync-on?))
                      (let [*exist? (::exist? state)
                            ;; special handling for asset:// protocol
                            ;; Capacitor uses a special URL for assets loading
                            asset-path (gp-config/remove-asset-protocol src)
                            asset-path (fs/asset-path-normalize asset-path)]
                        (if (string/blank? asset-path)
                          (reset! *exist? false)
                          ;; FIXME(andelf): possible bug here
                          (p/let [exist? (fs/asset-href-exists? asset-path)]
                            (reset! *exist? (boolean exist?))))
                        (assoc state ::asset-path asset-path ::asset-file? true))
                      state)))
   :will-update (fn [state]
                  (let [src (first (:rum/args state))
                        asset-file? (boolean (::asset-file? state))
                        sync-on? (file-sync/current-graph-sync-on?)
                        *loading? (::loading? state)
                        *exist? (::exist? state)]
                    (when (and sync-on? asset-file? (false? @*exist?))
                      (let [sync-state (state/get-file-sync-state (state/get-current-file-sync-graph-uuid))
                            downloading-files (:current-remote->local-files sync-state)
                            contain-url? (and (seq downloading-files)
                                              (some #(string/ends-with? src %) downloading-files))]
                        (cond
                          (and (not @*loading?) contain-url?)
                          (reset! *loading? true)

                          (and @*loading? (not contain-url?))
                          (do
                            (reset! *exist? true)
                            (reset! *loading? false))))))
                  state)}
  [state src content-fn]
  (let [_ (state/sub-file-sync-state (state/get-current-file-sync-graph-uuid))
        exist? @(::exist? state)
        loading? @(::loading? state)
        asset-file? (::asset-file? state)
        sync-enabled? (boolean (file-sync/current-graph-sync-on?))
        ext (keyword (util/get-file-ext src))
        img? (contains? (gp-config/img-formats) ext)
        audio? (contains? config/audio-formats ext)
        type (cond img? "image"
                   audio? "audio"
                   :else "asset")]

    (if (not sync-enabled?)
      (content-fn)
      (if (and asset-file? (or loading? (nil? exist?)))
        [:p.text-sm.opacity-50 (ui/loading (util/format "Syncing %s ..." type))]
        (if (or (not asset-file?)
                (and exist? (not loading?)))
          (content-fn)
          [:p.text-error.text-xs [:small.opacity-80
                                    (util/format "%s not found!" (string/capitalize type))]])))))

(defn open-lightbox
  [e]
  (let [images (js/document.querySelectorAll ".asset-container img")
        images (to-array images)
        images (if-not (= (count images) 1)
                 (let [^js image (.closest (.-target e) ".asset-container")
                       image (. image querySelector "img")]
                   (->> images
                        (sort-by (juxt #(.-y %) #(.-x %)))
                        (split-with (complement #{image}))
                        reverse
                        (apply concat)))
                 images)
        images (for [^js it images] {:src (.-src it)
                                     :w (.-naturalWidth it)
                                     :h (.-naturalHeight it)})]

    (when (seq images)
      (lightbox/preview-images! images))))

(defonce *resizing-image? (atom false))
(rum/defcs ^:large-vars/cleanup-todo resizable-image <
  (rum/local nil ::size)
  {:will-unmount (fn [state]
                   (reset! *resizing-image? false)
                   state)}
  [state config title src metadata full-text local?]
  (let [size (get state ::size)
        breadcrumb? (:breadcrumb? config)]
    (ui/resize-provider
     (ui/resize-consumer
      (if (and (not (mobile-util/native-platform?))
               (not breadcrumb?))
        (cond->
         {:className "resize image-resize"
          :onSizeChanged (fn [value]
                           (when (and (not @*resizing-image?)
                                      (some? @size)
                                      (not= value @size))
                             (reset! *resizing-image? true))
                           (reset! size value))
          :onMouseUp (fn []
                       (when (and @size @*resizing-image?)
                         (when-let [block-id (:block/uuid config)]
                           (let [size (bean/->clj @size)]
                             (editor-handler/resize-image! block-id metadata full-text size))))
                       (when @*resizing-image?
                            ;; TODO: need a better way to prevent the clicking to edit current block
                         (js/setTimeout #(reset! *resizing-image? false) 200)))
          :onClick (fn [e]
                     (when @*resizing-image? (util/stop e)))}
         (and (:width metadata) (not (util/mobile?)))
         (assoc :style {:width (:width metadata)}))
        {})
      [:div.asset-container {:key "resize-asset-container"}
       [:img.rounded-sm.relative
        (merge
         {:loading "lazy"
          :referrerPolicy "no-referrer"
          :src     src
          :title   title}
         metadata)]
       (when-not breadcrumb?
         [:<>
          [:.asset-overlay]
          (let [image-src (fs/asset-path-normalize src)]
            [:.asset-action-bar {:aria-hidden "true"}
             ;; the image path bar
             (when (util/electron?)
               [:button.asset-action-btn.text-left
                {:title         (t (if local? :asset/show-in-folder :asset/open-in-browser))
                 :tabIndex      "-1"
                 :on-mouse-down util/stop
                 :on-click      (fn [e]
                                  (util/stop e)
                                  (if local?
                                    (ipc/ipc "openFileInFolder" image-src)
                                    (js/window.apis.openExternal image-src)))}
                image-src])
             [:.flex
              (when-not config/publishing?
                [:button.asset-action-btn
                 {:title         (t :asset/delete)
                  :tabIndex      "-1"
                  :on-mouse-down util/stop
                  :on-click
                  (fn [e]
                    (when-let [block-id (:block/uuid config)]
                      (let [confirm-fn (ui/make-confirm-modal
                                         {:title         (t :asset/confirm-delete (.toLocaleLowerCase (t :text/image)))
                                          :sub-title     (if local? :asset/physical-delete "")
                                          :sub-checkbox? local?
                                          :on-confirm    (fn [_e {:keys [close-fn sub-selected]}]
                                                           (close-fn)
                                                           (editor-handler/delete-asset-of-block!
                                                             {:block-id      block-id
                                                              :local?        local?
                                                              :delete-local? (and sub-selected (first sub-selected))
                                                              :repo          (state/get-current-repo)
                                                              :href          src
                                                              :title         title
                                                              :full-text     full-text}))})]
                        (util/stop e)
                        (state/set-modal! confirm-fn))))}
                 (ui/icon "trash")])

              [:button.asset-action-btn
               {:title         (t :asset/copy)
                :tabIndex      "-1"
                :on-mouse-down util/stop
                :on-click      (fn [e]
                                 (util/stop e)
                                 (-> (util/copy-image-to-clipboard image-src)
                                     (p/then #(notification/show! "Copied!" :success))))}
               (ui/icon "copy")]

              [:button.asset-action-btn
               {:title         (t :asset/maximize)
                :tabIndex      "-1"
                :on-mouse-down util/stop
                :on-click      open-lightbox}

               (ui/icon "maximize")]]])])]))))

(rum/defc audio-cp [src]
  ;; Change protocol to allow media fragment uris to play
  [:audio {:src (string/replace-first src gp-config/asset-protocol "file://")
           :controls true
           :on-touch-start #(util/stop %)}])

(rum/defcs asset-link < rum/reactive
  (rum/local nil ::src)
  [state config title href metadata full_text]
  (let [src (::src state)
        granted? (state/sub [:nfs/user-granted? (state/get-current-repo)])
        href (config/get-local-asset-absolute-path href)]
    (when (or granted? (util/electron?) (mobile-util/native-platform?))
      (p/then (editor-handler/make-asset-url href) #(reset! src %)))

    (when @src
      ;; NOTE(andelf): Under nfs context, src might be a bare blob:http://..../uuid URI without ext info
      (let [ext (keyword (or (util/get-file-ext @src)
                             (util/get-file-ext href)))
            repo (state/get-current-repo)
            repo-dir (config/get-repo-dir repo)
            path (str repo-dir href)
            share-fn (fn [event]
                       (util/stop event)
                       (when (mobile-util/native-platform?)
                         ;; File URL must be legal, so filename muse be URI-encoded
                         ;; incoming href format: "/assets/whatever.ext"
                         (let [[rel-dir basename] (util/get-dir-and-basename href)
                               rel-dir (string/replace rel-dir #"^/+" "")
                               asset-url (path/path-join repo-dir rel-dir basename)]
                           (mobile-intent/open-or-share-file asset-url))))]

        (cond
          (contains? config/audio-formats ext)
          (asset-loader @src
                        #(audio-cp @src))

          (contains? (gp-config/img-formats) ext)
          (asset-loader @src
                        #(resizable-image config title @src metadata full_text true))

          (contains? (gp-config/text-formats) ext)
          [:a.asset-ref.is-plaintext {:href (rfe/href :file {:path path})
                                      :on-click (fn [_event]
                                                  (p/let [result (fs/read-file repo-dir path)]
                                                    (db/set-file-content! repo path result)))}
           title]

          (= ext :pdf)
          [:a.asset-ref.is-pdf {:href @src
                                :on-click share-fn}
           title]

          :else
          [:a.asset-ref.is-doc {:href @src
                                :on-click share-fn}
           title])))))

(defn ar-url->http-url
  [href]
  (string/replace href #"^ar://" (str (state/get-arweave-gateway) "/")))

;; TODO: safe encoding asciis
;; TODO: image link to another link
(defn- image-link* [config url href label metadata full_text]
  (let [metadata (if (string/blank? metadata)
                   nil
                   (gp-util/safe-read-string metadata))
        title (second (first label))]
    (ui/catch-error
     [:span.warning full_text]
     (if (and (gp-config/local-asset? href)
              (config/local-db? (state/get-current-repo)))
       (asset-link config title href metadata full_text)
       (let [href (cond
                    (util/starts-with? href "http")
                    href

                    (util/starts-with? href "ar")
                    (ar-url->http-url href)

                    config/publishing?
                    (subs href 1)

                    (= "Embed_data" (first url))
                    href

                    :else
                    (if (assets-handler/check-alias-path? href)
                      (assets-handler/normalize-asset-resource-url href)
                      (get-file-absolute-path config href)))]
         (resizable-image config title href metadata full_text false))))))

(defn image-link
  "F27 local-asset slice: inside an F27 panel body an asset is presented by
  F27's own bounded renderer — a size-constrained thumbnail for a graph-local
  image, a readable name for everything else, and nothing fetched for a remote
  or inline-data source. `:f27/media-render` is set ONLY by that renderer, so
  with the key absent this calls straight through and behaves byte-for-byte as
  it always has."
  [config url href label metadata full_text]
  (if-let [f27-media (:f27/media-render config)]
    (f27-media config href label full_text)
    (image-link* config url href label metadata full_text)))


(def timestamp-to-string export-common-handler/timestamp-to-string)

(defn timestamp [{:keys [active _date _time _repetition _wday] :as t} kind]
  (let [prefix (case kind
                 "Scheduled"
                 [:i {:class "fa fa-calendar"
                      :style {:margin-right 3.5}}]
                 "Deadline"
                 [:i {:class "fa fa-calendar-times-o"
                      :style {:margin-right 3.5}}]
                 "Date"
                 nil
                 "Closed"
                 nil
                 "Started"
                 [:i {:class "fa fa-clock-o"
                      :style {:margin-right 3.5}}]
                 "Start"
                 "From: "
                 "Stop"
                 "To: "
                 nil)
        class (when (= kind "Closed")
                "line-through")]
    [:span.timestamp (cond-> {:active (str active)}
                       class
                       (assoc :class class))
     prefix (timestamp-to-string t)]))

(defn range [{:keys [start stop]} stopped?]
  [:div {:class "timestamp-range"
         :stopped stopped?}
   (timestamp start "Start")
   (timestamp stop "Stop")])

(declare map-inline)
(declare markup-element-cp)
(declare markup-elements-cp)

(declare page-reference)

(defn open-page-ref
  [e page-name redirect-page-name page-name-in-block contents-page? whiteboard-page?]
  (util/stop e)
  (when (not (util/right-click? e))
    (cond
      (gobj/get e "shiftKey")
      (when-let [page-entity (db/entity [:block/name redirect-page-name])]
        (state/sidebar-add-block!
         (state/get-current-repo)
         (:db/id page-entity)
         :page))

      (and (util/meta-key? e) (whiteboard-handler/inside-portal? (.-target e)))
      (whiteboard-handler/add-new-block-portal-shape!
       page-name
       (whiteboard-handler/closest-shape (.-target e)))

      whiteboard-page?
      (route-handler/redirect-to-whiteboard! page-name)

      (not= redirect-page-name page-name)
      (route-handler/redirect-to-page! redirect-page-name)

      :else
      (state/pub-event! [:page/create page-name-in-block])))
  (when (and contents-page?
             (util/mobile?)
             (state/get-left-sidebar-open?))
    (ui-handler/close-left-sidebar!)))

(rum/defc page-inner
  "The inner div of page reference component

   page-name-in-block is the overridable name of the page (legacy)

   All page-names are sanitized except page-name-in-block"
  [config page-name-in-block page-name redirect-page-name page-entity contents-page? children html-export? label whiteboard-page?]
  (let [[mouse-down? set-mouse-down!] (rum/use-state false) ;; avoid click event after drag
        tag? (:tag? config)
        config (assoc config :whiteboard-page? whiteboard-page?)
        untitled? (model/untitled-page? page-name)]
        ; gradient-styles (state/sub-color-gradient-text-styles :09)]

    [:a
     {:tabIndex "0"
      :class (cond-> (if tag? "tag" "page-ref")
               (:property? config)
               (str " page-property-key block-property")
               untitled? (str " opacity-50"))
      :data-ref page-name
      :draggable true
      :on-drag-start (fn [e] (editor-handler/block->data-transfer! page-name-in-block e))
      :on-mouse-down #(set-mouse-down! true)
      :on-mouse-up (fn [e]
                     (when mouse-down?
                       ;; when page-entity is nil and page name is journal page(not the current format),
                       ;; convert title then redirect
                       (let [redirect-page-name (or (and (nil? page-entity)
                                                         (date/journal-title->custom-format page-name))
                                                    redirect-page-name)
                             redirect-page-name (string/lower-case redirect-page-name)]
                         (open-page-ref e page-name redirect-page-name page-name-in-block contents-page? whiteboard-page?))
                       (set-mouse-down! false)))
      :on-key-up (fn [e] (when (and e (= (.-key e) "Enter"))
                           (open-page-ref e page-name redirect-page-name page-name-in-block contents-page? whiteboard-page?)))}

     (if (and (coll? children) (seq children))
       (for [child children]
         (if (= (first child) "Label")
           (last child)
           (let [{:keys [content children]} (last child)
                 page-name (subs content 2 (- (count content) 2))]
             (rum/with-key (page-reference html-export? page-name (assoc config :children children) nil) page-name))))
       (cond
         (and label
              (string? label)
              (not (string/blank? label))) ; alias
         label

         (coll? label)
         (->elem :span (map-inline config label))

         :else
         (let [original-name (util/get-page-original-name page-entity)
               s (cond untitled?
                       (t :untitled)

                       ;; The page-name-in-block generated by the auto-complete is not page-name-sanitized
                       (pdf-utils/hls-file? page-name)
                       (pdf-utils/fix-local-asset-pagename page-name)

                       (not= (util/safe-page-name-sanity-lc original-name) page-name-in-block)
                       page-name-in-block ;; page-name-in-block might be overridden (legacy))

                       original-name
                       (util/trim-safe original-name)

                       :else
                       (util/trim-safe page-name))
               _ (when-not page-entity (js/console.warn "page-inner's page-entity is nil, given page-name: " page-name
                                                        " page-name-in-block: " page-name-in-block))]
           (if tag? (str "#" s) s))))]))

(rum/defc page-preview-trigger
  [{:keys [children sidebar? tippy-position tippy-distance fixed-position? open? manual?] :as config} page-name]
  (let [*tippy-ref (rum/create-ref)
        page-name (util/page-name-sanity-lc page-name)
        whiteboard-page? (model/whiteboard-page? page-name)
        redirect-page-name (or (model/get-redirect-page-name page-name (:block/alias? config))
                               page-name)
        page-original-name (model/get-page-original-name redirect-page-name)
        _  #_:clj-kondo/ignore (rum/defc html-template []
                                 (let [*el-popup (rum/use-ref nil)]

                                   (rum/use-effect!
                                    (fn []
                                      (let [el-popup (rum/deref *el-popup)
                                            cb (fn [^js e]
                                                 (when-not (:editor/editing? @state/state)
                                           ;; Esc
                                                   (and (= e.which 27)
                                                        (when-let [tp (rum/deref *tippy-ref)]
                                                          (.hideTooltip tp)))))]

                                        (js/setTimeout #(.focus el-popup))
                                        (.addEventListener el-popup "keyup" cb)
                                        #(.removeEventListener el-popup "keyup" cb)))
                                    [])

                                   (when redirect-page-name
                                     [:div.tippy-wrapper.overflow-y-auto.p-4.outline-none
                                      {:ref   *el-popup
                                       :tab-index -1
                                       :style {:width          600
                                               :text-align     "left"
                                               :font-weight    500
                                               :max-height     600
                                               :padding-bottom 64}}
                                      (if (and (string? page-original-name) (text/namespace-page? page-original-name))
                                        [:div.my-2
                                         (->>
                                          (for [namespace-page (gp-util/split-namespace-pages page-original-name)]
                                            (when (and (string? namespace-page) namespace-page)
                                              (let [label (second (gp-util/split-last model/ns-char namespace-page))]
                                                (page-reference false namespace-page {:preview? true} label))))
                                          (interpose [:span.mx-2.opacity-30 model/ns-char]))]
                                        [:h2.font-bold.text-lg (if (= page-name redirect-page-name)
                                                                 page-original-name
                                                                 [:span
                                                                  [:span.text-sm.mr-2 "Alias:"]
                                                                  page-original-name])])
                                      (let [page (db/entity [:block/name (util/page-name-sanity-lc redirect-page-name)])]
                                        (editor-handler/insert-first-page-block-if-not-exists! redirect-page-name {:redirect? false})
                                        (let [page-blocks-cp (state/get-page-blocks-cp)
                                              tldraw-preview (state/get-component :whiteboard/tldraw-preview)]
                                          (if whiteboard-page?
                                            (tldraw-preview page-name)
                                            (page-blocks-cp (state/get-current-repo) page {:sidebar? sidebar? :preview? true}))))])))]

    (if (or (not manual?) open?)
      (ui/tippy {:ref             *tippy-ref
                 :in-editor?      true
                 :html            html-template
                 :interactive     true
                 :delay           [1000, 100]
                 :fixed-position? fixed-position?
                 :position        (or tippy-position "top")
                 :distance        (or tippy-distance 10)
                 :popperOptions   {:modifiers {:preventOverflow
                                               {:enabled           true
                                                :boundariesElement "viewport"}}}}
                children)
      children)))

(rum/defc page-cp
  "Component for a page. `page` argument contains :block/name which can be (un)sanitized page name.
   Keys for `config`:
   - `:preview?`: Is this component under preview mode? (If true, `page-preview-trigger` won't be registered to this `page-cp`)"
  [{:keys [html-export? redirect-page-name label children contents-page? preview?] :as config} page]
  (when-let [page-name-in-block (:block/name page)]
    (let [page-name-in-block (gp-util/remove-boundary-slashes page-name-in-block)
          page-name (util/page-name-sanity-lc page-name-in-block)
          page-entity (db/entity [:block/name page-name])
          whiteboard-page? (model/whiteboard-page? page-name)
          redirect-page-name (or (and (= :org (state/get-preferred-format))
                                      (:org-mode/insert-file-link? (state/get-config))
                                      redirect-page-name)
                                 (model/get-redirect-page-name page-name (:block/alias? config)))
          inner (page-inner config
                            page-name-in-block
                            page-name
                            redirect-page-name page-entity contents-page? children html-export? label whiteboard-page?)
          modal? (:modal/show? @state/state)]
      (cond
        (:breadcrumb? config)
        (or (:block/original-name page)
            (:block/name page))

        (and (not (util/mobile?))
             (not preview?)
             (not modal?))
        (page-preview-trigger (assoc config :children inner) page-name)

        :else
        inner))))

(rum/defc asset-reference
  [config title path]
  (let [repo (state/get-current-repo)
        real-path-url (cond
                        (gp-util/url? path)
                        path

                        (path/absolute? path)
                        path

                        :else
                        (assets-handler/resolve-asset-real-path-url repo path))
        ext-name (util/get-file-ext path)
        title-or-path (cond
                        (string? title)
                        title
                        (seq title)
                        (->elem :span (map-inline config title))
                        :else
                        path)]

    [:div.asset-ref-wrap
     {:data-ext ext-name}

     (cond
       ;; https://en.wikipedia.org/wiki/HTML5_video
       (contains? config/video-formats (keyword ext-name))
       [:video {:src real-path-url
                :controls true}]

       :else
       [:a.asset-ref {:target "_blank" :href real-path-url}
        title-or-path])]))

(defonce excalidraw-loaded? (atom false))
(rum/defc excalidraw < rum/reactive
  {:init (fn [state]
           (p/let [_ (loader/load :excalidraw)]
             (reset! excalidraw-loaded? true))
           state)}
  [file block-uuid]
  (let [loaded? (rum/react excalidraw-loaded?)
        draw-component (when loaded?
                         (resolve 'frontend.extensions.excalidraw/draw))]
    (when draw-component
      (draw-component {:file file :block-uuid block-uuid}))))

(rum/defc page-reference < rum/reactive
  "Component for page reference"
  [html-export? s {:keys [nested-link? id] :as config} label]
  (let [show-brackets? (state/show-brackets?)
        block-uuid (:block/uuid config)
        contents-page? (= "contents" (string/lower-case (str id)))]
    (if (string/ends-with? s ".excalidraw")
      [:div.draw {:on-click (fn [e]
                              (.stopPropagation e))}
       (excalidraw s block-uuid)]
      [:span.page-reference
       {:data-ref s}
       (when (and (or show-brackets? nested-link?)
                  (not html-export?)
                  (not contents-page?))
         [:span.text-gray-500.bracket page-ref/left-brackets])
       (let [s (string/trim s)]
         (page-cp (assoc config
                         :label (mldoc/plain->text label)
                         :contents-page? contents-page?)
                  {:block/name s}))
       (when (and (or show-brackets? nested-link?)
                  (not html-export?)
                  (not contents-page?))
         [:span.text-gray-500.bracket page-ref/right-brackets])])))

(defn- latex-environment-content
  [name option content]
  (if (= (string/lower-case name) "equation")
    content
    (util/format "\\begin%s\n%s\\end{%s}"
                 (str "{" name "}" option)
                 content
                 name)))

(declare blocks-container)

(defn- edit-parent-block [e config]
  (when-not (state/editing?)
    (.stopPropagation e)
    (editor-handler/edit-block! config :max (:block/uuid config))))

(rum/defc block-embed < rum/reactive db-mixins/query
  [config uuid]
  (when-let [block (db/entity [:block/uuid uuid])]
    (let [blocks (db/get-paginated-blocks (state/get-current-repo) (:db/id block)
                                          {:scoped-block-id (:db/id block)})]
      [:div.color-level.embed-block.bg-base-2
       {:style {:z-index 2}
        :on-double-click #(edit-parent-block % config)
        :on-mouse-down (fn [e] (.stopPropagation e))}
       [:div.px-3.pt-1.pb-2
        (blocks-container blocks (assoc config
                                        :db/id (:db/id block)
                                        :id (str uuid)
                                        :embed-id uuid
                                        :embed? true
                                        :embed-parent (:block config)
                                        :ref? false))]])))

(rum/defc page-embed < rum/reactive db-mixins/query
  [config page-name]
  (let [page-name (util/page-name-sanity-lc (string/trim page-name))
        current-page (state/get-current-page)
        whiteboard-page? (model/whiteboard-page? page-name)]
    [:div.color-level.embed.embed-page.bg-base-2
     {:class (when (:sidebar? config) "in-sidebar")
      :on-double-click #(edit-parent-block % config)
      :on-mouse-down #(.stopPropagation %)}
     [:section.flex.items-center.p-1.embed-header
      [:div.mr-3 svg/page]
      (page-cp config {:block/name page-name})]
     (when (and
            (not= (util/page-name-sanity-lc (or current-page ""))
                  page-name)
            (not= (util/page-name-sanity-lc (get config :id ""))
                  page-name))
       (if whiteboard-page?
         ((state/get-component :whiteboard/tldraw-preview) page-name)
         (let [page (model/get-page page-name)
               blocks (db/get-paginated-blocks (state/get-current-repo) (:db/id page))]
           (blocks-container blocks (assoc config
                                           :db/id (:db/id page)
                                           :id page-name
                                           :embed? true
                                           :page-embed? true
                                           :ref? false)))))]))

(defn- get-label-text
  [label]
  (when (and (= 1 (count label))
             (string? (last (first label))))
    (gp-util/safe-decode-uri-component (last (first label)))))

(defn- get-page
  [label]
  (when-let [label-text (get-label-text label)]
    (db/entity [:block/name (util/page-name-sanity-lc label-text)])))

(defn- macro->text
  [name arguments]
  (if (and (seq arguments)
           (not= arguments ["null"]))
    (util/format "{{%s %s}}" name (string/join ", " arguments))
    (util/format "{{%s}}" name)))

(declare block-content)
(declare block-container)
(declare breadcrumb)
;; F27 inline-context slice. Defined beside the other F27 panels, far below,
;; because it reuses them; declared here because the two ordinary inline
;; reference call sites are above it.
(declare f27-inline-block-reference)

(rum/defc block-reference < rum/reactive
  db-mixins/query
  [config id label]
  (if-let [block-id (parse-uuid id)]
    (let [db-id (:db/id (db/pull [:block/uuid block-id]))
          block (when db-id (db/sub-block db-id))
          block-type (keyword (get-in block [:block/properties :ls-type]))
          hl-type (get-in block [:block/properties :hl-type])
          repo (state/get-current-repo)
          stop-inner-events? (= block-type :whiteboard-shape)]
      (if (and block (:block/content block))
        (let [title [:span.block-ref
                     (block-content (assoc config :block-ref? true :stop-events? stop-inner-events?)
                                    block nil (:block/uuid block)
                                    (:slide? config)
                                    false)]
              inner (if label
                      (->elem
                       :span.block-ref
                       (map-inline config label))
                      title)]
          [:div.block-ref-wrap.inline
           {:data-type    (name (or block-type :default))
            :data-hl-type hl-type
            :on-mouse-down
            (fn [^js/MouseEvent e]
              (if (util/right-click? e)
                (state/set-state! :block-ref/context {:block (:block config)
                                                      :block-ref block-id})

                (when (and
                       (or (gobj/get e "shiftKey")
                           (not (.. e -target (closest ".blank"))))
                       (not (util/right-click? e)))
                  (util/stop e)

                  (cond
                    (gobj/get e "shiftKey")
                    (state/sidebar-add-block!
                     (state/get-current-repo)
                     (:db/id block)
                     :block-ref)

                    (and (util/meta-key? e) (whiteboard-handler/inside-portal? (.-target e)))
                    (whiteboard-handler/add-new-block-portal-shape!
                     (:block/uuid block)
                     (whiteboard-handler/closest-shape (.-target e)))

                    :else
                    (match [block-type (util/electron?)]
                      ;; pdf annotation
                      [:annotation true] (pdf-assets/open-block-ref! block)

                      [:whiteboard-shape true] (route-handler/redirect-to-whiteboard!
                                                (get-in block [:block/page :block/name]) {:block-id block-id})

                      ;; default open block page
                      :else (route-handler/redirect-to-page! id))))))}

           ;; F27 inline-context slice: `:f27/suppress-hover?` is set ONLY by
           ;; `f27-inline-ref`, and only while ITS panel is open, so the hover
           ;; preview cannot float over the panel the reader just opened. With
           ;; the key absent — which is everywhere else — this condition is
           ;; byte-for-byte the one it has always been, and closing the panel
           ;; restores the preview.
           (if (and (not (util/mobile?))
                    (not (:preview? config))
                    (not (:f27/suppress-hover? config))
                    (not (:modal/show? @state/state))
                    (nil? block-type))
             (ui/tippy {:html        (fn []
                                       [:div.tippy-wrapper.overflow-y-auto.p-4
                                        {:style {:width      735
                                                 :text-align "left"
                                                 :max-height 600}}
                                        [(breadcrumb config repo block-id {:indent? true})
                                         (blocks-container
                                          (db/get-block-and-children repo block-id)
                                          (assoc config :id (str id) :preview? true))]])
                        :interactive true
                        :in-editor?  true
                        :delay       [1000, 100]} inner)
             inner)])
        [:span.warning.mr-1 {:title "Block ref invalid"}
         (block-ref/->block-ref id)]))
    [:span.warning.mr-1 {:title "Block ref invalid"}
      (block-ref/->block-ref id)]))

(defn inline-text
  ([format v]
   (inline-text {} format v))
  ([config format v]
   (when (string? v)
     (let [inline-list (gp-mldoc/inline->edn v (gp-mldoc/default-config format))]
       [:div.inline.mr-1 (map-inline config inline-list)]))))

(defn- render-macro
  [config name arguments macro-content format]
  [:div.macro {:data-macro-name name}

   (if macro-content
     (let [ast (->> (mldoc/->edn macro-content (gp-mldoc/default-config format))
                    (map first))
           paragraph? (and (= 1 (count ast))
                           (= "Paragraph" (ffirst ast)))]
       (if (and (not paragraph?)
                (mldoc/block-with-title? (ffirst ast)))
         (markup-elements-cp (assoc config :block/format format) ast)
         (inline-text config format macro-content)))
     [:span.warning {:title (str "Unsupported macro name: " name)}
      (macro->text name arguments)])])

(rum/defc nested-link < rum/reactive
  [config html-export? link]
  (let [show-brackets? (state/show-brackets?)
        {:keys [content children]} link]
    [:span.page-reference.nested
     (when (and show-brackets?
                (not html-export?)
                (not (= (:id config) "contents")))
       [:span.text-gray-500 page-ref/left-brackets])
     (let [page-name (subs content 2 (- (count content) 2))]
       (page-cp (assoc config
                       :children children
                       :nested-link? true) {:block/name page-name}))
     (when (and show-brackets?
                (not html-export?)
                (not (= (:id config) "contents")))
       [:span.text-gray-500 page-ref/right-brackets])]))

(defn- show-link?
  [config metadata s full-text]
  (let [media-formats (set (map name config/media-formats))
        metadata-show (:show (gp-util/safe-read-string metadata))
        format (get-in config [:block :block/format])]
    (or
     (and
      (= :org format)
      (or
       (and
        (nil? metadata-show)
        (or
         (gp-config/local-asset? s)
         (text-util/media-link? media-formats s)))
       (true? (boolean metadata-show))))

     ;; markdown
     (string/starts-with? (string/triml full-text) "!")

     ;; image http link
     (and (or (string/starts-with? full-text "http://")
              (string/starts-with? full-text "https://"))
          (text-util/media-link? media-formats s)))))

(defn- relative-assets-path->absolute-path
  [path]
  (when (path/protocol-url? path)
    (js/console.error "BUG: relative-assets-path->absolute-path called with protocol url" path))
  (if (or (path/absolute? path) (path/protocol-url? path))
    path
    (.. util/node-path
        (join (config/get-repo-dir (state/get-current-repo))
              (config/get-local-asset-absolute-path path)))))

(rum/defc audio-link
  [config url href _label metadata full_text]
  (if (and (gp-config/local-asset? href)
           (config/local-db? (state/get-current-repo)))
    (asset-link config nil href metadata full_text)
    (let [href (cond
                 (util/starts-with? href "http")
                 href

                 (util/starts-with? href "ar")
                 (ar-url->http-url href)

                 config/publishing?
                 (subs href 1)

                 (= "Embed_data" (first url))
                 href

                 :else
                 (if (assets-handler/check-alias-path? href)
                   (assets-handler/resolve-asset-real-path-url (state/get-current-repo) href)
                   (get-file-absolute-path config href)))]
      (audio-cp href))))

(defn- media-link*
  [config url s label metadata full_text]
  (let [ext (keyword (util/get-file-ext s))
        label-text (get-label-text label)]
    (cond
      (contains? config/audio-formats ext)
      (audio-link config url s label metadata full_text)

      (= ext :pdf)
      (cond
        (util/electron?)
        [:a.asset-ref.is-pdf
         {:data-href s
          :on-click (fn [^js e]
                      (when-let [s (some-> (.-target e) (.-dataset) (.-href))]
                        (when-let [current (pdf-assets/inflate-asset s)]
                          (state/set-current-pdf! current)
                          (util/stop e))))
          :draggable true
          :on-drag-start #(.setData (gobj/get % "dataTransfer") "file" s)}
         (or label-text
             (->elem :span (map-inline config label)))]

        (mobile-util/native-platform?)
        (asset-link config label-text s metadata full_text))

      (contains? config/doc-formats ext)
      (asset-link config label-text s metadata full_text)

      (not (contains? #{:mp4 :webm :mov} ext))
      (image-link config url s label metadata full_text)

      :else
      (asset-reference config label s))))

(defn- media-link
  "F27 local-asset slice — the same guarded hook as `image-link`. This is the
  branch that reaches `resizable-image` (an asset at its natural size, carrying
  OG's delete/copy/maximize action bar and a resize handle that writes the
  block) and `asset-reference`/`audio-cp` (playback). None of those belong in a
  read-only reference-context panel."
  [config url s label metadata full_text]
  (if-let [f27-media (:f27/media-render config)]
    (f27-media config s label full_text)
    (media-link* config url s label metadata full_text)))

(defn- search-link-cp
  [config url s label title metadata full_text]
  (cond
    (string/blank? s)
    [:span.warning {:title "Invalid link"} full_text]

    (= \# (first s))
    (->elem :a {:on-click #(route-handler/jump-to-anchor! (mldoc/anchorLink (subs s 1)))} (subs s 1))

    ;; FIXME: same headline, see more https://orgmode.org/manual/Internal-Links.html
    (and (= \* (first s))
         (not= \* (last s)))
    (->elem :a {:on-click #(route-handler/jump-to-anchor! (mldoc/anchorLink (subs s 1)))} (subs s 1))

    (block-ref/block-ref? s)
    (let [id (block-ref/get-block-ref-id s)]
      ;; F27 readable-context batch: inside an F27 panel body, a block reference
      ;; is presented by F27's own bounded renderer instead of being substituted
      ;; recursively. `:f27/ref-render` is set ONLY by that renderer, so with the
      ;; key absent this is byte-for-byte the behaviour it has always had.
      (if-let [f27-render (:f27/ref-render config)]
        (f27-render config id label)
        ;; F27 inline-context slice: the same `block-reference`, with the
        ;; explicit context control beside it on ordinary reading surfaces and
        ;; nothing at all anywhere else.
        (f27-inline-block-reference config id label)))

    ;; F27 local-asset slice. A markdown link to a graph-local file written
    ;; WITHOUT a leading `!` never satisfies `show-link?`, so it falls through to
    ;; the electron branch below and renders as a bare `file://` anchor with
    ;; `target="_blank"`. Inside an F27 panel it is presented as a named
    ;; attachment instead. Guarded on the same key, so nothing changes elsewhere.
    ;; Recognition, not authorisation: F27 handles every node OG would have
    ;; called a local asset, and then refuses the ones that are not provably
    ;; inside the graph's own asset directory. Falling through instead would
    ;; hand a traversal path back to OG's `file://` anchor.
    (and (:f27/media-render config) (f27a/recognized-local? s))
    ((:f27/media-render config) config s label full_text)

    (not (string/includes? s "."))
    (page-reference (:html-export? config) s config label)

    (path/protocol-url? s)
    (->elem :a {:href s
                :data-href s
                :target "_blank"}
            (map-inline config label))

    (show-link? config metadata s full_text)
    (media-link config url s label metadata full_text)

    (util/electron?)
    (let [path (cond
                 (string/starts-with? s "file://")
                 (string/replace s "file://" "")

                 (string/starts-with? s "/")
                 s

                 :else
                 (relative-assets-path->absolute-path s))]
      (->elem
       :a
       (cond->
        {:href      (path/path-join "file://" path)
         :data-href path
         :target    "_blank"}
        title
        (assoc :title title))
       (map-inline config label)))

    :else
    (page-reference (:html-export? config) s config label)))

(defn- link-cp [config html-export? link]
  (let [{:keys [url label title metadata full_text]} link]
    (match url
      ["Block_ref" id]
      (let [label* (if (seq (mldoc/plain->text label)) label nil)
            {:keys [link-depth]} config
            link-depth (or link-depth 0)]
        ;; F27 readable-context batch. Inside an F27 panel body the reference is
        ;; presented by F27's own bounded renderer: one preview level, a cycle
        ;; reported as a cycle, and a budget — instead of substituting the whole
        ;; target block one `:link-depth` further down until OG's ceiling prints
        ;; "Block ref nesting is too deep" in every branch. The key is set only
        ;; by that renderer; absent, everything below is unchanged, and OG's
        ;; global `max-depth-of-links` is not touched.
        (if-let [f27-render (:f27/ref-render config)]
          (f27-render config id label*)
          (if (> link-depth max-depth-of-links)
            [:p.warning.text-sm "Block ref nesting is too deep"]
            ;; F27 inline-context slice, as in `search-link-cp` above. The
            ;; depth guard, the config and the arguments are unchanged.
            (f27-inline-block-reference (assoc config
                                               :reference? true
                                               :link-depth (inc link-depth)
                                               :block/uuid id)
                                        id label*))))

      ["Page_ref" page]
      (let [format (get-in config [:block :block/format])]
        (if (and (= format :org)
                 (show-link? config nil page page)
                 (not (contains? #{"pdf" "mp4" "ogg" "webm"} (util/get-file-ext page))))
          (image-link config url page nil metadata full_text)
          (let [label* (if (seq (mldoc/plain->text label)) label nil)]
            (if (and (string? page) (string/blank? page))
              [:span (page-ref/->page-ref page)]
              (page-reference (:html-export? config) page config label*)))))

      ["Embed_data" src]
      (image-link config url src nil metadata full_text)

      ["Search" s]
      (search-link-cp config url s label title metadata full_text)

      :else
      (let [href (string-of-url url)
            [protocol path] (or (and (= "Complex" (first url)) url)
                                (and (= "File" (first url)) ["file" (second url)]))]
        (cond
          (and (= (get-in config [:block :block/format]) :org)
               (= "Complex" protocol)
               (= (string/lower-case (:protocol path)) "id")
               (string? (:link path))
               (util/uuid-string? (:link path))) ; org mode id
          (let [id (uuid (:link path))
                block (db/entity [:block/uuid id])]
            (if (:block/pre-block? block)
              (let [page (:block/page block)]
                (page-reference html-export? (:block/name page) config label))
              (block-reference config (:link path) label)))

          (= protocol "file")
          (if (show-link? config metadata href full_text)
            (media-link config url href label metadata full_text)
            (let [redirect-page-name (when (string? path) (text/get-page-name path))
                  config (assoc config :redirect-page-name redirect-page-name)
                  label-text (get-label-text label)
                  page (if (string/blank? label-text)
                         {:block/name (db/get-file-page (string/replace href "file:" "") false)}
                         (get-page label))
                  show-brackets? (state/show-brackets?)]
              (if (and page
                       (when-let [ext (util/get-file-ext href)]
                         (gp-config/mldoc-support? ext)))
                [:span.page-reference
                 (when show-brackets? [:span.text-gray-500 page-ref/left-brackets])
                 (page-cp config page)
                 (when show-brackets? [:span.text-gray-500 page-ref/right-brackets])]

                (let [href* (if (util/electron?)
                              (relative-assets-path->absolute-path href)
                              href)]
                  (->elem
                   :a
                   (cond-> {:href      (path/path-join "file://" href*)
                            :data-href href*
                            :target    "_blank"}
                     title (assoc :title title))
                   (map-inline config label))))))

          (show-link? config metadata href full_text)
          (media-link config url href label metadata full_text)

          (= protocol "ar")
          (->elem
           :a.external-link
           (cond->
            {:href (ar-url->http-url href)
             :target "_blank"}
            title
            (assoc :title title))
           (map-inline config label))

          :else
          (->elem
           :a.external-link
           (cond->
            {:href href
             :target "_blank"}
            title
            (assoc :title title))
           (map-inline config label)))))))

(declare ->hiccup inline)

(defn wrap-query-components
  [config]
  (merge config
         {:->hiccup ->hiccup
          :->elem ->elem
          :page-cp page-cp
          :inline-text inline-text
          :map-inline map-inline
          :inline inline}))

;;;; Macro component render functions
(defn- macro-query-cp
  [config arguments]
  [:div.dsl-query.pr-3.sm:pr-0
   (let [query (->> (string/join ", " arguments)
                    (string/trim))]
     (query/custom-query (wrap-query-components (assoc config :dsl-query? true))
                         {:builder (query-builder-component/builder query config)
                          :query query}))])

(defn- macro-function-cp
  [config arguments]
  (or
   (some-> (:query-result config) rum/react (block-macros/function-macro arguments))
   [:span.warning
    (util/format "{{function %s}}" (first arguments))]))

(defn- macro-embed-cp
  [config arguments]
  (let [a (first arguments)
        {:keys [link-depth]} config
        link-depth (or link-depth 0)]
    (cond
      (nil? a)                      ; empty embed
      nil

      (> link-depth max-depth-of-links)
      [:p.warning.text-sm "Embed depth is too deep"]

      (page-ref/page-ref? a)
      (let [page-name (text/get-page-name a)]
        (when-not (string/blank? page-name)
          (page-embed (assoc config :link-depth (inc link-depth)) page-name)))

      (block-ref/string-block-ref? a)
      (when-let [s (-> a block-ref/get-string-block-ref-id string/trim)]
        (when-let [id (some-> s parse-uuid)]
          (block-embed (assoc config :link-depth (inc link-depth)) id)))

      :else                         ;TODO: maybe collections?
      nil)))

(defn- macro-vimeo-cp
  [_config arguments]
  (when-let [url (first arguments)]
    (when-let [vimeo-id (nth (util/safe-re-find text-util/vimeo-regex url) 5)]
      (when-not (string/blank? vimeo-id)
        (let [width (min (- (util/get-width) 96)
                         560)
              height (int (* width (/ 315 560)))]
          [:iframe
           {:allow-full-screen "allowfullscreen"
            :allow
            "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope"
            :frame-border "0"
            :src (str "https://player.vimeo.com/video/" vimeo-id)
            :height height
            :width width}])))))

(defn- macro-bilibili-cp
  [_config arguments]
  (when-let [url (first arguments)]
    (when-let [id (cond
                    (<= (count url) 15) url
                    :else
                    (nth (util/safe-re-find text-util/bilibili-regex url) 5))]
      (when-not (string/blank? id)
        (let [width (min (- (util/get-width) 96)
                         560)
              height (int (* width (/ 360 560)))]
          [:iframe
           {:allowfullscreen true
            :framespacing "0"
            :frameborder "no"
            :border "0"
            :scrolling "no"
            :src (str "https://player.bilibili.com/player.html?bvid=" id "&high_quality=1")
            :width width
            :height (max 500 height)}])))))

(defn- macro-video-cp
  [_config arguments]
  (if-let [url (first arguments)]
    (if (gp-util/url? url)
      (let [results (text-util/get-matched-video url)
            src (match results
                  [_ _ _ (:or "youtube.com" "youtu.be" "y2u.be") _ id _]
                  (if (= (count id) 11) ["youtube-player" id] url)

                  [_ _ _ "youtube-nocookie.com" _ id _]
                  (str "https://www.youtube-nocookie.com/embed/" id)

                  [_ _ _ "loom.com" _ id _]
                  (str "https://www.loom.com/embed/" id)

                  [_ _ _ (_ :guard #(string/ends-with? % "vimeo.com")) _ id _]
                  (str "https://player.vimeo.com/video/" id)

                  [_ _ _ "bilibili.com" _ id & query]
                  (str "https://player.bilibili.com/player.html?bvid=" id "&high_quality=1&autoplay=0"
                       (when-let [page (second query)]
                         (str "&page=" page)))

                  :else
                  url)]
        (if (and (coll? src)
                 (= (first src) "youtube-player"))
          (let [t (re-find #"&t=(\d+)" url)
                opts (when (seq t)
                       {:start (nth t 1)})]
            (youtube/youtube-video (last src) opts))
          (when src
            (let [width (min (- (util/get-width) 96) 560)
                  height (int (* width (/ (if (string/includes? src "player.bilibili.com")
                                            360 315)
                                          560)))]
              [:iframe
               {:allow-full-screen true
                :allow "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope"
                :framespacing "0"
                :frame-border "no"
                :border "0"
                :scrolling "no"
                :src src
                :width width
                :height height}]))))
      [:span.warning.mr-1 {:title "Invalid URL"}
       (macro->text "video" arguments)])
    [:span.warning.mr-1 {:title "Empty URL"}
     (macro->text "video" arguments)]))

(defn- macro-else-cp
  [name config arguments]
  (if-let [block-uuid (:block/uuid config)]
    (let [format (get-in config [:block :block/format] :markdown)
          macro-content (or
                         (-> (db/entity [:block/uuid block-uuid])
                             (:block/page)
                             (:db/id)
                             (db/entity)
                             :block/properties
                             :macros
                             (get name))
                         (get (state/get-macros) name)
                         (get (state/get-macros) (keyword name)))
          macro-content (cond
                          (= (str name) "img")
                          (case (count arguments)
                            1
                            (util/format "[:img {:src \"%s\"}]" (first arguments))
                            4
                            (when (and (util/safe-parse-int (nth arguments 1))
                                       (util/safe-parse-int (nth arguments 2)))
                              (util/format "[:img.%s {:src \"%s\" :style {:width %s :height %s}}]"
                                           (nth arguments 3)
                                           (first arguments)
                                           (util/safe-parse-int (nth arguments 1))
                                           (util/safe-parse-int (nth arguments 2))))
                            3
                            (when (and (util/safe-parse-int (nth arguments 1))
                                       (util/safe-parse-int (nth arguments 2)))
                              (util/format "[:img {:src \"%s\" :style {:width %s :height %s}}]"
                                           (first arguments)
                                           (util/safe-parse-int (nth arguments 1))
                                           (util/safe-parse-int (nth arguments 2))))

                            2
                            (cond
                              (util/safe-parse-int (nth arguments 1))
                              (util/format "[:img {:src \"%s\" :style {:width %s}}]"
                                           (first arguments)
                                           (util/safe-parse-int (nth arguments 1)))
                              (contains? #{"left" "right" "center"} (string/lower-case (nth arguments 1)))
                              (util/format "[:img.%s {:src \"%s\"}]"
                                           (string/lower-case (nth arguments 1))
                                           (first arguments))
                              :else
                              macro-content)

                            macro-content)

                          (and (seq arguments) macro-content)
                          (block/macro-subs macro-content arguments)

                          :else
                          macro-content)
          macro-content (when macro-content
                          (template/resolve-dynamic-template! macro-content))]
      (render-macro config name arguments macro-content format))
    (let [macro-content (or
                         (get (state/get-macros) name)
                         (get (state/get-macros) (keyword name)))
          format (get-in config [:block :block/format] :markdown)]
      (render-macro config name arguments macro-content format))))

(rum/defc namespace-hierarchy-aux
  [config namespace children]
  [:ul
   (for [child children]
     [:li {:key (str "namespace-" namespace "-" (:db/id child))}
      (let [shorten-name (some-> (or (:block/original-name child) (:block/name child))
                                 (string/split "/")
                                 last)]
        (page-cp {:label shorten-name} child))
      (when (seq (:namespace/children child))
        (namespace-hierarchy-aux config (:block/name child)
                                 (:namespace/children child)))])])

(rum/defc namespace-hierarchy
  [config namespace children]
  [:div.namespace
   [:div.font-medium.flex.flex-row.items-center.pb-2
    [:span.text-sm.mr-1 "Namespace "]
    (page-cp config {:block/name namespace})]
   (namespace-hierarchy-aux config namespace children)])

(defn- macro-cp
  [config options]
  (let [{:keys [name arguments]} options
        arguments (if (and
                       (>= (count arguments) 2)
                       (and (string/starts-with? (first arguments) page-ref/left-brackets)
                            (string/ends-with? (last arguments) page-ref/right-brackets))) ; page reference
                    (let [title (string/join ", " arguments)]
                      [title])
                    arguments)]
    (cond
      (= name "query")
      (macro-query-cp config arguments)

      (= name "function")
      (macro-function-cp config arguments)

      (= name "namespace")
      (let [namespace (first arguments)]
        (when-not (string/blank? namespace)
          (let [namespace (string/lower-case (page-ref/get-page-name! namespace))
                children (model/get-namespace-hierarchy (state/get-current-repo) namespace)]
            (namespace-hierarchy config namespace children))))

      (= name "youtube")
      (when-let [url (first arguments)]
        (when-let [youtube-id (cond
                                (== 11 (count url)) url
                                :else
                                (nth (util/safe-re-find text-util/youtube-regex url) 5))]
          (when-not (string/blank? youtube-id)
            (youtube/youtube-video youtube-id nil))))

      (= name "youtube-timestamp")
      (when-let [timestamp (first arguments)]
        (when-let [seconds (youtube/parse-timestamp timestamp)]
          (youtube/timestamp seconds)))

      (= name "zotero-imported-file")
      (let [[item-key filename] arguments]
        (when (and item-key filename)
          [:span.ml-1 (zotero/zotero-imported-file item-key filename)]))

      (= name "zotero-linked-file")
      (when-let [path (first arguments)]
        [:span.ml-1 (zotero/zotero-linked-file path)])

      (= name "vimeo")
      (macro-vimeo-cp config arguments)

      ;; TODO: support fullscreen mode, maybe we need a fullscreen dialog?
      (= name "bilibili")
      (macro-bilibili-cp config arguments)

      (= name "video")
      (macro-video-cp config arguments)

      (contains? #{"tweet" "twitter"} name)
      (when-let [url (first arguments)]
        (let [id-regex #"/status/(\d+)"]
          (when-let [id (cond
                          (<= (count url) 15) url
                          :else
                          (last (util/safe-re-find id-regex url)))]
            (ui/tweet-embed id))))

      (= name "embed")
      (macro-embed-cp config arguments)

      (= name "renderer")
      (when config/lsp-enabled?
        (when-let [block-uuid (str (:block/uuid config))]
          (plugins/hook-ui-slot :macro-renderer-slotted (assoc options :uuid block-uuid))))

      (get @macro/macros name)
      ((get @macro/macros name) config options)

      :else
      (macro-else-cp name config arguments))))

(defn- emphasis-cp
  [config kind data]
  (let [elem (case kind
               "Bold" :b
               "Italic" :i
               "Underline" :ins
               "Strike_through" :del
               "Highlight" :mark)]
    (->elem elem (map-inline config data))))

(defn hiccup->html
  [s]
  (let [result (gp-util/safe-read-string s)
        result' (if (seq result) result
                    [:div.warning {:title "Invalid hiccup"}
                     s])]
    (-> result'
       (hiccups.core/html)
       (security/sanitize-html))))

(defn inline
  [{:keys [html-export?] :as config} item]
  ;; F27 dynamic boundary. Inside an F27 panel body a Macro, inline HTML or
  ;; Hiccup node is presented as an inert placeholder instead of being handed to
  ;; `macro-cp` (which renders embeds, queries, remote players and plugin slots)
  ;; or to `dangerouslySetInnerHTML`. `:f27/inert-render` is set ONLY by F27's
  ;; body renderer and answers nil for every node it does not claim, so with the
  ;; key absent — and for every other node with it present — this is
  ;; byte-for-byte the dispatch it has always been.
  (if-let [inert (when-let [f (:f27/inert-render config)] (f config item))]
    inert
    (match item
         [(:or "Plain" "Spaces") s]
         s

         ["Superscript" l]
         (->elem :sup (map-inline config l))
         ["Subscript" l]
         (->elem :sub (map-inline config l))

         ["Tag" _]
         (when-let [s (gp-block/get-tag item)]
           (let [s (text/page-ref-un-brackets! s)]
             (page-cp (assoc config :tag? true) {:block/name s})))

         ["Emphasis" [[kind] data]]
         (emphasis-cp config kind data)

         ["Entity" e]
         [:span {:dangerouslySetInnerHTML
                 {:__html (security/sanitize-html (:html e))}}]

         ["Latex_Fragment" [display s]] ;display can be "Displayed" or "Inline"
         (if html-export?
           (latex/html-export s false true)
           (latex/latex (str (d/squuid)) s false (not= display "Inline")))

         [(:or "Target" "Radio_Target") s]
         [:a {:id s} s]

         ["Email" address]
         (let [{:keys [local_part domain]} address
               address (str local_part "@" domain)]
           [:a {:href (str "mailto:" address)} address])

         ["Nested_link" link]
         (nested-link config html-export? link)

         ["Link" link]
         (link-cp config html-export? link)

         [(:or "Verbatim" "Code") s]
         [:code s]

         ["Inline_Source_Block" x]
         [:code (:code x)]

         ["Export_Snippet" "html" s]
         (when (not html-export?)
           [:span {:dangerouslySetInnerHTML
                   {:__html (security/sanitize-html s)}}])

         ["Inline_Hiccup" s] ;; String to hiccup
         (ui/catch-error
          [:div.warning {:title "Invalid hiccup"} s]
          [:span {:dangerouslySetInnerHTML
                  {:__html (hiccup->html s)}}])

         ["Inline_Html" s]
         (when (not html-export?)
           ;; TODO: how to remove span and only export the content of `s`?
           [:span {:dangerouslySetInnerHTML {:__html (security/sanitize-html s)}}])

         [(:or "Break_Line" "Hard_Break_Line")]
         [:br]

         ["Timestamp" [(:or "Scheduled" "Deadline") _timestamp]]
         nil
         ["Timestamp" ["Date" t]]
         (timestamp t "Date")
         ["Timestamp" ["Closed" t]]
         (timestamp t "Closed")
         ["Timestamp" ["Range" t]]
         (range t false)
         ["Timestamp" ["Clock" ["Stopped" t]]]
         (range t true)
         ["Timestamp" ["Clock" ["Started" t]]]
         (timestamp t "Started")

         ["Cookie" ["Percent" n]]
         [:span {:class "cookie-percent"}
          (util/format "[%d%%]" n)]
         ["Cookie" ["Absolute" current total]]
         [:span {:class "cookie-absolute"}
          (util/format "[%d/%d]" current total)]

         ["Footnote_Reference" options]
         (let [{:keys [name]} options
               encode-name (util/url-encode name)]
           [:sup.fn
            [:a {:id (str "fnr." encode-name)
                 :class "footref"
                 :on-click #(route-handler/jump-to-anchor! (str "fn." encode-name))}
             name]])

         ["Macro" options]
         (macro-cp config options)

         :else "")))

(rum/defc block-child
  [block]
  block)

(defn- dnd-same-block?
  [uuid]
  (= (:block/uuid @*dragging-block) uuid))

(defn- bullet-drag-start
  [event block uuid block-id]
  (editor-handler/highlight-block! uuid)
  (editor-handler/block->data-transfer! uuid event)
  (.setData (gobj/get event "dataTransfer")
            "block-dom-id"
            block-id)
  (reset! *dragging? true)
  (reset! *dragging-block block))

(defn- bullet-on-click
  [e block uuid]
  (cond
    (gp-whiteboard/shape-block? block)
    (route-handler/redirect-to-whiteboard! (get-in block [:block/page :block/name]) {:block-id uuid})

    (gobj/get e "shiftKey")
    (do
      (state/sidebar-add-block!
       (state/get-current-repo)
       (:db/id block)
       :block)
      (util/stop e))

    (and (util/meta-key? e) (whiteboard-handler/inside-portal? (.-target e)))
    (do (whiteboard-handler/add-new-block-portal-shape!
         uuid
         (whiteboard-handler/closest-shape (.-target e)))
        (util/stop e))

    :else
    (when uuid (route-handler/redirect-to-page! uuid))))

(rum/defc block-children < rum/reactive
  [config block children collapsed?]
  (let [ref?        (:ref? config)
        query?      (:custom-query? config)
        children    (when (coll? children)
                      (remove nil? children))]
    (when (and (coll? children)
               (seq children)
               (not collapsed?))
      [:div.block-children-container.flex
       [:div.block-children-left-border
        {:on-click (fn [_]
                     (editor-handler/toggle-open-block-children! (:block/uuid block)))}]
       [:div.block-children.w-full {:style {:display (if collapsed? "none" "")}}
        (for [child children]
          (when (map? child)
            (let [child  (dissoc child :block/meta)
                  config (cond->
                           (-> config
                               (assoc :block/uuid (:block/uuid child))
                               (dissoc :breadcrumb-show? :embed-parent))
                           (or ref? query?)
                           (assoc :ref-query-child? true))]
              (rum/with-key (block-container config child)
                (str (:blocks-container-id config) "-" (:block/uuid child))))))]])))

(defn- block-content-empty?
  [{:block/keys [properties title body]}]
  (and
   (or
    (empty? properties)
    (property/properties-hidden? properties))

   (empty? title)

   (every? #(= % ["Horizontal_Rule"]) body)))

(rum/defcs block-control < rum/reactive
  [state config block uuid block-id collapsed? *control-show? edit? selected?]
  (let [doc-mode?          (state/sub :document/mode?)
        control-show?      (util/react *control-show?)
        ref?               (:ref? config)
        empty-content?     (block-content-empty? block)
        fold-button-right? (state/enable-fold-button-right?)
        own-number-list?   (:own-order-number-list? config)
        order-list?        (boolean own-number-list?)
        order-list-idx     (:own-order-list-index config)
        collapsable?       (editor-handler/collapsable? uuid {:semantic? true})]
    [:div.block-control-wrap.flex.flex-row.items-center
     {:class (util/classnames [{:is-order-list order-list?
                                :bullet-closed collapsed?}])}
     (when (or (not fold-button-right?) collapsable?)
       [:a.block-control
        {:id       (str "control-" uuid)
         :on-click (fn [event]
                     (util/stop event)
                     (state/clear-edit!)
                     (if ref?
                       (state/toggle-collapsed-block! uuid)
                       (if collapsed?
                         (editor-handler/expand-block! uuid)
                         (editor-handler/collapse-block! uuid))))}
        [:span {:class (if (or (and control-show?
                                    (or collapsed?
                                        (editor-handler/collapsable? uuid {:semantic? true})))
                               (and collapsed? order-list?))
                         "control-show cursor-pointer"
                         "control-hide")}
         (ui/rotating-arrow collapsed?)]])

     (let [bullet [:a.bullet-link-wrap {:on-click #(bullet-on-click % block uuid)}
                   [:span.bullet-container.cursor
                    {:id (str "dot-" uuid)
                     :draggable true
                     :on-drag-start (fn [event]
                                      (bullet-drag-start event block uuid block-id))
                     :blockid (str uuid)
                     :class (str (when collapsed? "bullet-closed")
                                 (when (and (:document/mode? config)
                                            (not collapsed?))
                                   " hide-inner-bullet")
                                 (when order-list? " as-order-list typed-list"))}

                    [:span.bullet (cond->
                                    {:blockid (str uuid)}
                                    selected?
                                    (assoc :class "selected"))
                     (when order-list?
                       [:label (str order-list-idx ".")])]]]]
       (cond
         (and (or (mobile-util/native-platform?)
                  (:ui/show-empty-bullets? (state/get-config))
                  collapsed?
                  collapsable?)
              (not doc-mode?))
         bullet

         (or
          (and empty-content?
               (not edit?)
               (not (:block.temp/top? block))
               (not (:block.temp/bottom? block))
               (not (util/react *control-show?)))
          (and doc-mode?
               (not collapsed?)
               (not (util/react *control-show?))))
         ;; hidden
         [:span.bullet-container]

         :else
         bullet))]))

(rum/defc dnd-separator
  [move-to block-content?]
  [:div.relative
   [:div.dnd-separator.absolute
    {:style {:left (cond-> (if (= move-to :nested) 40 20)
                     block-content?
                     (- 34))
             :top 0
             :width "100%"
             :z-index 3}}]])

(defn block-checkbox
  [block class]
  (let [marker (:block/marker block)
        [class checked?] (cond
                           (nil? marker)
                           nil
                           (contains? #{"NOW" "LATER" "DOING" "IN-PROGRESS" "TODO" "WAIT" "WAITING"} marker)
                           [class false]
                           (= "DONE" marker)
                           [(str class " checked") true])]
    (when class
      (ui/checkbox {:class class
                    :style {:margin-right 5}
                    :checked checked?
                    :on-mouse-down (fn [e]
                                     (util/stop-propagation e))
                    :on-change (fn [_e]
                                 (if checked?
                                   (editor-handler/uncheck block)
                                   (editor-handler/check block)))}))))

(defn list-checkbox
  [config checked?]
  (ui/checkbox
   {:style {:margin-right 6}
    :checked checked?
    :on-change (fn [event]
                 (let [target (.-target event)
                       block (:block config)
                       item-content (.. target -nextSibling -data)]
                   (editor-handler/toggle-list-checkbox block item-content)))}))

(defn marker-switch
  [{:block/keys [marker] :as block}]
  (when (contains? #{"NOW" "LATER" "TODO" "DOING"} marker)
    (let [set-marker-fn (fn [new-marker]
                          (fn [e]
                            (util/stop e)
                            (editor-handler/set-marker block new-marker)))
          next-marker (case marker
                        "NOW" "LATER"
                        "LATER" "NOW"
                        "TODO" "DOING"
                        "DOING" "TODO")]
      [:a
       {:class (str "marker-switch block-marker " marker)
        :title (util/format "Change from %s to %s" marker next-marker)
        :on-mouse-down (set-marker-fn next-marker)}
       marker])))

(defn marker-cp
  [{:block/keys [pre-block? marker] :as _block}]
  (when-not pre-block?
    (when (contains? #{"IN-PROGRESS" "WAIT" "WAITING"} marker)
      [:span {:class (str "task-status block-marker " (string/lower-case marker))
              :style {:margin-right 3.5}}
       (string/upper-case marker)])))

(rum/defc set-priority
  [block priority]
  [:div
   (let [priorities (sort (remove #(= priority %) ["A" "B" "C"]))]
     (for [p priorities]
       [:a.mr-2.text-base.tooltip-priority {:key (str (random-uuid))
                                            :priority p
                                            :on-click (fn [] (editor-handler/set-priority block p))}]))])

(rum/defc priority-text
  [priority]
  [:a.opacity-50.hover:opacity-100
   {:class "priority"
    :href (rfe/href :page {:name priority})
    :style {:margin-right 3.5}}
   (util/format "[#%s]" (str priority))])

(defn priority-cp
  [{:block/keys [pre-block? priority] :as block}]
  (when (and (not pre-block?) priority)
    (ui/tippy
     {:interactive true
      :html (set-priority block priority)}
     (priority-text priority))))

(defn block-tags-cp
  [{:block/keys [pre-block? tags] :as _block}]
  (when (and (not pre-block?)
             (seq tags))
    (->elem
     :span
     {:class "block-tags"}
     (mapv (fn [tag]
             (when-let [page (db/entity (:db/id tag))]
               (let [tag (:block/name page)]
                 [:a.tag.mx-1 {:data-ref tag
                               :key (str "tag-" (:db/id tag))
                               :href (rfe/href :page {:name tag})}
                  (str "#" tag)])))
           tags))))

(declare block-content)

(defn build-block-title
  [config {:block/keys [title marker pre-block? properties level]
           :as t}]
  (let [config (assoc config :block t)
        slide? (boolean (:slide? config))
        block-ref? (:block-ref? config)
        block-type (or (keyword (:ls-type properties)) :default)
        html-export? (:html-export? config)
        checkbox (when (and (not pre-block?)
                            (not html-export?))
                   (block-checkbox t (str "mr-1 cursor")))
        marker-switch (when (and (not pre-block?)
                                 (not html-export?))
                        (marker-switch t))
        marker-cp (marker-cp t)
        priority (priority-cp t)
        tags (block-tags-cp t)
        bg-color (:background-color properties)
        ;; `heading-level` is for backward compatibility, will remove it in later releases
        heading-level (:block/heading-level t)
        heading (or
                 (and heading-level
                      (<= heading-level 6)
                      heading-level)
                 (:heading properties))
        heading (if (true? heading) (min (inc level) 6) heading)
        elem (if heading
               (keyword (str "h" heading
                             (when block-ref? ".inline")))
               :span.inline)]
    (->elem
     elem
     (merge
      {:data-hl-type (:hl-type properties)}
      (when (and marker
                 (not (string/blank? marker))
                 (not= "nil" marker))
        {:class (str (string/lower-case marker))})
      (when bg-color
        (let [built-in-color? (ui/built-in-color? bg-color)]
          {:style {:background-color (if built-in-color?
                                       (str "var(--ls-highlight-color-" bg-color ")")
                                       bg-color)
                   :color (when-not built-in-color? "white")}
           :class "px-1 with-bg-color"})))

     ;; children
     (let [area?  (= :area (keyword (:hl-type properties)))
           hl-ref #(when (and (or config/publishing? (util/electron?))
                              (not (#{:default :whiteboard-shape} block-type)))
                     [:div.prefix-link
                      {:on-mouse-down
                       (fn [^js e]
                         (let [^js target (.-target e)]
                           (case block-type
                             ;; pdf annotation
                             :annotation
                             (if (and area? (.contains (.-classList target) "blank"))
                               :actions
                               (do
                                 (pdf-assets/open-block-ref! t)
                                 (util/stop e)))

                             :dune)))}

                      [:span.hl-page
                       [:strong.forbid-edit (str "P" (or (:hl-page properties) "?"))]
                       [:label.blank " "]]

                      (when (and area? (:hl-stamp properties))
                        (pdf-assets/area-display t))])]
       (remove-nils
        (concat
         [(when-not slide? checkbox)
          (when-not slide? marker-switch)
          marker-cp
          priority]

         ;; highlight ref block (inline)
         (when-not area? [(hl-ref)])

         (if title
           (conj
            (map-inline config title)
            (when (= block-type :whiteboard-shape) [:span.mr-1 (ui/icon "whiteboard-element" {:extension? true})]))
           [[:span.opacity-50 "Click here to start writing, type '/' to see all the commands."]])

         [tags]

         ;; highlight ref block (area)
         (when area? [(hl-ref)])))))))

(rum/defc span-comma
  []
  [:span ", "])

(rum/defc property-cp
  [config block k value]
  (let [date (and (= k :date) (date/get-locale-string (str value)))
        user-config (state/get-config)
        ;; When value is a set of refs, display full property text
        ;; because :block/properties value only contains refs but user wants to see text
        property-separated-by-commas? (text/separated-by-commas? (state/get-config) k)
        v (or
           (when (and (coll? value) (seq value)
                      (not property-separated-by-commas?))
             (get (:block/properties-text-values block) k))
           value)
        property-pages-enabled? (contains? #{true nil} (:property-pages/enabled? user-config))]
    [:div
     (if property-pages-enabled?
       (page-cp (assoc config :property? true) {:block/name (subs (str k) 1)})
       [:span.page-property-key.font-medium (name k)])
     [:span.mr-1 ":"]
     [:div.page-property-value.inline
      (cond
        (int? v)
        v

        (= k :file-path)
        v

        date
        date

        (and (string? v) (gp-util/wrapped-by-quotes? v))
        (gp-util/unquote-string v)

        (and property-separated-by-commas? (coll? v))
        (let [v (->> (remove string/blank? v)
                     (filter string?))
              vals (for [v-item v]
                     (page-cp config {:block/name v-item}))
              elems (interpose (span-comma) vals)]
          (for [elem elems]
            (rum/with-key elem (str (random-uuid)))))

        :else
        (inline-text config (:block/format block) (str v)))]]))

(rum/defc properties-cp
  [config {:block/keys [pre-block?] :as block}]
  (let [ordered-properties
        (property/get-visible-ordered-properties (:block/properties block)
                                                 (:block/properties-order block)
                                                 {:pre-block? pre-block?
                                                  :page-id (:db/id (:block/page block))})]
    (cond
      (seq ordered-properties)
      [:div.block-properties.rounded
       {:class (when pre-block? "page-properties")
        :title (if pre-block?
                 "Click to edit this page's properties"
                 "Click to edit this block's properties")}
       (for [[k v] ordered-properties]
         (rum/with-key (property-cp config block k v)
           (str (:block/uuid block) "-" k)))]

      (and pre-block? ordered-properties)
      [:span.opacity-50 "Properties"]

      :else
      nil)))

(rum/defc invalid-properties-cp
  [invalid-properties]
  (when (seq invalid-properties)
    [:div.invalid-properties.mb-2
     [:div.warning {:title "Invalid properties"}
      "Invalid property names: "
      (for [p invalid-properties]
        [:button.p-1.mr-2 p])]
     [:code "Property name begins with a non-numeric character and can contain alphanumeric characters and . * + ! - _ ? $ % & = < >. If -, + or . are the first character, the second character (if any) must be non-numeric."]]))

(rum/defcs timestamp-cp
  < rum/reactive
  (rum/local false ::show-datepicker?)
  [state block typ ast]
  (let [ts-block-id (state/sub [:editor/set-timestamp-block :block :block/uuid])
        active? (= (get block :block/uuid) ts-block-id)
        *show-datapicker? (get state ::show-datepicker?)]
    [:div.flex.flex-col.gap-4.timestamp
     [:div.text-sm.flex.flex-row
      [:div.opacity-50.font-medium.timestamp-label
       (str typ ": ")]
      [:a.opacity-80.hover:opacity-100
       {:on-mouse-down (fn [e]
                         (util/stop e)
                         (state/clear-editor-action!)
                         (editor-handler/escape-editing false)
                         (if active?
                           (do
                             (reset! *show-datapicker? false)
                             (reset! commands/*current-command nil)
                             (state/set-timestamp-block! nil))
                           (do
                             (reset! *show-datapicker? true)
                             (reset! commands/*current-command typ)
                             (state/set-timestamp-block! {:block block
                                                          :typ typ}))))}
       [:span.time-start "<"] [:time (repeated/timestamp->text ast)] [:span.time-stop ">"]]]
     ;; date-picker in rendering-mode
     (if (and active? @*show-datapicker?)
       (datetime-comp/date-picker nil nil (repeated/timestamp->map ast))
       (reset! *show-datapicker? false))]))

(defn- target-forbidden-edit?
  [target]
  (or
   (dom/has-class? target "forbid-edit")
   (dom/has-class? target "bullet")
   (dom/has-class? target "logbook")
   (util/link? target)
   (util/time? target)
   (util/input? target)
   (util/audio? target)
   (util/video? target)
   (util/details-or-summary? target)
   (and (util/sup? target)
        (dom/has-class? target "fn"))
   (dom/has-class? target "image-resize")
   (dom/closest target "a")
   (dom/closest target ".query-table")))

(defn- block-content-on-mouse-down
  [e block block-id content edit-input-id]
  (when-not (> (count content) (state/block-content-max-length (state/get-current-repo)))
    (let [target (gobj/get e "target")
          button (gobj/get e "buttons")
          shift? (gobj/get e "shiftKey")
          meta? (util/meta-key? e)
          forbidden-edit? (target-forbidden-edit? target)]
      (when (and (not forbidden-edit?) (contains? #{1 0} button))
        (util/stop-propagation e)
        (let [selection-blocks (state/get-selection-blocks)
              starting-block (state/get-selection-start-block-or-first)]
          (cond
            (and meta? shift?)
            (when-not (empty? selection-blocks)
              (util/stop e)
              (editor-handler/highlight-selection-area! block-id true))

            meta?
            (do
              (util/stop e)
              (let [block-dom-element (gdom/getElement block-id)]
                (if (some #(= block-dom-element %) selection-blocks)
                  (state/drop-selection-block! block-dom-element)
                  (state/conj-selection-block! block-dom-element :down)))
              (if (empty? (state/get-selection-blocks))
                (state/clear-selection!)
                (state/set-selection-start-block! block-id)))

            (and shift? starting-block)
            (do
              (util/stop e)
              (util/clear-selection!)
              (editor-handler/highlight-selection-area! block-id))

            shift?
            (do
              (util/clear-selection!)
              (state/set-selection-start-block! block-id))

            :else
            (do
              (editor-handler/clear-selection!)
              (editor-handler/unhighlight-blocks!)
              (let [f #(let [block (or (db/pull [:block/uuid (:block/uuid block)]) block)
                             cursor-range (some-> (gdom/getElement block-id)
                                                  (dom/by-class "block-content-wrapper")
                                                  first
                                                  util/caret-range)
                             {:block/keys [content format]} block
                             content (->> content
                                          (property/remove-built-in-properties format)
                                          (drawer/remove-logbook))]
                         ;; save current editing block
                         (let [{:keys [value] :as state} (editor-handler/get-state)]
                           (editor-handler/save-block! state value))
                         (state/set-editing!
                          edit-input-id
                          content
                          block
                          cursor-range
                          false))]
                ;; wait a while for the value of the caret range
                (if (util/ios?)
                  (f)
                  (js/setTimeout f 5))

                (state/set-selection-start-block! block-id)))))))))

(rum/defc dnd-separator-wrapper < rum/reactive
  [block block-id slide? top? block-content?]
  (let [dragging? (rum/react *dragging?)
        drag-to-block (rum/react *drag-to-block)]
    (when (and
           (= block-id drag-to-block)
           dragging?
           (not slide?)
           (not (:block/pre-block? block)))
      (let [move-to (rum/react *move-to)]
        (when-not
         (or (and top? (not= move-to :top))
             (and (not top?) (= move-to :top))
             (and block-content? (not= move-to :nested))
             (and (not block-content?)
                  (seq (:block/children block))
                  (= move-to :nested)))
         (dnd-separator move-to block-content?))))))

(defn clock-summary-cp
  [block body]
  (when (and (state/enable-timetracking?)
             (or (= (:block/marker block) "DONE")
                 (contains? #{"TODO" "LATER"} (:block/marker block))))
    (let [summary (clock/clock-summary body true)]
      (when (and summary
                 (not= summary "0m")
                 (not (string/blank? summary)))
        [:div {:style {:max-width 100}}
         (ui/tippy {:html        (fn []
                                   (when-let [logbook (drawer/get-logbook body)]
                                     (let [clocks (->> (last logbook)
                                                       (filter #(string/starts-with? % "CLOCK:"))
                                                       (remove string/blank?))]
                                       [:div.p-4
                                        [:div.font-bold.mb-2 "LOGBOOK:"]
                                        [:ul
                                         (for [clock (take 10 (reverse clocks))]
                                           [:li clock])]])))
                    :interactive true
                    :in-editor?  true
                    :delay       [1000, 100]}
                   [:div.text-sm.time-spent.ml-1 {:style {:padding-top 3}}
                    [:a.fade-link
                     summary]])]))))

(defn- block-content-inner
  [config block body plugin-slotted? collapsed? block-ref-with-title?]
  (if plugin-slotted?
    [:div.block-slotted-body
     (plugins/hook-block-slot
      :block-content-slotted
      (-> block (dissoc :block/children :block/page)))]

    (let [title-collapse-enabled? (:outliner/block-title-collapse-enabled? (state/get-config))]
      (when (and (not block-ref-with-title?)
                 (seq body)
                 (or (not title-collapse-enabled?)
                     (and title-collapse-enabled?
                          (or (not collapsed?)
                              (some? (mldoc/extract-first-query-from-ast body))))))
        [:div.block-body
         ;; TODO: consistent id instead of the idx (since it could be changed later)
         (let [body (block/trim-break-lines! (:block/body block))]
           (for [[idx child] (medley/indexed body)]
             (when-let [block (markup-element-cp config child)]
               (rum/with-key (block-child block)
                 (str uuid "-" idx)))))]))))

(rum/defc block-content < rum/reactive
  [config {:block/keys [uuid content children properties scheduled deadline format pre-block?] :as block} edit-input-id block-id slide? selected?]
  (let [content (property/remove-built-in-properties format content)
        {:block/keys [title body] :as block} (if (:block/title block) block
                                                 (merge block (block/parse-title-and-body uuid format pre-block? content)))
        collapsed? (util/collapsed? block)
        plugin-slotted? (and config/lsp-enabled? (state/slot-hook-exist? uuid))
        block-ref? (:block-ref? config)
        stop-events? (:stop-events? config)
        block-ref-with-title? (and block-ref? (not (state/show-full-blocks?)) (seq title))
        block-type (or (:ls-type properties) :default)
        content (if (string? content) (string/trim content) "")
        mouse-down-key (if (util/ios?)
                         :on-click
                         :on-mouse-down) ; TODO: it seems that Safari doesn't work well with on-mouse-down

        attrs (cond->
               {:blockid       (str uuid)
                :data-type (name block-type)
                :style {:width "100%" :pointer-events (when stop-events? "none")}}

               (not (string/blank? (:hl-color properties)))
               (assoc :data-hl-color (:hl-color properties))

               (not block-ref?)
               (assoc mouse-down-key (fn [e]
                                       (block-content-on-mouse-down e block block-id content edit-input-id))))]
    [:div.block-content.inline
     (cond-> {:id (str "block-content-" uuid)
              :class (when selected? "select-none")
              :on-mouse-up (fn [e]
                             (when (and
                                    (state/in-selection-mode?)
                                    (not (string/includes? content "```"))
                                    (not (gobj/get e "shiftKey"))
                                    (not (util/meta-key? e)))
                               ;; clear highlighted text
                               (util/clear-selection!)))}
       (not slide?)
       (merge attrs))

     [:<>
      (when (> (count content) (state/block-content-max-length (state/get-current-repo)))
        [:div.warning.text-sm
         "Large block will not be editable or searchable to not slow down the app, please use another editor to edit this block."])
      [:div.flex.flex-row.justify-between.block-content-inner
       (when-not plugin-slotted?
         [:div.flex-1.w-full
          (cond
            (or (seq title) (:block/marker block))
            (build-block-title config block)

            :else
            nil)])

       (clock-summary-cp block body)]

      (when (seq children)
        (dnd-separator-wrapper block block-id slide? false true))

      (when deadline
        (when-let [deadline-ast (block-handler/get-deadline-ast block)]
          (timestamp-cp block "DEADLINE" deadline-ast)))

      (when scheduled
        (when-let [scheduled-ast (block-handler/get-scheduled-ast block)]
          (timestamp-cp block "SCHEDULED" scheduled-ast)))

      (when-let [invalid-properties (:block/invalid-properties block)]
        (invalid-properties-cp invalid-properties))

      (when (and (seq properties)
                 (let [hidden? (property/properties-hidden? properties)]
                   (not hidden?))
                 (not (and block-ref? (or (seq title) (seq body))))
                 (not (:slide? config))
                 (not= block-type :whiteboard-shape))
        (properties-cp config block))

      (block-content-inner config block body plugin-slotted? collapsed? block-ref-with-title?)

      (case (:block/warning block)
        :multiple-blocks
        [:p.warning.text-sm "Full content is not displayed, Logseq doesn't support multiple unordered lists or headings in a block."]
        nil)]]))

(rum/defc block-refs-count < rum/static
  [block *hide-block-refs? *show-ref-overview?]
  (let [block-refs-count (count (:block/_refs block))]
    (when (> block-refs-count 0)
      [:div
       [:a.open-block-ref-link.bg-base-2.text-sm.ml-2.fade-link
        {:title (t :f27/badge-title)
         :style {:margin-top -1}
         :on-click (fn [e]
                     ;; Shift-click keeps its existing behaviour exactly: straight
                     ;; to the right sidebar, bypassing the F27 overview.
                     (if (gobj/get e "shiftKey")
                       (state/sidebar-add-block!
                        (state/get-current-repo)
                        (:db/id block)
                        :block-ref)
                       ;; F27 slice 1: a normal click opens the compact
                       ;; incoming-reference overview instead of jumping straight
                       ;; to the full list. The full list stays one click away and
                       ;; renders through OG's existing component, unchanged.
                       (if (some? *show-ref-overview?)
                         (swap! *show-ref-overview? not)
                         (swap! *hide-block-refs? not))))}
        block-refs-count]])))

;; ---------------------------------------------------------------------------
;; F27 slice 1 — compact incoming-reference overview.
;;
;; The badge counts INCOMING references. Each row therefore describes ONE
;; referencing block and shows THAT block's own source page and short ancestor
;; path, reusing OG's existing `breadcrumb`. It is not a restatement of the
;; canonical target's own location.
;;
;; Display-only: no graph write, no persistence, no recursive traversal.
;; Crystal information is deliberately absent in slice 1 (see F27_FIRST_SLICE_SPEC).
;; ---------------------------------------------------------------------------
;; ---------------------------------------------------------------------------
;; F27 slice 2 — Crystal previews.
;;
;; A Crystal is content EXPLICITLY marked with the user's chosen tag. Explicit
;; means an inline tag node (#tag / #[[multi word]]) that OG's own parser emits,
;; or a block `tags::` property. An ordinary [[page link]] to the same page, an
;; inherited path reference, and text inside code are all deliberately excluded,
;; because OG's parser does not emit a Tag node for them.
;;
;; SCOPE: for each incoming-reference row, only the referencing block and its
;; ancestor chain on that same source page are searched. Unrelated branches, the
;; rest of the source page, the wider graph and followed references are NOT
;; searched. This is disclosed in the panel so the reader does not assume every
;; tagged item on the source page appears.
;;
;; All reads. Nothing here writes a graph file.
;; ---------------------------------------------------------------------------
(defn- f27-block-explicit-tags
  "Explicit tag identities carried by one block, using OG's own parser."
  [block]
  (let [content (:block/content block)
        format  (or (:block/format block) :markdown)
        inline  (when (and (string? content) (seq content))
                  (try
                    (f27c/tags-from-ast
                     (gp-mldoc/inline->edn content (gp-mldoc/default-config format))
                     gp-block/get-tag)
                    (catch :default _ nil)))
        props   (f27c/tags-from-properties (:block/properties block))]
    {:inline (or inline #{}) :props (or props #{})}))

(defn- f27-crystal-matches
  "Crystal matches for one incoming-reference row: the referencing block itself,
  then its ancestors on the same source page, nearest first. Bounded traversal."
  [repo crystal-tag ref-block]
  (when (and crystal-tag ref-block)
    (let [uuid' (:block/uuid ref-block)
          ancestors (when uuid'
                      (try
                        (reverse (db/get-block-parents repo uuid' f27c/max-ancestor-depth))
                        (catch :default _ nil)))
          candidates (->> (cons ref-block ancestors)
                          (remove nil?)
                          ;; a page entity is not a block match
                          (remove :block/name))]
      (->> candidates
           (keep (fn [b]
                   (let [{:keys [inline props]} (f27-block-explicit-tags b)]
                     (when (f27c/block-tagged? crystal-tag inline props)
                       {:uuid (:block/uuid b)
                        :content (:block/content b)
                        ;; Carried so the chip can drop the block's built-in
                        ;; properties the same way the block itself does.
                        :format (:block/format b)
                        :self? (= (:block/uuid b) uuid')}))))
           vec))))

(defn- f27-crystal-tag-inventory
  "Explicit tag names present in this graph, derived from the SAME two sources
  the matcher accepts: inline tag nodes and `tags::` properties.

  OG offers no API for this — `get-tag-pages` covers only the page-level
  :block/tags property, and :block/refs cannot tell #tag from [[link]] — so the
  inventory is computed here. A page that is only ever an ordinary link target
  never appears.

  Scanning is BOUNDED and reported honestly. `limit` caps how many candidate
  blocks are parsed in this pass; the returned map states how many candidates
  exist so the caller can offer continuation instead of implying completeness.
  Read-only throughout."
  ([repo] (f27-crystal-tag-inventory repo f27c/default-scan-batch))
  ([repo limit]
   (try
     (let [db (db/get-db repo)
           all (when db
                 (->> (d/q '[:find ?c ?f ?p
                             :where
                             [?b :block/content ?c]
                             [(get-else $ ?b :block/format :markdown) ?f]
                             [(get-else $ ?b :block/properties {}) ?p]]
                           db)
                      (filter (fn [[c _ p]]
                                (or (and (string? c)
                                         (or (string/includes? c "#")
                                             (string/includes? c "tags::")))
                                    (seq (f27c/tags-from-properties p)))))
                      vec))
           candidates (count all)
           limit (max 0 (or limit f27c/default-scan-batch))
           batch (subvec all 0 (min limit candidates))
           entries (map (fn [[c f p]]
                          {:inline (f27c/tags-from-ast
                                    (try (gp-mldoc/inline->edn c (gp-mldoc/default-config (or f :markdown)))
                                         (catch :default _ nil))
                                    gp-block/get-tag)
                           :props (f27c/tags-from-properties p)})
                        batch)
           page-tags (->> (d/q '[:find ?n :where [_ :block/tags ?t] [?t :block/name ?n]] db)
                          (map first)
                          (keep f27c/normalize-tag)
                          set)]
       {:repo repo
        :tags (into (f27c/collect-tags entries) page-tags)
        :scanned (count batch)
        :candidates candidates
        :limit limit
        :error nil})
     (catch :default e
       ;; An error must be visible, never a silently empty "complete" inventory.
       {:repo repo :tags #{} :scanned 0 :candidates 0 :limit limit
        :error (or (some-> e .-message) "scan failed")}))))

(defn- f27-display-content
  "One block's content as OG itself shows it: its BUILT-IN properties removed.

  `:block/content` is the raw file text, so a block carrying a persisted `id::`
  renders that line as literal text through an inline renderer. Every block in a
  reference chain has one by necessity — that is what makes it referable — so
  without this the panel showed a 36-character identifier under each row.

  `remove-built-in-properties` is the same function `block-content` uses for the
  outline itself, so the panel and the block agree on what the block says. The
  block on disk is untouched; this only affects what is displayed."
  [format content]
  (when (and (string? content) (not (string/blank? content)))
    (let [c (property/remove-built-in-properties (or format :markdown) content)]
      (when (and (string? c) (not (string/blank? c))) (string/trim c)))))

(defn- f27-btn
  "Props for one F27 panel control, so every one of them behaves identically.

  These are native `<button>`s, which Enter and Space are supposed to activate
  on their own. OG installs a global `goog.ui.KeyboardShortcutHandler` on
  `window` that binds `enter` and prevents the default action of every key it
  matches — and a button's implicit activation IS that default action, so Enter
  on a focused control in this panel did nothing at all. The key is therefore
  handled here and stopped before it reaches the global handler, which restores
  what a button should do without touching OG's own shortcut configuration.

  `preventDefault` also stops the browser synthesising its own click, so the
  action runs exactly once however the control was operated."
  [on-activate extra]
  (merge {:type "button"
          :on-click (fn [e] (util/stop e) (on-activate))
          :on-key-down (fn [e]
                         (let [k (.-key e)]
                           (when (or (= k "Enter") (= k " ") (= k "Spacebar"))
                             (.preventDefault e)
                             (.stopPropagation e)
                             (on-activate))))}
         extra))

;; ---------------------------------------------------------------------------
;; F27 readable-context batch — how a block's TEXT is rendered inside a panel.
;;
;; Until now the panels called `inline-text`, which is OG's ordinary inline
;; renderer. For a `((uuid))` that renderer reaches `block-reference`, which
;; renders the whole target block — including the references inside IT — one
;; `:link-depth` further down. Two blocks that reference each other therefore
;; substituted each other's text repeatedly until OG's ceiling was passed, and
;; every branch printed "Block ref nesting is too deep". That is what filled the
;; user's panels; the inbound navigator's cycle guard could not see it, because
;; it guards navigation steps, not body rendering.
;;
;; The contract here (F27_BODY_DISPLAY_CONTRACT.md):
;;   * the block's own text is rendered in full, by OG's own parser and
;;     renderer, so emphasis, page links, tags, headings, tasks, Korean and
;;     emoji are untouched;
;;   * a reference inside it shows ONE bounded preview of what it points at;
;;   * a reference inside THAT preview is not followed — it is named compactly
;;     and left for explicit navigation;
;;   * a repeat or a cycle is said to be a repeat, an unresolvable target is
;;     said to be unavailable, and neither is ever shown as a raw identifier.
;;
;; It is installed through `:f27/ref-render`, a config key only this code sets,
;; so OG's ordinary rendering — and its global `max-depth-of-links` — are
;; unchanged. Read-only throughout: entity lookups and pure functions.
;; ---------------------------------------------------------------------------

(defn- f27-ref-key
  "One reference identity, in the single form the render trail compares.

  Identities arrive both as parsed strings from the AST and as uuid objects from
  an entity; a trail that mixed the two would never detect the cycle it exists
  for."
  [id]
  (let [s (some-> id str string/trim string/lower-case)]
    (when-not (string/blank? s) s)))

(defn- f27-ref-target
  "Resolve a block reference's target for display. A read; never a write.

  A malformed identifier and a deleted block both resolve to nil, and the caller
  says so in words rather than showing the identifier."
  [repo id]
  (when-let [u (try (parse-uuid (str id)) (catch :default _ nil))]
    (try (db/entity repo [:block/uuid u]) (catch :default _ nil))))

(defn- f27-ref-label
  "A compact, readable name for a reference target — never an identifier.

  A referring block's raw text is largely `((uuid))` by definition, so inline
  reference markup is first reduced to what a person reads, then block-level
  prefixes are split off, and only then is it truncated on grapheme boundaries.

  The cap is explicit so the same label can serve as a preview's fallback
  without exceeding what that preview was allowed to spend."
  ([entity] (f27-ref-label entity f27b/max-label-chars))
  ([entity max-len]
   (let [content (f27-display-content (:block/format entity) (:block/content entity))
         {:keys [text]} (f27ctx/split-block-prefix (f27in/plain-label content))]
     (f27b/compact-label text max-len))))

(defn- f27-ref-source-button
  "The source control carried by every chip that HAS a source.

  A native button, so Tab reaches it and Enter or Space activates it, with an
  accessible name that says which block it opens. It goes to the same place
  OG's own block-reference click goes."
  [id label]
  [:button.f27-body-ref-src.f27-btn
   (f27-btn (fn [] (route-handler/redirect-to-page! (str id)))
            {:aria-label (if label
                           (t :f27/inbound-open-source-of label)
                           (t :f27/inbound-open-source))
             :title (t :f27/inbound-open-source)})
   "↗"])

;; ---------------------------------------------------------------------------
;; F27 local-asset slice — how an ASSET is presented inside a panel body.
;;
;; Until now the panels rendered assets with OG's own path, which inside a
;; read-only reference-context panel produced four separate problems:
;;
;;   * an image at its natural size (or the author's stored `:width`) filled the
;;     panel the reader opened to read text;
;;   * `resizable-image` hung OG's action bar on it — DELETE ASSET with a
;;     physical-delete checkbox, copy, maximize — and a resize handle whose
;;     mouse-up calls `editor-handler/resize-image!`, which WRITES the block.
;;     That was the one path from a read-only panel to a graph write;
;;   * an `http` source was FETCHED, so opening a context panel issued network
;;     requests for whatever the referenced blocks happened to link to;
;;   * a missing file said nothing at all: a broken image icon, or a dead link.
;;
;; The contract here (F27_ASSET_DISPLAY_CONTRACT.md):
;;
;;   full context   a graph-local image is a thumbnail bounded by CSS; every
;;                  other asset is its readable NAME with one open control
;;   preview        a compact indicator only, charged to the preview budget
;;   remote/data    named, never fetched, never decoded
;;   missing        said in words, with no control that cannot work
;;
;; Installed through `:f27/media-render`, a config key only `f27-body-config`
;; sets, so OG's ordinary asset rendering is untouched.
;; ---------------------------------------------------------------------------

(def ^:private f27-asset-index-ttl
  "How long one graph's asset listing is reused, in milliseconds.

  The listing IS the authorisation, so it is read rather than assumed; a body
  carrying five assets must not read it five times. A file added while a panel
  is open is therefore unavailable for up to this long, which is the direction
  this boundary is meant to fail in."
  5000)

(def ^:private f27-asset-root-ttl
  "How long a PASSING asset-root check is reused, in milliseconds.

  The root check reads the whole graph directory, and the asset listing reads
  only `assets/` — measured on a synthetic 20,300-file tree, about 40 ms against
  about 1 ms. Whether `assets` is a real directory changes far less often than
  what is inside it, so a pass is reused for a minute rather than for five
  seconds, and a large graph is not walked every time a panel re-renders.

  A REFUSAL is deliberately NOT cached this long — it is cached for
  `f27-asset-index-ttl` like the listing — so a graph whose asset directory is
  created or filled later recovers exactly as quickly as it did before."
  60000)

(defonce ^:private *f27-asset-index (atom {}))
(defonce ^:private *f27-asset-root (atom {}))

(defn- f27-asset-root-real?
  "Is `<graph>/assets` a real directory of this graph, rather than a symbolic
  link pointing out of it?

  This is the gate the boundary was missing. `logseq.common.graph/readdir`
  removes symbolic links among the entries it FINDS, but it seeds its walk with
  `[true root-dir]` and never asks whether the directory it was handed is itself
  a link. F27 hands it `<graph>/assets` directly, so an assets directory that is
  a symbolic link was walked and everything behind it was listed as though it
  were inside the graph — and every path under it is lexically contained, so the
  pure gate passed it too.

  The authority is unchanged and no capability is added to the main process. It
  is applied ONE LEVEL UP: a symlinked `assets` is removed among the graph
  root's own children, so nothing under `<root>/assets/` appears in the graph's
  own listing, and F27 refuses the directory before descending into it.

  Fails closed. A directory that cannot be read, a blank graph path and a
  listing with nothing under `assets/` all answer false, and a refusal is not
  cached beyond the listing's own lifetime."
  [repo {:keys [force?]}]
  (let [dir (config/get-repo-dir repo)
        root (f27a/graph-root dir)
        now (js/Date.now)
        cached (get @*f27-asset-root root)]
    (cond
      (nil? root) (p/resolved false)
      (and (not force?) cached
           (< (- now (:at cached)) (if (:ok? cached) f27-asset-root-ttl f27-asset-index-ttl)))
      (p/resolved (:ok? cached))

      :else
      ;; `:path-only? true` is the only non-deprecated spelling of this call:
      ;; `frontend.fs/readdir` normalises the paths it returns either way, and
      ;; the flag governs nothing but the deprecation notice it logs when the
      ;; flag is absent. Passing it changes what is READ by nothing at all.
      (-> (p/let [files (fs/readdir root :path-only? true)]
            (let [ok? (f27a/asset-root-real? root files)]
              (swap! *f27-asset-root assoc root {:at now :ok? ok?})
              ok?))
          (p/catch (fn [_]
                     (swap! *f27-asset-root assoc root {:at now :ok? false})
                     false))))))

(defn- f27-asset-listing
  "Every REAL file inside this graph's own asset directory: a map from the
  graph-relative path to the absolute path the filesystem reported.

  This is the containment authority, and it is deliberately a listing rather
  than a per-path probe. OG's own recursive `readdir` — unchanged, and already
  how the graph is read — removes symbolic links as it walks. A link planted
  inside `assets/` that points outside the graph therefore never appears here,
  so it is never authorised, and this batch adds no new capability to the main
  process to achieve that.

  The asset ROOT is checked first, because this listing cannot speak for the
  directory it starts from. With that gate refused, nothing is listed at all.

  Membership answers three questions at once: the file exists, it is inside the
  asset directory, and it is a real file rather than a way out of one."
  [repo opts]
  (let [dir (config/get-repo-dir repo)
        adir (f27a/asset-dir dir)
        now (js/Date.now)
        cached (get @*f27-asset-index adir)]
    (cond
      (nil? adir) (p/resolved {})
      (and (not (:force? opts)) cached (< (- now (:at cached)) f27-asset-index-ttl))
      (p/resolved (:files cached))

      :else
      (p/let [root-ok? (f27-asset-root-real? repo opts)]
        (if-not root-ok?
          ;; The asset directory is not provably a real directory of this graph.
          ;; Nothing behind it is authorised, and the refusal is not cached as a
          ;; listing, so the cheap gate above is re-asked on its own schedule.
          (p/resolved {})
          ;; Same call, same containment authority, same normalised result;
          ;; see the note on the root gate above.
          (-> (p/let [files (fs/readdir adir :path-only? true)]
                (let [m (f27a/asset-index dir files)]
                  (swap! *f27-asset-index assoc adir {:at now :files m})
                  m))
              ;; A directory that cannot be read authorises nothing, and is not
              ;; cached, so a graph whose assets appear later is not stuck.
              (p/catch (fn [_] {}))))))))

(defn- f27-asset-locate
  "The absolute path this asset is stored under, or nil.

  Three gates, in order, and all three must pass:

    1. **Containment**, purely, before any filesystem call at all. OG's
       `local-asset?` is a prefix recogniser: it calls
       `../assets/../../outside.png`, `../assets/%2e%2e/%2e%2e/outside.png` and
       `../assets-other/x.png` local. A spelling that is not provably inside the
       asset directory yields no candidates, so nothing is probed, loaded or
       revealed for it.
    2. **The asset root**, read from the graph's own listing one level up, so an
       `assets` directory that is ITSELF a symbolic link is refused before it is
       descended into.
    3. **The graph's own asset listing**, which excludes symbolic links, so a
       path that is lexically contained but leaves through a link is refused
       too.

  The answer is the path the FILESYSTEM reported, not the spelling the author
  typed — a live run showed that resolving from the typed spelling produced an
  address the asset protocol could not open. Both spellings of an encoded name
  are still tried, decoded first.

  `:force?` bypasses both caches. It is what the reveal control uses, so an
  authorisation is re-asked at the moment it is acted on rather than trusted
  from whenever the panel happened to mount."
  ([repo href] (f27-asset-locate repo href nil))
  ([repo href opts]
   (let [rels (f27a/contained-paths href)]
     (if (empty? rels)
       (p/resolved nil)
       (p/let [idx (f27-asset-listing repo opts)]
         (some (fn [rel]
                 (when-let [abs (get idx (f27a/normalize-name rel))]
                   {:rel rel :abs abs}))
               rels))))))

(defn- f27-asset-open-button
  "Reveal ONE local asset where it is stored.

  The same call OG's own image action bar makes for a local asset —
  `openFileInFolder` on the path the graph's own listing reported — and
  deliberately not OG's PDF viewer, which is the excluded annotation project,
  nor a `file://` anchor with `target=\"_blank\"`, which is what a plain markdown
  link to an asset renders as today. A native button, so Tab reaches it and
  Enter or Space activates it.

  **The authorisation is re-asked here, not trusted.** A listing is a statement
  about the past: the mounted path was authorised whenever the panel rendered,
  and the file may since have been replaced, removed or turned into a link out
  of the graph. Activating this control re-runs all three gates with both caches
  bypassed and dispatches only what the fresh listing reports; when the file is
  no longer authorised nothing is dispatched and `on-refused` turns the chip
  into its `(file not found)` state.

  A race remains between that check and the main process opening the path, and
  it is recorded rather than papered over: closing it would mean opening the
  file by handle in the main process, which is a new capability and not this
  batch's business.

  Outside Electron there is no such handling, so there is no control rather than
  a control that does nothing."
  [repo href label on-refused]
  (when (util/electron?)
    [:button.f27-asset-open.f27-btn
     (f27-btn (fn []
                (-> (p/let [found (f27-asset-locate repo href {:force? true})]
                      (if-let [abs (:abs found)]
                        ;; The VALIDATED path, exactly as the graph's own asset
                        ;; listing reported it a moment ago. Not the href, and
                        ;; not a path recovered from the display URL: a control
                        ;; that reveals a file must dispatch the path that was
                        ;; authorised, or the authorisation means nothing.
                        (ipc/ipc "openFileInFolder" abs)
                        (when on-refused (on-refused))))
                    (p/catch (fn [_] (when on-refused (on-refused))))))
              {:aria-label (if label (t :f27/asset-open-of label) (t :f27/asset-open))
               :title (t :f27/asset-open)})
     "↗"]))

(rum/defcs f27-local-asset < rum/reactive
  (rum/local nil ::src)
  (rum/local nil ::exists?)
  (rum/local false ::broken?)
  {:will-mount
   (fn [state]
     ;; Authorise and resolve ONCE, on mount, rather than on every render.
     ;; Everything here is a read: containment is pure and happens first, the
     ;; listing is OG's own `readdir`, and `make-asset-url` is OG's own
     ;; resolution. Nothing writes, and nothing fetches — a local file is not a
     ;; network request.
     (let [[_config href _kind _name _label] (:rum/args state)
           *src (::src state)
           *exists? (::exists? state)]
       (try
         (p/let [found (f27-asset-locate (state/get-current-repo) href)]
           (reset! *exists? (some? found))
           (when found
             ;; Resolved from the spelling found on disk, not the one the author
             ;; happened to type, so an encoded name and a literal one produce
             ;; the same working address.
             ;;
             ;; The path this resolves is used to DISPLAY a thumbnail and for
             ;; nothing else. The reveal control deliberately does not keep it:
             ;; it re-asks the gates when it is pressed, because what was
             ;; authorised at mount is not what is on disk now.
             (p/let [url (editor-handler/make-asset-url
                          (config/get-local-asset-absolute-path (:rel found)))]
               (reset! *src url))))
         (catch :default _ (reset! *exists? false)))
       state))}
  "One graph-local asset, as an F27 panel shows it.

  `kind` and `name` come from the pure classifier, so this component only
  resolves, probes and renders. An image is shown only in FULL context and only
  when the file is there; everywhere else the file is named. A name is never a
  path, and a missing file never carries a control that cannot work."
  [state config href kind name' label]
  (let [level (or (:f27/ref-level config) 0)
        src @(::src state)
        exists? @(::exists? state)
        broken? @(::broken? state)
        ;; nil means "not answered yet", which is not the same as "not there".
        ;; Only a definite `false`, or an image the browser could not decode,
        ;; is reported as missing.
        missing? (or broken? (false? exists?))
        alt (get-label-text label)
        badge (f27a/asset-badge href)
        shown (or name' (t :f27/asset-unnamed))
        title (cond missing? (t :f27/asset-missing)
                    (and (= :image kind) (pos? level)) (t :f27/asset-image-compact)
                    :else (t :f27/asset-local))
        ;; A thumbnail belongs to the surface the reader explicitly opened. In a
        ;; bounded reference preview the asset is a compact indicator, because
        ;; that preview has a text budget and an image has no place in it.
        image? (and (= :image kind)
                    (zero? level)
                    (not (:f27/compact? config))
                    (some? src)
                    (not missing?))]
    [:<>
     [:span.f27-asset {:class (str "is-" (name kind) (when missing? " is-missing"))
                       :title (if (string/blank? alt) title (str alt " — " title))}
      (when missing? [:span.f27-asset-mark {:aria-hidden "true"} "⚠"])
      (when badge [:span.f27-ctx-badge.is-asset badge])
      [:span.f27-asset-name shown]
      (when missing? [:span.f27-asset-missing (t :f27/asset-missing)])
      ;; The control re-asks the three gates when it is pressed, so a file that
      ;; stopped being authorised since this mounted is refused there and turns
      ;; this chip into its missing state rather than opening anything.
      (when-not missing?
        (f27-asset-open-button (state/get-current-repo) href shown
                               (fn [] (reset! (::exists? state) false))))]
     (when image?
       [:span.f27-asset-figure
        [:img.f27-asset-img
         {:src src
          :alt (if (string/blank? alt) shown alt)
          :loading "lazy"
          :referrerPolicy "no-referrer"
          ;; The file may be listed and still not be readable as an image. The
          ;; chip above then says so, instead of leaving a broken icon.
          :on-error (fn [_] (reset! (::broken? state) true))}]])]))

(defn- f27-asset-render
  "Present ONE asset found inside an F27 panel body.

  Called by `image-link`, `media-link` and `search-link-cp` in place of OG's own
  asset rendering, and only when `:f27/media-render` is set — which only
  `f27-body-config` does.

  Every branch is display-only, and no branch loads anything the reader did not
  already have on disk."
  [config href label full-text]
  (let [href (str href)
        name' (f27a/asset-name href f27b/max-label-chars)]
    (cond
      ;; Nothing is fetched and nothing is decoded. The author's own words, or
      ;; the address itself, name what is there; an ordinary external link is
      ;; how OG presents every other outward address, so that is what this is.
      (f27a/remote? href)
      (let [data? (string/starts-with? (string/lower-case href) "data:")
            text (or (get-label-text label) (when-not data? href))
            shown (or (f27c/preview-text (or text "") f27b/max-label-chars)
                      (t :f27/asset-embedded))]
        [:span.f27-asset.is-remote {:title (if data?
                                             (t :f27/asset-embedded)
                                             (t :f27/asset-remote))}
         [:span.f27-ctx-badge.is-asset (if data? "DATA" "WEB")]
         (if data?
           [:span.f27-asset-name shown]
           [:a.f27-asset-name {:href href :target "_blank" :rel "noreferrer"} shown])])

      ;; Written as a graph-local asset. Whether it IS one is a separate
      ;; question, and it is asked before anything is probed, loaded or
      ;; revealed. `../assets/../../outside.png` and `../assets-other/x.png` are
      ;; both recognised by OG's prefix matcher and neither is inside the asset
      ;; directory; they are named and refused here, with no control at all.
      (f27a/recognized-local? href)
      (if (f27a/contained? href)
        (f27-local-asset config href (f27a/asset-kind href) name' label)
        [:span.f27-asset.is-outside {:title (t :f27/asset-outside)}
         [:span.f27-asset-mark {:aria-hidden "true"} "⚠"]
         (when-let [b (f27a/asset-badge href)] [:span.f27-ctx-badge.is-asset b])
         [:span.f27-asset-name (or name' (t :f27/asset-unnamed))]
         [:span.f27-asset-missing (t :f27/asset-outside-short)]])

      ;; Neither in this graph's assets nor an address: a path this panel cannot
      ;; resolve and must not guess at. It is named, and nothing is offered.
      :else
      [:span.f27-asset.is-external {:title (t :f27/asset-external)}
       (when-let [b (f27a/asset-badge href)] [:span.f27-ctx-badge.is-asset b])
       [:span.f27-asset-name (or name'
                                 (f27c/preview-text (or (get-label-text label) full-text "")
                                                    f27b/max-label-chars)
                                 (t :f27/asset-unnamed))]])))

;; ---------------------------------------------------------------------------
;; F27 dynamic boundary — a construct that RENDERS rather than reads.
;;
;; The asset hooks above cover image and media LINKS. They do not cover
;; everything `inline` dispatches, and three shapes still reached code that
;; produces its own content:
;;
;;   * `Macro` reaches `macro-cp`. That is a renderer of programs: `{{embed}}`
;;     renders another block or page recursively — the very substitution this
;;     panel exists to stop — `{{query}}` runs a query, `{{youtube}}`,
;;     `{{vimeo}}`, `{{bilibili}}`, `{{video}}` and `{{tweet}}` each mount a
;;     remote player, and `{{renderer}}` hands the slot to a plugin.
;;   * `Inline_Html` and `Export_Snippet "html"` reach `dangerouslySetInnerHTML`
;;     with sanitised HTML. Sanitising decides which tags survive; it does not
;;     decide whether anything is loaded.
;;   * `Inline_Hiccup` is read as data and then also set as inner HTML.
;;
;; Deferring the embed FEATURE cannot mean running OG's unrestricted embed
;; renderer inside the panel meanwhile. Each of these becomes an inert, named,
;; bounded placeholder, carrying the one control this project can already honour
;; — the block, the page or the address it points at. This is boundary closure,
;; not an embed viewer: nothing here renders a target's content.
;; ---------------------------------------------------------------------------

(defn- f27-inert-page-button
  "Open the page an embed names, through OG's existing page route."
  [page label]
  [:button.f27-inert-open.f27-btn
   (f27-btn (fn [] (route-handler/redirect-to-page! page))
            {:aria-label (t :f27/inert-open-page-of (or label page))
             :title (t :f27/inert-open-page)})
   "↗"])

(defn- f27-embed-expansion
  "The target block's own text, as an EXPANDED embed shows it.

  Rendered by the same guarded F27 renderer the panel already uses, with two
  changes to the config it is handed:

    * `:f27/ref-level` becomes `max-preview-level`, and
    * `:f27/ref-trail` gains this target.

  Those two lines are the whole safety argument, because every guard already
  written then applies to the expanded content without a new rule: a `((uuid))`
  inside it is a closed `⋯` chip, one pointing back at the host or at this
  target is `↻`, an image is a compact named indicator rather than a thumbnail,
  remote media is named and never fetched, a nested `{{embed}}` is inert, and a
  macro, a query, inline HTML and Hiccup are inert placeholders.

  The block's CHILDREN are not read. Only its own text is, bounded by the same
  `displayed-length`/`take-nodes` the preview bound uses — graphemes, formatting
  included, an atomic node refused rather than half-emitted.

  The page-embed slice renders each block of an excerpt through this same
  function, which is why `max-chars` and the trail keys are parameters: a page
  excerpt pushes the PAGE's identity as well as the block's, so a reference
  inside it that points back at either is recognised as the repeat it is. The
  block-embed arity below passes exactly what it always passed."
  ([config entity trail-key]
   (f27-embed-expansion config entity f27e/max-embed-chars [trail-key]))
  ([config entity max-chars trail-keys]
   (let [level (or (:f27/ref-level config) 0)
         trail (or (:f27/ref-trail config) #{})
         format (or (:block/format entity) :markdown)
         content (f27-display-content format (:block/content entity))
         {:keys [heading marker text]} (f27ctx/split-block-prefix content)
         ast (gp-mldoc/inline->edn (or text "") (gp-mldoc/default-config format))
         {:keys [nodes truncated?]} (f27b/take-nodes ast max-chars)
         ;; Nothing of the target's text could be shortened to fit — an opening
         ;; node that is atomic and larger than the allowance, or one whose size
         ;; was never established, such as a block that BEGINS with a macro. The
         ;; answer is the target's compact label, exactly as a bounded preview
         ;; answers it, and never a claim that the block has no text.
         fallback (when (and (empty? nodes) (not (string/blank? text)))
                    (or (some-> (f27-ref-label entity f27b/max-label-chars)
                                (string/replace #"…+$" ""))
                        (t :f27/body-ref-untitled)))
         inner (assoc config
                      :f27/ref-level (max f27b/max-preview-level (inc level))
                      ;; The SAME identities the trail compares, so a reference
                      ;; inside the expansion that points back at this target —
                      ;; or, for a page excerpt, at the page itself — is
                      ;; recognised as the repeat it is.
                      :f27/ref-trail (reduce f27b/push-trail trail (remove nil? trail-keys)))
         ;; Forced, not lazy: what is emitted must be built here, under this
         ;; config, and not later under whatever config happens to be current.
         body (vec (map-inline inner nodes))]
     {:heading heading
      :marker marker
      :body (when (seq nodes) body)
      :fallback fallback
      :truncated? (boolean truncated?)})))

(rum/defcs f27-embed-chip < (rum/local false ::open?)
  "One `{{embed ((block-id))}}` the reader may open in place.

  Closed, it is byte-for-byte the inert chip this panel already showed: the
  `{{embed}}` badge, the target's compact label and the `↗` source control, with
  no part of the target's content emitted and nothing read beyond the one lookup
  that produced the label.

  Open, it shows the target block's own text — never OG's embed renderer, which
  would render the target AND its children through the ordinary block pipeline
  with `:link-depth` incremented.

  Collapsing returns it to exactly its closed state and reads nothing."
  [state config entity id trail-key label]
  (let [open? @(::open? state)
        {:keys [heading marker body fallback truncated?]}
        (when open? (f27-embed-expansion config entity trail-key))]
    [:<>
     [:span.f27-inert.is-embed {:class (when open? "is-open")
                                ;; Not `:f27/inert-embed` — this chip CAN be
                                ;; opened, so saying it is never rendered would
                                ;; be false about the control beside it.
                                :title (t :f27/embed-openable)}
      [:span.f27-ctx-badge.is-inert "{{embed}}"]
      [:span.f27-inert-text label]
      [:button.f27-embed-toggle.f27-btn
       (f27-btn (fn [] (swap! (::open? state) not))
                {:aria-expanded (if open? "true" "false")
                 :aria-label (if open?
                               (t :f27/embed-hide-of label)
                               (t :f27/embed-show-of label))
                 :title (if open? (t :f27/embed-hide) (t :f27/embed-show))})
       (if open? "▾" "▸")]
      (f27-ref-source-button id label)]
     (when open?
       [:span.f27-embed-body {:role "group"
                              :aria-label (t :f27/embed-open-of label)}
        [:span.f27-embed-head
         (when heading [:span.f27-ctx-badge.is-heading (str "H" heading)])
         (when marker [:span.f27-ctx-badge.is-task marker])]
        (cond
          body [:span.f27-embed-text body]
          fallback [:span.f27-embed-text [:span.f27-embed-fallback fallback]]
          :else [:span.f27-embed-text [:span.f27-embed-empty (t :f27/embed-empty)]])
        ;; The fallback carries its own ellipsis, so the chip supplies the one
        ;; truncation mark and an expansion never reads "……".
        (when truncated? [:span.f27-embed-cut {:aria-hidden "true"} "…"])
        (when (or truncated? (nil? body))
          [:span.f27-embed-note (t :f27/embed-bounded)])
        ;; Repeated at the end of the content, like every other F27 panel's
        ;; collapse control, so a long expansion does not leave the reader
        ;; scrolling back to close it.
        [:button.f27-embed-collapse.f27-btn
         (f27-btn (fn [] (reset! (::open? state) false))
                  {:aria-label (t :f27/embed-hide-of label)
                   :title (t :f27/embed-hide)})
         (t :f27/embed-hide)]])]))

;; ---------------------------------------------------------------------------
;; F27 page-embed slice — `{{embed [[Page]]}}` as an EXCERPT the reader opens.
;;
;; The block-embed slice above closed half of checklist C2 and deliberately left
;; a page embed named and source-only, because OG's own page embed renders the
;; page through the ordinary block pipeline — every block, at every depth, with
;; `:link-depth` incremented.
;;
;; An excerpt is the bounded answer: the page's TOP-LEVEL blocks only, in OG
;; outline order, five per request, twenty retained at most, each bounded to 420
;; displayed characters by the same limiter every other F27 bound uses. The
;; blocks are rendered by `f27-embed-expansion`, so every guard the block-embed
;; expansion has applies here unchanged, and the reading is a bounded sibling
;; walk in `frontend.db.f27-page` rather than a fetch of the page.
;; ---------------------------------------------------------------------------

(defn- f27-page-excerpt-row
  "ONE top-level block of a page excerpt.

  Its own text, bounded, with its structure badges — and, when it has children,
  the FACT that it has them. Their subtrees are never walked and they are never
  counted: `has-children?` stops at the first child datom."
  [config page-id label k {:keys [block children?]}]
  (let [{:keys [heading marker body fallback truncated?]}
        (f27-embed-expansion config block f27pe/max-block-chars
                             [page-id (f27-ref-key (:block/uuid block))])]
    [:span.f27-page-embed-row {:key k}
     [:span.f27-embed-head
      (when heading [:span.f27-ctx-badge.is-heading (str "H" heading)])
      (when marker [:span.f27-ctx-badge.is-task marker])]
     (cond
       body [:span.f27-embed-text body]
       fallback [:span.f27-embed-text [:span.f27-embed-fallback fallback]]
       :else [:span.f27-embed-text
              [:span.f27-embed-empty (t :f27/page-embed-block-empty)]])
     (when truncated? [:span.f27-embed-cut {:aria-hidden "true"} "…"])
     (when children?
       [:span.f27-page-embed-children (t :f27/page-embed-children)])
     (when (or truncated? (and (nil? body) fallback))
       [:span.f27-embed-note (t :f27/page-embed-bounded label)])]))

(rum/defcs f27-page-embed-chip < (rum/local 0 ::shown)
  "One `{{embed [[Page]]}}` the reader may open as an excerpt.

  Closed — `::shown` 0 — it is byte-for-byte the inert chip this panel already
  showed: the `{{embed}}` badge, the page's name and the `↗` control that opens
  it. Nothing of the page is read beyond the one keyed lookup that established
  it exists.

  Open, it shows the page's top-level blocks and says, in words, that it is an
  excerpt and what its bounds are. `::shown` is how many are retained; it never
  exceeds `max-page-blocks`, and the walk that fills it is bounded, cycle-guarded
  and re-run from the page on every render, so nothing is cached across a graph
  that may have changed underneath it."
  [state config repo page-entity page-id label]
  (let [shown @(::shown state)
        open? (pos? shown)
        want (f27pe/wanted shown)
        {:keys [blocks more? walk]} (when open?
                                      (f27p/top-level-excerpt repo page-entity want))
        ;; A walk that stopped on a bound or a cycle is malformed data, not the
        ;; end of the page. It is said out loud rather than looking like the
        ;; page simply ended.
        stopped? (and open? (f27pe/walk-failed? walk))
        capped? (not (f27pe/more-retainable? shown))]
    [:<>
     [:span.f27-inert.is-embed.is-page {:class (when open? "is-open")
                                        :title (t :f27/page-embed-openable)}
      [:span.f27-ctx-badge.is-inert "{{embed}}"]
      [:span.f27-inert-text label]
      [:button.f27-embed-toggle.f27-btn
       (f27-btn (fn [] (swap! (::shown state)
                              (fn [n] (if (pos? n) 0 f27pe/blocks-per-request))))
                {:aria-expanded (if open? "true" "false")
                 :aria-label (if open?
                               (t :f27/page-embed-hide-of label)
                               (t :f27/page-embed-show-of label))
                 :title (if open? (t :f27/page-embed-hide) (t :f27/page-embed-show))})
       (if open? "▾" "▸")]
      (f27-inert-page-button (:block/original-name page-entity) label)]
     (when open?
       [:span.f27-page-embed-body {:role "group"
                                   :aria-label (t :f27/page-embed-open-of label)}
        ;; An excerpt says what it is BEFORE it says anything the page contains,
        ;; so a reader never mistakes a bounded selection for the page.
        [:span.f27-page-embed-title
         (t :f27/page-embed-excerpt label (count blocks))]
        [:span.f27-page-embed-limits
         (t :f27/page-embed-limits f27pe/max-page-blocks f27pe/max-block-chars)]
        ;; The key lives in the element's own props: these are plain hiccup
        ;; vectors, not rum components, so `rum/with-key` is not what keys them.
        (map-indexed
         (fn [i b]
           (f27-page-excerpt-row config page-id label
                                 (str "f27-pe-" (:db/id (:block b)) "-" i) b))
         blocks)
        (when stopped? [:span.f27-embed-note (t :f27/page-embed-stopped)])
        (when (and more? capped?)
          [:span.f27-embed-note (t :f27/page-embed-capped f27pe/max-page-blocks)])
        (when (and more? (not capped?))
          [:span.f27-embed-note (t :f27/page-embed-has-more)])
        (when (and more? (not capped?) (not stopped?))
          [:button.f27-page-embed-more.f27-btn
           (f27-btn (fn [] (reset! (::shown state) (f27pe/next-wanted shown)))
                    {:aria-label (t :f27/page-embed-more-of f27pe/blocks-per-request label)
                     :title (t :f27/page-embed-more f27pe/blocks-per-request)})
           (t :f27/page-embed-more f27pe/blocks-per-request)])
        ;; Repeated at the end of the content, like every other F27 panel's
        ;; collapse control.
        [:button.f27-embed-collapse.f27-btn
         (f27-btn (fn [] (reset! (::shown state) 0))
                  {:aria-label (t :f27/page-embed-hide-of label)
                   :title (t :f27/page-embed-hide)})
         (t :f27/page-embed-hide)]])]))

(defn- f27-inert-macro
  "One macro, named rather than run.

  An `{{embed ((uuid))}}` is the case that matters most: it is the construct
  most likely to reintroduce the recursive substitution this panel was built to
  stop. It is shown as the target's own compact label with the same source
  control every other F27 chip carries — and, on the surface the reader
  explicitly opened, with one more control that shows the target's own text in
  place. Everything else stays inert: reading a label is a lookup, and nothing
  here runs a program to fill a slot.

  An `{{embed [[Page]]}}` is the same shape one construct further along: on that
  same surface it offers an EXCERPT of the page's top-level blocks. Its planning
  is a sibling of the block one rather than a change to it — `f27e/plan-embed`
  keeps its exact outcomes — and the two share only the per-body ledger, because
  the four-offer budget is shared between them by design."
  [config options]
  (let [repo (:f27/ref-repo config)
        {:keys [name arguments]} options
        {:keys [kind value]} (f27i/macro-target name arguments)
        args (f27i/macro-label name arguments f27b/max-label-chars)
        embed? (f27e/embed-macro? name)
        entity (when (= :block kind) (f27-ref-target repo value))
        ;; RESOLVED means there is something to read, not merely that an entity
        ;; came back. A `((uuid))` that names no block still creates an entity
        ;; carrying only that uuid — the parser records the reference — so an
        ;; embed of a block that does not exist looked ordinary and offered a
        ;; source control that went nowhere. `plan-ref` has always asked this
        ;; question about CONTENT; this asks the same question the same way.
        content (when entity (f27-display-content (:block/format entity) (:block/content entity)))
        text-label (when content (f27-ref-label entity))
        ;; A PAGE embed is the only macro whose page argument this slice plans.
        ;; `{{query [[X]]}}` and any other macro that happens to name a page keep
        ;; exactly the placeholder and the control they already had.
        page-embed? (and embed? (= :page kind))
        pk (when page-embed? (f27pe/page-key value))
        ;; One keyed lookup, the same class of read every block embed already
        ;; does for its label. It never creates a page: `{{embed [[Ghost]]}}`
        ;; makes `Ghost` an ENTITY by itself, which is exactly why `:file?`,
        ;; not `some?`, is what says a page is there to be read.
        lookup (when page-embed? (f27p/page-lookup repo value))
        page-entity (:entity lookup)
        shown (or text-label
                  (when (= :page kind)
                    (f27c/preview-text (or (:block/original-name page-entity) value)
                                       f27b/max-label-chars))
                  args)
        title (if embed? (t :f27/inert-embed) (t :f27/inert-macro name))
        k (f27-ref-key value)
        *ledger (:f27/embed-ledger config)
        ledger (if *ledger @*ledger (f27e/new-ledger))
        outcome (when embed?
                  (f27e/plan-embed {:kind kind
                                    :resolved? (some? content)
                                    :id k
                                    :level (or (:f27/ref-level config) 0)
                                    :compact? (:f27/compact? config)
                                    :trail (or (:f27/ref-trail config) #{})
                                    :ledger ledger}))
        page-surface (when page-embed?
                       (f27pe/surface-outcome {:kind kind
                                               :id pk
                                               :entity? (:entity? lookup)
                                               :file? (:file? lookup)
                                               :read-error? (:error lookup)
                                               :level (or (:f27/ref-level config) 0)
                                               :compact? (:f27/compact? config)
                                               :trail (or (:f27/ref-trail config) #{})
                                               :ledger ledger}))
        ;; The ONE bounded probe that separates a page with something to show
        ;; from an empty one, and it runs only where an excerpt could be
        ;; offered — never on a breadcrumb, a bounded preview, a repeat or a
        ;; body that has spent its budget. `want` 1: one block plus the
        ;; lookahead, which is two steps of the sibling walk.
        page-probe (when (= :may-excerpt page-surface)
                     (f27p/top-level-excerpt repo page-entity 1))
        page-outcome (when page-embed?
                       (f27pe/excerpt-outcome page-surface page-probe))
        ;; A mark MEANS something is not ordinary, exactly as it does on a
        ;; reference chip: `↻` a repeat that is not opened again, `⋯` a surface
        ;; that does not expand anything, `⚠` a target that is not there.
        mark (case outcome
               :repeat "↻"
               (:closed :budget) "⋯"
               :unavailable "⚠"
               (case page-outcome
                 :repeat "↻"
                 (:closed :budget) "⋯"
                 (:unnamed :missing :uncreated :error) "⚠"
                 nil))
        page-note (case page-outcome
                    :unnamed (t :f27/page-embed-unnamed)
                    :missing (t :f27/page-embed-missing)
                    :uncreated (t :f27/page-embed-uncreated)
                    :empty (t :f27/page-embed-empty)
                    :error (t :f27/page-embed-error)
                    nil)
        embed-title (case outcome
                      :repeat (t :f27/embed-repeat)
                      :closed (t :f27/embed-closed)
                      :budget (t :f27/embed-budget f27e/max-embeds)
                      :unavailable (t :f27/embed-unavailable)
                      (case page-outcome
                        :repeat (t :f27/page-embed-repeat)
                        :closed (t :f27/page-embed-closed)
                        :budget (t :f27/page-embed-budget f27e/max-embeds)
                        (:unnamed :missing :uncreated :empty :error) page-note
                        title))]
    (cond
      (f27e/expandable? outcome)
      (do
        ;; Recorded in the order the reader sees, during the same forced walk
        ;; that builds the body, so a second copy of one block is told it is a
        ;; second copy and the per-body cap means what it says.
        (when *ledger (vswap! *ledger f27e/record k))
        (f27-embed-chip config entity value k shown))

      (f27pe/expandable? page-outcome)
      (do
        ;; The SAME ledger the block embeds spend, so four is four across both.
        (when *ledger (vswap! *ledger f27e/record pk))
        (f27-page-embed-chip config repo page-entity pk shown))

      :else
      ;; `is-page` marks a page embed in EVERY state, not only the openable one,
      ;; so what the chip IS and whether it happens to be expandable here are two
      ;; separate questions on screen as well as in the code.
      [:span.f27-inert {:class (str (if embed? "is-embed" "is-macro")
                                    (when page-embed? " is-page"))
                        :title (if embed? embed-title title)}
       (when mark [:span.f27-inert-mark {:aria-hidden "true"} mark])
       ;; The macro's NAME is the badge, `{{embed}}` rather than `{{}}` beside a
       ;; separate word: a live screen showed the two spans running together and
       ;; reading as "embedFocus is a skill…" and "youtubehttps://…".
       [:span.f27-ctx-badge.is-inert
        (str "{{" (f27c/preview-text (str name) f27i/max-badge-name-chars) "}}")]
       (cond
         (= :url kind)
         [:a.f27-inert-text {:href value :target "_blank" :rel "noreferrer"}
          (or shown value)]

         ;; A block embed whose target is gone says so in words. The identifier
         ;; is never the label, and there is no control, because there is no
         ;; source to open.
         (= :unavailable outcome)
         [:span.f27-inert-missing (t :f27/embed-unavailable)]

         ;; A page embed that cannot be opened as an excerpt says WHY, and the
         ;; four reasons read differently: no name, nothing by that name, a name
         ;; nobody has written a page for, a page with nothing in it, and a read
         ;; that failed. `{{embed [[]]}}` has no name to show at all.
         (and page-note (= :unnamed page-outcome))
         [:span.f27-inert-missing page-note]

         page-note
         [:<> [:span.f27-inert-text shown]
          [:span.f27-inert-missing page-note]]

         shown [:span.f27-inert-text shown]
         :else nil)
       (case kind
         ;; No control when there is no source to open. An embed whose target
         ;; does not exist is named in words and offers nothing.
         :block (when (and entity (not= :unavailable outcome))
                  (f27-ref-source-button value text-label))
         ;; A page embed withholds the control in exactly the two states where
         ;; nothing in the graph carries the name: a blank argument, and a name
         ;; the graph has never heard of. Everywhere else — including a page
         ;; nobody has created yet, which OG itself already knows as a link
         ;; target — the control opens what OG would open. Nothing here writes,
         ;; and no page is created to preview it.
         :page (if page-embed?
                 (when-not (contains? #{:unnamed :missing} page-outcome)
                   (f27-inert-page-button (or (:block/original-name page-entity) value) shown))
                 (f27-inert-page-button value shown))
         nil)])))

(defn- f27-inert-markup
  "Inline HTML or Hiccup, shown as the characters the note contains.

  Nothing here produces markup, so nothing can load, execute or lay out. The
  fragment is bounded like every other compact label, so a long one cannot
  become the content of the row it sits in."
  [badge s]
  (let [shown (f27i/markup-label s f27b/max-label-chars)]
    [:span.f27-inert.is-markup {:title (t :f27/inert-markup)}
     [:span.f27-ctx-badge.is-inert badge]
     (if shown
       [:code.f27-inert-text shown]
       [:span.f27-inert-text (t :f27/inert-empty)])]))

(defn- f27-inert-render
  "Present ONE dynamic construct found inside an F27 panel body, or answer nil.

  nil means \"this is not a node the boundary claims\", and `inline` then renders
  it exactly as it always has. Only the shapes that reach a renderer or
  `innerHTML` are claimed."
  [config item]
  (case (f27i/node-kind item)
    :macro (f27-inert-macro config (second item))
    :html (f27-inert-markup "HTML" (if (= "Export_Snippet" (first item))
                                     (nth item 2 nil)
                                     (second item)))
    :hiccup (f27-inert-markup "HICCUP" (second item))
    nil))

(declare f27-ref-render)

(defn- f27-body-config
  "Rendering config for ONE block's text inside an F27 panel.

  Seeds the render trail with the host block itself, so a block that references
  itself is a repeat by construction rather than a special case, and creates
  this body's budget. The budget is a volatile created fresh on every render of
  this body, so it is per-render bookkeeping, not shared mutable state.

  It seeds the host's own PAGE too, for the same reason one construct along: a
  block that embeds the page it lives on would otherwise offer an excerpt whose
  blocks include this very block's own ancestor. That is the self case, and it
  is marked `↻` rather than opened. One keyed lookup per rendered body."
  [config repo host-uuid]
  (let [host-page-key (some-> (f27-ref-target repo host-uuid)
                              :block/page
                              :block/name
                              f27pe/page-key)
        trail (cond-> (f27b/push-trail #{} (f27-ref-key host-uuid))
                host-page-key (f27b/push-trail host-page-key))]
    (assoc config
           :f27/ref-render f27-ref-render
           :f27/media-render f27-asset-render
           :f27/inert-render f27-inert-render
           :f27/ref-repo repo
           :f27/ref-level 0
           :f27/ref-trail trail
           :f27/ref-budget (volatile! (f27b/new-budget))
           ;; Separate from the preview budget on purpose: an embed the reader
           ;; opens is not a preview the body produced on its own, and nothing
           ;; here may change what the existing bound does. Block embeds and
           ;; page embeds SHARE this one ledger, so four offers is four across
           ;; both kinds.
           :f27/embed-ledger (volatile! (f27e/new-ledger)))))

(defn- f27-breadcrumb-config
  "Rendering config for the ONE-LINE path an F27 row shows above its content.

  F27 reuses OG's own `breadcrumb`, and `breadcrumb` renders each ancestor's
  title through `map-inline` with the config it is given. Given a plain config
  that reaches OG's unguarded renderer: a live run found three of the fixture's
  deliberately escaping asset paths rendered as full `resizable-image` elements
  INSIDE the reference panel, because the referencing block's parent contained
  them. A breadcrumb is a panel surface like any other.

  It starts at `max-preview-level` on purpose. That is not a claim about nesting
  — it is the level at which this contract stops expanding anything, which is
  exactly right for a one-line path: a reference is named, an asset is a compact
  indicator, and nothing grows. `:f27/compact?` says the same thing in words, so
  a reader of the asset renderer does not have to infer it from a number."
  [config repo host-uuid]
  (assoc (f27-body-config config repo host-uuid)
         :f27/ref-level f27b/max-preview-level
         :f27/compact? true))

(defn- f27-ref-render
  "Present ONE block reference found inside an F27 panel body.

  Called by `link-cp`/`search-link-cp` in place of `block-reference`, and only
  when `:f27/ref-render` is set — which only `f27-body-config` does.

  Every branch is display-only. Nothing here follows a reference automatically
  beyond the single preview level the contract allows, so no amount of mutual
  referencing can produce recursion or a depth warning."
  [config id label]
  (let [repo (:f27/ref-repo config)
        level (or (:f27/ref-level config) 0)
        trail (or (:f27/ref-trail config) #{})
        *budget (:f27/ref-budget config)
        budget (if *budget @*budget (f27b/new-budget))
        k (f27-ref-key id)
        entity (f27-ref-target repo id)
        format (or (:block/format entity) :markdown)
        content (f27-display-content format (:block/content entity))
        labelled? (boolean (seq (mldoc/plain->text label)))
        outcome (f27b/plan-ref {:id k
                                :resolved? (some? content)
                                :labelled? labelled?
                                :level level
                                :trail trail
                                :budget budget})
        text-label (f27-ref-label entity)
        ;; A chip that cannot show the target's text still names it. Only when
        ;; there is genuinely nothing readable does it say so in words.
        named (or text-label (t :f27/body-ref-untitled))
        ;; `mark` is nil for an ordinary reference. A mark here MEANS something
        ;; is not ordinary — a repeat, a bound, a target that is not there — so
        ;; the three that matter stay legible instead of competing with a glyph
        ;; on every chip. `↗` is the SOURCE CONTROL and nothing else, which
        ;; keeps it distinct from the `↗` a compact label already uses to say
        ;; "a reference is written here".
        ;;
        ;; `.f27-body-ref-text` holds the PREVIEW TEXT and nothing else. The
        ;; mark, the structure badges, the `…` that says a preview was cut and
        ;; the source control are fixed chrome: constant in size, and what makes
        ;; a bound honest rather than silent. They sit outside that span so the
        ;; distinction is in the markup and not merely in a docstring — the
        ;; budget governs exactly what is inside it.
        chip (fn [kind mark badges body cut? title source?]
               [:span.f27-body-ref {:class kind :title title}
                (when mark [:span.f27-body-ref-mark {:aria-hidden "true"} mark])
                badges
                [:span.f27-body-ref-text body]
                (when cut? [:span.f27-body-ref-cut {:aria-hidden "true"} "…"])
                (when source? (f27-ref-source-button id text-label))])]
    (case outcome
      ;; Nothing resolved. The author's own label, if they wrote one, is still
      ;; their text and is kept; the identifier never becomes the label.
      :unresolved
      (chip "is-unresolved" "⚠" nil
            (if labelled?
              ;; The author's own words are kept, rendered with THIS renderer
              ;; still installed. Dropping the hook here would have let a
              ;; reference written inside a label reach OG's recursive path —
              ;; the very hole this contract closes.
              (vec (map-inline config label))
              [:span.f27-body-ref-missing (t :f27/body-ref-unavailable)])
            false
            (t :f27/body-ref-unavailable)
            false)

      ;; The author wrote what this reference means. Show that, not a preview of
      ;; the target, and charge it nothing.
      :label
      (chip "is-label" nil nil
            (vec (map-inline config label))
            false
            (t :f27/body-ref-preview)
            true)

      ;; Already being rendered above this point — a cycle, or the same block
      ;; twice. This is the case that used to fill the panel.
      :repeat
      (chip "is-repeat" "↻" nil named false (t :f27/children-cycle) true)

      ;; Below the one preview level this contract expands.
      :depth
      (chip "is-closed" "⋯" nil named false (t :f27/body-ref-depth) true)

      ;; This body has shown as many previews as it may.
      :budget
      (do (when *budget (vswap! *budget f27b/withhold))
          (chip "is-closed" "⋯" nil named false
                (t :f27/body-ref-budget f27b/max-expansions) true))

      ;; One bounded preview of the target's own text, rendered through the same
      ;; parser and renderer — with this same function still installed, so a
      ;; reference INSIDE the preview is named, never followed.
      (let [{:keys [heading marker text]} (f27ctx/split-block-prefix content)
            allowance (f27b/preview-allowance budget)
            ast (gp-mldoc/inline->edn (or text "") (gp-mldoc/default-config format))
            {:keys [nodes used truncated?]} (f27b/take-nodes ast allowance)
            inner (assoc config
                         :f27/ref-level (inc level)
                         :f27/ref-trail (f27b/push-trail trail k))
            ;; Nothing of the target's text could be shortened to fit — an
            ;; opening node that is atomic and larger than the allowance. The
            ;; answer is a compact label capped by that same allowance, with the
            ;; source control beside it. It is NOT to emit the node anyway:
            ;; doing that is how a formatted target escaped this bound.
            ;; The compact label carries its own ellipsis; the chip supplies
            ;; the one truncation mark, so a fallback never reads "……".
            fallback (when (and (empty? nodes) (not (string/blank? text)))
                       (or (some-> (f27-ref-label entity (min f27b/max-label-chars allowance))
                                   (string/replace #"…+$" ""))
                           (t :f27/body-ref-untitled)))
            ;; Forced, not lazy: the budget must be spent in the order the
            ;; reader sees, and read back correctly after the body is built.
            body (if fallback
                   [:span.f27-body-ref-fallback fallback]
                   (vec (map-inline inner nodes)))
            spent (if fallback (f27b/text-size fallback) used)]
        (when *budget (vswap! *budget f27b/spend spent (or truncated? (some? fallback))))
        (chip "is-preview" nil
              [:<>
               (when heading [:span.f27-ctx-badge.is-heading (str "H" heading)])
               (when marker [:span.f27-ctx-badge.is-task marker])]
              body
              (boolean (or truncated? fallback))
              (t :f27/body-ref-preview)
              true)))))

(defn- f27-body-text
  "One block's text as an F27 panel shows it.

  Same parser and same renderer OG uses for the block itself — no second
  grammar, no regular-expression rewriting of markup — with block references
  presented under the F27 contract instead of substituted recursively.

  The block's own text is never truncated: it is what the reader opened the
  panel to read. Only reference previews are bounded, and when any of them was
  shortened or left closed the body says so once, beside chips that each already
  offer their source."
  [config repo host-uuid format text]
  (when (and (string? text) (not (string/blank? text)))
    (let [cfg (f27-body-config config repo host-uuid)
          *budget (:f27/ref-budget cfg)
          ast (gp-mldoc/inline->edn text (gp-mldoc/default-config (or format :markdown)))
          rendered (vec (map-inline cfg ast))
          {:keys [truncated withheld] :as spent} @*budget]
      [:<>
       [:div.inline.mr-1 rendered]
       (when (f27b/body-note-needed? spent)
         [:div.f27-ctx-note.f27-body-note
          (t :f27/body-bounded (+ (or truncated 0) (or withheld 0)))])])))

(rum/defc f27-crystal-preview < rum/static
  [m]
  (let [raw (:content m)
        ;; Built-in properties out (a marked block that is referred to carries a
        ;; persisted `id::`), then inline reference markup reduced to what a
        ;; person reads. Falls back to the raw text if cleaning leaves nothing.
        label (f27c/preview-label (or (f27-display-content (:format m) raw) raw) 60)]
    [:button.f27-crystal-chip.f27-btn
     (f27-btn (fn []
                ;; Navigate through OG's existing block route; no new mechanism.
                (when-let [u (:uuid m)]
                  (route-handler/redirect-to-page! (str u))))
              {:title label
               :aria-label label})
     [:span.f27-crystal-dot "◆"]
     [:span.f27-crystal-text label]]))

(rum/defcs f27-crystal-selector < rum/reactive
  (rum/local false ::open?)
  (rum/local "" ::query)
  (rum/local nil ::scan)
  "Discoverable control for choosing ONE explicit graph tag as the Crystal
  marker, and for clearing it.

  The inventory is rescanned each time the control is OPENED, and is scoped to
  the current graph, so newly added, removed or renamed tags are reflected and a
  cache from another graph is never reused. It is not rescanned on render or on
  keystrokes. An incomplete scan says so and offers continuation rather than
  presenting a partial list as the whole truth."
  [state repo]
  (let [current (state/sub :f27/crystal-tags)
        tag (get current repo)
        *open? (::open? state)
        *query (::query state)
        *scan (::scan state)
        open? @*open?
        scan @*scan
        ;; Guard against reusing another graph's cache even if one lingers.
        scan (when (and scan (= (:repo scan) repo)) scan)]
    [:div.f27-crystal-config
     [:button.f27-crystal-config-toggle.f27-btn
      (f27-btn (fn []
                 (when-not open?
                   ;; Refresh on OPEN — modest, not per render or keystroke.
                   ;; Scoped to THIS graph, exactly as before.
                   (reset! *query "")
                   (reset! *scan (f27-crystal-tag-inventory repo)))
                 (swap! *open? not))
               {:aria-expanded (if open? "true" "false")})
      (if tag (t :f27/crystal-marker-is tag) (t :f27/crystal-choose))]
     (when open?
       (let [inv (:tags scan #{})
             summary (f27c/scan-summary (or scan {}))
             {:keys [matches total shown]} (f27c/filter-tags inv @*query)
             sel-state (f27c/selection-state tag inv (or scan {}))]
         [:div.f27-crystal-config-panel
          {:on-click (fn [e] (util/stop-propagation e))}
          [:div.f27-crystal-config-help (t :f27/crystal-help)]
          [:div.f27-crystal-config-local (t :f27/crystal-local-only)]

          ;; Honest scan state.
          (case summary
            :error [:div.f27-crystal-scan-error (t :f27/crystal-scan-error)]
            :partial [:div.f27-crystal-scan-partial
                      (t :f27/crystal-scan-partial (:scanned scan) (:candidates scan))]
            nil)

          ;; A chosen marker that was not found is described according to what
          ;; the scan actually covered — never called "missing" when unscanned.
          (case sel-state
            :missing [:div.f27-crystal-missing (t :f27/crystal-missing tag)]
            :unscanned [:div.f27-crystal-missing (t :f27/crystal-unscanned tag)]
            nil)

          [:input.f27-crystal-search
           {:type "text"
            :value @*query
            :placeholder (t :f27/crystal-search)
            :on-click (fn [e] (util/stop-propagation e))
            :on-change (fn [e] (reset! *query (.. e -target -value)))}]
          [:div.f27-crystal-options
           (if (seq matches)
             (for [n matches]
               [:button.f27-crystal-option.f27-btn
                (f27-btn #(state/set-crystal-tag! repo n)
                         {:key n
                          :class (when (f27c/same-tag? n tag) "is-selected")
                          :aria-pressed (if (f27c/same-tag? n tag) "true" "false")})
                (str "#" n)])
             [:div.f27-crystal-empty
              (if (zero? (count inv)) (t :f27/crystal-no-tags) (t :f27/crystal-no-match))])]
          (when (> total shown)
            [:div.f27-crystal-note (t :f27/crystal-narrow (- total shown))])
          ;; Search only ever covers what was scanned; say so.
          (when (= summary :partial)
            [:div.f27-crystal-note (t :f27/crystal-search-partial)])
          (when (not= summary :ok)
            [:button.f27-crystal-scan-more.f27-btn
             (f27-btn #(reset! *scan (f27-crystal-tag-inventory
                                      repo
                                      (+ (:scanned scan 0) f27c/default-scan-batch)))
                      nil)
             (t :f27/crystal-scan-more)])
          (when tag
            [:button.f27-crystal-clear.f27-btn
             (f27-btn #(state/set-crystal-tag! repo nil) nil)
             (t :f27/crystal-clear)])]))]))

(defn- f27-parent-fn
  "One step upward. Read-only entity lookup; never writes.

  A failed lookup is deliberately allowed to THROW. Swallowing it here and
  returning nil would make an unreadable parent indistinguishable from reaching
  the top of the outline, and the panel would then claim complete ancestry it
  never actually saw. `load-ancestors` catches it and reports it."
  [repo]
  (fn [uuid] (db/get-block-parent repo uuid)))

(rum/defc f27-context-line < rum/static
  "One ancestor or the referencing block itself, rendered read-only.

  Uses OG's own parser and renderer so emphasis, links, tags, Korean and emoji
  keep their meaning, through `f27-body-text`, which renders markup only — it
  installs no editing handler, creates no id, and cannot save — and presents a
  block reference under the F27 contract instead of substituting the target
  block's whole content recursively.

  A heading's leading `##` and a task's leading `TODO` are BLOCK-level markup an
  inline renderer echoes as literal characters, so they are split off and shown
  as structure instead. The block itself is not altered."
  [config repo block self?]
  (let [format (or (:block/format block) :markdown)
        content (f27-display-content format (f27ctx/block-label block))
        {:keys [heading marker text]} (f27ctx/split-block-prefix content)]
    [:div.f27-ctx-line {:class (str (when self? "is-self ")
                                    (when heading "is-heading"))}
     [:span.f27-ctx-marker (if self? "▸" "·")]
     [:span.f27-ctx-body
      (if (nil? content)
        [:span.f27-ctx-unavailable (t :f27/context-unavailable-line)]
        [:<>
         (when heading [:span.f27-ctx-badge.is-heading (str "H" heading)])
         (when marker [:span.f27-ctx-badge.is-task marker])
         (when-not (string/blank? text)
           (f27-body-text config repo (:block/uuid block) format text))])]]))

(defn- f27-children-fn
  "Immediate children of one block, in OG's canonical outline order.

  Deliberately NOT `db/get-block-children` (which pulls the whole subtree) and
  NOT `db/get-block-immediate-children`, whose `sort-by-left` runs with
  `:check? true` and ASSERTS when two siblings share a `:block/left` — a
  malformed outline would crash the panel rather than degrade.

  This reads the same two things that function reads and hands both to the pure
  planner: the raw sibling set, and OG's left-order walk of it. The planner
  compares them, so a broken `left` chain loses the ORDER (disclosed) instead of
  silently losing siblings.

  A block that cannot be resolved is reported as missing, which the planner
  keeps distinct from both a failed query and a childless block. Read-only: an
  entity lookup and a pure sort; nothing here writes."
  [repo]
  (fn [uuid]
    (if-let [parent (db/entity repo [:block/uuid uuid])]
      (let [raw (vec (:block/_parent parent))]
        {:raw raw
         :ordered (vec (db/sort-by-left raw parent {:check? false}))})
      {:missing? true})))

(defn- f27-row-label
  "A short, single-line name for one block, used to say WHICH branch or step a
  control belongs to.

  Built-in properties are dropped, inline reference markup is reduced to what a
  person reads, and truncation is the Unicode-safe one from slice 2, so a Korean
  syllable or an emoji sequence is never split. A referring block's raw text is
  mostly `((uuid))` by definition, which would otherwise fill the whole label
  with an identifier and name nothing."
  [entity]
  (let [content (f27-display-content (:block/format entity) (f27ch/node-label entity))
        {:keys [text]} (f27ctx/split-block-prefix (f27in/plain-label content))]
    (f27c/preview-text (or text "") 40)))

(rum/defc f27-descendant-line < rum/static
  "One descendant row: its own expansion control, then its text.

  Rendered through the same read-only inline renderer as the ancestor lines, so
  headings, tasks, emphasis, Korean and emoji keep their meaning and no editing
  handler, id or save path is created.

  The control is a NATIVE BUTTON, not a styled anchor without an href: it must
  be reachable by Tab, activated by Enter and Space, carry a visible focus ring
  and report its own expanded state. Its accessible name says which block it
  opens, because identical names on every row tell a screen-reader user
  nothing."
  [config repo row open? on-toggle]
  (let [{:keys [entity depth descend probe]} row
        content (f27-display-content (:block/format entity) (f27ch/node-label entity))
        format (or (:block/format entity) :markdown)
        label (f27-row-label entity)
        {:keys [heading marker text]} (f27ctx/split-block-prefix content)]
    [:div.f27-desc-line {:class (str "depth-" (min depth 5)
                                    (when heading " is-heading"))}
     ;; The control appears only when it can actually do something. Every other
     ;; case is explained by a marker with a title, never a dead affordance.
     (cond
       ;; A failed or unresolvable probe is NOT an ordinary leaf. Slice 4 showed
       ;; the same "·" for both, so a read failure on a collapsed child had no
       ;; way to reach the screen at all.
       (= probe :error)
       [:span.f27-desc-mark.is-stop.is-unknown {:title (t :f27/children-probe-error)} "?"]

       (= probe :unavailable)
       [:span.f27-desc-mark.is-stop.is-unknown {:title (t :f27/children-probe-unavailable)} "!"]

       (= descend :cycle)
       [:span.f27-desc-mark.is-stop {:title (t :f27/children-cycle)} "↻"]

       (= descend :depth)
       [:span.f27-desc-mark.is-stop {:title (t :f27/children-depth f27ch/max-depth)} "⋯"]

       (= descend :budget)
       [:span.f27-desc-mark.is-stop {:title (t :f27/children-budget f27ch/max-visible)} "⋯"]

       (f27ch/can-expand? row)
       (let [name' (if (string/blank? label)
                     (if open? (t :f27/children-hide) (t :f27/children-show))
                     (if open? (t :f27/children-hide-of label) (t :f27/children-show-of label)))]
         [:button.f27-desc-toggle.f27-btn
          (f27-btn on-toggle {:aria-expanded (if open? "true" "false")
                              :aria-label name'
                              :title name'})
          (if open? "▾" "▸")])

       :else [:span.f27-desc-mark "·"])
     [:span.f27-desc-body
      (if (nil? content)
        [:span.f27-ctx-unavailable (t :f27/context-unavailable-line)]
        [:<>
         (when heading [:span.f27-ctx-badge.is-heading (str "H" heading)])
         (when marker [:span.f27-ctx-badge.is-task marker])
         (when-not (string/blank? text)
           (f27-body-text config repo (:block/uuid entity) format text))])]]))

(rum/defc f27-descendant-probe-note < rum/static
  "What a rendered row's OWN children probe found, when that is not an ordinary
  answer, with a bounded way to try again and a source fallback.

  This is the row's honest state, shown WITHOUT requiring the reader to open a
  control that a failed probe would never have produced."
  [row attempts on-retry on-source]
  (let [{:keys [probe descend child-count depth]} row
        n (or child-count 0)]
    (when (or (#{:error :unavailable} probe)
              (and (#{:budget :depth} descend) (pos? n)))
      [:div.f27-desc-notes {:class (str "depth-" (min (inc (or depth 0)) 5))}
       (case probe
         :error [:div.f27-ctx-note.f27-ctx-error (t :f27/children-probe-error)]
         :unavailable [:div.f27-ctx-note.f27-ctx-error (t :f27/children-probe-unavailable)]
         nil)
       ;; Descendants known to exist behind a node no control can open. Slice 4
       ;; counted them nowhere, so a grandchild behind the last child that fit
       ;; simply disappeared.
       (when (and (= descend :budget) (pos? n))
         [:div.f27-ctx-note.f27-ctx-capped (t :f27/children-budget-behind n f27ch/max-visible)])
       (when (and (= descend :depth) (pos? n))
         [:div.f27-ctx-note.f27-ctx-capped (t :f27/children-depth-behind n f27ch/max-depth)])
       (when (#{:error :unavailable} probe)
         (if (f27ch/probe-retry-allowed? attempts)
           [:button.f27-desc-retry.f27-btn (f27-btn on-retry nil)
            (t :f27/children-retry)]
           [:span.f27-ctx-note (t :f27/children-retry-exhausted)]))
       (when (#{:error :unavailable} probe)
         [:button.f27-desc-source.f27-btn (f27-btn on-source nil)
          (t :f27/children-open-source)])])))

(rum/defc f27-descendant-notes < rum/static
  "Whatever one node has to say about its own children, beneath its row."
  [info depth]
  (let [{:keys [summary remaining unordered withheld]} info]
    [:div.f27-desc-notes {:class (str "depth-" (min (inc (or depth 0)) 5))}
     (case summary
       :error [:div.f27-ctx-note.f27-ctx-error (t :f27/children-error)]
       :unavailable [:div.f27-ctx-note.f27-ctx-error (t :f27/children-unavailable)]
       nil)
     ;; Order and completeness are separate claims. Losing the order does not
     ;; mean losing children, and the reader is told which happened.
     (when (false? (:ordered? info))
       [:div.f27-ctx-note.f27-ctx-error (t :f27/children-unordered unordered)])
     (when (and (= summary :partial) (pos? (or remaining 0)))
       [:div.f27-ctx-note (t :f27/children-remaining remaining)])
     ;; Children this node's own batch asked for but the shared limit had no
     ;; room to render. Distinct from children the batch never requested.
     (when (pos? (or withheld 0))
       [:div.f27-ctx-note.f27-ctx-capped (t :f27/children-withheld withheld f27ch/max-visible)])]))

(rum/defc f27-row-descendants < rum/reactive
  "Children of THIS referencing block, and progressively deeper descendants.

  These are the children of the block that REFERENCES the target, on its own
  source page — not children of the canonical target elsewhere. The heading says
  so, because the two are easy to confuse in a panel opened from the target.

  All expansion state lives in ONE atom per row instance, keyed by path, so:
    * rendering is a pure function of that state — nothing is mutated on render;
    * the visible-node safeguard can be counted exactly across all open
      branches, rather than guessed per node;
    * each row and each repeated appearance of a block owns its own state.

  It is TRANSIENT: nothing here touches OG's own saved `collapsed::` property,
  so collapsing a branch in this panel cannot change what the graph stores."
  [config repo uuid' *open? *desc]
  ;; rum/react, not deref: the expansion atoms are owned by the parent row, so
  ;; this component must SUBSCRIBE to them. Merely dereferencing them under
  ;; rum/static left it comparing identical atom identities and skipping the
  ;; re-render, so opening a branch changed nothing on screen.
  (let [desc (rum/react *desc)
        open? (rum/react *open?)
        plan (f27ch/build-plan (f27-children-fn repo) uuid' desc)
        root-info (get-in plan [:info []])
        {:keys [rows]} plan
        retries (:retries desc)
        ;; ONE capacity rule, consulted by every growth control. A plan that
        ;; fills the safeguard exactly still has no room for another row, so
        ;; continuation and expansion are both withheld there.
        hiding? (f27ch/plan-hiding-anything? plan)
        summary (:summary root-info)
        ;; Where each nested continuation belongs: at the end of its OWN branch,
        ;; not collected after the whole flattened tree with an identical label.
        boundaries (f27ch/branch-continuations plan)
        row-at (fn [path] (first (filter #(= path (:path %)) rows)))
        toggle-path! (fn [path]
                       (swap! *desc update :open
                              (fn [o] (if (contains? o path) (disj o path) (conj o path)))))
        show-more! (fn [path]
                     (swap! *desc update :limits
                            (fn [m] (assoc m path (f27ch/continue-limit
                                                   (get m path f27ch/default-batch))))))
        ;; A retry simply re-renders, which re-reads the database. The count is
        ;; kept so the offer is bounded rather than endless.
        retry! (fn [path] (swap! *desc update-in [:retries path] (fnil inc 0)))
        open-source! (fn [] (route-handler/redirect-to-page! (str uuid')))
        more-button (fn [path label nested? depth]
                      [:button.f27-desc-more.f27-btn
                       (f27-btn #(show-more! path)
                                {:key (str "m-" (string/join ">" (map str path)))
                                 :class (when nested? (str "is-nested depth-" (min depth 5)))
                                 :aria-label label})
                       label])]
    [:div.f27-desc
     ;; The toggle appears only when there is something to reveal. A block with
     ;; no children says nothing at all rather than offering an empty control.
     (cond
       ;; The referencing block's own children could not be read. Same honest
       ;; treatment as a failed probe deeper down: say so, offer a bounded
       ;; retry, and offer the source.
       (#{:error :unavailable} summary)
       [:<>
        [:div.f27-ctx-note.f27-ctx-error
         (if (= summary :error) (t :f27/children-error) (t :f27/children-unavailable))]
        (if (f27ch/probe-retry-allowed? (get retries []))
          [:button.f27-desc-retry.f27-btn (f27-btn #(retry! []) nil)
           (t :f27/children-retry)]
          [:span.f27-ctx-note (t :f27/children-retry-exhausted)])
        [:button.f27-desc-source.f27-btn (f27-btn open-source! nil)
         (t :f27/children-open-source)]]

       (= summary :none) nil

       :else
       [:<>
        [:button.f27-desc-toggle-all.f27-btn
         (f27-btn #(swap! *open? not) {:aria-expanded (if open? "true" "false")})
         (if open?
           (t :f27/children-hide-all)
           (t :f27/children-show-all (:total root-info)))]
        (when open?
          [:div.f27-desc-body-wrap
           [:div.f27-desc-head (t :f27/children-of-this-block)]
           ;; A keyed wrapper element, NOT rum/with-key: with-key clones a React
           ;; element, and handing it a raw hiccup vector fails at render time.
           (map-indexed
            (fn [i row]
              (let [path (:path row)]
                [:div.f27-desc-item {:key (str "d-" (string/join ">" (map str path)))}
                 (f27-descendant-line config repo row (:open? row)
                                      (fn [] (toggle-path! path)))
                 ;; The row's own probe outcome, shown on the row itself — no
                 ;; control has to be opened first to learn that a read failed.
                 (f27-descendant-probe-note row (get retries path)
                                            (fn [] (retry! path)) open-source!)
                 ;; Every branch that CLOSES here, innermost first. What a node
                 ;; has to say about its own children — the remainder, a lost
                 ;; order, a failed read — and the control that acts on it both
                 ;; belong at the END of that node's branch, next to each other
                 ;; and next to the children they describe.
                 (for [bpath (get boundaries i)
                       :let [binfo (get-in plan [:info bpath])
                             brow (row-at bpath)]
                       :when (and binfo brow)]
                   [:div.f27-desc-branch-end
                    {:key (str "b-" (string/join ">" (map str bpath)))}
                    (f27-descendant-notes binfo (:depth brow))
                    (when (f27ch/can-continue? binfo plan)
                      (more-button bpath
                                   (let [l (f27-row-label (:entity brow))]
                                     (if (string/blank? l)
                                       (t :f27/children-more)
                                       (t :f27/children-more-of l)))
                                   true
                                   (inc (:depth brow))))])]))
            rows)
           (f27-descendant-notes root-info 0)
           ;; The referencing block's own children close at the end of the tree,
           ;; so its continuation belongs here — and nowhere else.
           (when (f27ch/can-continue? root-info plan)
             (more-button [] (t :f27/children-more) false 0))
           (when hiding?
             [:div.f27-ctx-note.f27-ctx-capped
              (t :f27/children-budget f27ch/max-visible)])
           ;; At any safeguard the reader is sent to the source instead of being
           ;; offered a control that cannot progress.
           (when (or hiding? (some #(not= :ok (:descend %)) rows))
             [:button.f27-desc-source.f27-btn (f27-btn open-source! nil)
              (t :f27/children-open-source)])
           ;; The same collapse action as the control above the tree. A deep
           ;; tree used to push its only one off the top of what was on screen.
           [:div.f27-desc-end
            [:button.f27-desc-toggle-all.f27-btn
             (f27-btn #(reset! *open? false) {:aria-expanded "true"})
             (t :f27/children-hide-all)]]])])]))

;; --- F27 slice 5 — chained inbound-reference exploration --------------------
;;
;; DIRECTION: everything below is about blocks that REFER TO a selected block.
;; It is never the links written inside that block (outgoing references are not
;; followed at all) and never its children (slice 4, kept visibly separate).

(defn- f27-inbound-probe
  "Whether ONE result row has inbound references of its own, so a control that
  takes the next step appears only where there is a step to take.

  The block is re-resolved by uuid rather than trusting the entity already in
  hand, so a block that has gone away since the level was read is reported as
  unavailable instead of silently answering zero. A read that throws is reported
  as a failure: `{:total 0}` would assert 'nothing references this', which is
  exactly what a failed read did not establish.

  Read-only: one entity lookup and one count of an existing reverse-reference
  attribute. Nothing here writes, persists an id, or opens a transaction."
  [repo e]
  (try
    (if-let [live (db/entity repo [:block/uuid (:block/uuid e)])]
      {:total (count (:block/_refs live))}
      {:missing? true})
    (catch :default _ {:error? true})))

(defn- f27-load-inbound
  "Read ONE exploration level: the DIRECT inbound references of `uuid`.

  `(:block/_refs e)` is exactly what the reference badge counts, so the panel's
  total and the badge can never silently disagree. It is a single reverse-index
  read; no query walks the graph, no reference is followed, and no second level
  is fetched — the next level exists only if the reader asks for it.

  Each RETAINED row is then probed once, except rows already on the active trail,
  whose descent is refused by identity and needs no probe. The probes happen here,
  on the reader's explicit action, so that rendering and paging stay pure reads of
  what was already fetched.

  Every failure is turned into an explicit outcome: a block with no identity, a
  block that no longer resolves, and a read that threw are three different
  things, and none of them is an empty answer."
  [repo uuid skip-keys]
  (try
    (if-let [e (db/entity repo [:block/uuid uuid])]
      (let [prepared (f27in/prepare-results (vec (:block/_refs e))
                                            (fn [id] (db/entity repo id)))
            skip (set skip-keys)
            probes (reduce (fn [m r]
                             (let [k (f27in/step-key r)]
                               (if (contains? skip k)
                                 m
                                 (assoc m k (f27-inbound-probe repo r)))))
                           {}
                           (:unique prepared))]
        {:status :loaded :result prepared :probes probes})
      {:status :unavailable})
    (catch :default _ {:status :error})))

(rum/defc f27-inbound-row < rum/static
  "One block that REFERENCES the block at the current step.

  Shows that block's OWN source page and short ancestor path through OG's
  existing `breadcrumb`, and its text through `f27-body-text`, so emphasis,
  links, tags, Korean and emoji keep their meaning while a block reference is
  presented under the F27 contract rather than substituted recursively. It
  renders markup only: it installs no editing handler, creates no id, and has no
  save path — the same renderer audited in slices 3 and 4.

  A heading's leading `##` and a task's leading `TODO` are BLOCK-level markup an
  inline renderer would echo as literal characters, so they are shown as
  structure instead. The block itself is not altered."
  [config repo entity relation probe on-explore on-source]
  (let [format (or (:block/format entity) :markdown)
        content (f27-display-content format (f27in/block-label entity))
        {:keys [heading marker text]} (f27ctx/split-block-prefix content)
        label (f27-row-label entity)
        n (f27in/probe-count probe)]
    [:div.f27-in-row
     [:div.f27-in-row-head
      [:span.f27-in-mark {:class (case relation
                                  (:cycle :error :unavailable :trail) "is-stop"
                                  nil)}
       (case relation
         :cycle "↻"
         :error "?"
         :unavailable "!"
         :trail "⋯"
         "›")]
      [:span.f27-in-crumb
       ;; The F27 config, not the plain one: `breadcrumb` renders each
       ;; ancestor's title through OG's inline renderer, so without it an asset,
       ;; a macro or inline HTML written in a PARENT block would be rendered
       ;; unguarded inside this panel.
       (breadcrumb (f27-breadcrumb-config config repo (:block/uuid entity))
                   repo (:block/uuid entity)
                   {:show-page? true
                    :level-limit 3
                    :indent? false
                    :end-separator? false})]]
     [:div.f27-in-text
      (if (nil? content)
        [:span.f27-ctx-unavailable (t :f27/context-unavailable-line)]
        [:<>
         (when heading [:span.f27-ctx-badge.is-heading (str "H" heading)])
         (when marker [:span.f27-ctx-badge.is-task marker])
         (when-not (string/blank? text)
           (f27-body-text config repo (:block/uuid entity) format text))])]
     [:div.f27-in-actions
      ;; Exactly one relation earns a control that opens another level. The
      ;; others are explained where the control would have been, so the reader
      ;; is never left with an affordance that cannot progress.
      (case relation
        :ok
        [:button.f27-in-explore.f27-btn
         (f27-btn on-explore {:aria-label (t :f27/inbound-explore-of label (or n 0))})
         (if n (t :f27/inbound-explore-n n) (t :f27/inbound-explore))]

        :none [:span.f27-ctx-note (t :f27/inbound-none)]
        :cycle [:span.f27-ctx-note.f27-ctx-cycle (t :f27/inbound-cycle)]
        :trail [:span.f27-ctx-note.f27-ctx-capped (t :f27/inbound-trail-full f27in/max-trail)]
        :error [:span.f27-ctx-note.f27-ctx-error (t :f27/inbound-probe-error)]
        :unavailable [:span.f27-ctx-note.f27-ctx-error (t :f27/inbound-probe-unavailable)]
        nil)
      ;; Read-only source navigation is available on every row, whatever its
      ;; relation — including the two that cannot be opened further.
      [:button.f27-in-source.f27-btn
       (f27-btn on-source {:aria-label (t :f27/inbound-open-source-of label)})
       (t :f27/inbound-open-source)]]]))

(rum/defc f27-in-path < rum/static
  "The path the reader has walked, and Back.

  Every step but the current one is a control that returns to that step, so the
  path is readable AND usable; Back is the same operation for the immediately
  previous step and is kept as its own control because that is the one action
  the reader reaches for."
  [trail on-jump on-back]
  [:div.f27-in-path
   [:span.f27-in-path-label (t :f27/inbound-path)]
   (map-indexed
    (fn [i s]
      (let [l (f27-row-label (:entity s))
            l (if (string/blank? l) (t :f27/inbound-origin) l)
            last? (= i (dec (count trail)))]
        [:span.f27-in-path-step {:key (str "p-" i "-" (str (:key s)))}
         (when (pos? i) [:span.f27-in-path-sep "›"])
         (if last?
           [:span.f27-in-path-current {:aria-current "true"} l]
           [:button.f27-in-path-jump.f27-btn
            (f27-btn #(on-jump i) {:aria-label (t :f27/inbound-step-to l)})
            l])]))
    trail)
   (when (f27in/can-go-back? trail)
     (let [prev (f27-row-label (:entity (nth (vec trail) (- (count trail) 2))))
           prev (if (string/blank? prev) (t :f27/inbound-origin) prev)]
       [:button.f27-in-back.f27-btn
        (f27-btn on-back {:aria-label (t :f27/inbound-back-to prev)})
        (t :f27/inbound-back)]))])

(defn- f27-inbound-load!
  "Ask for ONE exploration level's read, deferred by a turn.

  Deferred so the level's `:loading` state is a real rendered state rather than
  one the model claims and never shows. `live?` is the row's own volatile: the
  read can still be in flight when the reader collapses the panel, and an answer
  that comes back to a component that has gone is dropped instead of written
  into state nothing is showing. `apply-result` drops it again if the reader has
  left the level meanwhile, so Back — and a refresh — can never be overwritten
  by a read they did not ask for.

  Extracted from the render body so the refresh resumption below can ask for the
  same read the reader's own actions ask for, rather than a second one written
  to look like it."
  [repo *ex live? req uuid skip]
  (js/setTimeout
   (fn []
     (when (and @live? (f27in/accepts-result? (:trail @*ex) req))
       (let [outcome (f27-load-inbound repo uuid skip)]
         (swap! *ex update :trail f27in/apply-result req outcome))))
   0))

(defn- f27-inbound-start!
  "Show a level, and read it.

  Two cases, and the difference is the point:

    * nothing walked yet, or a state belonging to another graph — the ORIGIN
      level is created for `ref-block` and read;
    * a path already walked — it is kept, and the level now on screen is read
      again, so re-opening never shows an answer that has since gone stale.

  Both take a fresh request id, so an answer still in flight for the old one is
  dropped rather than racing this read."
  [repo ref-block *ex live?]
  (let [cur @*ex
        fresh? (or (not= repo (:repo cur)) (empty? (:trail cur)))
        req (inc (:req cur 0))]
    (if fresh?
      (let [origin (f27in/new-step ref-block req)]
        (reset! *ex {:repo repo :trail [origin] :req req})
        (when (= :loading (:status origin))
          (f27-inbound-load! repo *ex live? req (:uuid origin) #{(:key origin)})))
      (let [tr (f27in/reload-step (:trail cur) req)
            st (f27in/current-step tr)]
        (swap! *ex assoc :req req :trail tr)
        (when (= :loading (:status st))
          (f27-inbound-load! repo *ex live? req (:uuid st) (f27in/trail-keys tr)))))))

(defn- f27-inbound-resume!
  "What an explicit refresh of the surrounding panel does to THIS section.

  The section is a snapshot and this is the only part of the context panel that
  is: every other section is derived from the database on each render, while the
  trail is a record of levels ALREADY READ — Back and a path jump re-display
  them without reading anything, which is what retaining the history is for. So
  a section left open across a change keeps showing what it read, and a refresh
  has to say so explicitly.

  `gen` is the panel's reading generation. When it moves:

    * the walked path is DISCARDED, not reloaded level by level. The reader gets
      the ROOT level — the panel's own target — read again, which is the inner
      traversal resetting to its root and is stated as such in the panel and in
      the specification;
    * `reset-trail` keeps the request counter, so the read still in flight for
      the discarded level is dropped by `accepts-result?` rather than landing on
      the refreshed one and displaying exactly the stale answer the reader asked
      to replace.

  A CLOSED section is not read: the generation is recorded and nothing else
  happens, so a refresh never turns a section the reader has not opened into a
  read. Nothing is started for a graph switch either — that leaves a level on
  the trail, and `awaiting-start?` is false for it.

  It runs AFTER the render, never during it and never before it. Rendering in
  this panel mutates nothing; and `:before-render` is React's
  `componentWillUpdate`, where requesting another render is exactly the illegal
  update Rum's `request-render` would perform synchronously. The read this asks
  for puts the level into `:loading`, which renders, and the guard is false on
  the way back through — so it settles rather than repeating."
  [state]
  (let [[_config repo ref-block *open? *ex gen] (:rum/args state)
        *seen (::gen-seen state)]
    (when (not= @*seen gen)
      (reset! *seen gen)
      (swap! *ex f27in/reset-trail))
    (when (f27in/awaiting-start? @*open? @*ex)
      (f27-inbound-start! repo ref-block *ex (::in-live state))))
  state)

(rum/defcs f27-row-inbound < rum/reactive
  ;; A level's read is deferred by one turn (see `load!`), so it can still be in
  ;; flight when the reader collapses the whole context panel. A plain volatile
  ;; — not a rum/local, which would request a render on the very component being
  ;; torn down — records that the component has gone, and the answer is dropped
  ;; instead of writing into state nothing is showing.
  {;; A PLAIN atom: the last reading generation this section acted on is
   ;; bookkeeping, and recording it must not re-render anything by itself.
   :init (fn [state _props] (assoc state ::gen-seen (atom nil)))
   :will-mount (fn [state] (assoc state ::in-live (volatile! true)))
   :will-unmount (fn [state] (vreset! (::in-live state) false) state)
   ;; The one read that is not started by a press: an explicit refresh of the
   ;; panel around this section discards the walked path and leaves the section
   ;; open, and this is what reads its root level again.
   :after-render f27-inbound-resume!}
  "Blocks that REFERENCE this referencing block, explored one level at a time.

  If B references A and C references B, the overview for A lists B; this is
  where the reader asks what references B, sees C, and can then ask the same
  question about C or go Back.

  What it deliberately is NOT:
    * it does not follow the links written INSIDE the selected block;
    * it does not show the selected block's children — that is the descendant
      tree above, and the two are labelled apart;
    * it never mounts a complete context panel inside another one. One level is
      on screen at a time, with a path and Back, so nothing recurses.

  Nothing is read until the reader opens it, and no level is read until the
  reader steps into it. Back and the path re-display a level the reader already
  walked, without another read.

  All state lives in ONE atom per row instance and is scoped to the graph, so
  each row and each panel appearance explores independently, and a graph switch
  starts over rather than showing another graph's path. It is TRANSIENT and
  READ-ONLY: nothing here edits, persists an id, opens a transaction, or writes
  a file.

  It is also the one part of the context panel that is a SNAPSHOT. A level is
  read when the reader asks for it and then replayed, so a section left open
  while the graph changes keeps showing what it read. `gen` — the surrounding
  panel's reading generation — is how an explicit refresh says otherwise; see
  `f27-inbound-resume!`."
  [component-state config repo ref-block *open? *ex _gen]
  (let [live? (::in-live component-state)
        raw-ex (rum/react *ex)
        open? (rum/react *open?)
        ;; Derived, never written during render: a state belonging to another
        ;; graph is treated as absent, and the next action rebuilds it.
        ex (if (= repo (:repo raw-ex)) raw-ex {:repo repo :trail [] :req 0})
        trail (vec (:trail ex))
        step (f27in/current-step trail)
        page (when (:result step) (f27in/page-of (:result step) (:limit step)))
        state (f27in/level-state step page)
        probes (:probes step)
        trail-label (let [l (f27-row-label (:entity step))]
                      (if (string/blank? l) (t :f27/inbound-origin) l))
        next-req (fn [] (inc (:req @*ex 0)))
        load! (fn [req uuid' skip] (f27-inbound-load! repo *ex live? req uuid' skip))
        start! (fn [] (f27-inbound-start! repo ref-block *ex live?))
        toggle! (fn [] (if open? (reset! *open? false)
                           (do (start!) (reset! *open? true))))
        explore! (fn [entity]
                   (when-not (f27in/trail-full? trail)
                     (let [req (next-req)
                           s (f27in/new-step entity req)
                           t (f27in/push-step trail s)]
                       (swap! *ex assoc :req req :trail t)
                       (when (= :loading (:status s))
                         (load! req (:uuid s) (f27in/trail-keys t))))))
        ;; Back and a path jump re-display a level already walked. They do not
        ;; read anything: that is what retaining the history is for.
        back! (fn [] (swap! *ex update :trail f27in/pop-step))
        jump! (fn [i] (swap! *ex update :trail f27in/truncate-trail i))
        more! (fn [] (swap! *ex update :trail
                            f27in/set-limit (f27in/next-limit (:limit step))))
        retry! (fn []
                 (let [req (next-req)
                       t (f27in/mark-retry trail req)
                       s (f27in/current-step t)]
                   (swap! *ex assoc :req req :trail t)
                   (when (= :loading (:status s))
                     (load! req (:uuid s) (f27in/trail-keys t)))))
        source! (fn [u] (fn [] (route-handler/redirect-to-page! (str u))))
        source-here! (source! (:uuid step))]
    [:div.f27-in
     [:button.f27-in-toggle.f27-btn
      (f27-btn toggle! {:aria-expanded (if open? "true" "false")})
      (if open? (t :f27/inbound-hide) (t :f27/inbound-show))]
     (when (and open? step)
       [:div.f27-in-body
        (f27-in-path trail jump! back!)
        [:div.f27-in-head (t :f27/inbound-head trail-label)]
        ;; Said in words, every time, because a panel opened from a reference
        ;; overview is exactly where the direction is easy to get backwards.
        [:div.f27-in-direction (t :f27/inbound-direction)]
        (case state
          ;; A read that has been asked for and has not answered. Never shown as
          ;; "nothing references this".
          :loading [:div.f27-ctx-note (t :f27/inbound-loading)]

          :no-identity [:div.f27-ctx-note.f27-ctx-error (t :f27/inbound-no-identity)]

          :unavailable
          [:<>
           [:div.f27-ctx-note.f27-ctx-error (t :f27/inbound-unavailable)]
           [:button.f27-in-source.f27-btn (f27-btn source-here! nil)
            (t :f27/inbound-open-source)]]

          ;; A failed read is not evidence of an empty answer, so it says so,
          ;; offers a bounded retry, and then offers the source instead of
          ;; becoming an endless button.
          :error
          [:<>
           [:div.f27-ctx-note.f27-ctx-error (t :f27/inbound-error)]
           (if (f27in/retry-allowed? (:attempts step))
             [:button.f27-in-retry.f27-btn (f27-btn retry! nil)
              (t :f27/inbound-retry)]
             [:span.f27-ctx-note (t :f27/inbound-retry-exhausted)])
           [:button.f27-in-source.f27-btn (f27-btn source-here! nil)
            (t :f27/inbound-open-source)]]

          :empty [:div.f27-ctx-note (t :f27/inbound-empty)]

          [:<>
           [:div.f27-in-count (t :f27/inbound-count (:total (:result step)))]
           [:div.f27-in-rows
            (for [e (:shown page)
                  :let [k (f27in/step-key e)
                        relation (f27in/row-relation k trail (get probes k))]]
              [:div.f27-in-item {:key (str "in-" (str k))}
               (f27-inbound-row config repo e relation (get probes k)
                                #(explore! e) (source! (:block/uuid e)))])]
           ;; Every inbound entry that is not visible above is explained. A row
           ;; that could not render is never reported as displayed.
           (when (pos? (:duplicates (:result step)))
             [:div.f27-ctx-note (t :f27/inbound-duplicates (:duplicates (:result step)))])
           (when (pos? (:unavailable (:result step)))
             [:div.f27-ctx-note.f27-ctx-error
              (t :f27/inbound-unresolved (:unavailable (:result step)))])
           (when (pos? (:remaining page))
             [:div.f27-ctx-note (t :f27/inbound-remaining (:remaining page))])
           (when (f27in/can-continue? page)
             [:button.f27-in-more.f27-btn (f27-btn more! nil)
              (t :f27/inbound-more)])
           ;; Entries beyond the per-level cap are counted and named, but no
           ;; control claims to reach them, because none can.
           (when (f27in/cap-hiding-anything? page)
             [:div.f27-ctx-note.f27-ctx-capped
              (t :f27/inbound-beyond-cap (:beyond-cap page) f27in/max-shown)])
           (when (and (zero? (:shown-count page)) (pos? (:total (:result step))))
             [:div.f27-ctx-note (t :f27/inbound-nothing-displayable)])
           (when (or (f27in/cap-hiding-anything? page)
                     (f27in/trail-full? trail)
                     (zero? (:shown-count page)))
             [:button.f27-in-source.f27-btn (f27-btn source-here! nil)
              (t :f27/inbound-open-source)])])
        ;; Back and the collapse control, repeated after the results.
        ;; Exploration is driven from the top of this panel, but a reader who
        ;; has just read a page of results is at the BOTTOM of it, and that is
        ;; where the step they most likely want next has to be.
        [:div.f27-in-end
         (when (f27in/can-go-back? trail)
           (let [prev (f27-row-label (:entity (nth (vec trail) (- (count trail) 2))))
                 prev (if (string/blank? prev) (t :f27/inbound-origin) prev)]
             [:button.f27-in-back.f27-btn
              (f27-btn back! {:aria-label (t :f27/inbound-back-to prev)})
              (t :f27/inbound-back)]))
         [:button.f27-in-toggle.f27-btn
          (f27-btn toggle! {:aria-expanded "true"})
          (t :f27/inbound-hide)]]])]))


;; ---------------------------------------------------------------------------
;; F27 outgoing first slice — the links written INSIDE one block.
;;
;; Every direction above this point is inbound (what refers to this block) or
;; structural (its ancestors, its children). This is the other direction, and it
;; is deliberately a SIBLING of the inbound section rather than part of it: two
;; lists that answer opposite questions must never read as one.
;;
;; The list is derived from the SAME parse the panel renders — `inline->edn`
;; over the block's displayed text — so what is listed and what is on screen
;; cannot disagree. `:block/refs` is deliberately not the basis: it carries page
;; refs, tags and refs inherited from ancestors, so a block would appear to link
;; to things nobody wrote in it.
;;
;; Everything shown is one hop. A target's own text is rendered by
;; `f27-embed-expansion`, which is the guarded renderer one level down, so a
;; reference inside it is a closed chip, an asset a compact indicator and a
;; macro inert — the same guards, without a new rule. Children are never read.
;; Read-only throughout: entity lookups and pure functions.
;; ---------------------------------------------------------------------------

(defn- f27-outgoing-scan
  "The inline block references written in ONE block's own text.

  The text scanned is the text the panel DISPLAYS: built-in properties removed,
  block-level prefix split off. A persisted `id::` is therefore never a source
  of links, and the parse is the one the renderer already performs.

  A failed read or parse is caught and reported as `:error`. It is never
  reported as an empty block: 'nothing is written here' and 'this could not be
  read' are different answers and the panel says which."
  [entity]
  (try
    (let [format (or (:block/format entity) :markdown)
          content (f27-display-content format (:block/content entity))
          {:keys [text]} (f27ctx/split-block-prefix content)
          ast (when-not (string/blank? text)
                (gp-mldoc/inline->edn text (gp-mldoc/default-config format)))
          {:keys [hits truncated?]} (f27o/scan (or ast []))
          collected (f27o/collect hits)]
      {:text text
       :collected collected
       :truncated? (boolean truncated?)
       ;; Completeness is part of the answer, not a note beside it: a bound that
       ;; stopped before the first link has not established that there is none.
       :state (f27o/section-state {:text text
                                   :collected collected
                                   :truncated? (boolean truncated?)})})
    (catch :default _
      {:text nil :collected (f27o/collect []) :truncated? false :state :error})))

(rum/defcs f27-outgoing-row < (rum/local false ::open?)
  "One target this block links to.

  Shows the target's own source page and short ancestor path through OG's
  existing `breadcrumb` — with the F27 config, so an asset or a macro written in
  one of ITS parents is not rendered unguarded here — and a bounded compact
  label of its text, never an identifier.

  Three outcomes, and only one of them offers the expansion:

    :show         the target resolves and is not this block. One control shows
                  its own text, bounded, one hop, read-only
    :self         the block refers to itself. Marked, said in words, and never
                  opened — expanding it would render the block inside its own
                  context
    :unavailable  the target could not be found. Said in words, and carrying no
                  control that cannot work"
  [state config repo host-uuid link]
  (let [id (:id link)
        resolved (f27-ref-target repo id)
        ;; NOT `(some? resolved)`. The parser turns every `((uuid))` into the
        ;; lookup ref `[:block/uuid id]`, and transacting one that resolves to
        ;; nothing CREATES an entity carrying that identity alone — so a link to
        ;; a block nobody has written resolves to a stub. `readable-target?`
        ;; asks whether there is a block there; a live run of this scenario is
        ;; what found the difference.
        entity (when (f27o/readable-target? resolved) resolved)
        outcome (f27o/plan-link {:id id :host host-uuid :resolved? (some? entity)})
        label (or (f27-ref-label entity) (t :f27/outgoing-untitled))
        open? (and (f27o/expandable? outcome) @(::open? state))
        ;; Built under the SAME config the body renderer uses, with this target
        ;; pushed onto the trail alongside the host: a reference inside the
        ;; expansion that points back at either is the repeat it is.
        {:keys [heading marker body fallback truncated?]}
        (when open?
          (f27-embed-expansion (f27-body-config config repo host-uuid)
                               entity f27o/max-target-chars
                               [(f27-ref-key host-uuid) (f27-ref-key id)]))
        repeats (or (:repeats link) 0)]
    [:div.f27-out-row {:class (case outcome
                                :self "is-self"
                                :unavailable "is-unavailable"
                                nil)}
     [:div.f27-out-row-head
      [:span.f27-out-pos (str (inc (or (:order link) 0)) ".")]
      [:span.f27-out-mark {:class (when (not= :show outcome) "is-stop")
                           :aria-hidden "true"}
       (case outcome :self "↻" :unavailable "⚠" "→")]
      [:span.f27-out-crumb
       (when (and entity (not= :unavailable outcome))
         (breadcrumb (f27-breadcrumb-config config repo (:block/uuid entity))
                     repo (:block/uuid entity)
                     {:show-page? true
                      :level-limit 3
                      :indent? false
                      :end-separator? false}))]]
     [:div.f27-out-text
      (if (= :unavailable outcome)
        [:span.f27-out-missing {:title (t :f27/outgoing-unavailable-title)}
         (t :f27/outgoing-unavailable)]
        [:span.f27-out-label label])
      (when (pos? repeats)
        [:span.f27-out-repeats (t :f27/outgoing-repeats repeats)])]
     (when (= :self outcome)
       [:div.f27-ctx-note.f27-ctx-cycle (t :f27/outgoing-self)])
     [:div.f27-out-actions
      (when (f27o/expandable? outcome)
        [:button.f27-out-toggle-text.f27-btn
         (f27-btn (fn [] (swap! (::open? state) not))
                  {:aria-expanded (if open? "true" "false")
                   :aria-label (if open?
                                 (t :f27/outgoing-hide-text-of label)
                                 (t :f27/outgoing-show-text-of label))
                   :title (if open?
                            (t :f27/outgoing-hide-text)
                            (t :f27/outgoing-show-text))})
         (if open? (t :f27/outgoing-hide-text) (t :f27/outgoing-show-text))])
      ;; No control is offered for a target that could not be found: a button
      ;; that navigates nowhere is worse than none.
      (when (not= :unavailable outcome)
        [:button.f27-out-source.f27-btn
         (f27-btn (fn [] (route-handler/redirect-to-page! (str id)))
                  {:aria-label (t :f27/outgoing-open-target-of label)
                   :title (t :f27/outgoing-open-target)})
         (t :f27/outgoing-open-target)])]
     (when open?
       [:div.f27-out-target {:role "group"
                             :aria-label (t :f27/outgoing-target-of label)}
        [:span.f27-out-target-head
         (when heading [:span.f27-ctx-badge.is-heading (str "H" heading)])
         (when marker [:span.f27-ctx-badge.is-task marker])]
        (cond
          body [:span.f27-out-target-text body]
          fallback [:span.f27-out-target-text [:span.f27-out-target-fallback fallback]]
          :else [:span.f27-out-target-text
                 [:span.f27-out-target-empty (t :f27/outgoing-empty-target)]])
        (when truncated? [:span.f27-out-cut {:aria-hidden "true"} "…"])
        (when truncated?
          [:div.f27-ctx-note.f27-out-note (t :f27/outgoing-bounded)])
        [:div.f27-ctx-note.f27-out-note (t :f27/outgoing-one-hop)]])]))

(rum/defcs f27-row-outgoing < (rum/local 0 ::shown)
  "The links written INSIDE this referencing block, on request.

  Collapsed by default: it is a second direction, and a panel that opened both
  directions at once would be a list of everything rather than a reading
  surface. The count in the control is taken from the block's own text, which is
  a pure parse of one string — no target is resolved until the section is open.

  Four outcomes are said differently, because they mean different things:
  nothing written here, a target that could not be found, more links than are
  kept, and a read that failed."
  [state config repo ref-block]
  (let [host-uuid (:block/uuid ref-block)
        scan (f27-outgoing-scan ref-block)
        collected (:collected scan)
        ;; Completeness now reaches this component through the STATE, not as a
        ;; separate flag beside it — which is what let the two disagree.
        status (:state scan)
        shown @(::shown state)
        open? (pos? shown)
        page (f27o/page-of collected shown)
        ;; Blank falls through to the plain heading below, rather than being
        ;; substituted with a placeholder name the block does not have.
        host-label (f27-row-label ref-block)
        ;; One number, used in both places: how many distinct targets this
        ;; block links to. Repeated writings of the same target are counted on
        ;; the row itself, where the reader can see which target repeats.
        found (or (:distinct collected) 0)
        partial? (f27o/partial-scan? status)
        open-source! (fn [] (when host-uuid
                              (route-handler/redirect-to-page! (str host-uuid))))]
    [:div.f27-out
     [:button.f27-out-toggle.f27-btn
      (f27-btn (fn [] (swap! (::shown state)
                             (fn [n] (if (pos? n) 0 f27o/links-per-request))))
               {:aria-expanded (if open? "true" "false")})
      (cond
        open? (t :f27/outgoing-hide)
        ;; A floor, not a total. The collapsed control is where a partial count
        ;; is most easily read as complete, so it is qualified here too.
        (and (pos? found) partial?) (t :f27/outgoing-show-partial found)
        (pos? found) (t :f27/outgoing-show found)
        ;; No count at all rather than a "0" a bounded scan never established.
        :else (t :f27/outgoing-show-none))]
     (when open?
       [:div.f27-out-body
        [:div.f27-out-head (if (string/blank? host-label)
                             (t :f27/outgoing-head-plain)
                             (t :f27/outgoing-head host-label))]
        ;; Said in words on the surface itself, not only in a contract: this is
        ;; the opposite direction from the section below it.
        [:div.f27-out-direction (t :f27/outgoing-direction)]
        [:div.f27-out-scope (t :f27/outgoing-scope)]
        (case status
          :error
          [:<>
           [:div.f27-ctx-note.f27-ctx-error (t :f27/outgoing-error)]
           [:button.f27-out-open-source.f27-btn (f27-btn open-source! nil)
            (t :f27/outgoing-open-source)]]

          :no-text [:div.f27-ctx-note (t :f27/outgoing-no-text)]

          ;; The WHOLE text was scanned and holds no reference. Only this state
          ;; may say so.
          :empty [:div.f27-ctx-note (t :f27/outgoing-empty)]

          ;; A bound stopped the scan before any link was found. There is no
          ;; count to show and no row to render — but there IS something to say,
          ;; and it must not be the sentence `:empty` gets.
          ;;
          ;; This branch deliberately renders its own content rather than
          ;; deferring to the shared note below, because a `case` clause whose
          ;; result is literal `nil` is COMPILED AWAY inside a hiccup body: the
          ;; next form becomes this clause's result, and the default disappears
          ;; with it. That is not a hypothesis — it was read out of the emitted
          ;; JavaScript, where `case "partial-empty"` returned the count-and-rows
          ;; fragment and the default threw "No matching clause: ready" for every
          ;; ordinary section. A live packaged run is what surfaced it.
          :partial-empty
          [:<>
           [:div.f27-ctx-note.f27-ctx-capped (t :f27/outgoing-partial-empty)]
           [:button.f27-out-open-source.f27-btn (f27-btn open-source! nil)
            (t :f27/outgoing-open-source)]]

          ;; :ready and :partial-ready
          [:<>
           [:div.f27-out-count (if partial?
                                 (t :f27/outgoing-count-partial found)
                                 (t :f27/outgoing-count found))]
           [:div.f27-out-rows
            (for [[i l] (map-indexed vector (:rows page))]
              (rum/with-key (f27-outgoing-row config repo host-uuid l)
                (str "f27-out-" (:id l) "-" i)))]])

        ;; Bounds and losses, each said only when it actually bites.
        (when (pos? (or (:malformed collected) 0))
          [:div.f27-ctx-note.f27-ctx-error
           (t :f27/outgoing-malformed (:malformed collected))])
        ;; An incomplete scan that DID find links: the list above is a floor,
        ;; and the source is the only place the rest of the text can be read.
        ;; `:partial-empty` says its own version of this in its own branch.
        (when (= :partial-ready status)
          [:<>
           [:div.f27-ctx-note.f27-ctx-capped (t :f27/outgoing-truncated)]
           [:button.f27-out-open-source.f27-btn (f27-btn open-source! nil)
            (t :f27/outgoing-open-source)]])
        (when (pos? (or (:remaining page) 0))
          [:div.f27-ctx-note (t :f27/outgoing-remaining (:remaining page))])
        (when (f27o/can-continue? page)
          [:button.f27-out-more.f27-btn
           (f27-btn (fn [] (reset! (::shown state) (f27o/next-wanted shown)))
                    {:aria-label (t :f27/outgoing-more-of f27o/links-per-request)})
           (t :f27/outgoing-more)])
        ;; A retention cap is NOT a continuation: nothing past it was kept, so
        ;; the reader is sent to the source rather than offered a control that
        ;; silently fails to reach what it names.
        (when (f27o/cap-hiding-anything? page)
          [:<>
           [:div.f27-ctx-note.f27-ctx-capped
            (t :f27/outgoing-beyond-cap (:beyond-cap page) f27o/max-links)]
           [:button.f27-out-open-source.f27-btn (f27-btn open-source! nil)
            (t :f27/outgoing-open-source)]])
        [:div.f27-out-end
         [:button.f27-out-toggle.f27-btn
          (f27-btn (fn [] (reset! (::shown state) 0)) {:aria-expanded "true"})
          (t :f27/outgoing-hide)]]])]))

(rum/defcs f27-row-context < rum/static
  (rum/local f27ctx/default-batch ::limit)
  (rum/local false ::kids-open?)
  (rum/local {:open #{} :limits {} :retries {}} ::desc)
  (rum/local false ::inbound-open?)
  (rum/local {:repo nil :trail [] :req 0} ::inbound)
  "Expanded ancestor context for ONE incoming-reference row.

  Ancestors are walked in BOUNDED BATCHES with explicit continuation, rather
  than relying on a default parent-query depth that truncates silently.

  The walk is synchronous and cheap (at most `hard-cap` single-step parent
  lookups), so the component keeps only the current LIMIT in instance-local
  state and derives everything else from it. Rendering therefore mutates
  nothing, and there is no 'loading' state to claim — continuation simply
  raises the limit and the row re-renders.

  State is per component instance, so each row and each panel appearance
  expands independently.

  `on-collapse` is the row's own collapse action, repeated at the END of the
  panel. A context with a long body used to leave its only collapse control far
  above whatever the reader had scrolled to; the control now sits on both sides
  of the content, so it is reachable from either end without a sticky element
  floating over the text.

  `gen` is the caller's reading generation, and it is carried rather than acted
  on here. Every section below is derived from the database on each render, so a
  re-render is already a re-reading of it; the ONE exception is the inbound
  explorer, which replays the level it read, and that is where the generation is
  used. The reader's own disclosure and paging state — how far the ancestor
  batch was continued, which descendant branches are open, how many links are
  shown — is not touched by a refresh, because none of it holds a stale answer.
  A caller with no refresh action of its own passes a constant."
  [state config repo ref-block on-collapse gen]
  (let [*limit (::limit state)
        uuid' (:block/uuid ref-block)]
    [:div.f27-ctx {:on-click (fn [e] (util/stop-propagation e))}
     (if (nil? uuid')
       ;; No identity to walk from. Say so plainly instead of showing an
       ;; empty panel or a state that could never resolve.
       [:div.f27-ctx-note.f27-ctx-unavailable (t :f27/context-unavailable-line)]
       (let [{:keys [ancestors more? cycle? depth capped? error?]}
             (f27ctx/load-ancestors (f27-parent-fn repo) uuid' @*limit)
             {:keys [page ancestors]} (f27ctx/context-rows ancestors ref-block)
             ;; Continuation is offered ONLY when clicking it can actually load
             ;; something: at the hard cap it cannot, and after a failed lookup
             ;; there is nothing dependable to continue from.
             continue? (and more? (not cycle?) (not capped?) (not error?))]
         [:<>
          (when page
            [:div.f27-ctx-page
             [:a {:on-click (fn [e]
                              (util/stop e)
                              (route-handler/redirect-to-page! (:block/name page)))}
              (or (:block/original-name page) (:block/name page))]])
          (when (and more? (not cycle?))
            [:div.f27-ctx-note (t :f27/context-more-above)])
          [:div.f27-ctx-lines
           (for [a ancestors]
             (rum/with-key (f27-context-line config repo a false)
               (str "anc-" (or (:block/uuid a) (hash a)))))
           (f27-context-line config repo ref-block true)]
          (when cycle?
            [:div.f27-ctx-note.f27-ctx-cycle (t :f27/context-cycle)])
          ;; A failed read keeps whatever was already loaded and says the chain
          ;; above it is unknown — never that it is finished.
          (when error?
            [:div.f27-ctx-note.f27-ctx-error (t :f27/context-error)])
          (when capped?
            [:div.f27-ctx-note.f27-ctx-capped (t :f27/context-capped f27ctx/hard-cap)])
          (when continue?
            [:button.f27-ctx-load-more.f27-btn
             (f27-btn #(reset! *limit (+ depth f27ctx/default-batch)) nil)
             (t :f27/context-load-more)])
          ;; Descendants of THIS referencing block.
          (f27-row-descendants config repo uuid'
                               (::kids-open? state) (::desc state))
          ;; The links written INSIDE this referencing block. A third
          ;; direction, above the inbound section and clearly labelled, so
          ;; "what this block points at" and "what points at this block" are
          ;; never read as one list.
          (f27-row-outgoing config repo ref-block)
          ;; Blocks that REFERENCE this referencing block — the opposite
          ;; direction from the descendants above, and deliberately below them
          ;; so the two are never read as one list.
          (f27-row-inbound config repo ref-block
                           (::inbound-open? state) (::inbound state) gen)
          ;; The same collapse action as the control above this panel, repeated
          ;; where a reader who has just finished reading actually is.
          (when on-collapse
            [:div.f27-ctx-end
             [:button.f27-ctx-collapse.f27-btn
              (f27-btn on-collapse {:aria-expanded "true"})
              (t :f27/context-hide)]])]))]))

;; ---------------------------------------------------------------------------
;; F27 inline-context slice — the explicit control beside an ORDINARY inline
;; block reference, and the panel it opens.
;;
;; Until now F27's context was reachable from one place only: a block's
;; incoming-reference badge. A reader meeting a reference in the middle of a
;; sentence could open the target's PAGE, send it to the sidebar, or hover it —
;; but could not see the target's own context without leaving what they were
;; reading.
;;
;; The contract here (F27_INLINE_CONTEXT_SPEC.md):
;;
;;   * the control is a SIBLING of `.block-ref-wrap`, never a descendant of it
;;     and never inside a link, so OG's ordinary click, Shift-click, right-click
;;     and hover behaviour are untouched. The one exception is deliberate: while
;;     the panel is open the hover preview over THAT reference is suppressed, so
;;     a floating preview cannot cover the panel;
;;   * the subject is the TARGET — its source page, its ancestors, its children,
;;     what it links to, and what links to IT. Never the host block's, and never
;;     another occurrence's;
;;   * state is component-local AND key-guarded by graph, host block and target,
;;     so a reused instance can never display state belonging to another
;;     reference;
;;   * while the panel is CLOSED nothing about the target's context is read,
;;     parsed or walked;
;;   * the panel reuses `f27-row-context` — the existing engine, with its
;;     existing bounds. No second context engine, and no new control inside
;;     F27's own safe previews: everything below renders through
;;     `f27-body-config`/`f27-breadcrumb-config`, which set `:f27/ref-render`,
;;     so a reference inside the panel is a bounded chip and never reaches this
;;     code path again.
;; ---------------------------------------------------------------------------

(defn- f27-inline-stop-mouse-down
  "Mouse-down inside `.block-content` puts the block into the editor
  (`block-content-on-mouse-down`). A press on this feature's control or inside
  its panel is neither an edit nor a navigation, so it is stopped at the
  feature's own root — and the elements also carry `forbid-edit`, which is the
  class OG's own handler already honours."
  [e]
  (util/stop-propagation e))

(defn- f27-inline-surface
  "OG's `config` mapped to the one question `frontend.util.f27-inline` asks.

  This is the ONLY place OG's config shape is known, so every rule in the
  specification is decided by a pure function over plain booleans and is tested
  without a renderer. `extra` carries the two facts that require the resolved
  block, and is supplied only after the cheap config-only decision has already
  said the control might belong here."
  ([config id] (f27-inline-surface config id nil))
  ([config id extra]
   (merge
    {:identity? (some? (try (parse-uuid (str id)) (catch :default _ nil)))
     ;; Inside an F27 panel body. `:f27/ref-render` is set by
     ;; `f27-body-config`, so this path is not even reached there; asked
     ;; anyway, because the guard must not depend on that staying true.
     :f27-panel? (some? (:f27/ref-render config))
     :inline-panel? (boolean (:f27/inline-context? config))
     :mobile? (boolean (util/mobile?))
     :preview? (boolean (:preview? config))
     :slide? (boolean (:slide? config))
     :sidebar? (boolean (:sidebar? config))
     :embed? (boolean (or (:embed? config) (:page-embed? config)))
     :block-ref? (boolean (:block-ref? config))
     :query? (boolean (:custom-query? config))
     :html-export? (boolean (:html-export? config))
     :whiteboard? (boolean (or (:whiteboard? config) (:whiteboard-view? config)))
     :annotation? false}
    extra)))

(defn- f27-inline-special-target
  "The two block kinds whose reference has its own click behaviour — a PDF
  annotation and a whiteboard shape. Neither is expanded in this slice, and
  both keep exactly the behaviour they have."
  [entity]
  (let [props (:block/properties entity)
        ls-type (keyword (:ls-type props))]
    {:whiteboard? (= :whiteboard-shape ls-type)
     :annotation? (or (= :annotation ls-type) (some? (:hl-type props)))}))

(defn- f27-inline-interest
  "The entity ids whose change could alter what THIS panel shows.

  Gathered when the panel renders, which is rare, so that the decision made on
  every transaction is a set lookup over that transaction's own datoms and
  nothing else — no query, no walk, no pull.

  It is deliberately small and bounded:

    the target itself   its text, its retraction, its reparenting
    its parent and page the breadcrumb's nearest step and its source page
    its ancestors       the rest of the breadcrumb, capped at the three levels
                        the breadcrumb is asked to show

  A child arriving under the target and a block starting to refer to it are NOT
  in this set and do not need to be: those transactions POINT at the target
  through `:block/parent` and `:block/refs`, which `f27w/touches?` reads."
  [repo entity]
  (let [ancestors (when-let [u (:block/uuid entity)]
                    (try (db/get-block-parents repo u 3) (catch :default _ nil)))]
    (into #{}
          (remove nil?)
          (concat [(:db/id entity)
                   (:db/id (:block/parent entity))
                   (:db/id (:block/page entity))]
                  (keep :db/id ancestors)))))

;; ---------------------------------------------------------------------------
;; Keeping an OPEN panel true, and why it cannot use the reactive query system.
;;
;; The obvious mechanism is `db/sub-block`, which every other reactive component
;; here uses. It does not work for this, and the reason was measured rather than
;; guessed:
;;
;;   * that query is keyed by DATABASE ID. A file changed on disk is re-parsed
;;     by `handler.file/alter-file`, which retracts the page's blocks and
;;     transacts new ones, so the block's IDENTITY survives and its database id
;;     does not;
;;
;;   * worse, NO reactive query is refreshed at all on that path.
;;     `outliner.pipeline/invoke-hooks` — the only caller of `react/refresh!` —
;;     is guarded by `(not (:from-disk? tx-meta))`, and the watcher's
;;     `alter-file` passes exactly that. So a `::block`, a `::page-blocks` and
;;     even a `:custom` key are all equally silent;
;;
;;   * what OG does instead is `ui-handler/re-render-root!`, which requests a
;;     render of the ROOT — and `rum/static` short-circuits the block subtree,
;;     so it never arrives. That is why OG's own inline reference text does not
;;     converge after a from-disk change either, until its host block re-renders
;;     for some other reason. This slice does not change `block-reference`; the
;;     lifecycle scenario records that as an observation.
;;
;; So the panel subscribes to the CONNECTION, which every transaction reaches
;; whatever its metadata carries. What it does NOT do is re-read anything to
;; decide: `f27w/touches?` answers from the transaction's own datoms and the set
;; above, so an open panel costs one pass over each transaction's datoms and
;; nothing more. There is no global re-render and no context scan.
;;
;; Scope and lifetime are the panel's own: the subscription starts at
;; `:did-mount` and is removed at `:will-unmount`, from the EXACT connection it
;; was added to — which matters because a re-index replaces the connection, and
;; asking the application again at unmount would unlisten from the new one and
;; leave this listener on the old one forever. If the connection is replaced
;; while the panel is open, the next render rebinds it.
;; ---------------------------------------------------------------------------

(defn- f27-inline-on-change
  "The listener body: invalidate this panel when, and only when, the transaction
  mentions something it is showing."
  [state]
  (let [*interest (::interest state)
        *tick (::tick state)]
    (fn [tx-report]
      (when (f27w/touches? @*interest (:tx-data tx-report))
        ;; A `rum/local` re-renders its component when it changes, so this is
        ;; the invalidation and nothing else.
        (swap! *tick inc)))))

(defn- f27-inline-watch-target!
  [state]
  (let [[_config repo id] (:rum/args state)]
    (reset! (::interest state) (f27-inline-interest repo (f27-ref-target repo id)))
    (reset! (::handle state) (f27w/watch! (db/get-db repo false)
                                          (f27-inline-on-change state))))
  state)

(defn- f27-inline-unwatch-target!
  [state]
  (f27w/unwatch! @(::handle state))
  (reset! (::handle state) nil)
  state)

(defn- f27-inline-keep-watching!
  "Called from the panel's own render, with the entity it just resolved.

  Two jobs, both cheap: refresh the set the listener decides from, and move the
  subscription if the graph's connection is no longer the one being held. The
  second is a single identity comparison; it does nothing at all in the ordinary
  case, and it is what stops a re-index leaving this panel attached to a
  connection that is not its graph's."
  [state repo entity]
  (reset! (::interest state) (f27-inline-interest repo entity))
  (let [*handle (::handle state)]
    ;; Only after `:did-mount` has established one: registering a listener from
    ;; a render that may never mount would leak it.
    (when @*handle
      (reset! *handle (f27w/rebind! @*handle (db/get-db repo false)
                                    (f27-inline-on-change state)))))
  nil)

(rum/defcs f27-inline-panel <
  ;; `rum/local` first: Rum collects before-render hooks MIXIN-major, so a map
  ;; placed before it would run against state its `:will-mount` has not built
  ;; yet. The same ordering fact that broke `f27-inline-ref` once.
  (rum/local 0 ::tick)
  {:init (fn [state _props]
           ;; PLAIN atoms, deliberately: the interest set and the subscription
           ;; handle are bookkeeping, and setting either of them must not
           ;; re-render anything by itself. Only `::tick` does that.
           (assoc state
                  ::interest (atom #{})
                  ::handle (atom nil)))
   :did-mount f27-inline-watch-target!
   :will-unmount f27-inline-unwatch-target!}
  "The panel itself. Rendered ONLY while open, so everything it reads — the
  target, its breadcrumb, its Crystal matches and its context — is work that
  happens because the reader asked for it.

  `context?` is the second disclosure. The first names the target; the second
  is `f27-row-context` for the TARGET, which is where the ancestors,
  descendants, outgoing and inbound sections come from, unchanged.

  It is a component of its own, rather than a fragment of `f27-inline-ref`, so
  that the target subscription above lives exactly as long as the panel does.

  `gen` is the reading generation, and `on-refresh` advances it. What the panel
  shows is a SNAPSHOT — read when the panel was opened, and again whenever the
  watcher above sees a transaction that touches something it shows. Refresh is
  the reader's explicit way to ask for another reading, and the one section it
  actually changes is the incoming-reference explorer, which replays levels it
  has already read. It stays this panel's own: it does not navigate, does not
  re-index, transacts nothing, remounts nothing outside this panel, and cannot
  reach another occurrence's panel."
  [state config repo id panel-id context? gen on-context on-refresh on-close]
  ;; Read so this panel re-renders when the watcher above sees something it
  ;; shows change. The value carries no meaning: everything below is resolved
  ;; fresh from the current database on every render, so it is already correct
  ;; once something has caused one.
  @(::tick state)
  (let [entity (f27-ref-target repo id)
        ;; Refresh what the listener decides from, and follow the connection if
        ;; the graph's has been replaced. Neither re-renders anything.
        _ (f27-inline-keep-watching! state repo entity)
        readable? (f27o/readable-target? entity)
        tstate (f27il/target-state {:identity? true :readable? readable?})
        label (or (f27-ref-label entity) (t :f27/inline-untitled))
        crystal-tag (when readable? (state/get-crystal-tag repo))
        {:keys [previews remainder]}
        (when crystal-tag
          (f27c/select-previews (f27-crystal-matches repo crystal-tag entity)))
        ;; Everything below renders as INSIDE this panel, so no further inline
        ;; control can be offered within it.
        inner-config (assoc config :f27/inline-context? true)]
    [:div.f27-il-panel {:id panel-id
                        :role "group"
                        :aria-label (t :f27/inline-panel-of label)
                        :on-mouse-down f27-inline-stop-mouse-down
                        :on-click (fn [e] (util/stop-propagation e))}
     [:div.f27-il-head
      [:span.f27-il-title (t :f27/inline-head)]
      ;; Every action carries an explicit React key. The middle one is
      ;; CONDITIONAL — a target that has gone unreadable has no source to open —
      ;; and without keys its removal would let React reuse one action's element
      ;; for another, moving the focus a reader is holding onto a different
      ;; control. Refresh is first for the same reason: its position does not
      ;; depend on a control that may not be there.
      [:div.f27-il-actions
       [:button.f27-il-refresh.f27-btn.forbid-edit
        (assoc (f27-btn on-refresh {:key "refresh"
                                    :aria-label (t :f27/inline-refresh-of label)
                                    :title (t :f27/inline-refresh-title)})
               :on-mouse-down f27-inline-stop-mouse-down)
        (t :f27/inline-refresh)]
       (when (f27il/expandable? tstate)
         [:button.f27-il-source.f27-btn.forbid-edit
          (assoc (f27-btn (fn [] (route-handler/redirect-to-page! (str id)))
                          {:key "source"
                           :aria-label (t :f27/inline-source-of label)
                           :title (t :f27/inline-source)})
                 :on-mouse-down f27-inline-stop-mouse-down)
          (t :f27/inline-source)])
       [:button.f27-il-close.f27-btn.forbid-edit
        (assoc (f27-btn on-close {:key "close"
                                  :aria-label (t :f27/inline-close-of label)
                                  :title (t :f27/inline-close)})
               :on-mouse-down f27-inline-stop-mouse-down)
        (t :f27/inline-close)]]]
     ;; Which direction this is, in words. The inbound section inside the
     ;; context below is about the TARGET, not about the block being read, and
     ;; the two must never be read as one.
     [:div.f27-il-direction (t :f27/inline-direction)]
     ;; And WHEN this was read, in words, because it is a snapshot rather than a
     ;; live list. Said on the surface itself and not only in a contract: a
     ;; section left open while the graph changes keeps showing the level it
     ;; read, and Refresh is what asks for another reading.
     [:div.f27-il-snapshot (t :f27/inline-snapshot)]
     (if-not (f27il/expandable? tstate)
       [:div.f27-ctx-note.f27-ctx-error.f27-il-unavailable (t :f27/inline-unavailable)]
       [:<>
        ;; First disclosure: the target's source page and short breadcrumb,
        ;; through the same component and the same F27 breadcrumb config the
        ;; incoming-reference overview uses — so an asset or a macro written in
        ;; an ancestor is a compact indicator here, never a picture.
        [:div.f27-il-crumb
         (breadcrumb (f27-breadcrumb-config inner-config repo (:block/uuid entity))
                     repo (:block/uuid entity)
                     {:show-page? true
                      :level-limit 3
                      :indent? false
                      :end-separator? false})]
        (when (seq previews)
          [:div.f27-crystal-row
           (for [m previews] (rum/with-key (f27-crystal-preview m) (str (:uuid m))))
           (when (pos? remainder)
             [:span.f27-crystal-more (t :f27/crystal-more remainder)])])
        ;; Second disclosure: the existing context engine, for the TARGET.
        [:div.f27-ctx-wrap.f27-il-ctx-wrap
         [:button.f27-ctx-toggle.f27-il-ctx-toggle.f27-btn.forbid-edit
          (assoc (f27-btn on-context {:aria-expanded (if context? "true" "false")})
                 :on-mouse-down f27-inline-stop-mouse-down)
          (if context? (t :f27/context-hide) (t :f27/context-show))]
         (when context?
           (f27-row-context inner-config repo entity on-context gen))]])
     ;; The panel's own actions, repeated where a reader who has just finished
     ;; reading actually is — the same rule the context panel already follows.
     ;; Refresh belongs here most of all: the list a reader doubts is the one
     ;; they have just read to the end of.
     [:div.f27-il-end
      [:button.f27-il-refresh.f27-btn.forbid-edit
       (assoc (f27-btn on-refresh {:key "refresh-end"
                                   :aria-label (t :f27/inline-refresh-of label)
                                   :title (t :f27/inline-refresh-title)})
              :on-mouse-down f27-inline-stop-mouse-down)
       (t :f27/inline-refresh)]
      [:button.f27-il-close.f27-btn.forbid-edit
       (assoc (f27-btn on-close {:key "close-end"
                                 :aria-label (t :f27/inline-close-of label)
                                 :title (t :f27/inline-close)})
              :on-mouse-down f27-inline-stop-mouse-down)
       (t :f27/inline-close)]]]))

(rum/defcs f27-inline-ref <
  ;; Deliberately NOT `rum/static`. This component re-renders with the block it
  ;; sits in, so a target that is deleted while its panel is open is re-resolved
  ;; and the panel says so on the next render, instead of showing an entity that
  ;; no longer exists because the arguments happened to compare equal.
  ;;
  ;; `rum/local` comes FIRST, and that order is load-bearing. Rum builds its
  ;; before-render pipeline with `(collect* [:will-mount :unsafe/will-mount
  ;; :before-render] mixins)`, which walks MIXIN-major: every hook of the first
  ;; mixin, then every hook of the second. With the map first, this component's
  ;; `:before-render` ran before `rum/local`'s `:will-mount` had created the
  ;; atom, and dereferenced nil on the very first render — which threw for every
  ;; inline reference on screen. Read out of the emitted JavaScript, not guessed.
  (rum/local nil ::panel)
  {:init (fn [state _props]
           ;; One identity per MOUNTED OCCURRENCE, so two references in one
           ;; sentence never share a DOM id, and Escape in the second panel
           ;; cannot return focus to the first control.
           (assoc state ::uid (str (gensym "f27il"))))
   :before-render
   (fn [state]
     ;; A mounted instance can be REUSED for a different reference: editing the
     ;; host block's text off disk keeps the block, so React reconciles the same
     ;; position and this component survives with another target under it.
     ;;
     ;; `panel-state` already refuses to display state whose key does not match,
     ;; which is what stops one target's context appearing under another. On its
     ;; own it is not enough: the stored value survives, so retargeting
     ;; A -> B -> A found the old key matching again and a panel the reader had
     ;; never re-opened reappeared. Observed live before it was fixed.
     ;;
     ;; Forgetting it here makes the mismatch permanent, which is what
     ;; "a deliberate fresh disclosure state" means.
     (let [[config repo id _label] (:rum/args state)
           k (f27il/panel-key {:repo repo
                               :host (get-in config [:block :block/uuid])
                               :target id})
           *panel (::panel state)]
       ;; Guarded as well as ordered: a hook that assumes another mixin has
       ;; already run is exactly what broke here once.
       (when (and *panel (f27il/stale? @*panel k))
         (reset! *panel (f27il/forget-when-stale @*panel k)))
       state))}
  "One ordinary inline block reference, plus the explicit control that opens the
  TARGET's context in place.

  While the panel is closed this renders exactly what OG rendered before, plus
  one `<button>`. No entity is resolved for the panel, no ancestor is walked, no
  reference is scanned and nothing is parsed."
  [state config repo id label]
  (let [*panel (::panel state)
        uid (::uid state)
        host-uuid (get-in config [:block :block/uuid])
        k (f27il/panel-key {:repo repo :host host-uuid :target id})
        {:keys [open? context? gen]} (f27il/panel-state @*panel k)
        panel-id (str "f27-il-panel-" uid)
        btn-id (str "f27-il-toggle-" uid)
        ;; The control keeps its place in the DOM whether the panel is open or
        ;; closed, so this returns focus when it still exists — and does
        ;; nothing at all when the reference has gone.
        focus-control! (fn [] (some-> (gdom/getElement btn-id) (.focus)))
        close! (fn [] (swap! *panel f27il/close-panel k) (focus-control!))
        toggle! (fn [] (swap! *panel f27il/toggle-panel k))
        toggle-context! (fn [] (swap! *panel f27il/toggle-context k))
        ;; Refresh. It advances THIS occurrence's reading generation and does
        ;; nothing else: no navigation, no re-index, no transaction, no remount
        ;; of anything outside this panel, and no reach into another occurrence
        ;; — the atom is this instance's own and the key guards it besides. The
        ;; panel below re-renders, which re-resolves the target and re-derives
        ;; every section from the current database; the one section that was
        ;; replaying an earlier read is told to read its root level again.
        refresh! (fn [] (swap! *panel f27il/refresh-panel k))
        ;; The reference's OWN written label, when the author wrote one. Read
        ;; from the already-parsed label nodes, never from the target — naming
        ;; the target would mean reading and parsing it while closed.
        written (get-label-text label)
        named (if (string/blank? written) nil written)]
    [:span.f27-il {:class (when open? "is-open")
                   :on-key-down (fn [e]
                                  (when (and open? (f27il/escape-key? (.-key e)))
                                    (.preventDefault e)
                                    (.stopPropagation e)
                                    (close!)))}
     ;; OG's reference, with the same arguments it has always had. The one
     ;; added key suppresses the hover preview WHILE the panel is open, so a
     ;; floating preview cannot cover it; closing restores it.
     (block-reference (cond-> config open? (assoc :f27/suppress-hover? true))
                      id label)
     [:button.f27-il-toggle.f27-btn.forbid-edit
      (assoc (f27-btn toggle!
                      {:id btn-id
                       :aria-expanded (if open? "true" "false")
                       ;; Named only while the element it names exists.
                       :aria-controls (when open? panel-id)
                       :aria-label (cond
                                     (and open? named) (t :f27/inline-hide-of named)
                                     open? (t :f27/inline-hide)
                                     named (t :f27/inline-show-of named)
                                     :else (t :f27/inline-show))
                       :title (if open? (t :f27/inline-hide) (t :f27/inline-show))})
             :on-mouse-down f27-inline-stop-mouse-down)
      (if open? "⌃" "⌄")]
     (when open?
       (f27-inline-panel config repo id panel-id context? gen
                         toggle-context! refresh! close!))]))

(defn f27-inline-block-reference
  "The ordinary inline block-reference call site, with the F27 control where it
  belongs and nothing at all where it does not.

  Every excluded surface renders exactly what it rendered before: the same
  `block-reference` call, with the same arguments and no wrapper. The cheap,
  config-only decision runs first, so the resolved-block question below is asked
  only where the control might actually be offered."
  [config id label]
  (if-not (f27il/offer-control? (f27-inline-surface config id))
    (block-reference config id label)
    (let [repo (state/get-current-repo)
          entity (f27-ref-target repo id)
          surface (f27-inline-surface config id (f27-inline-special-target entity))]
      (if (f27il/offer-control? surface)
        (f27-inline-ref config repo id label)
        (block-reference config id label)))))

(rum/defcs f27-ref-overview-row < rum/static
  (rum/local false ::ctx-open?)
  [state config repo ref-block idx crystal-tag]
  (when (f27/renderable? ref-block)
    (let [{:keys [previews remainder]}
          (when crystal-tag
            (f27c/select-previews (f27-crystal-matches repo crystal-tag ref-block)))]
      [:div.f27-ref-row {:key (f27/row-key ref-block idx)}
       [:div.f27-ref-row-main
        [:span.f27-ref-bullet "›"]
        [:span.f27-ref-crumb
         ;; The F27 config, for the same reason as the inbound row above. This
         ;; is also what keeps the COMPACT OVERVIEW compact: an asset in an
         ;; ancestor's text is a small indicator here, never a picture.
         (breadcrumb (f27-breadcrumb-config config repo (:block/uuid ref-block))
                     repo (:block/uuid ref-block)
                     {:show-page? true
                      :level-limit 3
                      :indent? false
                      :end-separator? false})]]
       ;; Crystal previews for THIS referencing block and its ancestors only.
       ;; No configured tag, or no match, renders nothing at all — never an
       ;; empty placeholder row.
       (when (seq previews)
         [:div.f27-crystal-row
          (for [m previews] (rum/with-key (f27-crystal-preview m) (str (:uuid m))))
          (when (pos? remainder)
            [:span.f27-crystal-more (t :f27/crystal-more remainder)])])
       ;; Per-row ancestor context. Independent per row and per panel appearance.
       (let [*ctx (::ctx-open? state)]
         [:div.f27-ctx-wrap
          [:button.f27-ctx-toggle.f27-btn
           (f27-btn #(swap! *ctx not) {:aria-expanded (if @*ctx "true" "false")})
           (if @*ctx (t :f27/context-hide) (t :f27/context-show))]
          (when @*ctx
            ;; The incoming-reference overview has no refresh action of its
            ;; own, so its context is always its first reading: opening the row
            ;; is what reads it, and closing the row is what discards it.
            (f27-row-context config repo ref-block #(reset! *ctx false)
                             f27il/initial-generation))])])))

(rum/defc f27-ref-overview < rum/reactive
  [config repo block list-visible? *hide-block-refs? *show-ref-overview?]
  ;; (:block/_refs block) yields reverse-reference stubs ({:db/id N}), not
  ;; realised entities, so each one is resolved before a row can show its own
  ;; page and ancestor path. Resolution is a read; nothing is written.
  ;;
  ;; prepare-rows accounts for EVERY incoming entry, so the badge count, the
  ;; panel total, the visible rows and the remainder can never silently disagree.
  (let [{:keys [total rows displayed capped duplicates unavailable]}
        (f27/prepare-rows (:block/_refs block) (fn [id] (db/entity id)))
        shown rows
        ;; Subscribed, not merely read: the panel must re-render when the user
        ;; chooses or clears a marker.
        crystal-tag (get (state/sub :f27/crystal-tags) repo)]
    [:div.f27-ref-overview
     ;; Contain clicks so opening/closing the panel never reaches the block's
     ;; own content handler (which would start editing) or an ancestor handler.
     ;; stop-propagation, not stop: inner breadcrumb links must keep working.
     {:on-click (fn [e] (util/stop-propagation e))
      :on-mouse-down (fn [e] (util/stop-propagation e))}
     ;; The panel's own actions sit in the HEADING line, above the rows. A row
     ;; whose context is open can be long, and the reader must never have to
     ;; scroll past that content to find the way out of the panel. There is no
     ;; sticky element: the controls come BEFORE the body that would bury them.
     [:div.f27-ref-overview-head
      [:span.f27-ref-overview-title (t :f27/incoming-references total)]
      [:div.f27-ref-actions.is-head
       [:button.f27-ref-action.f27-btn
        (f27-btn #(swap! *hide-block-refs? not)
                 {:aria-expanded (if list-visible? "true" "false")})
        (if list-visible? (t :f27/hide-references) (t :f27/show-references total))]
       [:button.f27-ref-action.f27-btn
        (f27-btn #(reset! *show-ref-overview? false) nil)
        (t :f27/close-overview)]]]
     [:div.f27-ref-rows
      (map-indexed (fn [idx r] (f27-ref-overview-row config repo r idx crystal-tag)) shown)]
     ;; Every incoming reference that is NOT visible above is explained. A row
     ;; that cannot render is never reported as displayed.
     (when (pos? duplicates)
       [:div.f27-ref-note (t :f27/repeated-from-same-block duplicates)])
     (when (pos? unavailable)
       [:div.f27-ref-note.f27-ref-unavailable (t :f27/context-unavailable unavailable)])
     (when (pos? capped)
       [:div.f27-ref-more (t :f27/more-not-shown capped)])
     (when (and (zero? displayed) (pos? total))
       [:div.f27-ref-note (t :f27/nothing-displayable)])
     ;; Crystal scope is stated so the reader never assumes every tagged item on
     ;; the source page is included.
     (when crystal-tag
       [:div.f27-ref-note.f27-crystal-scope (t :f27/crystal-scope)])
     (f27-crystal-selector repo)
     ;; Repeated at the end, so the way out is next to the reader wherever they
     ;; finished reading. Same action, same label — not a second, different one.
     [:div.f27-ref-actions.is-end
      [:button.f27-ref-action.f27-btn
       (f27-btn #(reset! *show-ref-overview? false) nil)
       (t :f27/close-overview)]]]))

(rum/defc block-left-menu < rum/reactive
  [_config {:block/keys [uuid] :as _block}]
  [:div.block-left-menu.flex.bg-base-2.rounded-r-md.mr-1
   [:div.commands-button.w-0.rounded-r-md
    {:id (str "block-left-menu-" uuid)}
    [:div.indent (ui/icon "indent-increase" {:size 18})]]])

(rum/defc block-right-menu < rum/reactive
  [_config {:block/keys [uuid] :as _block} edit?]
  [:div.block-right-menu.flex.bg-base-2.rounded-md.ml-1
   [:div.commands-button.w-0.rounded-md
    {:id (str "block-right-menu-" uuid)
     :style {:max-width (if edit? 40 80)}}
    [:div.outdent (ui/icon "indent-decrease" {:size 18})]
    (when-not edit?
      [:div.more (ui/icon "dots-circle-horizontal" {:size 18})])]])

(rum/defcs block-content-or-editor < rum/reactive
  {:init (fn [state]
           (let [block (second (:rum/args state))
                 config (first (:rum/args state))
                 current-block-page? (= (str (:block/uuid block)) (state/get-current-page))
                 embed-self? (and (:embed? config)
                                  (= (:block/uuid block) (:block/uuid (:block config))))
                 default-hide? (if (and current-block-page? (not embed-self?) (state/auto-expand-block-refs?)) false true)]
             ;; F27 slice 1: a SECOND, instance-local atom for the compact overview.
             ;; Instance-local means repeated appearances of the same block each own
             ;; their own panel state and never control one another. The existing
             ;; auto-expand behaviour above is untouched.
             (assoc state
                    ::hide-block-refs? (atom default-hide?)
                    ::show-ref-overview? (atom false))))}
  [state config {:block/keys [uuid format] :as block} edit-input-id block-id edit? hide-block-refs-count? selected?]
  (let [*hide-block-refs? (get state ::hide-block-refs?)
        hide-block-refs? (rum/react *hide-block-refs?)
        *show-ref-overview? (get state ::show-ref-overview?)
        show-ref-overview? (rum/react *show-ref-overview?)
        editor-box (get config :editor-box)
        editor-id (str "editor-" edit-input-id)
        slide? (:slide? config)
        block-reference-only? (some->
                               (:block/content block)
                               string/trim
                               block-ref/block-ref?)]
    (if (and edit? editor-box)
      [:div.editor-wrapper
       {:id editor-id}
       (ui/catch-error
        (ui/block-error "Something wrong in the editor" {})
        (editor-box {:block block
                     :block-id uuid
                     :block-parent-id block-id
                     :format format
                     :on-hide (fn [value event]
                                (when (= event :esc)
                                  (editor-handler/save-block! (editor-handler/get-state) value)
                                  (let [select? (not (string/includes? value "```"))]
                                    (editor-handler/escape-editing select?))))}
                    edit-input-id
                    config))]
      (let [refs-count (count (:block/_refs block))]
        [:div.flex.flex-col.block-content-wrapper
         [:div.flex.flex-row
          [:div.flex-1.w-full {:style {:display (if (:slide? config) "block" "flex")}}
           (ui/catch-error
            (ui/block-error "Block Render Error:"
                            {:content (:block/content block)
                             :section-attrs
                             {:on-click #(do
                                           (editor-handler/clear-selection!)
                                           (editor-handler/unhighlight-blocks!)
                                           (state/set-editing! edit-input-id (:block/content block) block ""))}})
            (block-content config block edit-input-id block-id slide? selected?))]

          (when-not hide-block-refs-count?
            [:div.flex.flex-row.items-center
             (when (and (:embed? config)
                        (:embed-parent config))
               [:a.opacity-70.hover:opacity-100.svg-small.inline
                {:on-mouse-down (fn [e]
                                  (util/stop e)
                                  (when-let [block (:embed-parent config)]
                                    (editor-handler/edit-block! block :max (:block/uuid block))))}
                svg/edit])

             (when block-reference-only?
               [:a.opacity-70.hover:opacity-100.svg-small.inline
                {:on-mouse-down (fn [e]
                                  (util/stop e)
                                  (editor-handler/edit-block! block :max (:block/uuid block)))}
                svg/edit])

             (block-refs-count block *hide-block-refs? *show-ref-overview?)])]

         ;; F27 slice 1: compact incoming-reference overview, shown above OG's
         ;; existing full reference list. The list below is rendered by the same
         ;; component as before and is not modified by this slice.
         (when (and show-ref-overview? (> refs-count 0))
           (f27-ref-overview config (state/get-current-repo) block
                             (not hide-block-refs?)
                             *hide-block-refs? *show-ref-overview?))

         (when (and (not hide-block-refs?) (> refs-count 0))
           (let [refs-cp (state/get-component :block/linked-references)]
             (refs-cp uuid)))]))))

;; FIXME: not updating when block content is updated outbound
(rum/defcs single-block-cp-inner < rum/reactive db-mixins/query
  ;; todo: mixin for init-blocks-container-id?
  {:init (fn [state]
           (assoc state
                  ::init-blocks-container-id (atom nil)))}
  [state block-uuid]
  (let [uuid (if (string? block-uuid) (uuid block-uuid) block-uuid)
        *init-blocks-container-id (::init-blocks-container-id state)
        block-entity (db/entity [:block/uuid uuid])
        block-id (:db/id block-entity)
        block (first (model/get-paginated-blocks (state/get-current-repo) block-id))
        blocks-container-id (if @*init-blocks-container-id
                              @*init-blocks-container-id
                              (let [id' (swap! *blocks-container-id inc)]
                                (reset! *init-blocks-container-id id')
                                id'))
        block-el-id (str "ls-block-" blocks-container-id "-" uuid)
        config {:id (str uuid)
                :db/id (:db/id block-entity)
                :block/uuid uuid
                :block? true
                :editor-box (state/get-component :editor/box)}
        edit-input-id (str "edit-block-" blocks-container-id "-" uuid)
        edit? (state/sub [:editor/editing? edit-input-id])
        block (block/parse-title-and-body block)]
    (when (:block/content block)
      [:div.single-block.ls-block
       {:class (str block-uuid)
        :id (str "ls-block-" blocks-container-id "-" block-uuid)}
       (block-content-or-editor config block edit-input-id block-el-id edit? true false)])))

(rum/defc single-block-cp
  [block-uuid]
  (single-block-cp-inner block-uuid))

(defn non-dragging?
  [e]
  (and (= (gobj/get e "buttons") 1)
       (not (dom/has-class? (gobj/get e "target") "bullet-container"))
       (not (dom/has-class? (gobj/get e "target") "bullet"))
       (not @*dragging?)))

(rum/defc breadcrumb-fragment
  [config block label opts]
  [:a {:on-mouse-up
       (fn [e]
         (cond
           (gobj/get e "shiftKey")
           (do
             (util/stop e)
             (state/sidebar-add-block!
              (state/get-current-repo)
              (:db/id block)
              :block-ref))

           (util/atom? (:navigating-block opts))
           (do
             (util/stop e)
             (reset! (:navigating-block opts) (:block/uuid block)))

           (some? (:sidebar-key config))
           (do
             (util/stop e)
             (state/sidebar-replace-block!
              (:sidebar-key config)
              [(state/get-current-repo)
               (:db/id block)
               (if (:block/name block) :page :block)]))

           :else
           (route-handler/redirect-to-page! (:block/uuid block))))}
   label])

(rum/defc breadcrumb-separator
  []
  (ui/icon "chevron-right" {:style {:font-size 20}
                            :class "opacity-50 mx-1"}))

(defn breadcrumb
  "block-id - uuid of the target block of breadcrumb. page uuid is also acceptable"
  [config repo block-id {:keys [show-page? indent? end-separator? level-limit _navigating-block]
                         :or {show-page? true
                              level-limit 3}
                         :as opts}]
  (when block-id
    (let [parents (db/get-block-parents repo block-id (inc level-limit))
          page (or (db/get-block-page repo block-id) ;; only return for block uuid
                   (model/query-block-by-uuid block-id)) ;; return page entity when received page uuid
          page-name (:block/name page)
          page-original-name (:block/original-name page)
          show? (or (seq parents) show-page? page-name)
          parents (if (= page-name (:block/name (first parents)))
                    (rest parents)
                    parents)
          more? (> (count parents) level-limit)
          parents (if more? (take-last level-limit parents) parents)
          config (assoc config :breadcrumb? true)]
      (when show?
        (let [page-name-props (when show-page?
                                [page
                                 (page-cp (dissoc config :breadcrumb? true) page)
                                 {:block/name (or page-original-name page-name)}])
              parents-props (doall
                             (for [{:block/keys [uuid name content] :as block} parents]
                               (when-not name ; not page
                                 (let [{:block/keys [title body]} (block/parse-title-and-body
                                                                   uuid
                                                                   (:block/format block)
                                                                   (:block/pre-block? block)
                                                                   content)
                                       config (assoc config :block/uuid uuid)]
                                   [block
                                    (when title
                                      (if (seq title)
                                        (->elem :span.inline-wrap (map-inline config title))
                                        (->elem :div (markup-elements-cp config body))))]))))
              ;; F28: the ONLY change to OG's breadcrumb. `:more` is the marker
              ;; for ancestors this breadcrumb did not load, and a caller that
              ;; can disclose them supplies `:f28/more-control` to render in its
              ;; place. Without that key the output is byte-for-byte what it
              ;; was. The `:else` branch still serves a parent whose title is
              ;; nil, which is a DIFFERENT thing OG also draws as `⋯` and which
              ;; this feature deliberately does not claim.
              more-control (:f28/more-control config)
              breadcrumb (->> (into [] parents-props)
                              (concat [page-name-props] (when more? [:more]))
                              (filterv identity)
                              (map (fn [x] (cond
                                             (and (vector? x) (second x))
                                             (let [[block label] x]
                                               (rum/with-key (breadcrumb-fragment config block label opts) (:block/uuid block)))

                                             (and (= :more x) (fn? more-control))
                                             (more-control)

                                             :else
                                             [:span.opacity-70 "⋯"])))
                              (interpose (breadcrumb-separator)))]
          (when (seq breadcrumb)
            [:div.breadcrumb.block-parents
             {:class (when (seq breadcrumb)
                       (str (when-not (:search? config)
                              " my-2")
                            (when indent?
                              " ml-4")))}
             (when (and (false? (:top-level? config))
                        (seq parents))
               (breadcrumb-separator))
             breadcrumb
             (when end-separator? (breadcrumb-separator))]))))))

(defn- block-drag-over
  [event uuid top? block-id *move-to]
  (util/stop event)
  (when-not (dnd-same-block? uuid)
    (let [over-block (gdom/getElement block-id)
          rect (utils/getOffsetRect over-block)
          element-top (gobj/get rect "top")
          element-left (gobj/get rect "left")
          x-offset (- (.. event -pageX) element-left)
          cursor-top (gobj/get event "clientY")
          move-to-value (cond
                          (and top? (<= (js/Math.abs (- cursor-top element-top)) 16))
                          :top

                          (> x-offset 50)
                          :nested

                          :else
                          :sibling)]
      (reset! *drag-to-block block-id)
      (reset! *move-to move-to-value))))

(defn- block-drag-leave
  [*move-to]
  (reset! *move-to nil))

(defn block-drag-end
  ([_event]
   (block-drag-end _event *move-to))
  ([_event *move-to]
   (reset! *dragging? false)
   (reset! *dragging-block nil)
   (reset! *drag-to-block nil)
   (reset! *move-to nil)
   (editor-handler/unhighlight-blocks!)))

(defn- block-drop
  "Block on-drop handler"
  [^js event uuid target-block *move-to]
  (util/stop event)
  (when-not (dnd-same-block? uuid)
    (let [block-uuids (state/get-selection-block-ids)
          lookup-refs (map (fn [id] [:block/uuid id]) block-uuids)
          selected (db/pull-many (state/get-current-repo) '[*] lookup-refs)
          blocks (if (seq selected) selected [@*dragging-block])
          blocks (remove-nils blocks)]
      (if (seq blocks)
        ;; dnd block moving in current Logseq instance
        (dnd/move-blocks event blocks target-block @*move-to)
        ;; handle DataTransfer
        (let [repo (state/get-current-repo)
              data-transfer (.-dataTransfer event)
              transfer-types (set (js->clj (.-types data-transfer)))]
          (cond
            (contains? transfer-types "text/plain")
            (let [text (.getData data-transfer "text/plain")]
              (editor-handler/api-insert-new-block!
               text
               {:block-uuid  uuid
                :edit-block? false
                :sibling?    (= @*move-to :sibling)
                :before?     (= @*move-to :top)}))

            (contains? transfer-types "Files")
            (let [files (.-files data-transfer)
                  format (:block/format target-block)]
              ;; When editing, this event will be handled by editor-handler/upload-asset(editor-on-paste)
              (when (and (config/local-db? repo) (not (state/editing?)))
                ;; Basically the same logic as editor-handler/upload-asset,
                ;; does not require edting
                (-> (editor-handler/save-assets! repo (js->clj files))
                    (p/then
                     (fn [res]
                       (when-let [[asset-file-name file-obj asset-file-fpath matched-alias] (first res)]
                         (let [image? (config/ext-of-image? asset-file-name)
                               link-content (assets-handler/get-asset-file-link format
                                                                                (if matched-alias
                                                                                  (str
                                                                                   (if image? "../assets/" "")
                                                                                   "@" (:name matched-alias) "/" asset-file-name)
                                                                                  (editor-handler/resolve-relative-path (or asset-file-fpath asset-file-name)))
                                                                                (if file-obj (.-name file-obj) (if image? "image" "asset"))
                                                                                image?)]
                           (editor-handler/api-insert-new-block!
                            link-content
                            {:block-uuid  uuid
                             :edit-block? false
                             :replace-empty-target? true
                             :sibling?   true
                             :before?    false}))
                         (recur (rest res))))))))

            :else
            (prn ::unhandled-drop-data-transfer-type transfer-types))))))
  (block-drag-end event *move-to))

(defn- block-mouse-over
  [e *control-show? block-id doc-mode?]
  (when-not @*dragging?
    (util/stop e)
    (reset! *control-show? true)
    (when-let [parent (gdom/getElement block-id)]
      (let [node (.querySelector parent ".bullet-container")]
        (when doc-mode?
          (dom/remove-class! node "hide-inner-bullet"))))
    (when (and
           (state/in-selection-mode?)
           (non-dragging? e))
      (editor-handler/highlight-selection-area! block-id))))

(defn- block-mouse-leave
  [e *control-show? block-id doc-mode?]
  (util/stop e)
  (reset! *control-show? false)
  (when doc-mode?
    (when-let [parent (gdom/getElement block-id)]
      (when-let [node (.querySelector parent ".bullet-container")]
        (dom/add-class! node "hide-inner-bullet"))))
  (when (and (non-dragging? e)
             (not @*resizing-image?))
    (state/into-selection-mode!)))

(defn- on-drag-and-mouse-attrs
  [block uuid top? block-id *move-to]
  {:on-drag-over (fn [event]
                   (block-drag-over event uuid top? block-id *move-to))
   :on-drag-leave (fn [_event]
                    (block-drag-leave *move-to))
   :on-drop (fn [event]
              (block-drop event uuid block *move-to))
   :on-drag-end (fn [event]
                  (block-drag-end event *move-to))})

(defn- build-refs-data-value
  [refs]
  (let [refs (model/get-page-names-by-ids
              (->> (map :db/id refs)
                   (remove nil?)))]
    (text-util/build-data-value refs)))

(defn- get-children-refs
  [children]
  (let [refs (atom [])]
    (walk/postwalk
     (fn [m]
       (when (and (map? m) (:block/refs m))
         (swap! refs concat (:block/refs m)))
       m)
     children)
    (distinct @refs)))

(defn- root-block?
  [config block]
  (and (:block? config)
       (util/collapsed? block)
       (= (:id config)
          (str (:block/uuid block)))))

(defn- build-config [config block {:keys [navigating-block navigated?]}]
  (cond-> config
    navigated?
    (assoc :id (str navigating-block))

    true
    (update :block merge block)

    ;; Each block might have multiple queries, but we store only the first query's result.
    ;; This :query-result atom is used by the query function feature to share results between
    ;; the parent's query block and the children blocks. This works because config is shared
    ;; between parent and children blocks
    (nil? (:query-result config))
    (assoc :query-result (atom nil))

    (:ref? config)
    (block-handler/attach-order-list-state block)))

(defn- build-block [repo config block* {:keys [navigating-block navigated?]}]
  (let [block (if (or (and (:custom-query? config)
                           (empty? (:block/children block*))
                           (not (and (:dsl-query? config)
                                     (string/includes? (:query config) "not"))))
                      navigated?)
                (let [block (db/pull [:block/uuid navigating-block])
                      blocks (db/get-paginated-blocks repo (:db/id block)
                                                      {:scoped-block-id (:db/id block)})
                      tree (tree/blocks->vec-tree blocks (:block/uuid (first blocks)))]
                  (first tree))
                block*)
        {:block/keys [pre-block? format content] :as block'}
        (if (:ref? config)
          (merge block (db/sub-block (:db/id block)))
          block)]
    (merge block' (block/parse-title-and-body uuid format pre-block? content))))

;; `f28-surface` is defined here rather than beside the source-path components
;; below because BOTH features ask it, and the child-context control is
;; rendered from `block-container-inner`, which comes first.
(defn- f28-surface
  "OG's `config` mapped to the one question `frontend.util.f28-refpath` asks.

  This is the ONLY place OG's config shape is known for this feature, so every
  rule in the specification is decided by a pure function over plain booleans
  and is tested without a renderer.

  `:source-path-list?` is an explicit opt-in, set by
  `frontend.components.reference/references*`, rather than an inference from a
  pile of flags: `breadcrumb-with-container` also serves the custom-query branch
  and `block-linked-references`, and a surface must SAY that it is this one.

  `:elided?` is deliberately absent here — only `breadcrumb` knows it. The
  caller asks `surface-allows?`, which is every rule but that one."
  [config]
  {:source-path-list? (boolean (:f28/source-path? config))
   :f27-panel? (some? (:f27/ref-render config))
   :mobile? (boolean (util/mobile?))
   :preview? (boolean (:preview? config))
   :slide? (boolean (:slide? config))
   :sidebar? (boolean (:sidebar? config))
   :block-refs-list? (boolean (:f28/block-refs-list? config))
   :embed? (boolean (or (:embed? config) (:page-embed? config)))
   :query? (boolean (:custom-query? config))
   :html-export? (boolean (:html-export? config))
   :whiteboard? (boolean (or (:whiteboard? config) (:whiteboard-view? config)))})

;; ---------------------------------------------------------------------------
;; F28 child context — what is written UNDER a linked reference.
;;
;; OG's linked-references list ALREADY shows a reference's own children, and
;; shows them well. That was measured in the packaged application before this
;; was written (`f28-refpath/checks/refctx-baseline-checks.js`): right
;; hierarchy, right order, markup rendered, Korean and emoji intact, a journal
;; source, two references under one parent independent of each other. None of
;; that is touched here.
;;
;; Where it STOPS is what this adds to. `non-consecutive-blocks->vec-tree`
;; numbers a reference's own subtree from 1 and `block-default-collapsed?`
;; collapses a `:ref?` row once `:block/level` reaches
;; `ref/default-open-blocks-level` — 2 by default — after which `block-children`
;; renders nothing at all. The same run measured `:block/level` `[nil 1 2]`
;; across the whole section, 20 blocks behind 4 collapsed rows with none of them
;; drawn, those blocks ABSENT from the page rather than hidden on it, no count
;; of them anywhere, and 0 of the section's 53 fold controls able to take focus.
;;
;; This adds ONE control beneath such a row, which discloses that withheld
;; context in bounded batches, read-only, in place. Specification:
;; `project-notes/F28_CHILD_CONTEXT_SPEC.md`.
;;
;; THREE THINGS ABOUT THE SHAPE, all deliberate:
;;
;; 1. It appears ONLY where OG has stopped. `f28-refctx/withheld?` is
;;    `collapsed?` AND `has-child?` — the two values this component has already
;;    computed for its own `data-collapsed` attribute. A row OG is drawing in
;;    full costs nothing at all: no walk, no probe, no query.
;;
;; 2. The walk is `f27-children/build-plan`, unchanged, with the SAME
;;    `f27-children-fn` the F27 panels inject. No second walker, and no second
;;    rich renderer: a disclosed descendant is the plain bounded label
;;    `f28-refctx/plain-row` builds, never a rendered block.
;;
;; 3. Nothing here touches `state/toggle-collapsed-block!`. OG's own collapse is
;;    exactly as the reader left it, its fold control still does what it did,
;;    and closing this panel returns the row to precisely what OG rendered.
;; ---------------------------------------------------------------------------

(rum/defc f28-context-line < rum/static
  "One disclosed descendant: its own expansion control, then its plain text.

  A NATIVE BUTTON, not a styled anchor without an href: it must be reachable by
  Tab, activated by Enter and Space, carry a visible focus ring and report its
  own expanded state. Its accessible name says which block it opens, because
  identical names on every row tell a screen-reader user nothing.

  Every other outcome is a marker with a title rather than a dead affordance,
  and each of them is a different outcome — a failed probe is not an ordinary
  leaf, and a cycle is not a depth limit."
  [row open? on-toggle]
  (let [{:keys [entity depth descend probe]} row
        {:keys [heading marker text empty?]} (f28ctx/plain-row
                                              (f27-display-content
                                               (:block/format entity)
                                               (f27ch/node-label entity)))
        said (if empty? (t :f28/context-empty) text)]
    [:div.f28-ctx-line {:class (str "depth-" (min depth 5) (when heading " is-heading"))}
     (cond
       (= probe :error)
       [:span.f28-ctx-mark.is-stop {:title (t :f27/children-probe-error)} "?"]

       (= probe :unavailable)
       [:span.f28-ctx-mark.is-stop {:title (t :f27/children-probe-unavailable)} "!"]

       (= descend :cycle)
       [:span.f28-ctx-mark.is-stop {:title (t :f27/children-cycle)} "↻"]

       (= descend :depth)
       [:span.f28-ctx-mark.is-stop {:title (t :f27/children-depth f27ch/max-depth)} "⋯"]

       (= descend :budget)
       [:span.f28-ctx-mark.is-stop {:title (t :f27/children-budget f27ch/max-visible)} "⋯"]

       (f27ch/can-expand? row)
       (let [name' (if open? (t :f28/context-hide-of said) (t :f28/context-show-of said))]
         [:button.f28-ctx-toggle.f27-btn
          (f27-btn on-toggle {:aria-expanded (if open? "true" "false")
                              :aria-label name'
                              :title name'})
          (if open? "▾" "▸")])

       :else [:span.f28-ctx-mark "·"])
     [:span.f28-ctx-body
      (when heading [:span.f28-ctx-badge (str "H" heading)])
      (when marker [:span.f28-ctx-badge marker])
      (if empty?
        [:span.f28-ctx-text.is-empty said]
        [:span.f28-ctx-text text])]]))

(rum/defc f28-context-notes < rum/static
  "Whatever one node has to say about its own children, beneath its row.

  Order and completeness are separate claims, and a failure is never reported as
  an answer of zero — both distinctions belong to `f27-children` and are simply
  shown here."
  [info depth]
  (let [{:keys [summary remaining unordered withheld]} info]
    [:div.f28-ctx-notes {:class (str "depth-" (min (inc (or depth 0)) 5))}
     (case summary
       :error [:div.f28-ctx-note.is-error (t :f27/children-error)]
       :unavailable [:div.f28-ctx-note.is-error (t :f27/children-unavailable)]
       nil)
     (when (false? (:ordered? info))
       [:div.f28-ctx-note.is-error (t :f27/children-unordered unordered)])
     (when (and (= summary :partial) (pos? (or remaining 0)))
       [:div.f28-ctx-note (t :f27/children-remaining remaining)])
     (when (pos? (or withheld 0))
       [:div.f28-ctx-note.is-capped (t :f27/children-withheld withheld f27ch/max-visible)])]))

(rum/defc f28-context-panel
  "The context this list is not drawing, disclosed under the row it belongs to.

  The heading SAYS what these are, because three things are easy to confuse in a
  reference list: this block's own children, the blocks that reference it, and
  the children of the page whose list this is. Only the first is here.

  Not `rum/static`: `build-plan` runs in this render body, so the panel must
  re-render whenever its row does — see limit M4, which says exactly what that
  makes the disclosure and what it does not."
  [repo uuid' panel-id desc on-change on-hide]
  (let [plan (f27ch/build-plan (f27-children-fn repo) uuid' desc)
        {:keys [rows root status total shown remaining continue? capped? behind]}
        (f28ctx/disclosure plan)
        boundaries (f27ch/branch-continuations plan)
        row-at (fn [path] (first (filter #(= path (:path %)) rows)))
        toggle-path! (fn [path]
                       (on-change (update desc :open
                                          (fn [o] (let [o (or o #{})]
                                                    (if (contains? o path)
                                                      (disj o path)
                                                      (conj o path)))))))
        show-more! (fn [path]
                     (on-change (update desc :limits
                                        (fn [m] (assoc m path
                                                       (f27ch/continue-limit
                                                        (get m path f27ch/default-batch)))))))
        more-button (fn [path label nested? depth]
                      [:button.f28-ctx-more.f27-btn
                       (f27-btn #(show-more! path)
                                {:class (when nested? (str "is-nested depth-" (min depth 5)))
                                 :aria-label label})
                       label])]
    [:div.f28-ctx-panel {:id panel-id
                         :role "group"
                         :aria-label (t :f28/context-panel-label)}
     [:div.f28-ctx-head (t :f28/context-of-this-block)]
     (if (#{:error :unavailable} status)
       ;; A read that failed is not an empty outline, and it is never dressed as
       ;; one. There is no retry here: this panel re-walks whenever its row
       ;; redraws, so the honest thing to offer is the explanation, not a button
       ;; that repeats what the next render does anyway.
       [:div.f28-ctx-note.is-error
        (if (= status :error) (t :f27/children-error) (t :f27/children-unavailable))]
       [:<>
        (map-indexed
         (fn [i row]
           (let [path (:path row)]
             [:div.f28-ctx-item {:key (f28ctx/row-key row)}
              (f28-context-line row (:open? row) (fn [] (toggle-path! path)))
              ;; Every branch that CLOSES here, innermost first: what a node has
              ;; to say about its own children and the control that acts on it
              ;; belong at the END of that node's branch, beside the children
              ;; they describe.
              (for [bpath (get boundaries i)
                    :let [binfo (get-in plan [:info bpath])
                          brow (row-at bpath)]
                    :when (and binfo brow)]
                [:div.f28-ctx-branch-end
                 {:key (str "b-" (string/join ">" (map str bpath)))}
                 (f28-context-notes binfo (:depth brow))
                 (when (f27ch/can-continue? binfo plan)
                   (more-button bpath (t :f28/context-more) true (inc (:depth brow))))])]))
         rows)
        (f28-context-notes root 0)
        (when continue? (more-button [] (t :f28/context-more) false 0))
        (when capped?
          [:div.f28-ctx-note.is-capped (t :f27/children-budget f27ch/max-visible)])
        (when (pos? (or behind 0))
          [:div.f28-ctx-note.is-capped
           (t :f27/children-budget-behind behind f27ch/max-visible)])])
     [:div.f28-ctx-status
      (case status
        :none (t :f28/context-none)
        :ok (t :f28/context-complete shown)
        :partial (t :f28/context-partial shown total remaining)
        nil)]
     [:div.f28-ctx-actions
      [:button.f28-ctx-hide.f27-btn
       (f27-btn on-hide {:aria-label (t :f28/context-hide)
                         :aria-expanded "true"})
       (t :f28/context-hide)]]]))

(rum/defcs f28-child-context <
  ;; `rum/local` FIRST, then the map — the same order `f27-inline-ref` records
  ;; the reason for: Rum collects before-render hooks mixin-major, so a map
  ;; placed first can run against state `rum/local`'s own hook has not built.
  (rum/local nil ::desc)
  {:init (fn [state _props]
           ;; ONE identity per MOUNTED OCCURRENCE. The same block can be drawn
           ;; TWICE in one linked-references list — once as its own result and
           ;; once as context under its parent — and `state/sub-collapsed` is
           ;; keyed by block uuid alone, so when such a block is collapsed both
           ;; appearances are collapsed and both offer this control. Deriving
           ;; the DOM id from the list and the block alone gave them the SAME
           ;; id: `gdom/getElement` could hand a collapse the other
           ;; appearance's control, and `aria-controls` named a panel
           ;; ambiguously.
           ;;
           ;; Created in `:init`, so it is made once when this instance mounts
           ;; and is the same string for every later render. Generating it in
           ;; the render body would produce a new id each time and break both
           ;; `aria-controls` and focus return, which is the defect rather than
           ;; the fix.
           (assoc state ::uid (str (gensym "f28ctx"))))}
  "The control that discloses what a collapsed linked-reference row is holding
  back, and the panel it opens.

  `::desc` is BOTH the open flag and the expansion state: nil means closed and
  nothing has been walked; a map means open. One atom per row instance, so two
  rows of one group are independent without either knowing the other exists, and
  nothing is remembered across navigation.

  `::uid` is this occurrence's identity, and every DOM id below is built from
  it, so two appearances of ONE block in one list stay two separate controls
  over two separate panels.

  A CLOSED control renders no panel, so `build-plan` is never called for it. Its
  existence was decided by the caller from `collapsed?` and `has-child?`, both
  of which the caller had already computed for its own rendering."
  [state config block]
  (let [*desc (::desc state)
        desc @*desc
        repo (state/get-current-repo)
        uuid' (:block/uuid block)
        panel-id (f28ctx/panel-id (:id config) uuid' (::uid state))
        toggle-id (f28ctx/toggle-id panel-id)
        label (f28ctx/plain-row (f27-display-content (:block/format block)
                                                     (:block/content block)))
        named (if (:empty? label) (t :f28/context-empty) (:text label))
        ;; Collapsing from INSIDE the panel destroys the element that had focus,
        ;; so focus is returned to THIS OCCURRENCE's own control — the id is
        ;; derived from this occurrence's panel id, which carries `::uid`, so
        ;; two open panels cannot move each other's focus even when they are two
        ;; appearances of the SAME block in the same list.
        ;; Asserted twice: once synchronously, and once after the re-render, in
        ;; case React replaced the control's node with the panel beside it.
        focus-toggle! (fn []
                        (some-> (gdom/getElement toggle-id) (.focus))
                        (js/setTimeout
                         (fn []
                           (when-let [el (gdom/getElement toggle-id)]
                             (when-not (identical? el (.-activeElement js/document))
                               (.focus el))))
                         0))]
    [:div.f28-ctx
     [:button.f28-ctx-open.f27-btn
      (f27-btn (fn [] (if desc (do (reset! *desc nil) (focus-toggle!))
                          (reset! *desc {:open #{} :limits {}})))
               {:id toggle-id
                :aria-expanded (if desc "true" "false")
                :aria-controls panel-id
                :aria-label (if desc (t :f28/context-hide-of named)
                                (t :f28/context-show-of named))
                :title (if desc (t :f28/context-hide) (t :f28/context-show))})
      (t :f28/context-show)]
     (when desc
       (f28-context-panel repo uuid' panel-id desc
                          (fn [d] (reset! *desc d))
                          (fn [] (reset! *desc nil) (focus-toggle!))))]))

(rum/defc ^:large-vars/cleanup-todo block-container-inner < rum/reactive db-mixins/query
  [state repo config* block*]
  (let [ref? (:ref? config*)
        custom-query? (boolean (:custom-query? config*))
        ref-or-custom-query? (or ref? custom-query?)
        *navigating-block (get state ::navigating-block)
        navigating-block (rum/react *navigating-block)
        navigated? (and (not= (:block/uuid block*) navigating-block) navigating-block)
        block (build-block repo config* block* {:navigating-block navigating-block :navigated? navigated?})
        {:block/keys [uuid children pre-block? refs level content properties]} block
        {:block.temp/keys [top?]} block
        config (build-config config* block {:navigated? navigated? :navigating-block navigating-block})
        blocks-container-id (:blocks-container-id config)
        heading? (:heading properties)
        *control-show? (get state ::control-show?)
        db-collapsed? (util/collapsed? block)
        collapsed? (cond
                     (or ref-or-custom-query? (root-block? config block))
                     (state/sub-collapsed uuid)

                     :else
                     db-collapsed?)
        breadcrumb-show? (:breadcrumb-show? config)
        *show-left-menu? (::show-block-left-menu? state)
        *show-right-menu? (::show-block-right-menu? state)
        slide? (boolean (:slide? config))
        doc-mode? (:document/mode? config)
        embed? (:embed? config)
        page-embed? (:page-embed? config)
        reference? (:reference? config)
        whiteboard-block? (gp-whiteboard/shape-block? block)
        block-id (str "ls-block-" blocks-container-id "-" uuid)
        has-child? (first (:block/_parent (db/entity (:db/id block))))
        attrs (on-drag-and-mouse-attrs block uuid top? block-id *move-to)
        children-refs (get-children-refs children)
        data-refs (build-refs-data-value children-refs)
        data-refs-self (build-refs-data-value refs)
        edit-input-id (str "edit-block-" blocks-container-id "-" uuid)
        edit? (state/sub [:editor/editing? edit-input-id])
        card? (string/includes? data-refs-self "\"card\"")
        review-cards? (:review-cards? config)
        own-number-list? (:own-order-number-list? config)
        order-list? (boolean own-number-list?)
        selected? (when-not slide?
                    (state/sub-block-selected? blocks-container-id uuid))]
    [:div.ls-block
     (cond->
      {:id block-id
       :data-refs data-refs
       :data-refs-self data-refs-self
       :data-collapsed (and collapsed? has-child?)
       :class (str uuid
                   (when pre-block? " pre-block")
                   (when (and card? (not review-cards?)) " shadow-md")
                   (when selected? " selected")
                   (when order-list? " is-order-list")
                   (when (string/blank? content) " is-blank"))
       :blockid (str uuid)
       :haschild (str (boolean has-child?))}

      level
      (assoc :level level)

      (not slide?)
      (merge attrs)

      (or reference? (and embed? (not page-embed?)))
      (assoc :data-transclude true)

      embed?
      (assoc :data-embed true)

      custom-query?
      (assoc :data-query true))

     (when (and ref? breadcrumb-show?)
       (breadcrumb config repo uuid {:show-page? false
                                     :indent? true
                                     :navigating-block *navigating-block}))

     ;; only render this for the first block in each container
     (when top?
       (dnd-separator-wrapper block block-id slide? true false))

     [:div.block-main-container.flex.flex-row.pr-2
      {:class (if (and heading? (seq (:block/title block))) "items-baseline" "")
       :on-touch-start (fn [event uuid] (block-handler/on-touch-start event uuid))
       :on-touch-move (fn [event]
                        (block-handler/on-touch-move event block uuid edit? *show-left-menu? *show-right-menu?))
       :on-touch-end (fn [event]
                       (block-handler/on-touch-end event block uuid *show-left-menu? *show-right-menu?))
       :on-touch-cancel (fn [_e]
                          (block-handler/on-touch-cancel *show-left-menu? *show-right-menu?))
       :on-mouse-over (fn [e]
                        (block-mouse-over e *control-show? block-id doc-mode?))
       :on-mouse-leave (fn [e]
                         (block-mouse-leave e *control-show? block-id doc-mode?))}
      (when (not slide?)
        (block-control config block uuid block-id collapsed? *control-show? edit? selected?))

      (when @*show-left-menu?
        (block-left-menu config block))

      (if whiteboard-block?
        (block-reference {} (str uuid) nil)
        ;; Not embed self
        (let [hide-block-refs-count? (and (:embed? config)
                                          (= (:block/uuid block) (:embed-id config)))]
          (block-content-or-editor config block edit-input-id block-id edit? hide-block-refs-count? selected?)))

      (when @*show-right-menu?
        (block-right-menu config block edit?))]

     (block-children config block children collapsed?)

     ;; F28: what this list is holding back under THIS row. Rendered only
     ;; where OG has collapsed the row and it has children — the same two
     ;; values `data-collapsed` above is built from — so a row OG is drawing
     ;; in full is untouched, and so is every surface but this list.
     (when (f28ctx/offer-control?
            (assoc (f28-surface config)
                   :context-list? (boolean (:f28/source-path? config))
                   :withheld? (f28ctx/withheld? {:collapsed? collapsed?
                                                 :has-children? (some? has-child?)})))
       (f28-child-context config block))

     (dnd-separator-wrapper block block-id slide? false false)]))

(defn- attach-order-list-state!
  [cp-state]
  (let [args (:rum/args cp-state)]
    (assoc cp-state
      :rum/args (assoc (vec args) 0 (block-handler/attach-order-list-state (first args) (second args))))))

(rum/defcs block-container < rum/reactive
  (rum/local false ::show-block-left-menu?)
  (rum/local false ::show-block-right-menu?)
  {:init (fn [state]
           (let [[config block] (:rum/args state)
                 block-id (:block/uuid block)]
             (cond
               (root-block? config block)
               (state/set-collapsed-block! block-id false)

               (or (:ref? config) (:custom-query? config))
               (state/set-collapsed-block! block-id
                                           (boolean (editor-handler/block-default-collapsed? block config)))

               :else
               nil)
             (-> (assoc state
                   ::control-show? (atom false)
                   ::navigating-block (atom (:block/uuid block)))
                 (attach-order-list-state!))))

   :will-remount (fn [_old-state new-state]
                   (-> new-state
                       (attach-order-list-state!)))

   :should-update (fn [old-state new-state]
                    (let [compare-keys        [:block/uuid :block/content :block/parent :block/collapsed?
                                               :block/properties :block/left :block/children :block/_refs :block.temp/bottom? :block.temp/top?]
                          config-compare-keys [:show-cloze? :own-order-list-type :own-order-list-index]
                          b1                  (second (:rum/args old-state))
                          b2                  (second (:rum/args new-state))
                          result              (or
                                                (not= (select-keys b1 compare-keys)
                                                      (select-keys b2 compare-keys))
                                                (not= (select-keys (first (:rum/args old-state)) config-compare-keys)
                                                      (select-keys (first (:rum/args new-state)) config-compare-keys)))]
                      (boolean result)))
   :will-unmount (fn [state]
                   ;; restore root block's collapsed state
                   (let [[config block] (:rum/args state)
                         block-id (:block/uuid block)]
                     (when (root-block? config block)
                       (state/set-collapsed-block! block-id nil)))
                   state)}
  [state config block]
  (let [repo          (state/get-current-repo)
        ref?          (:ref? config)
        custom-query? (boolean (:custom-query? config))]
    (if (and (or ref? custom-query?) (not (:ref-query-child? config)))
      (ui/lazy-visible
       (fn [] (block-container-inner state repo config block))
       {:debug-id (str "block-container-ref " (:db/id block))})
      (block-container-inner state repo config block))))

(defn divide-lists
  [[f & l]]
  (loop [l        l
         ordered? (:ordered f)
         result   [[f]]]
    (if (seq l)
      (let [cur          (first l)
            cur-ordered? (:ordered cur)]
        (if (= ordered? cur-ordered?)
          (recur
           (rest l)
           cur-ordered?
           (update result (dec (count result)) conj cur))
          (recur
           (rest l)
           cur-ordered?
           (conj result [cur]))))
      result)))

(defn list-element
  [l]
  (match l
    [l1 & _tl]
    (let [{:keys [ordered name]} l1]
      (cond
        (seq name)
        :dl
        ordered
        :ol
        :else
        :ul))

    :else
    :ul))

(defn list-item
  [config {:keys [name content checkbox items number] :as _list}]
  (let [content (when-not (empty? content)
                  (match content
                    [["Paragraph" i] & rest]
                    (vec-cat
                     (map-inline config i)
                     (markup-elements-cp config rest))
                    :else
                    (markup-elements-cp config content)))
        checked? (some? checkbox)
        items (when (seq items)
                (->elem
                 (list-element items)
                 (for [item items]
                   (list-item config item))))]
    (cond
      (seq name)
      [:dl {:checked checked?}
       [:dt (map-inline config name)]
       (->elem :dd
               (vec-cat content [items]))]

      :else
      (if (nil? checkbox)
        (->elem
         :li
         (cond->
          {:checked checked?}
          number
          (assoc :value number))
         (vec-cat
          [(->elem
            :p
            content)]
          [items]))
        (->elem
         :li
         {:checked checked?}
         (vec-cat
          [(->elem
            :p
            (list-checkbox config checkbox)
            content)]
          [items]))))))

(defn table
  [config {:keys [header groups col_groups]}]
  (case (get-shui-component-version :table config)
    2 (shui/table-v2 {:data (concat [[header]] groups)}
                     (make-shui-context config inline))
    1 (let [tr (fn [elm cols]
                 (->elem
                  :tr
                  (mapv (fn [col]
                          (->elem
                           elm
                           {:scope "col"
                            :class "org-left"}
                           (map-inline config col)))
                        cols)))
            tb-col-groups (try
                            (mapv (fn [number]
                                    (let [col-elem [:col {:class "org-left"}]]
                                      (->elem
                                       :colgroup
                                       (repeat number col-elem))))
                                  col_groups)
                            (catch :default _e
                              []))
            head (when header
                   [:thead (tr :th header)])
            groups (mapv (fn [group]
                           (->elem
                            :tbody
                            (mapv #(tr :td %) group)))
                         groups)]
        [:div.table-wrapper
         (->elem
          :table
          {:class "table-auto"
           :border 2
           :cell-spacing 0
           :cell-padding 6
           :rules "groups"
           :frame "hsides"}
          (vec-cat
           tb-col-groups
           (cons head groups)))])))

(defn logbook-cp
  [log]
  (let [clocks (filter #(string/starts-with? % "CLOCK:") log)
        clocks (reverse (sort-by str clocks))]
        ;; TODO: display states change log
        ; states (filter #(not (string/starts-with? % "CLOCK:")) log)

    (when (seq clocks)
      (let [tr (fn [elm cols] (->elem :tr
                                      (mapv (fn [col] (->elem elm col)) cols)))
            head  [:thead.overflow-x-scroll (tr :th.py-0 ["Type" "Start" "End" "Span"])]
            clock-tbody (->elem
                         :tbody.overflow-scroll.sm:overflow-auto
                         (mapv (fn [clock]
                                 (let [cols (->> (string/split clock #": |--|=>")
                                                 (map string/trim))]
                                   (mapv #(tr :td.py-0 %) [cols])))
                               clocks))]
        [:div.overflow-x-scroll.sm:overflow-auto
         (->elem
          :table.m-0
          {:class "logbook-table"
           :border 0
           :style {:width "max-content"}
           :cell-spacing 15}
          (cons head [clock-tbody]))]))))

(defn map-inline
  [config col]
  (map #(inline config %) col))

(declare ->hiccup)

(rum/defc src-cp < rum/static
  [config options html-export?]
  (when options
    (let [{:keys [lines language]} options
          attr (when language
                 {:data-lang language})
          code (apply str lines)
          [inside-portal? set-inside-portal?] (rum/use-state nil)]
      (cond
        html-export?
        (highlight/html-export attr code)

        :else
        (let [language (if (contains? #{"edn" "clj" "cljc" "cljs" "clojurescript"} language) "clojure" language)]
          [:div.ui-fenced-code-editor
           {:ref (fn [el]
                   (set-inside-portal? (and el (whiteboard-handler/inside-portal? el))))}
           (cond
             (nil? inside-portal?) nil

             (or (:slide? config) inside-portal?)
             (highlight/highlight (str (random-uuid))
                                  {:class     (str "language-" language)
                                   :data-lang language}
                                  code)

             :else
             [:<>
              (lazy-editor/editor config (str (d/squuid)) attr code options)
              (let [options (:options options) block (:block config)]
                (when (and (= language "clojure") (contains? (set options) ":results"))
                  (sci/eval-result code block)))])])))))

(defn ^:large-vars/cleanup-todo markup-element-cp
  [{:keys [html-export?] :as config} item]
  (try
    (match item
      ["Drawer" name lines]
      (when (or (not= name "logbook")
                (and
                 (= name "logbook")
                 (state/enable-timetracking?)
                 (or  (get-in (state/get-config) [:logbook/settings :enabled-in-all-blocks])
                      (when (get-in (state/get-config)
                                    [:logbook/settings :enabled-in-timestamped-blocks] true)
                        (or (:block/scheduled (:block config))
                            (:block/deadline (:block config)))))))
        [:div
         [:div.text-sm
          [:div.drawer {:data-drawer-name name}
           (ui/foldable
            [:div.opacity-50.font-medium.logbook
             (util/format ":%s:" (string/upper-case name))]
            [:div.opacity-50.font-medium
             (if (= name "logbook")
               (logbook-cp lines)
               (apply str lines))
             [:div ":END:"]]
            {:default-collapsed? true
             :title-trigger? true})]]])

      ;; for file-level property in orgmode: #+key: value
      ;; only display caption. https://orgmode.org/manual/Captions.html.
      ["Directive" key value]
      [:div.file-level-property
       (when (contains? #{"caption"} (string/lower-case key))
         [:span.font-medium
          [:span.font-bold (string/upper-case key)]
          (str ": " value)])]

      ["Paragraph" l]
      ;; TODO: speedup
      (if (util/safe-re-find #"\"Export_Snippet\" \"embed\"" (str l))
        (->elem :div (map-inline config l))
        (->elem :div.is-paragraph (map-inline config l)))

      ["Horizontal_Rule"]
      (when-not (:slide? config)
        [:hr])
      ["Heading" h]
      (block-container config h)
      ["List" l]
      (let [lists (divide-lists l)]
        (if (= 1 (count lists))
          (let [l (first lists)]
            (->elem
             (list-element l)
             (map #(list-item config %) l)))
          [:div.list-group
           (for [l lists]
             (->elem
              (list-element l)
              (map #(list-item config %) l)))]))
      ["Table" t]
      (table config t)
      ["Math" s]
      (if html-export?
        (latex/html-export s true true)
        (latex/latex (str (d/squuid)) s true true))
      ["Example" l]
      [:pre.pre-wrap-white-space
       (join-lines l)]
      ["Quote" l]
      (->elem
       :blockquote
       (markup-elements-cp config l))
      ["Raw_Html" content]
      (when (not html-export?)
        [:div.raw_html {:dangerouslySetInnerHTML
                        {:__html (security/sanitize-html content)}}])
      ["Export" "html" _options content]
      (when (not html-export?)
        [:div.export_html {:dangerouslySetInnerHTML
                           {:__html (security/sanitize-html content)}}])
      ["Hiccup" content]
      (ui/catch-error
       [:div.warning {:title "Invalid hiccup"}
        content]
       [:div.hiccup_html {:dangerouslySetInnerHTML
                          {:__html (hiccup->html content)}}])

      ["Export" "latex" _options content]
      (if html-export?
        (latex/html-export content true false)
        (latex/latex (str (d/squuid)) content true false))

      ["Custom" "query" _options _result content]
      (try
        (let [query (reader/read-string content)]
          (query/custom-query (wrap-query-components config) query))
        (catch :default e
          (log/error :read-string-error e)
          (ui/block-error "Invalid query:" {:content content})))

      ["Custom" "note" _options result _content]
      (ui/admonition "note" (markup-elements-cp config result))

      ["Custom" "tip" _options result _content]
      (ui/admonition "tip" (markup-elements-cp config result))

      ["Custom" "important" _options result _content]
      (ui/admonition "important" (markup-elements-cp config result))

      ["Custom" "caution" _options result _content]
      (ui/admonition "caution" (markup-elements-cp config result))

      ["Custom" "warning" _options result _content]
      (ui/admonition "warning" (markup-elements-cp config result))

      ["Custom" "pinned" _options result _content]
      (ui/admonition "pinned" (markup-elements-cp config result))

      ["Custom" "center" _options l _content]
      (->elem
       :div.text-center
       (markup-elements-cp config l))

      ["Custom" name _options l _content]
      (->elem
       :div
       {:class name}
       (markup-elements-cp config l))

      ["Latex_Fragment" l]
      [:p.latex-fragment
       (inline config ["Latex_Fragment" l])]

      ["Latex_Environment" name option content]
      (let [content (latex-environment-content name option content)]
        (if html-export?
          (latex/html-export content true true)
          (latex/latex (str (d/squuid)) content true true)))

      ["Displayed_Math" content]
      (if html-export?
        (latex/html-export content true true)
        (latex/latex (str (d/squuid)) content true true))

      ["Footnote_Definition" name definition]
      (let [id (util/url-encode name)]
        [:div.footdef
         [:div.footpara
          (conj
           (markup-element-cp config ["Paragraph" definition])
           [:a.ml-1 {:id (str "fn." id)
                     :style {:font-size 14}
                     :class "footnum"
                     :on-click #(route-handler/jump-to-anchor! (str "fnr." id))}
            [:sup.fn (str name "↩︎")]])]])

      ["Src" options]
      (let [lang (util/safe-lower-case (:language options))]
        [:div.cp__fenced-code-block
         {:data-lang lang}
         (if-let [opts (plugin-handler/hook-fenced-code-by-type lang)]
           [:div.ui-fenced-code-wrap
            (src-cp config options html-export?)
            (plugins/hook-ui-fenced-code (:block config) (string/join "" (:lines options)) opts)]
           (src-cp config options html-export?))])

      :else
      "")
    (catch :default e
      (println "Convert to html failed, error: " e)
      "")))

(defn markup-elements-cp
  [config col]
  (map #(markup-element-cp config %) col))

(defn- block-item
  [config blocks idx item]
  (let [item (->
              (dissoc item :block/meta)
              (assoc :block.temp/top? (zero? idx)
                     :block.temp/bottom? (= (count blocks) (inc idx))))
        config (assoc config :block/uuid (:block/uuid item))]
    (rum/with-key (block-container config item)
      (str (:blocks-container-id config) "-" (:block/uuid item)))))

(defn- block-list
  [config blocks]
  (for [[idx item] (medley/indexed blocks)]
    (block-item config blocks idx item)))

(defn- custom-query-or-ref?
  [config]
  (let [ref? (:ref? config)
        custom-query? (:custom-query? config)]
    (or custom-query? ref?)))

(defn- load-more-blocks!
  [config flat-blocks]
  (when-let [db-id (:db/id config)]
    (let [last-block-id (:db/id (last flat-blocks))]
      (block-handler/load-more! db-id last-block-id))))

(defn- loading-more-data!
  [config *loading? flat-blocks initial?]
  ;; To prevent scrolling after inserting new blocks
  (when (or initial?
            (and (not initial?) (> (- (util/time-ms) (:start-time config)) 100)))
    (reset! *loading? true)
    (load-more-blocks! config flat-blocks)
    (reset! *loading? false)))

(rum/defcs lazy-blocks < rum/reactive
  (rum/local nil ::loading?)
  {:init (fn [state]
           (assoc state ::id (str (random-uuid))))
   :did-mount (fn [state]
                (let [[config _ flat-blocks] (:rum/args state)]
                  (loading-more-data! config (::loading? state) flat-blocks true))
                state)}
  [state config blocks flat-blocks]
  (let [db-id (:db/id config)
        *loading? (::loading? state)]
    (if-not db-id
      (block-list config blocks)
      (let [has-more? (and
                       (>= (count flat-blocks) model/initial-blocks-length)
                       (some? (model/get-next-open-block (db/get-db) (last flat-blocks) db-id)))
            dom-id (str "lazy-blocks-" (::id state))]
        [:div {:id dom-id}
         (ui/infinite-list
          "main-content-container"
          (block-list config blocks)
          {:on-load #(loading-more-data! config *loading? flat-blocks false)
           :bottom-reached (fn []
                             (when-let [node (gdom/getElement dom-id)]
                               (ui/bottom-reached? node 300)))
           :has-more has-more?
           :more (cond
                   (or (:preview? config) (:sidebar? config))
                   "More"

                   @*loading?
                   (ui/lazy-loading-placeholder 88)

                   :else
                   "")})]))))

(rum/defcs blocks-container <
  {:init (fn [state] (assoc state ::init-blocks-container-id (atom nil)))}
  [state blocks config]
  (let [*init-blocks-container-id (::init-blocks-container-id state)
        blocks-container-id (if @*init-blocks-container-id
                              @*init-blocks-container-id
                              (let [id' (swap! *blocks-container-id inc)]
                                (reset! *init-blocks-container-id id')
                                id'))
        config (assoc config :blocks-container-id blocks-container-id)
        doc-mode? (:document/mode? config)]
    (when (seq blocks)
      (let [flat-blocks (vec blocks)
            query-or-ref? (custom-query-or-ref? config)
            id (if (:navigated? config) @(:navigating-block config) (:id config))
            blocks' (if (or (and query-or-ref? (:navigated? config))
                            (not query-or-ref?))
                      (tree/blocks->vec-tree flat-blocks id)
                      flat-blocks)
            config (assoc config :start-time (util/time-ms))]
        [:div.blocks-container.flex-1
         {:class (when doc-mode? "document-mode")}
         (lazy-blocks config blocks' flat-blocks)]))))

;; ---------------------------------------------------------------------------
;; F28 first slice — the SOURCE PATH of a linked reference.
;;
;; OG groups a page's linked references by source page and then by the
;; referencing block's parent, and draws one breadcrumb per group with
;; `:level-limit 3`. `breadcrumb` reads `level-limit + 1` ancestors, shows the
;; nearest three and emits a bare `⋯` for the rest — measured in the packaged
;; application: no role, no tabindex, no title, no label, nothing happens when it
;; is pressed, nothing in the whole section can take focus, and the elided
;; ancestors are ABSENT from the page rather than hidden on it.
;;
;; This adds ONE control in that marker's place, which discloses those ancestors
;; in bounded batches, read-only, in place. Specification:
;; `project-notes/F28_SOURCE_PATH_SPEC.md`.
;;
;; TWO THINGS ABOUT THE SHAPE, both deliberate:
;;
;; 1. The control is handed to `breadcrumb` as `:f28/more-control` and is
;;    invoked ONLY at the `:more` marker. So a reference whose whole path OG
;;    already shows costs nothing at all — no walk, no query, no probe — and
;;    `breadcrumb`'s output is unchanged wherever the key is absent.
;;
;; 2. Nothing has to be signalled back out of `breadcrumb`. The panel renders
;;    only when the press count is set, and the press count can only be set by
;;    the button, which exists only where the marker was drawn. A path with
;;    nothing elided therefore renders neither the control nor the panel,
;;    without the wrapper asking a second time how deep the path is.
;; ---------------------------------------------------------------------------

(defn- f28-panel-id
  "A DOM id for one group's panel, stable across renders and unique on the page.

  The group is identified by the list it belongs to and the block its breadcrumb
  is drawn for; two lists on one page therefore cannot collide."
  [config block-id]
  (str "f28-path-"
       (string/replace (str (:id config) "-" block-id) #"[^A-Za-z0-9_-]" "_")))

(rum/defc f28-refusal-line
  "Why a step could not be opened, in one sentence.

  One component for BOTH places it can appear — against the row that refused,
  and, when a redraw has taken that row away, for the panel — so the reader is
  told the same thing either way and the two cannot drift apart.

  `cond`, not `case`, for the reason the panel's status line gives: a `case`
  clause whose result is a literal nil is compiled away inside a hiccup body."
  [reason]
  [:div.f28-path-gone
   [:span.f28-path-mark "⚠"] " "
   (cond
     (= reason :missing) (t :f28/path-step-gone)
     (= reason :unreadable) (t :f28/path-step-unreadable)
     (= reason :mismatch) (t :f28/path-step-changed)
     (= reason :placeholder) (t :f28/path-step-placeholder)
     :else (t :f28/path-step-not-openable))])

(rum/defc f28-path-step
  "One disclosed ancestor: PLAIN TEXT, and — new in this batch — a way to go there.

  Deliberately NOT rendered through OG's inline renderer. A source path answers
  where a reference sits, and rendering ancestor content on a new surface is
  exactly the defect the F27 boundary corrections found in F27's own breadcrumb:
  an asset, a macro or a fragment of HTML written in a PARENT block reached the
  screen through it. A step is therefore a bounded, grapheme-safe label with
  reference markup reduced to what a person reads first, and a heading level or
  task marker shown as structure instead of echoed as `##` or `TODO`.

  MAKING IT ACTIONABLE CHANGES THE ELEMENT, NOT THE LABEL. The same characters
  the inert step showed are wrapped in a native `<button>`; nothing is parsed
  again, no macro runs, no reference is followed and no file is requested. If
  this ever grows a renderer, the L1 boundary this feature was built around is
  gone, so the packaged run keeps measuring a panel with no image, no media, no
  macro container, no reference element and no anchor in it.

  `n` is the level's position counted from the source page, or nil when the walk
  has not reached the page and no position can honestly be claimed. `on-open` is
  nil for a step with no stable identity, which is then drawn exactly as it was
  before: a label, not a control that would refuse when it was pressed."
  [e n on-open refusal]
  (let [;; `:block/content` is the RAW FILE TEXT, so a block carrying a
        ;; persisted `id::` carries that line with it — and every ancestor of a
        ;; referable block is liable to have one. The first run of the packaged
        ;; scenario showed `L1 · 최상위 조상 — the outermost level id::
        ;; 65f28a00-…` as a path step. Stripped through the SAME function
        ;; `block-content` and the F27 panels use, so the step and the block
        ;; agree on what the block says. The block on disk is untouched.
        content (f27-display-content (or (:block/format e) :markdown)
                                     (f27ctx/block-label e))
        {:keys [heading marker text]} (f28/step-prefix content)
        label (f27c/preview-label (or text content) f28/max-step-chars)
        said (if (string/blank? label) (t :f28/path-step-empty) label)
        body [(when n [:span.f28-path-level {:aria-hidden "true"} (str n ".")])
              (when heading [:span.f28-path-badge (str "H" heading)])
              (when marker [:span.f28-path-badge marker])
              (if (string/blank? label)
                [:span.f28-path-text.f28-path-empty said]
                [:span.f28-path-text label])]]
    [:li.f28-path-step
     (if on-open
       (into [:button.f28-path-step-open.f27-btn
              (f27-btn on-open {:aria-label (t :f28/path-open-step said)
                                :title (t :f28/path-open-step said)})]
             body)
       (into [:span.f28-path-step-inert] body))
     ;; The refusal is shown HERE, against the step that refused, rather than as
     ;; one line for the whole panel: a path of four identical rows would
     ;; otherwise say "one of these is gone" and leave the reader to guess which.
     (when refusal (f28-refusal-line refusal))]))

(rum/defc f28-source-path-panel
  "The part of one reference's ancestor path that OG's breadcrumb did not show.

  Walks upward with `frontend.util.f27-context/load-ancestors`, which already
  owns the three properties this needs: bounded batches with explicit
  continuation, a visited-identity guard that stops a cycle before it can
  recurse, and a failed lookup that stays distinguishable from reaching the top.
  `frontend.util.f28-refpath/disclosure` subtracts the levels the breadcrumb is
  already showing, so no step is repeated and none is claimed that was not read.

  A cycle, an unreadable ancestor and the hard cap are three different answers
  and each withdraws the continuation control for its own reason. None of them
  is described as a complete path.

  WHEN THE WALK RUNS, said plainly because the first specification of this slice
  claimed otherwise: it runs HERE, in the render body, so it runs on every
  render of this panel — which is every render of the group's
  `breadcrumb-with-container`, since neither this component nor its wrapper is
  `rum/static`. It is not one walk per press. What IS structurally guaranteed is
  the other half: a CLOSED control renders no panel at all (`f28-source-path`
  guards this call with `when press`), so it performs no walk, no query and no
  probe. The walk is bounded either way — at most `request-limit` single-step
  parent lookups, capped at `f27-context/hard-cap`.

  `actions` carries this GROUP's own callbacks and its own refusal, so two
  panels open at once cannot reach into each other: the atoms they read and
  write belong to their own `f28-source-path` instance."
  [repo uuid panel-id press actions]
  (let [{:keys [on-more on-hide on-open-step refusal]} actions
        loaded (f27ctx/load-ancestors (f27-parent-fn repo) uuid (f28/request-limit press))
        {:keys [steps page hidden depth status complete?]}
        (f28/disclosure loaded f28/og-visible-levels)
        more-press (f28/next-press press loaded)
        ;; WHERE the refusal is said is decided from the steps this render
        ;; actually produced, not from the ones that were on screen when the
        ;; reader pressed. A redraw renumbers them, and a walk that fails higher
        ;; up removes them; neither is a reason to stop explaining.
        placement (f28/refusal-placement refusal steps)]
    [:div.f28-path-panel {:id panel-id
                          :role "group"
                          :aria-label (t :f28/path-panel-label)}
     (when page
       [:div.f28-path-page
        (t :f28/path-from-page (or (:block/original-name page) (:block/name page)))])
     (if (zero? hidden)
       [:div.f28-path-note (if (= status :partial)
                             (t :f28/path-none-yet)
                             (t :f28/path-nothing-hidden))]
       [:ol.f28-path-steps
        (map-indexed (fn [i e]
                       (rum/with-key
                         (f28-path-step e (when complete? (inc i))
                                        ;; A step with no stable identity is
                                        ;; not offered at all — deciding that
                                        ;; while rendering is what keeps a
                                        ;; control from existing only to say
                                        ;; no.
                                        (when (f28/navigable-step? e)
                                          #(on-open-step e))
                                        (when (f28/refusal-on-step? placement e)
                                          (:reason refusal)))
                         (f28/step-key i e)))
                     steps)])
     ;; The row the reader pressed is not on screen any more — it was renumbered
     ;; away by a deeper read, or the walk stopped before reaching it. The
     ;; explanation stays, for the panel, because the reader still pressed
     ;; something and is still owed an answer.
     (when (:on-panel placement)
       [:div.f28-path-gone-panel (f28-refusal-line (:reason refusal))])
     ;; `cond`, not `case`: the outgoing batch found that a `case` clause whose
     ;; result is a literal `nil` is compiled away inside a hiccup body, taking
     ;; the default with it. A `cond`'s clauses are pairs by construction.
     [:div.f28-path-note.f28-path-status
      (cond
        (= status :complete) (t :f28/path-complete hidden f28/og-visible-levels)
        (= status :partial) (t :f28/path-partial hidden)
        (= status :cycle) [:span [:span.f28-path-mark "↻"] " " (t :f28/path-cycle)]
        (= status :unreadable) [:span [:span.f28-path-mark "⚠"] " " (t :f28/path-unreadable)]
        (= status :capped) [:span [:span.f28-path-mark "⚠"] " "
                            (t :f28/path-capped f27ctx/hard-cap)]
        :else "")]
     ;; Stated on the panel rather than left to be inferred — and stated
     ;; ACCURATELY, which the first version of this sentence was not. The walk
     ;; below runs in this component's RENDER BODY, and neither this component
     ;; nor its wrapper is `rum/static`, so it re-runs whenever the surrounding
     ;; `breadcrumb-with-container` re-renders. It is therefore not a snapshot
     ;; taken at the press; nor is it live, because nothing subscribes on the
     ;; panel's behalf. The sentence says exactly that.
     [:div.f28-path-snapshot (t :f28/path-snapshot)]
     [:div.f28-path-actions
      (when more-press
        [:button.f28-path-more.f27-btn
         (f27-btn #(on-more more-press) {:aria-label (t :f28/path-more)})
         (t :f28/path-more)])
      [:button.f28-path-hide.f27-btn
       (f27-btn on-hide {:aria-label (t :f28/path-hide)
                         :aria-controls panel-id})
       (t :f28/path-hide)]]
     (when (and (pos? depth) (not complete?))
       [:div.f28-path-note.f28-path-incomplete (t :f28/path-not-complete)])]))

(rum/defcs f28-source-path < (rum/local nil ::press) (rum/local nil ::refusal)
  "OG's breadcrumb for one linked-reference group, plus the source-path
  disclosure attached to the point where OG cut the path.

  The control replaces `⋯` inside the row. The panel is a SIBLING of the
  breadcrumb rather than a child of it, so a multi-line path does not have to
  fight an inline row for layout, and Tab reaches it immediately after the
  control that opened it.

  Not `rum/static`: OG's breadcrumb is a plain function called from here, so
  this component must re-render whenever `breadcrumb-with-container` does, or
  the crumb would stop following the database — a regression in OG's own
  behaviour rather than a limit of this feature.

  BOTH atoms belong to THIS group. `::press` is how far up this path has been
  read, and `::refusal` is the one step that was pressed and could not be
  opened. Nothing is shared between groups and nothing is remembered across
  navigation, which is what makes two open panels independent without either of
  them knowing the other exists."
  [state config repo block-id opts]
  (let [*press (::press state)
        *refusal (::refusal state)
        press @*press
        panel-id (f28-panel-id config block-id)
        toggle-id (str panel-id "-toggle")
        ;; The control keeps its place inside the breadcrumb row whether the
        ;; panel is open or closed, so this returns focus to THIS group's own
        ;; control — never to another group's, because the id is derived from
        ;; the list and the block this breadcrumb is drawn for.
        ;;
        ;; Focused twice on purpose. Rum re-renders after this handler returns,
        ;; and if React replaces the control's DOM node the synchronous focus
        ;; went with it; the deferred pass re-asserts it once the re-render has
        ;; happened, and does nothing when focus already arrived.
        focus-toggle! (fn []
                        (some-> (gdom/getElement toggle-id) (.focus))
                        (js/setTimeout
                         (fn []
                           (when-let [el (gdom/getElement toggle-id)]
                             (when-not (identical? el (.-activeElement js/document))
                               (.focus el))))
                         0))
        ;; RE-RESOLVE, THEN DECIDE. The steps on screen were read when this
        ;; panel last rendered; the destination is looked up again here, by
        ;; identity, at the moment the reader asks for it. Anything other than
        ;; "this exact block is there now" refuses and says why — it never
        ;; creates a block or a page, never falls back to the source page, and
        ;; never looks for a block that merely reads the same.
        open-step! (fn [e]
                     (let [captured (f28/step-identity e)
                           lookup (try
                                    {:found (when captured
                                              (db/entity repo [:block/uuid captured]))}
                                    ;; A lookup that could not be performed is
                                    ;; NOT the same fact as a block that is
                                    ;; gone, and is not reported as one.
                                    (catch :default _ {:error true}))
                           decision (f28/navigation captured lookup)]
                       (if-let [target (f28/opened decision)]
                         (do (reset! *refusal nil)
                             ;; OG's own navigation, by identity. The uuid comes
                             ;; from the entity the lookup above proved, so this
                             ;; can never be handed a name that does not resolve
                             ;; — which is the case in which OG's own
                             ;; `redirect-to-page!` creates a page (#3511).
                             (route-handler/redirect-to-page! target))
                         ;; Recorded by IDENTITY, never by position: the row
                         ;; this belongs to moves when the path is read further,
                         ;; and it can leave the panel entirely.
                         (reset! *refusal {:uuid captured
                                           :reason (f28/refused decision)}))))
        control (fn []
                  [:button.f28-path-toggle.f27-btn
                   (f27-btn #(do (reset! *refusal nil)
                                 (swap! *press (fn [p] (when-not p 1))))
                            {:id toggle-id
                             :aria-expanded (if press "true" "false")
                             :aria-controls panel-id
                             :aria-label (if press (t :f28/path-hide) (t :f28/path-show))
                             :title (if press (t :f28/path-hide) (t :f28/path-show))
                             :on-mouse-down (fn [e] (util/stop-propagation e))})
                   [:span.f28-path-toggle-mark {:aria-hidden "true"} "⋯"]])]
    [:div.f28-path
     (breadcrumb (assoc config :f28/more-control control) repo block-id opts)
     (when press
       (f28-source-path-panel
        repo block-id panel-id press
        ;; Reading FURTHER up the path does not clear a refusal. It is not a
        ;; fresh disclosure — the steps already on screen stay on screen, the
        ;; refused one among them — so withdrawing the explanation here would
        ;; take it away for no reason the reader gave.
        {:on-more (fn [n] (reset! *press n))
         ;; Collapsing from INSIDE the path returns focus to the control that
         ;; opened it. Without this the reader's focus is on a button that has
         ;; just been removed from the document, and the next Tab starts from
         ;; the top of the page.
         :on-hide (fn [] (reset! *refusal nil) (reset! *press nil) (focus-toggle!))
         :on-open-step open-step!
         :refusal @*refusal}))]))

(rum/defcs breadcrumb-with-container < rum/reactive db-mixins/query
  {:init (fn [state]
           (let [first-block (ffirst (:rum/args state))]
             (assoc state
                    ::initial-block    first-block
                    ::navigating-block (atom (:block/uuid first-block)))))}
  [state blocks config]
  (let [repo (state/get-current-repo)
        *navigating-block (::navigating-block state)
        navigating-block (rum/react *navigating-block)
        navigating-block-entity (db/entity [:block/uuid navigating-block])
        navigated? (and
                    navigating-block
                    (not= (:db/id (:block/parent (::initial-block state)))
                          (:db/id (:block/parent navigating-block-entity))))
        blocks (if navigated?
                 (let [block navigating-block-entity]
                   (db/get-paginated-blocks repo (:db/id block)
                                            {:scoped-block-id (:db/id block)}))
                 blocks)]
    [:div
     (when (:breadcrumb-show? config)
       (let [crumb-id (or navigating-block (:block/uuid (first blocks)))
             crumb-opts {:show-page? false
                         :navigating-block *navigating-block}]
         ;; F28: the same breadcrumb, wrapped so the point where OG cut the
         ;; path can be opened. `surface-allows?` is every rule but the elision
         ;; one; `breadcrumb` decides that one itself, at the `:more` marker.
         ;; Everywhere else this renders exactly what it rendered before.
         (if (f28/surface-allows? (f28-surface config))
           (f28-source-path config repo crumb-id crumb-opts)
           (breadcrumb config repo crumb-id crumb-opts))))
     (blocks-container blocks (assoc config
                                     :breadcrumb-show? false
                                     :navigating-block *navigating-block
                                     :navigated? navigated?))]))

;; headers to hiccup
(defn ->hiccup
  [blocks config option]
  [:div.content
   (cond-> option
     (:document/mode? config) (assoc :class "doc-mode"))
   (cond
     (and (:custom-query? config) (:group-by-page? config))
     [:div.flex.flex-col
      (let [blocks (sort-by (comp :block/journal-day first) > blocks)]
        (for [[page blocks] blocks]
          (ui/lazy-visible
           (fn []
             (let [alias? (:block/alias? page)
                   page (db/entity (:db/id page))
                   blocks (tree/non-consecutive-blocks->vec-tree blocks)
                   parent-blocks (group-by :block/parent blocks)]
               [:div.custom-query-page-result.color-level {:key (str "page-" (:db/id page))}
                (ui/foldable
                 [:div
                  (page-cp config page)
                  (when alias? [:span.text-sm.font-medium.opacity-50 " Alias"])]
                 (let [{top-level-blocks true others false} (group-by
                                                             (fn [b] (= (:db/id page) (:db/id (first b))))
                                                             parent-blocks)
                       sorted-parent-blocks (concat top-level-blocks others)]
                   (for [[parent blocks] sorted-parent-blocks]
                     (let [top-level? (= (:db/id parent) (:db/id page))]
                       (rum/with-key
                         (breadcrumb-with-container blocks (assoc config :top-level? top-level?))
                         (:db/id parent)))))
                 {:debug-id page})])))))]

     (and (:ref? config) (:group-by-page? config))
     [:div.flex.flex-col.references-blocks-wrap
      (let [blocks (sort-by (comp :block/journal-day first) > blocks)]
        (for [[page page-blocks] blocks]
          (ui/lazy-visible
           (fn []
             (let [alias? (:block/alias? page)
                   page (db/entity (:db/id page))
                   ;; FIXME: parents need to be sorted
                   parent-blocks (group-by :block/parent page-blocks)]
               [:div.my-2.references-blocks-item {:key (str "page-" (:db/id page))}
                (ui/foldable
                 [:div
                  (page-cp config page)
                  (when alias? [:span.text-sm.font-medium.opacity-50 " Alias"])]
                 (for [[parent blocks] parent-blocks]
                   (let [blocks' (map (fn [b]
                                        ;; Block might be a datascript entity
                                        (if (e/entity? b)
                                          (db/pull (:db/id b))
                                          (update b :block/children
                                                  (fn [col]
                                                    (tree/non-consecutive-blocks->vec-tree col))))) blocks)]
                     (rum/with-key
                       (breadcrumb-with-container blocks' config)
                       (:db/id parent))))
                 {:debug-id page})])))))]

     (and (:group-by-page? config)
          (vector? (first blocks)))
     [:div.flex.flex-col
      (let [blocks (sort-by (comp :block/journal-day first) > blocks)]
        (for [[page blocks] blocks]
          (let [blocks (remove nil? blocks)]
            (when (seq blocks)
              (let [alias? (:block/alias? page)
                    page (db/entity (:db/id page))
                    whiteboard? (model/whiteboard-page? page)]
                [:div.my-2 {:key (str "page-" (:db/id page))}
                 (ui/foldable
                  [:div
                   (page-cp config page)
                   (when alias? [:span.text-sm.font-medium.opacity-50 " Alias"])]
                  (when-not whiteboard? (blocks-container blocks config))
                  {})])))))]

     :else
     (blocks-container blocks config))])
