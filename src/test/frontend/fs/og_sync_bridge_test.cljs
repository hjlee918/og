(ns frontend.fs.og-sync-bridge-test
  (:require [cljs.test :refer [deftest is]]
            [electron.ipc :as ipc]
            [frontend.config :as config]
            [frontend.db :as db]
            [frontend.fs :as fs]
            [frontend.fs.node :as node]
            [frontend.fs.og-sync-bridge :as bridge]
            [frontend.fs.watcher-handler :as watcher]
            [frontend.handler.page :as page-handler]
            [frontend.state :as state]
            [frontend.test.helper :include-macros true :refer [deftest-async with-reset]]
            [promesa.core :as p]))

(defn- test-runtime
  ([] (test-runtime {}))
  ([overrides]
   (let [events (atom [])
         stored (or (:stored overrides) (atom nil))
         counter (atom 0)
         runtime {:state (atom {:causes {} :writes {}})
                  :events events
                  :stored stored
                  :adapter! #(swap! events conj %)
                  :next-id! (fn [kind] (str (name kind) "-" (swap! counter inc)))
                  :rename-content-hash! (fn [_graph _path] "hash:rename")
                  :complete-state! (constantly nil)
                  :reconcile! (fn [& _] :reconciled)
                  :save-active! #(reset! stored %)
                  :load-active! #(deref stored)
                  :clear-active! #(reset! stored nil)
                  :revalidate-plan! :authoritative-plan
                  :validate-binding! #(= {:root-id "root-1" :graph-id "graph-a"} %)
                  :validate-acceptance!
                  (fn [_active evidence]
                    (= #{:files-match :identity-bytes-match :checkpoint-match :binding-match}
                       (set (keep (fn [[key value]] (when value key)) evidence))))}]
     (merge runtime (dissoc overrides :stored)))))

(defn- active-inputs
  []
  {:graph-id "graph-a"
   :replica-id "replica-a"
   :source-snapshot {:fingerprint "source-1"}
   :issued-preview {:preview-id "preview-1" :diagnostic-only true}
   :target {:files [{:file-id "file-a" :content "incoming"}]}
   :authoritative-plan {:plan-id "plan-1" :actions [{:operation-id "op-1"}]}
   :projected-snapshot {:fingerprint "projected-1"}
   :proposed-identity-bytes "synthetic identity bytes"
   :basis-generation "generation-1"
   :target-generation "generation-2"
   :operation-ids ["op-1"]
   :working-journal-identity {:journal-id "journal-1"}
   :graph-binding {:root-id "root-1" :graph-id "graph-a"}
   :causes []})

(deftest disabled-bridge-allocates-and-calls-nothing
  (is (false? (bridge/enabled?)))
  (is (nil? (bridge/save-pending! "graph-a" "pages/a.md" "A")))
  (is (nil? (bridge/rename-intent! "graph-a" "pages/a.md" "pages/b.md")))
  (is (nil? (bridge/observe-watcher! "change" "/synthetic" "pages/a.md"
                                     "A" {:mtime 1} false)))
  (is (nil? (bridge/start-active! (active-inputs)))))

(deftest-async disabled-save-boundary-preserves-results-errors-and-order
  (let [order (atom [])
        result #js {:mtime 17}]
    (with-reset reset
      [ipc/ipc (fn [command & _]
                 (swap! order conj command)
                 (if (= command "writeFile")
                   (p/resolved result)
                   (p/rejected (js/Error. "unexpected IPC"))))]
      (-> (node/write-file-impl!
           "graph-a" "/synthetic" "pages/a.md" "A"
           {:skip-compare? true
            :ok-handler (fn [_repo _path value]
                          (swap! order conj :ok)
                          (is (identical? result value))
                          :original-result)}
           :not-found)
          (p/then (fn [value]
                    (is (= :original-result value))
                    (is (= ["writeFile" :ok] @order))
                    (reset)
                    (with-reset reset-error
                      [ipc/ipc (fn [& _] (p/rejected (js/Error. "disk failed")))]
                      (-> (node/write-file-impl!
                           "graph-a" "/synthetic" "pages/a.md" "A"
                           {:skip-compare? true
                            :error-handler (fn [error]
                                             (swap! order conj (.-message error))
                                             :original-error-result)}
                           :not-found)
                          (p/then (fn [error-result]
                                    (is (= :original-error-result error-result))
                                    (is (= ["writeFile" :ok "disk failed"] @order))
                                    (reset-error)))))))))))

(deftest-async enabled-save-boundary-binds-overlaps-and-isolates-adapter-failure
  (let [runtime (test-runtime {:adapter! (fn [event]
                                           (when (and (= :save-completed (:event event))
                                                      (= "graph-a" (get-in event [:cause :graph-id])))
                                             (throw (js/Error. "adapter failed"))))})
        completions (atom {})]
    (with-reset reset
      [ipc/ipc (fn [_command repo & _]
                 (js/Promise. (fn [resolve _reject]
                                (swap! completions assoc repo resolve))))]
      (let [save-a (binding [bridge/*test-runtime* runtime]
                     (node/write-file-impl! "graph-a" "/synthetic" "pages/a.md" "A"
                                            {:skip-compare? true} :not-found))
            save-b (binding [bridge/*test-runtime* runtime]
                     (node/write-file-impl! "graph-b" "/synthetic" "pages/b.md" "B"
                                            {:skip-compare? true} :not-found))]
        (-> (p/resolved nil)
            (p/then (fn [_]
                      ((get @completions "graph-b") #js {:mtime 2})
                      save-b))
            (p/then (fn [_]
                      ((get @completions "graph-a") #js {:mtime 1})
                      save-a))
            (p/then (fn [_]
                      (is (= #{"graph-a" "graph-b"}
                             (set (map :graph-id (vals (:writes @(:state runtime)))))))
                      (is (= #{:completed}
                             (set (map :status (vals (:writes @(:state runtime)))))))
                      (is (= :save-completed (get-in @(:state runtime) [:blocked :phase])))
                      (reset))))))))

(deftest-async adapter-failure-cannot-hide-the-original-save-error
  (let [runtime (test-runtime {:adapter! (fn [event]
                                           (when (= :save-failed (:event event))
                                             (throw (js/Error. "adapter failure"))))})
        handled (atom nil)]
    (with-reset reset
      [ipc/ipc (fn [& _] (p/rejected (js/Error. "original disk error")))]
      (-> (binding [bridge/*test-runtime* runtime]
            (node/write-file-impl!
             "graph-a" "/synthetic" "pages/a.md" "A"
             {:skip-compare? true
              :error-handler (fn [error]
                               (reset! handled (.-message error))
                               :handled-original)}
             :not-found))
          (p/then (fn [value]
                    (is (= :handled-original value))
                    (is (= "original disk error" @handled))
                    (is (= :save-failed (get-in @(:state runtime) [:blocked :phase])))
                    (reset)))))))

(deftest-async disabled-rename-boundary-preserves-settlement-and-order
  (let [order (atom [])
        file {:db/id 1 :file/path "pages/a.md"}]
    (with-reset reset
      [state/get-current-repo (constantly "graph-a")
       db/pull (constantly file)
       db/transact! (fn [_repo _tx] (swap! order conj :transact))
       state/offer-file-rename-event-chan! (fn [_] (swap! order conj :offer) (p/resolved nil))
       fs/rename! (fn [_repo old-path new-path]
                    (swap! order conj [old-path new-path])
                    (p/resolved :renamed))]
      (-> (page-handler/rename-file! file "b" #(do (swap! order conj :ok) :ok-result))
          (p/then (fn [value]
                    (is (= :ok-result value))
                    (is (= [:transact :offer ["pages/a.md" "pages/b.md"] :ok] @order))
                    (reset)))))))

(deftest-async enabled-rename-boundary-retains-originating-graph
  (let [runtime (test-runtime)
        file {:db/id 1 :file/path "pages/a.md"}]
    (with-reset reset
      [state/get-current-repo (constantly "graph-before-switch")
       db/pull (constantly file)
       db/transact! (fn [& _])
       state/offer-file-rename-event-chan! (fn [_] (p/resolved nil))
       fs/rename! (fn [& _] (p/resolved :renamed))]
      (-> (binding [bridge/*test-runtime* runtime]
            (page-handler/rename-file! file "b" (constantly :ok)))
          (p/then (fn [value]
                    (is (= :ok value))
                    (let [events @(:events runtime)]
                      (is (= [:rename-intent :rename-completed] (mapv :event events)))
                      (is (= ["graph-before-switch" "graph-before-switch"]
                             (mapv #(get-in % [:cause :graph-id]) events))))
                    (reset)))))))

(deftest-async rejected-rename-reports-failure-without-changing-og-settlement
  (let [runtime (test-runtime)
        file {:db/id 1 :file/path "pages/a.md"}
        ok-called? (atom false)]
    (with-reset reset
      [state/get-current-repo (constantly "graph-a")
       db/pull (constantly file)
       db/transact! (fn [& _])
       state/offer-file-rename-event-chan! (fn [_] (p/resolved nil))
       fs/rename! (fn [& _] (p/rejected (js/Error. "rename refused")))]
      (-> (binding [bridge/*test-runtime* runtime]
            (page-handler/rename-file! file "b" #(reset! ok-called? true)))
          (p/then (fn [value]
                    (is (nil? value))
                    (is (false? @ok-called?))
                    (is (= [:rename-intent :rename-failed]
                           (mapv :event @(:events runtime))))
                    (reset)))))))

(deftest disabled-watcher-boundary-keeps-ordinary-path
  (let [calls (atom [])]
    (with-redefs [watcher/reconcile-from-disk!
                  (fn [& args] (swap! calls conj args))
                  state/get-current-repo (constantly "graph-a")]
      (is (nil? (watcher/handle-changed! "change" {:path "pages/a.md"})))
      (is (empty? @calls)))))

(deftest enabled-unmatched-watcher-observation-remains-a-normal-local-edit
  (let [calls (atom [])
        runtime (test-runtime
                 {:complete-state! (constantly {:graph-id "graph-a"
                                                :new-path "pages/a.md"
                                                :new-present true
                                                :new-content-hash "not-a-retained-cause"})})]
    (with-redefs [config/get-local-repo (constantly "graph-a")
                  config/get-local-dir (constantly "/synthetic")
                  db/get-file (constantly "accepted bytes")
                  watcher/reconcile-from-disk! (fn [& args] (swap! calls conj args))]
      (binding [bridge/*test-runtime* runtime]
        (is (nil? (watcher/handle-changed!
                   "change" {:dir "/synthetic" :path "pages/a.md"
                             :content "ordinary local edit" :stat {:mtime 7}}))))
      (is (= 1 (count @calls)))
      (is (= :raw-watcher-observation (:event (last @(:events runtime))))))))

(deftest pending-success-failure-and-incoming-write-block
  (let [runtime (test-runtime)]
    (binding [bridge/*test-runtime* runtime]
      (let [pending (bridge/save-pending! "graph-a" "pages/a.md" "local")]
        (is (= :unfinished-local-write
               (:code (bridge/register-incoming-cause!
                       {:cause-id "incoming-1" :graph-id "graph-a" :kind :update
                        :path "pages/a.md" :content-hash "hash:incoming"}))))
        (bridge/save-completed! pending :ok)
        (is (= :pending
               (:status (bridge/register-incoming-cause!
                         {:cause-id "incoming-1" :graph-id "graph-a" :kind :update
                          :path "pages/a.md" :content-hash "hash:incoming"}))))
        (let [failed (bridge/save-pending! "graph-b" "pages/b.md" "B")]
          (bridge/save-failed! failed (js/Error. "rejected"))
          (is (= :failed (get-in @(:state runtime) [:writes (:cause-id failed) :status]))))))))

(deftest watcher-matching-local-incoming-ambiguous-and-different-edits
  (let [complete (atom nil)
        reconcile-count (atom 0)
        runtime (test-runtime {:complete-state! (fn [_] @complete)
                               :reconcile! (fn [& _] (swap! reconcile-count inc) :ok)})]
    (binding [bridge/*test-runtime* runtime]
      (let [local (bridge/save-pending! "graph-a" "pages/a.md" "local")
            _ (bridge/save-completed! local :ok)
            local-cause (get-in @(:state runtime) [:causes (:cause-id local)])]
        (reset! complete {:graph-id "graph-a" :new-path "pages/a.md" :new-present true
                          :new-content-hash (:content-hash local-cause)})
        (is (= :completed-local
               (:status (bridge/observe-watcher! "change" "/synthetic" "pages/a.md"
                                                 "local" {} false))))
        (reset! complete {:graph-id "graph-a" :new-path "pages/a.md" :new-present true
                          :new-content-hash "different-edit"})
        (is (= {:status :ordinary :match-count 0}
               (bridge/observe-watcher! "change" "/synthetic" "pages/a.md"
                                        "different" {} false))))
      (bridge/register-incoming-cause!
       {:cause-id "incoming-a" :operation-id "op-a" :graph-id "graph-a"
        :kind :update :path "pages/in.md" :content-hash "incoming-hash"})
      (reset! complete {:graph-id "graph-a" :new-path "pages/in.md" :new-present true
                        :new-content-hash "incoming-hash"})
      (is (= :reconciled (:status (bridge/observe-watcher! "change" "/synthetic"
                                                           "pages/in.md" "incoming" {} false))))
      (is (= :echo (:status (bridge/observe-watcher! "change" "/synthetic"
                                                     "pages/in.md" "incoming" {} false))))
      (is (= 1 @reconcile-count))
      (bridge/register-incoming-cause!
       {:cause-id "incoming-b" :operation-id "op-b" :graph-id "graph-a"
        :kind :update :path "pages/ambiguous.md" :content-hash "same"})
      (bridge/register-incoming-cause!
       {:cause-id "incoming-c" :operation-id "op-c" :graph-id "graph-a"
        :kind :update :path "pages/ambiguous.md" :content-hash "same"})
      (reset! complete {:graph-id "graph-a" :new-path "pages/ambiguous.md"
                        :new-present true :new-content-hash "same"})
      (is (= {:status :ordinary :match-count 2}
             (bridge/observe-watcher! "change" "/synthetic" "pages/ambiguous.md"
                                      "same" {} false))))))

(deftest reconciliation-failure-is-retryable-before-echo-deduplication
  (let [attempts (atom 0)
        complete {:graph-id "graph-a" :old-path "pages/a.md" :old-present false
                  :new-path "pages/b.md" :new-present true :new-content-hash "renamed"}
        runtime (test-runtime {:complete-state! (constantly complete)
                               :reconcile! (fn [& _]
                                             (if (= 1 (swap! attempts inc))
                                               (throw (js/Error. "first reconciliation failed"))
                                               :ok))})]
    (binding [bridge/*test-runtime* runtime]
      (bridge/register-incoming-cause!
       {:cause-id "incoming-rename" :operation-id "op-rename" :graph-id "graph-a"
        :kind :rename :old-path "pages/a.md" :new-path "pages/b.md"
        :content-hash "renamed"})
      (is (= :reconciliation-failed
             (:status (bridge/observe-watcher! "add" "/synthetic" "pages/b.md"
                                               "renamed" {} false))))
      (is (= :reconcile-pending
             (get-in @(:state runtime) [:causes "incoming-rename" :status])))
      (is (= :reconciled
             (:status (bridge/observe-watcher! "add" "/synthetic" "pages/b.md"
                                               "renamed" {} false))))
      (is (= :echo
             (:status (bridge/observe-watcher! "add" "/synthetic" "pages/b.md"
                                               "renamed" {} false))))
      (is (= 2 @attempts)))))

(deftest serialized-active-restart-revalidates-and-blocks-incompatible-batches
  (let [runtime (test-runtime)
        started (binding [bridge/*test-runtime* runtime]
                  (bridge/start-active! (active-inputs)))
        transaction-id (get-in started [:envelope :transaction-id])
        restarted (test-runtime {:stored (:stored runtime)})]
    (is (= :active (:status started)))
    (binding [bridge/*test-runtime* restarted]
      (is (= :recovery-pending (:status (bridge/recover-active!))))
      (is (= :incompatible-active
             (:code (bridge/start-active! (assoc (active-inputs)
                                                 :target-generation "generation-3")))))
      (is (= :files-applied (:status (bridge/mark-files-applied! transaction-id))))
      (is (= :identity-evidence-incomplete
             (:code (bridge/accept-identity! transaction-id {:checkpoint-match true}))))
      (is (= :identity-accepted
             (:status (bridge/accept-identity!
                       transaction-id
                       {:files-match true :identity-bytes-match true
                        :checkpoint-match true :binding-match true}))))
      (is (= :complete (:status (bridge/finish-active! transaction-id))))
      (is (nil? @(:stored restarted))))))

(deftest persisted-reconciliation-result-survives-simulated-restart
  (let [complete {:graph-id "graph-a" :new-path "pages/in.md" :new-present true
                  :new-content-hash "incoming-hash"}
        cause {:cause-id "incoming-active" :operation-id "op-1" :graph-id "graph-a"
               :kind :update :path "pages/in.md" :content-hash "incoming-hash"}
        attempts (atom 0)
        runtime (test-runtime {:complete-state! (constantly complete)
                               :reconcile! (fn [& _] (swap! attempts inc) :ok)})
        started (binding [bridge/*test-runtime* runtime]
                  (bridge/start-active! (assoc (active-inputs) :causes [cause])))]
    (binding [bridge/*test-runtime* runtime]
      (is (= :reconciled
             (:status (bridge/observe-watcher! "change" "/synthetic" "pages/in.md"
                                               "incoming" {} false)))))
    (let [restart-attempts (atom 0)
          restarted (test-runtime {:stored (:stored runtime)
                                   :complete-state! (constantly complete)
                                   :reconcile! (fn [& _] (swap! restart-attempts inc) :ok)})]
      (binding [bridge/*test-runtime* restarted]
        (is (= :recovery-pending (:status (bridge/recover-active!))))
        (is (= :echo
               (:status (bridge/observe-watcher! "change" "/synthetic" "pages/in.md"
                                                 "incoming" {} false))))
        (is (= :reconciled
               (get-in @(:state restarted) [:causes "incoming-active" :status]))))
      (is (= 1 @attempts))
      (is (zero? @restart-attempts))
      (is (= (get-in started [:envelope :transaction-id])
             (get-in @(:state restarted) [:active :transaction-id]))))))

(deftest restart-refuses-tampered-inputs-and-nonauthoritative-plan
  (let [runtime (test-runtime)
        _ (binding [bridge/*test-runtime* runtime]
            (bridge/start-active! (active-inputs)))
        parsed (bridge/deserialize-active @(:stored runtime))
        tampered (assoc-in parsed [:inputs :target :files 0 :content] "tampered")
        tampered-runtime (test-runtime {:stored (atom (bridge/serialize-active tampered))})]
    (binding [bridge/*test-runtime* tampered-runtime]
      (is (= :tampered-active (:code (bridge/recover-active!)))))
    (let [wrong-plan-runtime (test-runtime {:stored (:stored runtime)
                                            :revalidate-plan! (constantly {:plan-id "other"})})]
      (binding [bridge/*test-runtime* wrong-plan-runtime]
        (is (= :plan-mismatch (:code (bridge/recover-active!))))))))
