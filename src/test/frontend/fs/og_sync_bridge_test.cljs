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

(defn- incoming-cause
  [cause-id operation-id path]
  {:cause-id cause-id :operation-id operation-id :graph-id "graph-a"
   :kind :update :path path :content-hash (str "hash-" cause-id)})

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
      (is (= :raw-watcher-observation (:event (last @(:events runtime)))))
      (is (= "graph-a"
             (get-in (last @(:events runtime)) [:observation :graph-id]))))))

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
      (is (= :active-save-uncertain (:code refused)))
      (is (nil? (:active @(:state rejected-runtime))))
      ;; The unproven rejection reserves the exact attempted transaction as
      ;; recovery-required evidence; nothing was proven about the store.
      (is (some? (:uncertain-active @(:state rejected-runtime)))))))

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

(deftest-async concurrent-incompatible-starts-serialize-active-ownership
  (let [stored (atom nil)
        save-count (atom 0)
        {binding-promise :promise resolve-binding! :resolve!} (deferred)
        runtime (test-runtime {:stored stored
                               :validate-binding! (fn [_] binding-promise)
                               :save-active! (fn [serialized]
                                               (swap! save-count inc)
                                               (reset! stored serialized))})
        first-start (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active! (active-inputs)))
        second-start (binding [bridge/*test-runtime* runtime]
                       (bridge/start-active!
                        (assoc (active-inputs) :target-generation "generation-3")))]
    (is (nil? @stored))
    (resolve-binding! true)
    (p/let [first-result first-start
            second-result second-start]
      (is (= :active (:status first-result)))
      (is (= :incompatible-active (:code second-result)))
      (is (= (get-in first-result [:envelope :transaction-id])
             (get-in @(:state runtime) [:active :transaction-id])))
      (is (= (get-in first-result [:envelope :transaction-id])
             (:transaction-id (bridge/deserialize-active @stored))))
      (is (= 1 @save-count)))))

(deftest-async exact-duplicate-starts-share-one-active-record
  (let [stored (atom nil)
        save-count (atom 0)
        {binding-promise :promise resolve-binding! :resolve!} (deferred)
        runtime (test-runtime {:stored stored
                               :validate-binding! (fn [_] binding-promise)
                               :save-active! (fn [serialized]
                                               (swap! save-count inc)
                                               (reset! stored serialized))})
        first-start (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active! (active-inputs)))
        second-start (binding [bridge/*test-runtime* runtime]
                       (bridge/start-active! (active-inputs)))]
    (resolve-binding! true)
    (p/let [first-result first-start
            second-result second-start]
      (is (= :active (:status first-result)))
      (is (= :already-active (:status second-result)))
      (is (= (get-in first-result [:envelope :transaction-id])
             (get-in second-result [:envelope :transaction-id])))
      (is (= 1 @save-count)))))

(deftest-async reversed-reconciliation-completions-preserve-every-progress-entry
  (let [cause-a (incoming-cause "rev-a" "op-a" "pages/rev-a.md")
        cause-b (incoming-cause "rev-b" "op-b" "pages/rev-b.md")
        completes {"pages/rev-a.md" {:graph-id "graph-a" :new-path "pages/rev-a.md"
                                    :new-present true :new-content-hash "hash-rev-a"}
                   "pages/rev-b.md" {:graph-id "graph-a" :new-path "pages/rev-b.md"
                                     :new-present true :new-content-hash "hash-rev-b"}}
        reconcile-handles (atom {})
        receipt-handles (atom {})
        deferred-for (fn [store cause-id]
                       (let [{:keys [promise resolve!]} (deferred)]
                         (swap! store assoc cause-id {:promise promise :resolve! resolve!})
                         promise))
        runtime (test-runtime
                 {:complete-state! (fn [observation] (get completes (:path observation)))
                  :reconcile! (fn [cause & _] (deferred-for reconcile-handles (:cause-id cause)))
                  :record-reconciliation-progress!
                  (fn [_active cause _result]
                    (deferred-for receipt-handles (:cause-id cause)))})]
    (p/let [_started (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active!
                       (-> (active-inputs)
                           (assoc :operation-ids ["op-a" "op-b"])
                           (assoc :causes [cause-a cause-b]))))]
      (let [observation-a (binding [bridge/*test-runtime* runtime]
                            (bridge/observe-watcher! "change" "/synthetic"
                                                     "pages/rev-a.md" "incoming" {} false))
            observation-b (binding [bridge/*test-runtime* runtime]
                            (bridge/observe-watcher! "change" "/synthetic"
                                                     "pages/rev-b.md" "incoming" {} false))]
        (p/let [_ (is (= :reconciliation-pending (:status observation-a)))
                _ (is (= :reconciliation-pending (:status observation-b)))
                ;; The distinct reconciliations complete in reversed order.
                _ ((:resolve! (get @reconcile-handles "rev-b")) :ok)
                _ (p/resolved nil)
                _ ((:resolve! (get @reconcile-handles "rev-a")) :ok)
                _ (p/resolved nil)
                ;; Both receipts settle after both completions captured the
                ;; shared ACTIVE record.
                _ (p/let [a (get @receipt-handles "rev-a")
                          b (get @receipt-handles "rev-b")]
                    ((:resolve! a) {:ledger :a})
                    ((:resolve! b) {:ledger :b}))
                settled-a (:settled observation-a)
                settled-b (:settled observation-b)]
          (is (= :reconciled (:status settled-a)))
          (is (= :reconciled (:status settled-b)))
          (is (= #{"rev-a" "rev-b"}
                 (set (keys (get-in @(:state runtime) [:active :progress :reconciled])))))
          (is (= :active (get-in @(:state runtime) [:active :phase])))
          (let [recovered (bridge/deserialize-active @(:stored runtime))]
            (is (= #{"rev-a" "rev-b"}
                   (set (keys (get-in recovered [:progress :reconciled])))))
            (is (= :active (:phase recovered)))))))))

(deftest-async reconciliation-overlapping-files-applied-progress-preserves-both
  (let [cause-a (incoming-cause "overlap-a" "op-1" "pages/overlap.md")
        complete {:graph-id "graph-a" :new-path "pages/overlap.md"
                  :new-present true :new-content-hash "hash-overlap-a"}
        {reconcile-promise :promise resolve-reconcile! :resolve!} (deferred)
        {receipt-promise :promise resolve-receipt! :resolve!} (deferred)
        runtime (test-runtime {:complete-state! (constantly complete)
                               :reconcile! (fn [& _] reconcile-promise)
                               :record-reconciliation-progress! (fn [& _] receipt-promise)})]
    (p/let [started (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active!
                       (assoc (active-inputs) :causes [cause-a])))
            transaction-id (get-in started [:envelope :transaction-id])
            observation (binding [bridge/*test-runtime* runtime]
                          (bridge/observe-watcher! "change" "/synthetic"
                                                   "pages/overlap.md" "incoming" {} false))
            _ (is (= :reconciliation-pending (:status observation)))
            _ (resolve-reconcile! :ok)
            ;; One microtask hop lets the reconciliation capture its ACTIVE
            ;; snapshot before files-applied progress is recorded.
            _ (p/resolved nil)
            marked (binding [bridge/*test-runtime* runtime]
                     (bridge/mark-files-applied! transaction-id))
            _ (is (= :files-applied (:status marked)))
            _ (resolve-receipt! {:ledger :overlap})
            settled (:settled observation)]
      (is (= :reconciled (:status settled)))
      (is (= :files-applied (get-in @(:state runtime) [:active :phase])))
      (is (some? (get-in @(:state runtime) [:active :progress :files-applied])))
      (is (= #{"overlap-a"} (set (keys (get-in @(:state runtime)
                                               [:active :progress :reconciled])))))
      (let [recovered (bridge/deserialize-active @(:stored runtime))]
        (is (= :files-applied (:phase recovered)))
        (is (some? (get-in recovered [:progress :files-applied])))
        (is (= #{"overlap-a"} (set (keys (get-in recovered [:progress :reconciled])))))))))

(deftest-async recovery-before-an-overlapping-start-keeps-the-recovered-active
  (let [stored (atom nil)
        seed (test-runtime {:stored stored})
        {binding-promise :promise resolve-binding! :resolve!} (deferred)
        binding-calls (atom 0)
        runtime (test-runtime
                 {:stored stored
                  :validate-binding!
                  (fn [binding]
                    (if (= 1 (swap! binding-calls inc))
                      binding-promise
                      (= {:root-id "root-1" :graph-id "graph-a"} binding)))})]
    (p/let [_ (binding [bridge/*test-runtime* seed]
                (bridge/start-active! (active-inputs)))]
      (let [recovery (binding [bridge/*test-runtime* runtime] (bridge/recover-active!))
            overlapping (binding [bridge/*test-runtime* runtime]
                          (bridge/start-active!
                           (assoc (active-inputs) :target-generation "generation-3")))]
        (is (nil? (:active @(:state runtime))))
        (resolve-binding! true)
        (p/let [recovery-result recovery
                start-result overlapping]
          (is (= :recovery-pending (:status recovery-result)))
          (is (= :incompatible-active (:code start-result)))
          (is (= (get-in recovery-result [:envelope :transaction-id])
                 (get-in @(:state runtime) [:active :transaction-id])))
          (is (= (get-in recovery-result [:envelope :transaction-id])
                 (:transaction-id (bridge/deserialize-active @stored)))))))))

(deftest-async start-before-an-overlapping-recovery-recovers-the-persisted-record
  (let [stored (atom nil)
        seed (test-runtime {:stored stored})
        {binding-promise :promise resolve-binding! :resolve!} (deferred)
        binding-calls (atom 0)
        runtime (test-runtime
                 {:stored stored
                  :validate-binding!
                  (fn [binding]
                    (if (= 1 (swap! binding-calls inc))
                      binding-promise
                      (= {:root-id "root-1" :graph-id "graph-a"} binding)))})]
    (p/let [_ (binding [bridge/*test-runtime* seed]
                (bridge/start-active! (active-inputs)))]
      (let [overlapping (binding [bridge/*test-runtime* runtime]
                          (bridge/start-active!
                           (assoc (active-inputs) :target-generation "generation-3")))
            recovery (binding [bridge/*test-runtime* runtime] (bridge/recover-active!))]
        (resolve-binding! true)
        (p/let [start-result overlapping
                recovery-result recovery]
          (is (= :active (:status start-result)))
          (is (= :recovery-pending (:status recovery-result)))
          (is (= (get-in start-result [:envelope :transaction-id])
                 (get-in recovery-result [:envelope :transaction-id])))
          (is (= (get-in start-result [:envelope :transaction-id])
                 (get-in @(:state runtime) [:active :transaction-id])))
          (is (= (get-in start-result [:envelope :transaction-id])
                 (:transaction-id (bridge/deserialize-active @stored)))))))))

(deftest-async delayed-finish-cannot-clear-a-newer-active-lifecycle
  (let [stored (atom nil)
        replacement (test-runtime {:stored stored})
        {recover-binding-promise :promise resolve-recover-binding! :resolve!} (deferred)
        {clear-promise :promise resolve-clear! :resolve!} (deferred)
        clear-calls (atom 0)
        deferred-phase? (atom false)
        binding-calls (atom 0)
        runtime (test-runtime
                 {:stored stored
                  :clear-active! (fn [_]
                                   (swap! clear-calls inc)
                                   (reset! stored nil)
                                   clear-promise)
                  :validate-binding!
                  (fn [binding]
                    (if (and @deferred-phase? (= 1 (swap! binding-calls inc)))
                      recover-binding-promise
                      (= {:root-id "root-1" :graph-id "graph-a"} binding)))})]
    (p/let [started (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active! (active-inputs)))
            transaction-id (get-in started [:envelope :transaction-id])
            _ (binding [bridge/*test-runtime* runtime]
                (bridge/mark-files-applied! transaction-id))
            _ (binding [bridge/*test-runtime* runtime]
                (bridge/accept-identity!
                 transaction-id
                 {:files-match true :identity-bytes-match true
                  :checkpoint-match true :binding-match true}))
            ;; A second lifecycle replaces the persisted record.
            replacement-started (binding [bridge/*test-runtime* replacement]
                                 (bridge/start-active!
                                  (assoc (active-inputs)
                                         :target-generation "generation-3")))
            replacement-id (get-in replacement-started [:envelope :transaction-id])]
      ;; Recovery of that record and a delayed finish of the completed
      ;; lifecycle are both reserved before either settles.
      (reset! deferred-phase? true)
      (let [recovery (binding [bridge/*test-runtime* runtime] (bridge/recover-active!))
            delayed-finish (binding [bridge/*test-runtime* runtime]
                             (bridge/finish-active! transaction-id))]
        (resolve-recover-binding! true)
        (resolve-clear! :cleared)
        (p/let [recovery-result recovery
                finish-result delayed-finish]
          (is (= :recovery-pending (:status recovery-result)))
          (is (= :acceptance-pending (:code finish-result)))
          (is (= replacement-id (get-in @(:state runtime) [:active :transaction-id])))
          (let [recovered (when @stored (bridge/deserialize-active @stored))]
            (is (= replacement-id (:transaction-id recovered))))
          (is (zero? @clear-calls)))))))

(deftest-async files-applied-persistence-rejection-preserves-active-and-evidence
  (let [stored (atom nil)
        save-count (atom 0)
        rejected-save (p/rejected (js/Error. "files-applied store failed"))
        _handled (.catch rejected-save (fn [_] nil))
        runtime (test-runtime
                 {:stored stored
                  :save-active! (fn [serialized]
                                  (case (swap! save-count inc)
                                    1 (reset! stored serialized)
                                    2 rejected-save
                                    (reset! stored serialized)))})]
    (p/let [started (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active! (active-inputs)))
            transaction-id (get-in started [:envelope :transaction-id])
            refused (binding [bridge/*test-runtime* runtime]
                      (bridge/mark-files-applied! transaction-id))]
      (is (= :progress-recording-failed (:code refused)))
      (is (= :active (get-in @(:state runtime) [:active :phase])))
      (is (nil? (get-in @(:state runtime) [:active :progress :files-applied])))
      (is (seq @(:files-evidence runtime)))
      (p/let [retried (binding [bridge/*test-runtime* runtime]
                        (bridge/mark-files-applied! transaction-id))]
        (is (= :files-applied (:status retried)))
        (is (= :files-applied (get-in @(:state runtime) [:active :phase])))
        (is (some? (get-in @(:state runtime) [:active :progress :files-applied])))
        (is (= :files-applied (:phase (bridge/deserialize-active @stored))))))))

(deftest-async reentrant-non-awaiting-callback-queues-nested-work-and-settles
  ;; The supported reentrancy contract: a callback invoked from inside a
  ;; running coordination turn may reenter the bridge and reserve further
  ;; turns, but it must return its own value without awaiting the nested
  ;; turn's result. Awaiting it would wait on a turn that cannot run until
  ;; the callback's own turn settles. The FIFO boundary does not detect or
  ;; refuse that pattern, the port contract forbids it, and this test covers
  ;; only the non-awaiting shape — it does not prove general deadlock
  ;; freedom.
  (let [stored (atom nil)
        reentered (atom nil)
        base (test-runtime {:stored stored})
        ;; The port is created after the runtime exists, so the closure holds a
        ;; bound runtime value rather than capturing its own let binding.
        runtime (assoc base
                       :record-files-applied!
                       (fn [active]
                         ;; Reenter the bridge synchronously from inside the
                         ;; port that mark-files-applied! awaits.
                         (reset! reentered
                                 (binding [bridge/*test-runtime* base]
                                   (bridge/accept-identity!
                                    (:transaction-id active)
                                    {:files-match true :identity-bytes-match true
                                     :checkpoint-match true :binding-match true})))
                         (let [receipt {:transaction-id (:transaction-id active)}]
                           (swap! (:files-evidence base) conj receipt)
                           receipt)))]
    (p/let [started (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active! (active-inputs)))
            transaction-id (get-in started [:envelope :transaction-id])
            marked (binding [bridge/*test-runtime* runtime]
                     (bridge/mark-files-applied! transaction-id))
            reentered-result @reentered]
      (is (= :files-applied (:status marked)))
      (is (= :identity-accepted (:status reentered-result)))
      (is (= :identity-accepted (get-in @(:state runtime) [:active :phase]))))))

(deftest-async failed-recovery-refuses-an-already-queued-incompatible-start
  ;; Recovery reserves its turn and awaits a deferred load while the runtime
  ;; is still unblocked; an incompatible start queues behind it; recovery
  ;; then fails and latches the runtime blocked. The queued start must
  ;; refuse without performing any operational work.
  (let [stored (atom nil)
        seed (test-runtime {:stored stored})
        {load-promise :promise resolve-load! :resolve!} (deferred)
        save-count (atom 0)
        runtime (test-runtime {:stored stored
                               :load-active! (fn [] load-promise)
                               :save-active! (fn [serialized]
                                               (swap! save-count inc)
                                               (reset! stored serialized))})]
    (-> (binding [bridge/*test-runtime* seed]
           (bridge/start-active! (active-inputs)))
        (p/then
         (fn [_]
           (let [base (bridge/deserialize-active @stored)
                 tampered (assoc-in base [:inputs :target :files 0 :content] "tampered")
                 recovery (binding [bridge/*test-runtime* runtime]
                            (bridge/recover-active!))
                 queued-start (binding [bridge/*test-runtime* runtime]
                                (bridge/start-active!
                                 (assoc (active-inputs)
                                        :target-generation "generation-3")))]
             ;; The load resolves only after both turns are queued, so the
             ;; start was reserved while the runtime was still unblocked.
             (resolve-load! (bridge/serialize-active tampered))
             (p/let [recovery-result recovery
                     start-result queued-start]
               (is (= :tampered-active (:code recovery-result)))
               (is (some? (:recovery-evidence @(:state runtime))))
               (is (= :recover-active (get-in @(:state runtime) [:blocked :phase])))
               (is (= :coordination-blocked (:code start-result)))
               (is (zero? @save-count))
               (is (nil? (:active @(:state runtime))))
               (is (= (:transaction-id base)
                      (:transaction-id (bridge/deserialize-active @stored)))))))))))

(deftest-async safety-stop-while-a-start-turn-awaits-its-binding-validation
  ;; A callback reenters the hook path from inside the awaited binding port
  ;; and its failing adapter latches the runtime blocked. The suspended
  ;; start turn must refuse before its next publication instead of saving
  ;; and installing an ACTIVE record.
  (let [stored (atom nil)
        save-count (atom 0)
        base (test-runtime
              {:stored stored
               :adapter! (fn [event]
                           (when (= :save-pending (:event event))
                             (throw (js/Error. "adapter failed inside the awaited port"))))})
        runtime (assoc base
                       :validate-binding!
                       (fn [graph-binding]
                         ;; The parameter must not be named `binding`: a local
                         ;; with that name shadows the binding macro and the
                         ;; dynamic rebinding silently never happens.
                         (binding [bridge/*test-runtime* base]
                           (bridge/save-pending! "graph-a" "pages/a.md" "local"))
                         (= {:root-id "root-1" :graph-id "graph-a"} graph-binding))
                       :save-active! (fn [serialized]
                                       (swap! save-count inc)
                                       (reset! stored serialized)))
        started (binding [bridge/*test-runtime* runtime]
                  (bridge/start-active! (active-inputs)))]
    (p/let [result started]
      (is (= :coordination-blocked (:code result)))
      (is (= :save-pending (get-in @(:state base) [:blocked :phase])))
      (is (zero? @save-count))
      (is (nil? @stored))
      (is (nil? (:active @(:state base))))
      (is (nil? (:uncertain-active @(:state base)))))))

(deftest-async uncertain-save-rejection-reserves-the-transaction-against-a-queued-start
  ;; The save port writes the record and then rejects. Rejection does not
  ;; prove nothing persisted, so the exact attempted envelope is reserved and
  ;; a queued incompatible start may not overwrite the stored record.
  (let [stored (atom nil)
        save-count (atom 0)
        runtime (test-runtime
                 {:stored stored
                  :save-active! (fn [serialized]
                                  (swap! save-count inc)
                                  (reset! stored serialized)
                                  (p/rejected (js/Error. "acknowledge lost after write")))})
        first-start (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active! (active-inputs)))
        competing-start (binding [bridge/*test-runtime* runtime]
                          (bridge/start-active!
                           (assoc (active-inputs) :target-generation "generation-3")))]
    (p/let [first-result first-start
            competing-result competing-start]
      (is (= :active-save-uncertain (:code first-result)))
      (is (nil? (:active @(:state runtime))))
      (let [reservation (:uncertain-active @(:state runtime))]
        (is (some? reservation))
        (is (= (:transaction-id reservation)
               (:transaction-id (bridge/deserialize-active
                                (:serialized reservation)))))
        (is (= (:transaction-id reservation)
               (:transaction-id (bridge/deserialize-active @stored)))))
      (is (= :uncertain-active (:code competing-result)))
      (is (= 1 @save-count)))))

(deftest-async uncertain-clear-rejection-is-resolved-by-validated-recovery
  ;; The clear port removes the record and then rejects. The exact accepted
  ;; envelope is retained as transaction-bound uncertain-clear evidence, and
  ;; validated recovery — the authoritative durable store — confirms the clear,
  ;; resolves the reservation and reconciles the orphaned in-memory owner so
  ;; later work proceeds consistently.
  (let [stored (atom nil)
        clear-count (atom 0)
        runtime (test-runtime
                 {:stored stored
                  :clear-active! (fn [_]
                                   (swap! clear-count inc)
                                   (reset! stored nil)
                                   (p/rejected (js/Error. "acknowledge lost after clear")))})]
    (p/let [started (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active! (active-inputs)))
            transaction-id (get-in started [:envelope :transaction-id])
            _ (binding [bridge/*test-runtime* runtime]
                (bridge/mark-files-applied! transaction-id))
            _ (binding [bridge/*test-runtime* runtime]
                (bridge/accept-identity!
                 transaction-id
                 {:files-match true :identity-bytes-match true
                  :checkpoint-match true :binding-match true}))
            refused (binding [bridge/*test-runtime* runtime]
                     (bridge/finish-active! transaction-id))
            _ (is (= :clear-active-uncertain (:code refused)))
            _ (is (= :identity-accepted (get-in @(:state runtime) [:active :phase])))
            _ (is (= transaction-id
                     (get-in @(:state runtime) [:uncertain-clear :transaction-id])))
            recovery (binding [bridge/*test-runtime* runtime]
                       (bridge/recover-active!))
            _ (is (= :none (:status recovery)))
            _ (is (= :uncertain-clear (:resolved recovery)))
            _ (is (nil? (:active @(:state runtime))))
            _ (is (nil? (:uncertain-clear @(:state runtime))))
            restarted (binding [bridge/*test-runtime* runtime]
                        (bridge/start-active!
                         (assoc (active-inputs) :target-generation "generation-3")))]
      (is (= 1 @clear-count))
      (is (= :active (:status restarted)))
      (is (= (get-in restarted [:envelope :transaction-id])
             (:transaction-id (bridge/deserialize-active @stored)))))))

(deftest-async proven-no-write-failure-differs-from-an-uncertain-save-outcome
  ;; Only a missing port (the write function was never invoked) or a port
  ;; that declares :proven-no-write proves nothing persisted. Those failures
  ;; leave no reservation, so unrelated work proceeds; an unproven rejection
  ;; reserves recovery-required state and refuses incompatible work.
  (let [proven-stored (atom nil)
        proven-base (test-runtime
                     {:stored proven-stored
                      :save-active! (fn [_]
                                      (throw (ex-info "refused before any write"
                                                      {:proven-no-write true})))})
        missing-port-runtime (dissoc (test-runtime {:stored (atom nil)})
                                     :save-active!)
        uncertain-runtime (test-runtime
                           {:stored (atom nil)
                            :save-active! #(p/rejected (js/Error. "plain rejection"))})]
    (p/let [proven-result (binding [bridge/*test-runtime* proven-base]
                            (bridge/start-active! (active-inputs)))
            missing-result (binding [bridge/*test-runtime* missing-port-runtime]
                             (bridge/start-active! (active-inputs)))
            uncertain-result (binding [bridge/*test-runtime* uncertain-runtime]
                               (bridge/start-active! (active-inputs)))
            _ (is (= :active-refused (:code proven-result)))
            _ (is (nil? (:uncertain-active @(:state proven-base))))
            _ (is (= :missing-port (:code missing-result)))
            _ (is (nil? (:uncertain-active @(:state missing-port-runtime))))
            _ (is (= :active-save-uncertain (:code uncertain-result)))
            _ (is (some? (:uncertain-active @(:state uncertain-runtime))))
            proven-next (binding [bridge/*test-runtime*
                                  (assoc proven-base :save-active!
                                          #(reset! proven-stored %))]
                          (bridge/start-active!
                           (assoc (active-inputs) :target-generation "generation-3")))
            missing-next (binding [bridge/*test-runtime*
                                   (assoc missing-port-runtime :save-active!
                                          #(reset! (:stored missing-port-runtime) %))]
                           (bridge/start-active!
                            (assoc (active-inputs) :target-generation "generation-3")))
            uncertain-next (binding [bridge/*test-runtime* uncertain-runtime]
                             (bridge/start-active!
                              (assoc (active-inputs) :target-generation "generation-3")))]
      (is (= :active (:status proven-next)))
      (is (= :active (:status missing-next)))
      (is (= :uncertain-active (:code uncertain-next))))))

(deftest-async validated-recovery-resolves-an-uncertain-save-and-preserves-exact-evidence
  ;; The uncertain write actually landed. Validated recovery installs the
  ;; exact persisted record, clears the reservation, and leaves the exact
  ;; retry and incompatible paths settled without hanging.
  (let [stored (atom nil)
        save-count (atom 0)
        runtime (test-runtime
                 {:stored stored
                  :save-active! (fn [serialized]
                                  (swap! save-count inc)
                                  (reset! stored serialized)
                                  (p/rejected (js/Error. "acknowledge lost after write")))})
        started (binding [bridge/*test-runtime* runtime]
                  (bridge/start-active! (active-inputs)))]
    (p/let [refused started
            _ (is (= :active-save-uncertain (:code refused)))
            reservation (:uncertain-active @(:state runtime))
            _ (is (= (:transaction-id reservation)
                     (:transaction-id (bridge/deserialize-active
                                      (:serialized reservation)))))
            recovery (binding [bridge/*test-runtime* runtime]
                       (bridge/recover-active!))
            _ (is (= :recovery-pending (:status recovery)))
            _ (is (nil? (:uncertain-active @(:state runtime))))
            _ (is (= (:transaction-id reservation)
                     (get-in recovery [:envelope :transaction-id])))
            retried (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active! (active-inputs)))
            incompatible (binding [bridge/*test-runtime* runtime]
                           (bridge/start-active!
                            (assoc (active-inputs) :target-generation "generation-3")))]
      (is (= :already-active (:status retried)))
      (is (= :incompatible-active (:code incompatible)))
      (is (= 1 @save-count))
      (is (= (:transaction-id reservation)
             (:transaction-id (bridge/deserialize-active @stored)))))))

(deftest-async exact-retry-after-an-uncertain-save-restores-the-active-lifecycle
  ;; An exact retry re-attempts only the same reserved transaction; a fresh
  ;; working port resolves the reservation without validated recovery, so
  ;; the uncertain outcome creates no permanent dead end.
  (let [stored (atom nil)
        save-count (atom 0)
        base (test-runtime
              {:stored stored
               :save-active! (fn [serialized]
                                (swap! save-count inc)
                                (reset! stored serialized)
                                (p/rejected (js/Error. "acknowledge lost after write")))})
        refused (binding [bridge/*test-runtime* base]
                  (bridge/start-active! (active-inputs)))]
    (p/let [refused-result refused
            _ (is (= :active-save-uncertain (:code refused-result)))
            _ (is (some? (:uncertain-active @(:state base))))
            reservation-id (get-in @(:state base) [:uncertain-active :transaction-id])
            retry (binding [bridge/*test-runtime*
                            (assoc base :save-active!
                                    (fn [serialized]
                                      (swap! save-count inc)
                                      (reset! stored serialized)))]
                    (bridge/start-active! (active-inputs)))
            _ (is (= :active (:status retry)))
            _ (is (nil? (:uncertain-active @(:state base))))
            _ (is (= reservation-id (get-in @(:state base) [:active :transaction-id])))
            incompatible (binding [bridge/*test-runtime* base]
                           (bridge/start-active!
                            (assoc (active-inputs) :target-generation "generation-3")))]
      (is (= :incompatible-active (:code incompatible)))
      (is (= 2 @save-count))
      (is (= reservation-id (:transaction-id (bridge/deserialize-active @stored)))))))

(deftest-async missing-persisted-record-preserves-the-installed-owner-and-blocks
  ;; The durable store holds no record for an unfinished transaction that is
  ;; installed in memory, and no uncertain clear explains the absence.
  ;; Absence is not proof of completed work: recovery preserves the in-memory
  ;; owner and evidence, latches the runtime blocked, and admits no other
  ;; transaction over the forgotten record.
  (let [stored (atom nil)
        save-count (atom 0)
        runtime (test-runtime
                 {:stored stored
                  :save-active! (fn [_]
                                  (swap! save-count inc)
                                  (p/resolved nil))})]
    (p/let [started (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active! (active-inputs)))
            transaction-id (get-in started [:envelope :transaction-id])
            _ (is (= :active (:status started)))
            _ (is (some? (:active @(:state runtime))))
            recovery (binding [bridge/*test-runtime* runtime]
                       (bridge/recover-active!))
            blocked-start (binding [bridge/*test-runtime* runtime]
                            (bridge/start-active!
                             (assoc (active-inputs)
                                    :target-generation "generation-3")))]
      (is (= :missing-active-record (:code recovery)))
      (is (= transaction-id (get-in @(:state runtime) [:active :transaction-id])))
      (is (= :active (get-in @(:state runtime) [:active :phase])))
      (is (= :recover-active (get-in @(:state runtime) [:blocked :phase])))
      (let [evidence (:recovery-evidence @(:state runtime))]
        (is (= transaction-id (get-in evidence [:envelope :transaction-id])))
        (is (= :missing-active-record (:code evidence))))
      (is (nil? @stored))
      (is (= 1 @save-count))
      (is (= :coordination-blocked (:code blocked-start))))))

(deftest-async verified-absence-resolves-an-uncertain-initial-save
  ;; The unproven initial save never became durable: recovery's verified
  ;; empty load resolves the reservation instead of keeping it, and later
  ;; work is admitted rather than staying blocked on evidence the store
  ;; disproves.
  (let [stored (atom nil)
        runtime (test-runtime
                 {:stored stored
                  :save-active! #(p/rejected (js/Error. "plain rejection"))})]
    (p/let [refused (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active! (active-inputs)))
            _ (is (= :active-save-uncertain (:code refused)))
            _ (is (some? (:uncertain-active @(:state runtime))))
            recovery (binding [bridge/*test-runtime* runtime]
                       (bridge/recover-active!))]
      (is (= :none (:status recovery)))
      (is (= :uncertain-save (:resolved recovery)))
      (is (nil? (:uncertain-active @(:state runtime))))
      (is (nil? (:active @(:state runtime))))
      ;; The next transaction is admitted with a fresh working save port;
      ;; the resolved reservation no longer blocks it.
      (p/let [started (binding [bridge/*test-runtime*
                               (assoc runtime :save-active! #(reset! stored %))]
                        (bridge/start-active!
                         (assoc (active-inputs)
                                :target-generation "generation-3")))]
        (is (= :active (:status started)))
        (is (= (get-in started [:envelope :transaction-id])
               (:transaction-id (bridge/deserialize-active @stored))))))))

(deftest-async uncertain-clear-then-finish-retry-requires-validated-recovery
  ;; The clear port removes the record and then rejects. The exact accepted
  ;; envelope is retained as transaction-bound uncertain-clear evidence; a
  ;; direct finish retry refuses to repeat the clear before a validated
  ;; readback, and only recovery confirms the clear and admits new work.
  (let [stored (atom nil)
        clear-count (atom 0)
        runtime (test-runtime
                 {:stored stored
                  :clear-active! (fn [_]
                                   (swap! clear-count inc)
                                   (reset! stored nil)
                                   (p/rejected (js/Error. "acknowledge lost after clear")))})]
    (p/let [started (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active! (active-inputs)))
            transaction-id (get-in started [:envelope :transaction-id])
            _ (binding [bridge/*test-runtime* runtime]
                (bridge/mark-files-applied! transaction-id))
            _ (binding [bridge/*test-runtime* runtime]
                (bridge/accept-identity!
                 transaction-id
                 {:files-match true :identity-bytes-match true
                  :checkpoint-match true :binding-match true}))
            refused (binding [bridge/*test-runtime* runtime]
                      (bridge/finish-active! transaction-id))
            _ (is (= :clear-active-uncertain (:code refused)))
            _ (is (= :identity-accepted (get-in @(:state runtime) [:active :phase])))
            reservation (:uncertain-clear @(:state runtime))
            _ (is (some? reservation))
            _ (is (= transaction-id (:transaction-id reservation)))
            _ (is (= transaction-id
                     (when reservation
                       (:transaction-id (bridge/deserialize-active
                                        (:serialized reservation))))))
            retried (binding [bridge/*test-runtime* runtime]
                      (bridge/finish-active! transaction-id))
            _ (is (= :clear-active-uncertain (:code retried)))
            _ (is (= 1 @clear-count))
            incompatible (binding [bridge/*test-runtime* runtime]
                           (bridge/start-active!
                            (assoc (active-inputs)
                                   :target-generation "generation-3")))
            _ (is (= :incompatible-active (:code incompatible)))
            recovery (binding [bridge/*test-runtime* runtime]
                       (bridge/recover-active!))
            _ (is (= :none (:status recovery)))
            _ (is (= :uncertain-clear (:resolved recovery)))
            _ (is (nil? (:active @(:state runtime))))
            _ (is (nil? (:uncertain-clear @(:state runtime))))
            restarted (binding [bridge/*test-runtime* runtime]
                        (bridge/start-active!
                         (assoc (active-inputs)
                                :target-generation "generation-3")))]
      (is (= :active (:status restarted)))
      (is (= 1 @clear-count)))))

(deftest-async proven-no-write-clear-refusal-stays-separately-retryable
  ;; A clear refusal that proves nothing was cleared (the port function was
  ;; never invoked) mutates nothing: no uncertain-clear reservation is
  ;; recorded, the accepted record is retained untouched, and finish
  ;; remains retryable without a recovery in between.
  (let [stored (atom nil)
        clear-count (atom 0)
        runtime (dissoc (test-runtime {:stored stored}) :clear-active!)]
    (p/let [started (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active! (active-inputs)))
            transaction-id (get-in started [:envelope :transaction-id])
            _ (binding [bridge/*test-runtime* runtime]
                (bridge/mark-files-applied! transaction-id))
            _ (binding [bridge/*test-runtime* runtime]
                (bridge/accept-identity!
                 transaction-id
                 {:files-match true :identity-bytes-match true
                  :checkpoint-match true :binding-match true}))
            refused (binding [bridge/*test-runtime* runtime]
                      (bridge/finish-active! transaction-id))]
      (is (= :missing-port (:code refused)))
      (is (= :identity-accepted (get-in @(:state runtime) [:active :phase])))
      (is (nil? (:uncertain-clear @(:state runtime))))
      (is (= transaction-id (:transaction-id (bridge/deserialize-active @stored))))
      (p/let [retried (binding [bridge/*test-runtime*
                               (assoc runtime
                                      :clear-active!
                                      (fn [_]
                                        (swap! clear-count inc)
                                        (reset! stored nil)))]
                      (bridge/finish-active! transaction-id))]
        (is (= :complete (:status retried)))
        (is (= 1 @clear-count))
        (is (nil? @stored))
        (is (nil? (:active @(:state runtime))))))))

(deftest-async unexpected-different-record-during-uncertain-clear-recovery-is-preserved
  ;; After an uncertain clear, the durable store unexpectedly holds a
  ;; different transaction's record. Recovery preserves the stored record,
  ;; the in-memory accepted owner and the uncertain-clear evidence instead
  ;; of installing over them, and latches the runtime blocked.
  (let [stored (atom nil)
        clear-count (atom 0)
        runtime (test-runtime
                 {:stored stored
                  :clear-active! (fn [_]
                                   (swap! clear-count inc)
                                   (reset! stored nil)
                                   (p/rejected (js/Error. "acknowledge lost after clear")))})
        replacement (test-runtime {:stored stored})]
    (p/let [started (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active! (active-inputs)))
            transaction-id (get-in started [:envelope :transaction-id])
            _ (binding [bridge/*test-runtime* runtime]
                (bridge/mark-files-applied! transaction-id))
            _ (binding [bridge/*test-runtime* runtime]
                (bridge/accept-identity!
                 transaction-id
                 {:files-match true :identity-bytes-match true
                  :checkpoint-match true :binding-match true}))
            refused (binding [bridge/*test-runtime* runtime]
                      (bridge/finish-active! transaction-id))
            _ (is (= :clear-active-uncertain (:code refused)))
            replacement-started (binding [bridge/*test-runtime* replacement]
                                 (bridge/start-active!
                                  (assoc (active-inputs)
                                         :target-generation "generation-3")))
            replacement-id (get-in replacement-started [:envelope :transaction-id])
            _ (is (= :active (:status replacement-started)))
            recovery (binding [bridge/*test-runtime* runtime]
                       (bridge/recover-active!))
            blocked-finish (binding [bridge/*test-runtime* runtime]
                             (bridge/finish-active! transaction-id))]
      (is (= :unexpected-active-record (:code recovery)))
      (is (= transaction-id (get-in @(:state runtime) [:active :transaction-id])))
      (is (= :identity-accepted (get-in @(:state runtime) [:active :phase])))
      (is (= transaction-id
             (get-in @(:state runtime) [:uncertain-clear :transaction-id])))
      (is (= :recover-active (get-in @(:state runtime) [:blocked :phase])))
      ;; The unexpected stored record is preserved untouched.
      (is (= replacement-id (:transaction-id (bridge/deserialize-active @stored))))
      (is (= :unexpected-active-record
             (get-in @(:state runtime) [:recovery-evidence :code])))
      (is (= :coordination-blocked (:code blocked-finish))))))

(deftest-async blocked-latch-during-the-empty-load-preserves-ownership
  ;; A callback reenters from the awaited load port and latches the runtime
  ;; blocked while the empty load is pending. The recovery turn must recheck
  ;; the latch after the load settles and change no ownership through the
  ;; blocked runtime; the first latch reason is preserved.
  (let [stored (atom nil)
        {load-promise :promise resolve-load! :resolve!} (deferred)
        base (test-runtime
              {:stored stored
               :adapter! (fn [event]
                           (when (= :save-pending (:event event))
                             (throw (js/Error. "adapter latched during the load"))))})
        runtime (assoc base
                       :save-active! (fn [_] (p/resolved nil))
                       :load-active! (fn []
                                       (p/then load-promise
                                               (fn [_]
                                                 ;; Reenter the bridge from the
                                                 ;; awaited load port's settlement
                                                 ;; and latch the runtime blocked
                                                 ;; before the empty-store branch
                                                 ;; runs.
                                                 (binding [bridge/*test-runtime* base]
                                                   (bridge/save-pending!
                                                    "graph-a" "pages/a.md" "local"))
                                                 nil))))]
    (p/let [started (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active! (active-inputs)))
            transaction-id (get-in started [:envelope :transaction-id])]
      (is (= :active (:status started)))
      (is (some? (:active @(:state base))))
      (let [recovery (binding [bridge/*test-runtime* runtime]
                       (bridge/recover-active!))]
        ;; The load settles empty only after the runtime latched blocked.
        (resolve-load! nil)
        (p/let [recovery-result recovery]
          (is (= :coordination-blocked (:code recovery-result)))
          (is (= :save-pending (get-in @(:state base) [:blocked :phase])))
          (is (= transaction-id (get-in @(:state base) [:active :transaction-id])))
          (is (nil? (:recovery-evidence @(:state base))))
          (is (nil? @stored)))))))

(deftest-async uncertain-clear-refuses-reconciliation-publication-until-recovery
  ;; While an accepted transaction's clear outcome is unknown, no progress
  ;; write may resurrect the record the clear may have removed. The
  ;; reconciliation settles as retryable evidence and the store stays
  ;; untouched until validated recovery resolves the reservation.
  (let [stored (atom nil)
        clear-count (atom 0)
        save-count (atom 0)
        complete {:graph-id "graph-a" :new-path "pages/late.md" :new-present true
                  :new-content-hash "hash-late"}
        runtime (test-runtime
                 {:stored stored
                  :complete-state! (constantly complete)
                  :save-active! (fn [serialized]
                                  (swap! save-count inc)
                                  (reset! stored serialized))
                  :clear-active! (fn [_]
                                   (swap! clear-count inc)
                                   (reset! stored nil)
                                   (p/rejected (js/Error. "acknowledge lost after clear")))})]
    (p/let [started (binding [bridge/*test-runtime* runtime]
                      (bridge/start-active! (active-inputs)))
            transaction-id (get-in started [:envelope :transaction-id])
            _ (binding [bridge/*test-runtime* runtime]
                (bridge/mark-files-applied! transaction-id))
            _ (binding [bridge/*test-runtime* runtime]
                (bridge/accept-identity!
                 transaction-id
                 {:files-match true :identity-bytes-match true
                  :checkpoint-match true :binding-match true}))
            refused (binding [bridge/*test-runtime* runtime]
                      (bridge/finish-active! transaction-id))
            _ (is (= :clear-active-uncertain (:code refused)))
            saves-before @save-count
            _ (binding [bridge/*test-runtime* runtime]
                (bridge/register-incoming-cause!
                 {:cause-id "late-1" :operation-id "op-late" :graph-id "graph-a"
                  :kind :update :path "pages/late.md" :content-hash "hash-late"}))
            observation (binding [bridge/*test-runtime* runtime]
                          (bridge/observe-watcher! "change" "/synthetic"
                                                   "pages/late.md" "late" {} false))
            settled (:settled observation)]
      (is (= :reconciliation-failed (:status settled)))
      (is (= :clear-active-uncertain (:code settled)))
      (is (= :reconcile-pending
             (get-in @(:state runtime) [:causes "late-1" :status])))
      (is (nil? @stored))
      (is (= saves-before @save-count))
      (is (= transaction-id
             (get-in @(:state runtime) [:uncertain-clear :transaction-id]))))))
