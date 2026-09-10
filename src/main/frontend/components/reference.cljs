(ns frontend.components.reference
  (:require [clojure.string :as string]
            [frontend.components.block :as block]
            [frontend.components.content :as content]
            [frontend.components.editor :as editor]
            [frontend.context.i18n :refer [t]]
            [frontend.db :as db]
            [frontend.db-mixins :as db-mixins]
            [frontend.db.utils :as db-utils]
            [frontend.db.model :as model-db]
            [frontend.handler.block :as block-handler]
            [frontend.handler.page :as page-handler]
            [frontend.search :as search]
            [frontend.state :as state]
            [frontend.ui :as ui]
            [frontend.util :as util]
            [frontend.util.f28-reforder :as f28ord]
            [rum.core :as rum]
            [frontend.modules.outliner.tree :as tree]))

(defn- frequencies-sort
  [references]
  (sort-by second #(> %1 %2) references))

(defn filtered-refs
  [page-name filters filters-atom filtered-references]
  [:div.flex.gap-2.flex-wrap.items-center
   (for [[ref-name ref-count] filtered-references]
     (when ref-name
       (let [lc-reference (string/lower-case ref-name)]
         (ui/button
           [:span
            ref-name
            (when ref-count [:sup " " ref-count])]
           :on-click (fn [e]
                       (swap! filters-atom #(if (nil? (get filters lc-reference))
                                              (assoc % lc-reference (not (.-shiftKey e)))
                                              (dissoc % lc-reference)))
                       (page-handler/save-filter! page-name @filters-atom))
           :small? true
           :variant :outline
           :key ref-name))))])

(rum/defcs filter-dialog-inner < rum/reactive (rum/local "" ::filterSearch)
  [state filters-atom *references page-name]
  (let [filter-search (get state ::filterSearch)
        references (rum/react *references)
        filtered-references  (frequencies-sort
                              (if (= @filter-search "")
                                references
                                (search/fuzzy-search references @filter-search :limit 500 :extract-fn first)))
        filters (rum/react filters-atom)
        includes (keep (fn [[page include?]]
                         (let [page' (model-db/get-page-original-name page)]
                           (when include? [page'])))
                       filters)
        excludes (keep (fn [[page include?]]
                         (let [page' (model-db/get-page-original-name page)]
                           (when-not include? [page'])))
                       filters)]
    [:div.ls-filters.filters
     [:div.sm:flex.sm:items-start
      [:div.mx-auto.flex-shrink-0.flex.items-center.justify-center.h-12.w-12.rounded-full.bg-gray-200.text-gray-500.sm:mx-0.sm:h-10.sm:w-10
       (ui/icon "filter" {:size 20})]
      [:div.mt-3.text-center.sm:mt-0.sm:ml-4.sm:text-left.pb-2
       [:h3#modal-headline.text-lg.leading-6.font-medium (t :linked-references/filter-heading)]
       [:span.text-xs
        (t :linked-references/filter-directions)]]]
     (when (seq filters)
       [:div.cp__filters.mb-4.ml-2
        (when (seq includes)
          [:div.flex.flex-row.flex-wrap.center-items
           [:div.mr-1.font-medium.py-1 (t :linked-references/filter-includes)]
           (filtered-refs page-name filters filters-atom includes)])
        (when (seq excludes)
          [:div.flex.flex-row.flex-wrap
           [:div.mr-1.font-medium.py-1 (t :linked-references/filter-excludes)]
           (filtered-refs page-name filters filters-atom excludes)])])
     [:div.cp__filters-input-panel.flex
      (ui/icon "search")
      [:input.cp__filters-input.w-full
       {:placeholder (t :linked-references/filter-search)
        :auto-focus true
        :on-change (fn [e]
                     (reset! filter-search (util/evalue e)))}]]
     (let [all-filters (set (keys filters))
           refs (remove (fn [[page _]] (all-filters (util/page-name-sanity-lc page)))
                        filtered-references)]
       (when (seq refs)
         [:div.mt-4
          (filtered-refs page-name filters filters-atom refs)]))]))

(defn filter-dialog
  [filters-atom *references page-name]
  (fn []
    (filter-dialog-inner filters-atom *references page-name)))

(rum/defc block-linked-references < rum/reactive db-mixins/query
  [block-id]
  (let [e (db/entity [:block/uuid block-id])
        page? (some? (:block/name e))
        ref-blocks (if page?
                     (-> (db/get-page-referenced-blocks (:block/name e))
                         db-utils/group-by-page)
                     (db/get-block-referenced-blocks block-id))
        ref-hiccup (block/->hiccup ref-blocks
                                   {:id (str block-id)
                                    :ref? true
                                    :breadcrumb-show? true
                                    :group-by-page? true
                                    :editor-box editor/box
                                    ;; F28: named explicitly rather than left to
                                    ;; the absent opt-in. This list renders under
                                    ;; any block on any surface — the sidebar, an
                                    ;; embed, a whiteboard portal — and is not
                                    ;; this slice's.
                                    :f28/block-refs-list? true}
                                   {})]
    [:div.references-blocks
     (content/content block-id
                      {:hiccup ref-hiccup})]))

;; ---------------------------------------------------------------------------
;; F28 source-page group ordering — one selectable order for the GROUPS.
;;
;; OG orders the source-page groups by `:block/journal-day` alone, which only a
;; journal has; every ordinary page keeps whatever order `group-by` produced,
;; and nothing offers the reader a choice. Measured on screen, in a build
;; without this feature: `f28-refpath/checks/reforder-baseline-checks.js`.
;;
;; The choice is LOCAL TO THIS VIEW — a `rum/local` on `references*` below. Not
;; a graph-file preference, not `config.edn`, not app state, not synchronised.
;; It lasts as long as the list is on screen, and a fresh visit starts at
;; `:original`, which is OG's own order.
;; ---------------------------------------------------------------------------

(rum/defc f28-group-order-control < rum/reactive
  "One `<select>` choosing the order of this list's source-page groups.

  `rum/reactive` is here for TWO measured reasons, not by habit:

    * it reads `*group-order`, so choosing an order redraws the control itself
      without redrawing `references*` and re-running its queries;
    * `t` reads the interface language through `state/sub`, and
      `frontend.util/react` degrades to a plain deref outside a reactive
      component. The reference-role slice's first packaged run found exactly
      that failure — the language changed and 47 labels stayed English — so the
      subscription is made HERE, where the words are.

  `data-f28-order` carries the DECISION, so a check reads the order rather than
  the dictionary.

  Both mouse-down handlers stop propagation and nothing else. `ui/foldable` is
  rendered with `:title-trigger?`, so its header calls `util/stop` — which
  PREVENTS THE DEFAULT ACTION — on mouse-down; a select whose default action is
  prevented never opens. `stop-propagation` keeps the header from folding
  without touching what the browser does with the control. The key handler is
  the same bargain the F27 panel controls make: OG installs a global
  `goog.ui.KeyboardShortcutHandler` on `window` which prevents the default
  action of every key it matches, and a select is driven by exactly those keys,
  so the event is stopped before it can reach it — and never prevented, because
  the browser's own handling of the key IS the feature."
  [*group-order]
  (let [mode (f28ord/normalize-mode (rum/react *group-order))]
    [:div.f28-order
     {:on-mouse-down util/stop-propagation
      :on-click util/stop-propagation}
     [:select.f28-order-select
      {:value (f28ord/mode-value mode)
       :data-f28-order (f28ord/mode-value mode)
       :aria-label (t :f28/order-label)
       :title (t :f28/order-why)
       :on-change (fn [e] (reset! *group-order (f28ord/value->mode (util/evalue e))))
       :on-mouse-down util/stop-propagation
       :on-key-down util/stop-propagation}
      (for [m f28ord/modes]
        [:option {:key (f28ord/mode-value m)
                  :value (f28ord/mode-value m)}
         (t (f28ord/label-key m))])]]))

(rum/defc references-inner < rum/reactive
  [page-name filters filtered-ref-blocks source-path? role-pages *group-order]
  [:div.references-blocks
   (let [;; F28 ordering: read HERE rather than in `references*`, so choosing an
         ;; order redraws this list and not the component that queries for it.
         ;; nil on every surface that was not offered the control, which is what
         ;; `->hiccup` reads as "leave OG's own order exactly alone".
         group-order (when *group-order (rum/react *group-order))
         ref-hiccup (block/->hiccup filtered-ref-blocks
                                    {:id page-name
                                     :ref? true
                                     :breadcrumb-show? true
                                     :group-by-page? true
                                     :editor-box editor/box
                                     :filters filters
                                     ;; F28: the explicit opt-in for the source-path
                                     ;; disclosure. `breadcrumb-with-container` also
                                     ;; serves custom queries and a block's own
                                     ;; reference list, so the surface has to SAY it
                                     ;; is this one rather than be inferred. False in
                                     ;; the right sidebar's copy of this list, whose
                                     ;; behaviour is protected as it is.
                                     :f28/source-path? (boolean source-path?)
                                     ;; F28 reference roles: WHICH page this list is
                                     ;; about, as the identity set `references*`
                                     ;; itself filters `top-level-blocks` with. A row
                                     ;; is a direct mention exactly when its own
                                     ;; `:block/refs` meets this set, so a label and
                                     ;; the count in the heading cannot disagree.
                                     ;; Carried as ids rather than a name because a
                                     ;; name would have to be re-resolved per row and
                                     ;; would miss the aliases the count includes.
                                     ;; nil in the sidebar's copy, which gets no
                                     ;; labels at all.
                                     :f28/role-pages role-pages
                                     ;; F28 source-page group ordering: the order
                                     ;; the GROUPS are drawn in. `:original` is
                                     ;; OG's own sequence handed back untouched,
                                     ;; and nil means this surface has no control
                                     ;; and nothing about the order changes.
                                     :f28/group-order group-order}
                                    {})]
     (content/content page-name {:hiccup ref-hiccup}))])

(rum/defc references-cp
  [page-name filters filters-atom filter-state total filter-n filtered-ref-blocks *ref-pages
   source-path? role-pages *group-order]
  (let [threshold (state/get-linked-references-collapsed-threshold)
        default-collapsed? (>= total threshold)
        *collapsed? (atom nil)]
    (ui/foldable
     [:div.flex.flex-row.flex-1.justify-between.items-center
      [:h2.font-medium (t :linked-references/reference-count (if (seq filters) filter-n nil) total)]
      ;; F28 ordering sits BESIDE OG's own filter control, in the heading row
      ;; the `justify-between` above already lays out: the count on the left,
      ;; the controls on the right. `*group-order` is nil on every surface that
      ;; is not this one, and then nothing is added here at all.
      [:div.flex.flex-row.items-center.f28-order-row
       (when *group-order (f28-group-order-control *group-order))
       [:a.filter.fade-link
        {:title (t :linked-references/filter-heading)
         :on-mouse-over (fn [_e]
                          (when @*collapsed? ; collapsed
                            ;; expand
                            (reset! @*collapsed? false)))
         :on-mouse-down (fn [e]
                          (util/stop-propagation e))
         :on-click (fn []
                     (state/set-modal! (filter-dialog filters-atom *ref-pages page-name)
                                       {:center? true}))}
        (ui/icon "filter" {:class (cond
                                    (empty? filter-state)
                                    "opacity-60 hover:opacity-100"
                                    (every? true? (vals filter-state))
                                    "text-success"
                                    (every? false? (vals filter-state))
                                    "text-error"
                                    :else
                                    "text-warning")
                           :size  22})]]]

     (fn []
       (references-inner page-name filters filtered-ref-blocks source-path? role-pages
                         *group-order))

     {:default-collapsed? default-collapsed?
      :title-trigger? true
      :init-collapsed (fn [collapsed-atom]
                        (reset! *collapsed? collapsed-atom))})))

(defn- get-filtered-children
  [block parent->blocks]
  (let [children (get parent->blocks (:db/id block))]
    (set
     (loop [blocks children
            result (vec children)]
       (if (empty? blocks)
         result
         (let [fb (first blocks)
               children (get parent->blocks (:db/id fb))]
           (recur
            (concat children (rest blocks))
            (conj result fb))))))))

(rum/defc sub-page-properties-changed < rum/static
  [page-name v filters-atom]
  (rum/use-effect!
    (fn []
      (reset! filters-atom
              (page-handler/get-filters (util/page-name-sanity-lc page-name))))
    [page-name v filters-atom])
  [:<>])

(rum/defcs references* < rum/reactive db-mixins/query
  (rum/local nil ::ref-pages)
  ;; F28 source-page group ordering: the reader's choice, LOCAL TO THIS VIEW.
  ;; It starts at OG's own order, it is never written anywhere, and leaving the
  ;; page and coming back starts at OG's own order again.
  (rum/local :original ::group-order)
  {:init (fn [state]
           (let [page-name (first (:rum/args state))
                 filters (when page-name (atom nil))]
             (assoc state ::filters filters)))}
  [state page-name opts]
  (when page-name
    (let [source-path? (not (:sidebar? opts))
          page-name (util/page-name-sanity-lc page-name)
          page-props-v (state/sub-page-properties-changed page-name)
          *ref-pages (::ref-pages state)
          repo (state/get-current-repo)
          filters-atom (get state ::filters)
          filter-state (rum/react filters-atom)
          ref-blocks (db/get-page-referenced-blocks page-name)
          page-id (:db/id (db/entity repo [:block/name page-name]))
          aliases (db/page-alias-set repo page-name)
          aliases-exclude-self (set (remove #{page-id} aliases))
          top-level-blocks (filter (fn [b] (some aliases (set (map :db/id (:block/refs b))))) ref-blocks)
          top-level-blocks-ids (set (map :db/id top-level-blocks))
          filters (when (seq filter-state)
                    (-> (group-by second filter-state)
                        (update-vals #(map first %))))
          filtered-ref-blocks (->> (block-handler/filter-blocks ref-blocks filters)
                                   (block-handler/get-filtered-ref-blocks-with-parents ref-blocks))
          total (count top-level-blocks)
          filtered-top-blocks (filter (fn [b] (top-level-blocks-ids (:db/id b))) filtered-ref-blocks)
          filter-n (count filtered-top-blocks)
          parent->blocks (group-by (fn [x] (:db/id (x :block/parent))) filtered-ref-blocks)
          result (->> (group-by :block/page filtered-top-blocks)
                      (map (fn [[page blocks]]
                             (let [blocks (sort-by (fn [b] (not= (:db/id page) (:db/id (:block/parent b)))) blocks)
                                   result (map (fn [block]
                                                 (let [filtered-children (get-filtered-children block parent->blocks)
                                                       refs (when-not (contains? top-level-blocks-ids (:db/id (:block/parent block)))
                                                              (block-handler/get-blocks-refed-pages aliases (cons block filtered-children)))
                                                       block' (assoc (tree/block-entity->map block) :block/children filtered-children)]
                                                   [block' refs])) blocks)
                                   blocks' (map first result)
                                   page' (if (contains? aliases-exclude-self (:db/id page))
                                           {:db/id (:db/id page)
                                            :block/alias? true
                                            :block/journal-day (:block/journal-day page)}
                                           page)]
                               [[page' blocks'] (mapcat second result)]))))
          filtered-ref-blocks' (map first result)
          ref-pages (->>
                     (mapcat second result)
                     (map :block/original-name)
                     frequencies)]
      (reset! *ref-pages ref-pages)
      (when (or (seq filter-state) (> filter-n 0))
        [:div.references.page-linked.flex-1.flex-row
         (sub-page-properties-changed page-name page-props-v filters-atom)
         [:div.content.pt-6
          (references-cp page-name filters filters-atom filter-state total filter-n
                         filtered-ref-blocks' *ref-pages source-path?
                         ;; F28 reference roles: the same `aliases` set two lines
                         ;; of `top-level-blocks` above use to decide what this
                         ;; heading counts. Withheld from the sidebar's copy for
                         ;; the same reason `source-path?` is.
                         (when source-path? aliases)
                         ;; F28 ordering: withheld from the sidebar's copy for the
                         ;; same reason again, and nil there means the control is
                         ;; not rendered and the order is not touched.
                         (when source-path? (::group-order state)))]]))))

(rum/defc references
  "`opts` carries only `:sidebar?`, which F28 reads to keep the source-path
  disclosure out of the right sidebar's copy of this list. It is a NEW key on a
  new argument rather than OG's `:sidebar?` threaded into the block config,
  because that key already changes how blocks render (`lazy-blocks`' load-more
  label among others) and this feature may not change what the sidebar shows."
  ([page-name] (references page-name nil))
  ([page-name opts]
   (ui/catch-error
    (ui/component-error (t :linked-references/unexpected-error))
    (ui/lazy-visible
     (fn []
       (references* page-name opts))
     {:debug-id (str page-name " references")}))))

(rum/defcs unlinked-references-aux
  < rum/reactive db-mixins/query
  {:wrap-render
   (fn [render-fn]
     (fn [state]
       (reset! (second (:rum/args state))
               (apply +
                      (for [[_ rfs]
                            (db/get-page-unlinked-references
                             (first (:rum/args state)))]
                        (count rfs))))
       (render-fn state)))}
  [state page-name _n-ref]
  (let [ref-blocks (db/get-page-unlinked-references page-name)]
    [:div.references-blocks
     (let [ref-hiccup (block/->hiccup ref-blocks
                                      {:id (str page-name "-unlinked-")
                                       :ref? true
                                       :group-by-page? true
                                       :editor-box editor/box}
                                      {})]
       (content/content page-name
                        {:hiccup ref-hiccup}))]))

(rum/defcs unlinked-references < rum/reactive
  (rum/local nil ::n-ref)
  [state page-name]
  (let [n-ref (get state ::n-ref)]
    (when page-name
      (let [page-name (string/lower-case page-name)]
        [:div.references.page-unlinked.mt-6.flex-1.flex-row
         [:div.content.flex-1
          (ui/foldable
           [:h2.font-medium (t :unlinked-references/reference-count @n-ref)]
           (fn [] (unlinked-references-aux page-name n-ref))
           {:default-collapsed? true
            :title-trigger? true})]]))))
