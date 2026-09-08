(ns frontend.util.f27-inline-test
  "F27 inline-context first slice — focused tests for the pure decisions.

  What these pin:

    * every surface the specification excludes is excluded, BY NAME, and an
      ordinary reading surface is not;
    * the panel key separates graph, host block and target, and normalises the
      two forms an identity arrives in;
    * a component instance reused for a different reference reads as CLOSED —
      state can never be displayed against the wrong target;
    * the second disclosure cannot be open while the panel is closed;
    * a target that resolves to a parser stub is `:unavailable`, and only a
      readable one may have its context opened."
  (:require [cljs.test :refer [deftest testing is]]
            [frontend.util.f27-inline :as il]))

(def ^:private repo "logseq_local_/tmp/graph-one")
(def ^:private repo2 "logseq_local_/tmp/graph-two")
(def ^:private host "7f270000-0000-4000-8000-0000000000d4")
(def ^:private host2 "7f270000-0000-4000-8000-0000000000d5")
(def ^:private a "7f270000-0000-4000-8000-0000000000a1")
(def ^:private b "7f270000-0000-4000-8000-0000000000b2")

(def ^:private ordinary
  "The surface this feature exists for: an ordinary block in main reading
  content. Every exclusion test below turns exactly one flag on."
  {:identity? true})

;; ---------------------------------------------------------------------------
;; Identity
;; ---------------------------------------------------------------------------

(deftest identity-is-normalised-to-one-form
  (testing "the two forms an identity arrives in compare equal"
    (is (= (il/ident (uuid a)) (il/ident a)))
    (is (= (il/ident (str "  " (.toUpperCase a) "  ")) (il/ident a))))
  (testing "nothing readable is nothing"
    (is (nil? (il/ident nil)))
    (is (nil? (il/ident "")))
    (is (nil? (il/ident "   ")))))

(deftest a-panel-key-separates-graph-host-and-target
  (testing "the same target in one host in one graph is one panel"
    (is (= (il/panel-key {:repo repo :host host :target a})
           (il/panel-key {:repo repo :host (uuid host) :target (uuid a)}))))
  (testing "a different target is a different panel"
    (is (not= (il/panel-key {:repo repo :host host :target a})
              (il/panel-key {:repo repo :host host :target b}))))
  (testing "the same target from a different host block is a different panel"
    (is (not= (il/panel-key {:repo repo :host host :target a})
              (il/panel-key {:repo repo :host host2 :target a}))))
  (testing "the same target in a different graph is a different panel"
    (is (not= (il/panel-key {:repo repo :host host :target a})
              (il/panel-key {:repo repo2 :host host :target a}))))
  (testing "no target is no panel identity at all"
    (is (nil? (il/panel-key {:repo repo :host host :target nil})))
    (is (nil? (il/panel-key {:repo repo :host host :target "  "}))))
  (testing "a missing graph or host still yields a usable, distinct key"
    (is (some? (il/panel-key {:target a})))
    (is (not= (il/panel-key {:target a}) (il/panel-key {:target b})))))

;; ---------------------------------------------------------------------------
;; Where the control belongs
;; ---------------------------------------------------------------------------

(deftest an-ordinary-reading-surface-gets-the-control
  (is (nil? (il/excluded-surface ordinary)))
  (is (true? (il/offer-control? ordinary))))

(deftest every-excluded-surface-is-excluded-by-name
  (doseq [[flag reason]
          [[:f27-panel?    :f27-panel]
           [:inline-panel? :inline-panel]
           [:mobile?       :mobile]
           [:preview?      :preview]
           [:slide?        :slide]
           [:sidebar?      :sidebar]
           [:embed?        :embed]
           [:block-ref?    :block-ref]
           [:query?        :query]
           [:html-export?  :html-export]
           [:whiteboard?   :whiteboard]
           [:annotation?   :annotation]]]
    (testing (str flag " excludes the control as " reason)
      (is (= reason (il/excluded-surface (assoc ordinary flag true))))
      (is (false? (il/offer-control? (assoc ordinary flag true)))))))

(deftest text-that-is-not-an-identity-gets-no-control
  (is (= :no-identity (il/excluded-surface {:identity? false})))
  (is (false? (il/offer-control? {:identity? false})))
  (testing "and no identity beats every other reason, because there is nothing to open"
    (is (= :no-identity (il/excluded-surface {:identity? false :mobile? true})))))

(deftest the-set-of-exclusions-is-fixed-and-visible
  (testing "adding or removing a surface is a visible change, not a deleted clause"
    (is (= [:no-identity :f27-panel :inline-panel :mobile :preview :slide :sidebar
            :embed :block-ref :query :html-export :whiteboard :annotation]
           il/exclusion-reasons)))
  (testing "every listed reason is reachable"
    (is (= (set il/exclusion-reasons)
           (into #{:no-identity}
                 (for [flag [:f27-panel? :inline-panel? :mobile? :preview? :slide?
                             :sidebar? :embed? :block-ref? :query? :html-export?
                             :whiteboard? :annotation?]]
                   (il/excluded-surface (assoc ordinary flag true))))))))

;; ---------------------------------------------------------------------------
;; State isolation
;; ---------------------------------------------------------------------------

(deftest a-panel-starts-closed
  (let [k (il/panel-key {:repo repo :host host :target a})]
    (is (= il/closed (il/panel-state nil k)))
    (is (false? (il/open? nil k)))
    (is (false? (il/context-open? nil k)))))

(deftest opening-and-closing-the-first-disclosure
  (let [k (il/panel-key {:repo repo :host host :target a})
        opened (il/toggle-panel nil k)]
    (is (true? (il/open? opened k)))
    (is (false? (il/context-open? opened k)))
    (let [closed (il/toggle-panel opened k)]
      (is (false? (il/open? closed k))))))

(deftest closing-the-panel-also-closes-the-context
  (let [k (il/panel-key {:repo repo :host host :target a})
        with-ctx (il/toggle-context (il/toggle-panel nil k) k)]
    (is (true? (il/context-open? with-ctx k)))
    (testing "re-opening starts at the first disclosure again"
      (let [reopened (il/toggle-panel (il/toggle-panel with-ctx k) k)]
        (is (true? (il/open? reopened k)))
        (is (false? (il/context-open? reopened k)))))))

(deftest the-second-disclosure-cannot-be-open-while-the-panel-is-closed
  (let [k (il/panel-key {:repo repo :host host :target a})]
    (is (= il/closed (il/panel-state (il/toggle-context nil k) k)))
    (is (false? (il/context-open? (il/toggle-context nil k) k)))))

(deftest close-panel-closes-everything
  (let [k (il/panel-key {:repo repo :host host :target a})
        deep (il/toggle-context (il/toggle-panel nil k) k)
        shut (il/close-panel deep k)]
    (is (false? (il/open? shut k)))
    (is (false? (il/context-open? shut k)))))

(deftest state-belonging-to-another-reference-is-never-displayed
  (let [ka (il/panel-key {:repo repo :host host :target a})
        kb (il/panel-key {:repo repo :host host :target b})
        khost (il/panel-key {:repo repo :host host2 :target a})
        kgraph (il/panel-key {:repo repo2 :host host :target a})
        opened (il/toggle-context (il/toggle-panel nil ka) ka)]
    (testing "an instance reused for a different TARGET reads as closed"
      (is (= il/closed (il/panel-state opened kb))))
    (testing "an instance reused under a different HOST block reads as closed"
      (is (= il/closed (il/panel-state opened khost))))
    (testing "an instance reused in a different GRAPH reads as closed"
      (is (= il/closed (il/panel-state opened kgraph))))
    (testing "its own key still reads as open"
      (is (true? (il/open? opened ka)))
      (is (true? (il/context-open? opened ka))))))

(deftest toggling-under-a-new-key-opens-that-panel-rather-than-closing-the-old-one
  (let [ka (il/panel-key {:repo repo :host host :target a})
        kb (il/panel-key {:repo repo :host host :target b})
        opened (il/toggle-panel nil ka)
        moved (il/toggle-panel opened kb)]
    (is (true? (il/open? moved kb)))
    (is (= il/closed (il/panel-state moved ka)))))

(deftest state-belonging-to-another-reference-is-FORGOTTEN-not-merely-hidden
  ;; Regression for a defect the lifecycle scenario observed live: refusing to
  ;; DISPLAY mismatched state is not the same as discarding it. A mounted
  ;; instance retargeted A -> B -> A found its old key matching again and a
  ;; panel the reader had never re-opened reappeared.
  (let [ka (il/panel-key {:repo repo :host host :target a})
        kb (il/panel-key {:repo repo :host host :target b})
        opened (il/toggle-context (il/toggle-panel nil ka) ka)]
    (testing "it is stale under the other reference, and not under its own"
      (is (true? (il/stale? opened kb)))
      (is (false? (il/stale? opened ka))))
    (testing "forgetting it under B makes coming back to A a fresh, closed panel"
      (let [forgotten (il/forget-when-stale opened kb)]
        (is (nil? forgotten))
        (is (= il/closed (il/panel-state forgotten ka)))
        (is (false? (il/open? forgotten ka)))))
    (testing "without forgetting, returning to A would restore it — the defect"
      (is (true? (il/open? opened ka))))
    (testing "its own key is left exactly as it was"
      (is (= opened (il/forget-when-stale opened ka))))))

(deftest nothing-stored-and-no-identity-are-not-stale
  (let [ka (il/panel-key {:repo repo :host host :target a})]
    (is (false? (il/stale? nil ka)))
    (is (false? (il/stale? {} ka)))
    (is (nil? (il/forget-when-stale nil ka))))
  (testing "a reference that lost its identity forgets state that named one"
    (let [ka (il/panel-key {:repo repo :host host :target a})
          opened (il/toggle-panel nil ka)]
      (is (true? (il/stale? opened nil)))
      (is (nil? (il/forget-when-stale opened nil))))))

(deftest a-panel-with-no-target-identity-is-always-closed
  (let [opened (il/toggle-panel nil nil)]
    (is (= il/closed (il/panel-state opened nil)))
    (is (false? (il/open? opened nil)))))

;; ---------------------------------------------------------------------------
;; What the panel may say
;; ---------------------------------------------------------------------------

(deftest a-target-that-cannot-be-read-is-said-to-be-unreadable
  (is (= :ready (il/target-state {:identity? true :readable? true})))
  (testing "an identity the parser created an entity for, that nobody wrote"
    (is (= :unavailable (il/target-state {:identity? true :readable? false}))))
  (is (= :no-identity (il/target-state {:identity? false :readable? false})))
  (testing "no identity beats readability, whatever the caller claims"
    (is (= :no-identity (il/target-state {:identity? false :readable? true})))))

(deftest only-a-readable-target-may-have-its-context-opened
  (is (true? (il/expandable? :ready)))
  (is (false? (il/expandable? :unavailable)))
  (is (false? (il/expandable? :no-identity))))

(deftest escape-is-recognised-in-both-spellings
  (is (true? (il/escape-key? "Escape")))
  (is (true? (il/escape-key? "Esc")))
  (is (false? (il/escape-key? "Enter")))
  (is (false? (il/escape-key? " ")))
  (is (false? (il/escape-key? nil))))
