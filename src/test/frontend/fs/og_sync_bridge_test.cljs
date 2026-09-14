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
         progress-evidence (or (:progress-evidence overrides) (atom #{}))
         files-evidence (or (:files-evidence overrides) (atom #{}))
         acceptance-evidence (or (:acceptance-evidence overrides) (atom #{}))
         counter (atom 0)
         runtime {:state (atom {:causes {} :writes {}})
                  :events events
                  :stored stored
                  :progress-evidence progress-evidence
                  :files-evidence files-evidence
                  :acceptance-evidence acceptance-evidence
                  :adapter! #(swap! events conj %)
                  :next-id! (fn [kind] (str (name kind) "-" (swap! counter inc)))
                  :rename-content-hash! (fn [_graph _path] "hash:rename")
                  :complete-state! (constantly nil)
                  :reconcile! (fn [& _] :reconciled)
                  :record-reconciliation-progress!
                  (fn [active cause _result]
                    (let [receipt {:transaction-id (:transaction-id active)
                                   :cause-id (:cause-id cause)
                                   :operation-id (:operation-id cause)}]
                      (swap! progress-evidence conj receipt)
                      receipt))
                  :validate-reconciliation-progress!
                  (fn [_active _cause entry]
                    (contains? @progress-evidence (:receipt entry)))
                  :save-active! #(reset! stored %)
                  :load-active! #(deref stored)
                  :clear-active! #(reset! stored nil)
                  :record-files-applied!
                  (fn [active]
                    (let [receipt {:transaction-id (:transaction-id active)}]
                      (swap! files-evidence conj receipt)
                      receipt))
                  :validate-files-applied-progress!
                  (fn [_active entry]
                    (contains? @files-evidence (:receipt entry)))
                  :revalidate-plan! :authoritative-plan
                  :validate-binding! #(= {:root-id "root-1" :graph-id "graph-a"} %)
                  :validate-acceptance!
                  (fn [_active evidence]
                    (= #{:files-match :identity-bytes-match :checkpoint-match :binding-match}
                       (set (keep (fn [[key value]] (when value key)) evidence))))
                  :record-identity-acceptance!
                  (fn [active _evidence]
                    (let [receipt {:transaction-id (:transaction-id active)}]
                      (swap! acceptance-evidence conj receipt)
                      receipt))
                  :validate-identity-acceptance-progress!
                  (fn [_active entry]
                    (contains? @acceptance-evidence (:receipt entry)))}]
     (merge runtime (dissoc overrides :stored :progress-evidence :files-evidence
                                    :acceptance-evidence)))))

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

(defn- deferred
  []
  (let [resolve! (atom nil)
        reject! (atom nil)
        promise (js/Promise. (fn [resolve reject]
                               (reset! resolve! resolve)
                               (reset! reject! reject)))]
    {:promise promise :resolve! @resolve! :reject! @reject!}))

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

(deftest-async watcher-matching-local-incoming-ambiguous-and-different-edits
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
      (let [pending (bridge/observe-watcher! "change" "/synthetic"
                                             "pages/in.md" "incoming" {} false)]
        (is (= :reconciliation-pending (:status pending)))
        (-> (:settled pending)
            (p/then
             (fn [settled]
               (is (= :reconciled (:status settled)))
               (is (= :echo
                      (:status (binding [bridge/*test-runtime* runtime]
                                 (bridge/observe-watcher! "change" "/synthetic"
                                                          "pages/in.md" "incoming" {} false)))))
               (is (= 1 @reconcile-count))
               (binding [bridge/*test-runtime* runtime]
                 (bridge/register-incoming-cause!
                  {:cause-id "incoming-b" :operation-id "op-b" :graph-id "graph-a"
                   :kind :update :path "pages/ambiguous.md" :content-hash "same"})
                 (bridge/register-incoming-cause!
                  {:cause-id "incoming-c" :operation-id "op-c" :graph-id "graph-a"
                   :kind :update :path "pages/ambiguous.md" :content-hash "same"}))
               (reset! complete {:graph-id "graph-a" :new-path "pages/ambiguous.md"
                                 :new-present true :new-content-hash "same"})
               (let [ambiguous (binding [bridge/*test-runtime* runtime]
                                 (bridge/observe-watcher! "change" "/synthetic"
                                                          "pages/ambiguous.md" "same" {} false))]
                 (is (= {:status :ordinary :match-count 2} ambiguous))))))))))

(deftest-async reconciliation-failure-is-retryable-before-echo-deduplication
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
      (let [first-result (bridge/observe-watcher! "add" "/synthetic" "pages/b.md"
                                                  "renamed" {} false)]
        (is (= :reconciliation-pending (:status first-result)))
        (p/let [failure (:settled first-result)
                _ (is (= :reconciliation-failed (:status failure)))
                _ (is (= :reconcile-pending
                         (get-in @(:state runtime) [:causes "incoming-rename" :status])))
                retry (binding [bridge/*test-runtime* runtime]
                        (bridge/observe-watcher! "add" "/synthetic" "pages/b.md"
                                                 "renamed" {} false))
                success (:settled retry)]
          (is (= :reconciled (:status success)))
          (is (= :echo
                 (:status (binding [bridge/*test-runtime* runtime]
                            (bridge/observe-watcher! "add" "/synthetic"
                                                     "pages/b.md" "renamed" {} false)))))
          (is (= 2 @attempts)))))))

(deftest-async serialized-active-restart-revalidates-and-blocks-incompatible-batches
  (let [runtime (test-runtime)]
    (p/let [started (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active! (active-inputs)))
            transaction-id (get-in started [:envelope :transaction-id])
            restarted (test-runtime {:stored (:stored runtime)})
            recovery (binding [bridge/*test-runtime* restarted]
                       (bridge/recover-active!))
            incompatible (binding [bridge/*test-runtime* restarted]
                           (bridge/start-active! (assoc (active-inputs)
                                                       :target-generation "generation-3")))
            files-applied (binding [bridge/*test-runtime* restarted]
                            (bridge/mark-files-applied! transaction-id))
            incomplete (binding [bridge/*test-runtime* restarted]
                         (bridge/accept-identity! transaction-id {:checkpoint-match true}))
            accepted (binding [bridge/*test-runtime* restarted]
                       (bridge/accept-identity!
                        transaction-id
                        {:files-match true :identity-bytes-match true
                         :checkpoint-match true :binding-match true}))
            finished (binding [bridge/*test-runtime* restarted]
                       (bridge/finish-active! transaction-id))]
      (is (= :active (:status started)))
      (is (= :recovery-pending (:status recovery)))
      (is (= :incompatible-active (:code incompatible)))
      (is (= :files-applied (:status files-applied)))
      (is (= :identity-evidence-incomplete (:code incomplete)))
      (is (= :identity-accepted (:status accepted)))
      (is (= :complete (:status finished)))
      (is (nil? @(:stored restarted))))))

(deftest-async persisted-reconciliation-result-survives-simulated-restart
  (let [complete {:graph-id "graph-a" :new-path "pages/in.md" :new-present true
                  :new-content-hash "incoming-hash"}
        cause {:cause-id "incoming-active" :operation-id "op-1" :graph-id "graph-a"
               :kind :update :path "pages/in.md" :content-hash "incoming-hash"}
        attempts (atom 0)
        runtime (test-runtime {:complete-state! (constantly complete)
                               :reconcile! (fn [& _] (swap! attempts inc) :ok)})]
    (p/let [started (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active! (assoc (active-inputs) :causes [cause])))
            observation (binding [bridge/*test-runtime* runtime]
                          (bridge/observe-watcher! "change" "/synthetic" "pages/in.md"
                                                   "incoming" {} false))
            settled (:settled observation)
            restart-attempts (atom 0)
            restarted (test-runtime {:stored (:stored runtime)
                                     :progress-evidence (:progress-evidence runtime)
                                     :complete-state! (constantly complete)
                                     :reconcile! (fn [& _] (swap! restart-attempts inc) :ok)})
            recovery (binding [bridge/*test-runtime* restarted]
                       (bridge/recover-active!))]
      (is (= :active (:status started)))
      (is (= :reconciled (:status settled)))
      (is (= :recovery-pending (:status recovery)))
      (is (= :echo
             (:status (binding [bridge/*test-runtime* restarted]
                        (bridge/observe-watcher! "change" "/synthetic" "pages/in.md"
                                                 "incoming" {} false)))))
      (is (= :reconciled
             (get-in @(:state restarted) [:causes "incoming-active" :status])))
      (is (= 1 @attempts))
      (is (zero? @restart-attempts))
      (is (= (get-in started [:envelope :transaction-id])
             (get-in @(:state restarted) [:active :transaction-id]))))))

(deftest-async restart-refuses-tampered-inputs-and-nonauthoritative-plan
  (let [runtime (test-runtime)]
    (p/let [_ (binding [bridge/*test-runtime* runtime]
                (bridge/start-active! (active-inputs)))
            parsed (bridge/deserialize-active @(:stored runtime))
            tampered (assoc-in parsed [:inputs :target :files 0 :content] "tampered")
            tampered-runtime (test-runtime {:stored (atom (bridge/serialize-active tampered))})
            tampered-result (binding [bridge/*test-runtime* tampered-runtime]
                              (bridge/recover-active!))
            wrong-plan-runtime (test-runtime {:stored (:stored runtime)
                                              :revalidate-plan! (constantly {:plan-id "other"})})
            wrong-plan-result (binding [bridge/*test-runtime* wrong-plan-runtime]
                                (bridge/recover-active!))]
      (is (= :tampered-active (:code tampered-result)))
      (is (= :plan-mismatch (:code wrong-plan-result))))))

(deftest-async pending-reconciliation-settlement-controls-echo-and-deduplicates-in-flight-work
  (let [{:keys [promise resolve!]} (deferred)
        attempts (atom 0)
        complete {:graph-id "graph-a" :new-path "pages/in.md" :new-present true
                  :new-content-hash "incoming-hash"}
        runtime (test-runtime {:complete-state! (constantly complete)
                               :reconcile! (fn [& _] (swap! attempts inc) promise)})]
    (binding [bridge/*test-runtime* runtime]
      (bridge/register-incoming-cause!
       {:cause-id "async-incoming" :operation-id "op-async" :graph-id "graph-a"
        :kind :update :path "pages/in.md" :content-hash "incoming-hash"})
      (let [first-result (bridge/observe-watcher! "change" "/synthetic" "pages/in.md"
                                                  "incoming" {} false)
            duplicate-result (bridge/observe-watcher! "change" "/synthetic" "pages/in.md"
                                                      "incoming" {} false)]
        (is (= :reconciliation-pending (:status first-result)))
        (is (= :reconciliation-pending (:status duplicate-result)))
        (is (= 1 @attempts))
        (is (= :reconciling
               (get-in @(:state runtime) [:causes "async-incoming" :status])))
        (resolve! :ok)
        (-> (or (:settled first-result) promise)
            (p/then (fn [_]
                      (is (= :reconciled
                             (get-in @(:state runtime) [:causes "async-incoming" :status])))
                      (is (= :echo
                             (:status (binding [bridge/*test-runtime* runtime]
                                        (bridge/observe-watcher! "change" "/synthetic"
                                                                 "pages/in.md" "incoming" {} false)))))
                      (is (= 1 @attempts)))))))))

(deftest-async rejected-reconciliation-promise-preserves-retryable-evidence
  (let [{:keys [promise reject!]} (deferred)
        _handled (.catch promise (fn [_] nil))
        complete {:graph-id "graph-a" :new-path "pages/in.md" :new-present true
                  :new-content-hash "incoming-hash"}
        runtime (test-runtime {:complete-state! (constantly complete)
                               :reconcile! (fn [& _] promise)})]
    (binding [bridge/*test-runtime* runtime]
      (bridge/register-incoming-cause!
       {:cause-id "rejected-incoming" :operation-id "op-rejected" :graph-id "graph-a"
        :kind :update :path "pages/in.md" :content-hash "incoming-hash"})
      (let [result (bridge/observe-watcher! "change" "/synthetic" "pages/in.md"
                                            "incoming" {} false)]
        (is (= :reconciliation-pending (:status result)))
        (reject! (js/Error. "async reconciliation rejected"))
        (-> (or (:settled result) (.catch promise identity))
            (p/then (fn [_]
                      (is (= :reconcile-pending
                             (get-in @(:state runtime) [:causes "rejected-incoming" :status])))
                      (is (not= :echo
                                (:status (binding [bridge/*test-runtime* runtime]
                                           (bridge/observe-watcher! "change" "/synthetic"
                                                                    "pages/in.md" "incoming" {} false))))))))))))

(deftest pending-rename-blocks-both-paths-but-not-unrelated-work
  (doseq [[blocked-path close!] [["pages/a.md" bridge/rename-completed!]
                                 ["pages/b.md" bridge/rename-failed!]]]
    (let [runtime (test-runtime)]
      (binding [bridge/*test-runtime* runtime]
        (let [rename (bridge/rename-intent! "graph-a" "pages/a.md" "pages/b.md")]
          (is (= :unfinished-local-write
                 (:code (bridge/register-incoming-cause!
                         {:cause-id (str "blocked-" blocked-path) :graph-id "graph-a"
                          :kind :update :path blocked-path :content-hash "incoming"}))))
          (is (= :pending
                 (:status (bridge/register-incoming-cause!
                           {:cause-id (str "unrelated-" blocked-path) :graph-id "graph-a"
                            :kind :update :path "pages/c.md" :content-hash "incoming"}))))
          (is (= :pending
                 (:status (bridge/register-incoming-cause!
                           {:cause-id (str "other-graph-" blocked-path) :graph-id "graph-b"
                            :kind :update :path blocked-path :content-hash "incoming"}))))
          (close! rename :closed)
          (is (= :pending
                 (:status (bridge/register-incoming-cause!
                           {:cause-id (str "after-close-" blocked-path) :graph-id "graph-a"
                            :kind :update :path blocked-path :content-hash "incoming"})))))))))

(deftest-async progress-recording-failure-does-not-enable-echo-and-can-retry
  (let [stored (atom nil)
        save-count (atom 0)
        rejected-save (p/rejected (js/Error. "progress store failed"))
        _handled (.catch rejected-save (fn [_] nil))
        complete {:graph-id "graph-a" :new-path "pages/in.md" :new-present true
                  :new-content-hash "incoming-hash"}
        cause {:cause-id "progress-cause" :operation-id "op-1" :graph-id "graph-a"
               :kind :update :path "pages/in.md" :content-hash "incoming-hash"}
        runtime (test-runtime {:stored stored
                               :complete-state! (constantly complete)
                               :save-active! (fn [serialized]
                                               (case (swap! save-count inc)
                                                 1 (reset! stored serialized)
                                                 2 rejected-save
                                                 (reset! stored serialized)))})]
    (p/let [started (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active! (assoc (active-inputs) :causes [cause])))
            first-result (binding [bridge/*test-runtime* runtime]
                           (bridge/observe-watcher! "change" "/synthetic" "pages/in.md"
                                                    "incoming" {} false))
            first-settlement (:settled first-result)]
      (is (= :active (:status started)))
      (is (= :reconciliation-pending (:status first-result)))
      (is (= :reconciliation-failed (:status first-settlement)))
      (is (= :reconcile-pending
             (get-in @(:state runtime) [:causes "progress-cause" :status])))
      (let [retry (binding [bridge/*test-runtime* runtime]
                    (bridge/observe-watcher! "change" "/synthetic" "pages/in.md"
                                             "incoming" {} false))]
        (p/let [retry-settlement (:settled retry)]
          (is (= :reconciled (:status retry-settlement)))
          (is (= :echo
                 (:status (binding [bridge/*test-runtime* runtime]
                            (bridge/observe-watcher! "change" "/synthetic"
                                                     "pages/in.md" "incoming" {} false))))))))))

(deftest-async asynchronous-active-storage-settles-before-runtime-commit
  (let [{save-promise :promise resolve-save! :resolve!} (deferred)
        pending-runtime (test-runtime {:save-active! (fn [_] save-promise)})
        pending-start (binding [bridge/*test-runtime* pending-runtime]
                        (bridge/start-active! (active-inputs)))
        {reject-promise :promise reject-save! :reject!} (deferred)
        rejected-runtime (test-runtime {:save-active! (fn [_] reject-promise)})
        rejected-start (binding [bridge/*test-runtime* rejected-runtime]
                         (bridge/start-active! (active-inputs)))]
    (is (nil? (:active @(:state pending-runtime))))
    (is (nil? (:active @(:state rejected-runtime))))
    (resolve-save! :stored)
    (reject-save! (js/Error. "synthetic ACTIVE store rejected"))
    (p/let [started pending-start
            refused rejected-start]
      (is (= :active (:status started)))
      (is (some? (:active @(:state pending-runtime))))
      (is (= :active-refused (:code refused)))
      (is (nil? (:active @(:state rejected-runtime)))))))

(deftest synchronous-watcher-port-rejects-thenables
  (let [runtime (test-runtime {:complete-state! (fn [_] (p/resolved nil))})]
    (binding [bridge/*test-runtime* runtime]
      (is (= :ordinary
             (:status (bridge/observe-watcher! "change" "/synthetic"
                                                "pages/a.md" "A" {} false))))
      (is (= :coordination-blocked
             (:code (bridge/observe-watcher! "change" "/synthetic"
                                              "pages/a.md" "A" {} false))))
      (is (= :watcher-complete-state
             (get-in @(:state runtime) [:blocked :phase]))))))

(deftest-async restart-does-not-trust-phase-or-forged-progress-and-failed-recovery-blocks-new-work
  (let [cause {:cause-id "restart-cause" :operation-id "op-1" :graph-id "graph-a"
               :kind :update :path "pages/in.md" :content-hash "incoming-hash"}
        runtime (test-runtime)]
    (p/let [started (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active! (assoc (active-inputs) :causes [cause])))
            base (bridge/deserialize-active @(:stored runtime))
            forged-phase (assoc base :phase :identity-accepted)
            forged-runtime (test-runtime {:stored (atom (bridge/serialize-active forged-phase))})
            forged-recovery (binding [bridge/*test-runtime* forged-runtime]
                              (bridge/recover-active!))
            forged-finish (binding [bridge/*test-runtime* forged-runtime]
                            (bridge/finish-active! (:transaction-id base)))
            forged-entry {:transaction-id (:transaction-id base)
                          :cause-id "restart-cause"
                          :operation-id "op-1"
                          :receipt {:forged true}}
            forged-progress (assoc-in base [:progress :reconciled "restart-cause"]
                                      forged-entry)
            forged-progress-runtime
            (test-runtime {:stored (atom (bridge/serialize-active forged-progress))})
            forged-progress-result
            (binding [bridge/*test-runtime* forged-progress-runtime]
              (bridge/recover-active!))
            unknown-progress (assoc-in base [:progress :reconciled "unknown-cause"] true)
            unknown-runtime (test-runtime {:stored (atom (bridge/serialize-active unknown-progress))})
            unknown-result (binding [bridge/*test-runtime* unknown-runtime]
                             (bridge/recover-active!))
            tampered (assoc-in base [:inputs :target :files 0 :content] "tampered")
            blocked-runtime (test-runtime {:stored (atom (bridge/serialize-active tampered))})
            tampered-result (binding [bridge/*test-runtime* blocked-runtime]
                              (bridge/recover-active!))
            after-failure (binding [bridge/*test-runtime* blocked-runtime]
                            (bridge/start-active! (active-inputs)))]
      (is (= :active (:status started)))
      (is (= :recovery-pending (:status forged-recovery)))
      (is (= :reconcile-pending
             (get-in @(:state forged-runtime) [:causes "restart-cause" :status])))
      (is (= :acceptance-pending (:code forged-finish)))
      (is (= :recovery-pending (:status forged-progress-result)))
      (is (= :reconcile-pending
             (get-in @(:state forged-progress-runtime)
                     [:causes "restart-cause" :status])))
      (is (= :invalid-progress (:code unknown-result)))
      (is (= :tampered-active (:code tampered-result)))
      (is (= :coordination-blocked (:code after-failure))))))
