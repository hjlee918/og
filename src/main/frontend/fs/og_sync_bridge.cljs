(ns frontend.fs.og-sync-bridge
  "Default-off, removable seams for the synthetic OG synchronization experiment.

  Production callers never install a runtime.  All state and every operational
  port belong to an explicitly bound test runtime; the disabled path therefore
  constructs no event payload, allocates no coordination state and performs no
  asynchronous work."
  (:require [cljs.reader :as reader]
            [clojure.set :as set]
            [goog.crypt :as crypt]
            [goog.crypt.Sha256]
            [promesa.core :as p]))

(goog-define ENABLE-OG-SYNC-BRIDGE false)

(def ^:dynamic *test-runtime* nil)
(defonce ^:private enabled-runtime*
  (when ENABLE-OG-SYNC-BRIDGE (atom nil)))

(def active-schema "frontend.fs.og-sync-bridge.active/2")

(def ^:private active-input-keys
  #{:graph-id :replica-id :source-snapshot :issued-preview :target
    :authoritative-plan :projected-snapshot :proposed-identity-bytes
    :basis-generation :target-generation :operation-ids
    :working-journal-identity :graph-binding :causes})

(defn- current-runtime
  []
  (or *test-runtime*
      (when enabled-runtime* @enabled-runtime*)))

(defn enabled?
  []
  (some? (current-runtime)))

(defn install-runtime!
  "Install a runtime only in a separately enabled build. Tests use the dynamic
  binding instead, and a default build allocates no runtime atom."
  [runtime]
  (when enabled-runtime*
    (reset! enabled-runtime* runtime)))

(defn- sha256
  [value]
  (let [hasher (goog.crypt.Sha256.)]
    (.update hasher (crypt/stringToUtf8ByteArray (str value)))
    (str "sha256:" (crypt/byteArrayToHex (.digest hasher)))))

(declare canonical serialize-active)

(defn- canonical-map
  [value]
  (into (sorted-map-by #(compare (pr-str %1) (pr-str %2)))
        (map (fn [[key item]] [key (canonical item)]))
        value))

(defn- canonical
  [value]
  (cond
    (map? value) (canonical-map value)
    (vector? value) (mapv canonical value)
    (set? value) (into (sorted-set-by #(compare (pr-str %1) (pr-str %2)))
                       (map canonical value))
    (seq? value) (mapv canonical value)
    :else value))

(defn- canonical-string
  [value]
  (pr-str (canonical value)))

(defn- runtime-state
  [runtime]
  (:state runtime))

(defn- blocked?
  [runtime]
  (boolean (:blocked @(runtime-state runtime))))

(defn- block-runtime!
  [runtime phase error]
  (swap! (runtime-state runtime) assoc :blocked
         {:phase phase :error (str error)})
  nil)

(defn- thenable?
  [value]
  (and (some? value) (fn? (.-then value))))

(defn- invoke-sync-port
  [runtime port phase & args]
  (when-not (blocked? runtime)
    (try
      (when-let [f (get runtime port)]
        (let [result (apply f args)]
          (when (thenable? result)
            ;; Attach both handlers before refusing the contract so even a
            ;; rejected thenable cannot surface as an unhandled rejection.
            (.then result (fn [_] nil) (fn [_] nil))
            (throw (ex-info "synchronous bridge port returned a thenable"
                            {:code :asynchronous-sync-port :port port})))
          result))
      (catch :default error
        (block-runtime! runtime phase error)))))

(defn- invoke-async-port
  [runtime port & args]
  (try
    (if-let [f (get runtime port)]
      (p/resolved (apply f args))
      (p/rejected (ex-info "required asynchronous bridge port is missing"
                           {:code :missing-port :port port})))
    (catch :default error
      (p/rejected error))))

(defn- emit!
  [runtime event]
  (invoke-sync-port runtime :adapter! (:event event) event))

(defn- next-id!
  [runtime kind]
  (or (invoke-sync-port runtime :next-id! :allocate-cause-id kind)
      (when-not (blocked? runtime)
        (str (name kind) "-" (inc (count (:causes @(runtime-state runtime))))))))

(defn- public-cause
  [cause]
  (dissoc cause :runtime))

(defn- cause-hash
  [content]
  (when (string? content) (sha256 content)))

(defn save-pending!
  "Register an exact save cause. Returns an opaque token for completion/failure."
  [graph-id path content]
  (when (enabled?)
    (let [runtime (current-runtime)]
      (when-not (blocked? runtime)
        (when-let [cause-id (next-id! runtime :save)]
          (let [cause {:runtime runtime :cause-id cause-id :origin :local
                       :kind :save :graph-id graph-id :path path
                       :content-hash (cause-hash content) :status :pending}]
            (swap! (runtime-state runtime)
                   (fn [state]
                     (-> state
                         (assoc-in [:writes cause-id] cause)
                         (assoc-in [:causes cause-id] cause))))
            (emit! runtime {:event :save-pending :cause (public-cause cause)})
            cause))))))

(defn- close-local-cause!
  [cause status event result-key result]
  (when-let [runtime (:runtime cause)]
    (when-not (blocked? runtime)
      (let [closed (assoc cause :status status)]
        (swap! (runtime-state runtime)
               (fn [state]
                 (-> state
                     (assoc-in [:writes (:cause-id cause)] closed)
                     (assoc-in [:causes (:cause-id cause)] closed))))
        (emit! runtime {:event event :cause (public-cause closed)
                        result-key result})))))

(defn save-completed!
  [cause result]
  (close-local-cause! cause :completed :save-completed :result result))

(defn save-failed!
  [cause error]
  (close-local-cause! cause :failed :save-failed :error (str error)))

(defn rename-intent!
  [graph-id old-path new-path]
  (when (enabled?)
    (let [runtime (current-runtime)]
      (when-not (blocked? runtime)
        (when-let [cause-id (next-id! runtime :rename)]
          (let [content-hash (invoke-sync-port runtime :rename-content-hash!
                                               :rename-content-hash graph-id old-path)
                cause {:runtime runtime :cause-id cause-id :origin :local
                       :kind :rename :graph-id graph-id :old-path old-path
                       :new-path new-path :content-hash content-hash
                       :status :pending}]
            (when-not (blocked? runtime)
              (swap! (runtime-state runtime) assoc-in [:causes cause-id] cause)
              (emit! runtime {:event :rename-intent :cause (public-cause cause)})
              cause)))))))

(defn- close-rename-cause!
  [cause status event result-key result]
  (when-let [runtime (:runtime cause)]
    (when-not (blocked? runtime)
      (let [closed (assoc cause :status status)]
        (swap! (runtime-state runtime) assoc-in [:causes (:cause-id cause)] closed)
        (emit! runtime {:event event :cause (public-cause closed)
                        result-key result})))))

(defn rename-completed!
  [cause result]
  (close-rename-cause! cause :completed :rename-completed :result result))

(defn rename-failed!
  [cause error]
  (close-rename-cause! cause :failed :rename-failed :error (str error)))

(defn- cause-paths
  [cause]
  (set (remove nil? [(:path cause) (:old-path cause) (:new-path cause)])))

(defn unfinished-local-write?
  [runtime graph-id paths]
  (let [paths (set paths)]
    (boolean
     (some (fn [cause]
             (and (= :pending (:status cause))
                  (= :local (:origin cause))
                  (contains? #{:save :rename} (:kind cause))
                  (= graph-id (:graph-id cause))
                  (seq (set/intersection paths (cause-paths cause)))))
           (vals (:causes @(runtime-state runtime)))))))

(defn register-incoming-cause!
  "Register one complete synthetic incoming cause, unless an unfinished local
  write conflicts with it. The supplied cause contains no operation ID from a
  watcher; its retained operation binding is used only after exact matching."
  [cause]
  (when (enabled?)
    (let [runtime (current-runtime)
          paths (cause-paths cause)]
      (cond
        (blocked? runtime) {:status :blocked :code :coordination-blocked}
        (unfinished-local-write? runtime (:graph-id cause) paths)
        {:status :blocked :code :unfinished-local-write}
        :else
        (let [retained (assoc cause :origin :incoming :status :reconcile-pending)]
          (swap! (runtime-state runtime) assoc-in [:causes (:cause-id retained)] retained)
          (emit! runtime {:event :incoming-cause-pending :cause retained})
          {:status :pending :cause retained})))))

(defn- complete-state-matches?
  [cause complete]
  (and (= (:graph-id cause) (:graph-id complete))
       (case (:kind cause)
         (:save :update :create)
         (and (= true (:new-present complete))
              (= (or (:new-path cause) (:path cause)) (:new-path complete))
              (= (:content-hash cause) (:new-content-hash complete)))

         :rename
         (and (= false (:old-present complete))
              (= true (:new-present complete))
              (= (:old-path cause) (:old-path complete))
              (= (:new-path cause) (:new-path complete))
              (= (:content-hash cause) (:new-content-hash complete)))

         :delete
         (and (= false (:old-present complete))
              (= (:old-path cause) (:old-path complete)))

         false)))

(defn- serialized!
  "Run (section) as the next coordination turn of this runtime. Turns are
  reserved in call order, run one at a time, and a rejected turn never stalls
  later turns; a turn reentering the bridge from an injected callback reserves
  the next turn instead of deadlocking. Every ACTIVE publication — persisted
  write and in-memory installation — happens inside a turn, so overlapping
  starts, reconciliations, recovery and lifecycle completions cannot replace or
  clear one another's state. This boundary coordinates only this process's
  in-memory runtime state and synthetic persistence ports; it is neither a
  cross-process lock nor crash durability."
  [runtime section]
  (let [state* (runtime-state runtime)
        prior (:coordination-tail @state*)
        started (p/then (or prior (p/resolved nil)) section)
        tail (p/catch started (fn [_] nil))]
    (swap! state* assoc :coordination-tail tail)
    started))

(defn- active-transaction-id
  "The transaction that currently owns the active slot, or nil."
  [runtime]
  (get-in @(runtime-state runtime) [:active :transaction-id]))

(defn- reconcile-incoming!
  [runtime cause observation complete]
  (emit! runtime {:event :incoming-reconciliation-request
                  :cause cause :observation observation :complete-state complete})
  (if (blocked? runtime)
    {:status :ordinary :code :coordination-blocked}
    (let [reconciling (assoc cause :status :reconciling)
          _ (swap! (runtime-state runtime) assoc-in
                   [:causes (:cause-id cause)] reconciling)
          ;; Ownership is reserved before any asynchronous work: the exact
          ;; transaction whose ACTIVE record this reconciliation may update.
          owner-active (:active @(runtime-state runtime))
          owner (:transaction-id owner-active)
          settled
          (-> (invoke-async-port runtime :reconcile! cause observation complete)
              (p/then
               (fn [result]
                 (p/let [receipt (invoke-async-port
                                  runtime :record-reconciliation-progress!
                                  owner-active cause result)
                         _ (when (nil? receipt)
                             (throw (ex-info "reconciliation progress receipt is missing"
                                             {:code :missing-progress-receipt})))
                         ;; Publication turn: revalidate that the exact reserved
                         ;; transaction still owns the active slot, then persist
                         ;; and install one merged entry. Serialized turns keep
                         ;; concurrent reconciliations from losing each other's
                         ;; progress or regressing a later phase.
                         settled-result
                         (serialized! runtime
                           (fn []
                             (let [current (:active @(runtime-state runtime))]
                               (if (and owner current
                                        (= owner (:transaction-id current)))
                                 (let [entry {:transaction-id owner
                                              :cause-id (:cause-id cause)
                                              :operation-id (:operation-id cause)
                                              :receipt (canonical receipt)}
                                       updated (assoc-in current
                                                        [:progress :reconciled (:cause-id cause)]
                                                        entry)]
                                   (-> (invoke-async-port runtime :save-active!
                                                          (serialize-active updated))
                                       ;; Persist the transaction-bound progress
                                       ;; before changing the runtime cause to
                                       ;; reconciled. Only a later watcher
                                       ;; observation can then be an echo.
                                       (p/then
                                        (fn [_]
                                          (let [reconciled (assoc cause :status :reconciled)]
                                            (swap! (runtime-state runtime)
                                                   (fn [state]
                                                     (-> state
                                                         (assoc-in [:causes (:cause-id cause)]
                                                                   reconciled)
                                                         (assoc :active updated))))
                                            (emit! runtime
                                                   {:event :incoming-reconciliation-result
                                                    :cause reconciled :status :success
                                                    :result result})
                                            {:status :reconciled :cause reconciled
                                             :result result})))
                                       (p/catch
                                        (fn [error]
                                          (let [pending (assoc cause :status :reconcile-pending)]
                                            (swap! (runtime-state runtime) assoc-in
                                                   [:causes (:cause-id cause)] pending)
                                            (emit! runtime
                                                   {:event :incoming-reconciliation-result
                                                    :cause pending :status :failure
                                                    :error (str error)})
                                            {:status :reconciliation-failed :cause pending
                                             :error error})))))
                                 ;; The reserved transaction no longer owns the
                                 ;; active slot. Settle in memory only and never
                                 ;; publish into a record this reconciliation
                                 ;; does not own.
                                 (let [reconciled (assoc cause :status :reconciled)]
                                   (swap! (runtime-state runtime) assoc-in
                                          [:causes (:cause-id cause)] reconciled)
                                   (emit! runtime {:event :incoming-reconciliation-result
                                                   :cause reconciled :status :success
                                                   :result result})
                                   {:status :reconciled :cause reconciled
                                    :result result})))))]
                   settled-result)))
              (p/catch
               (fn [error]
                 (let [pending (assoc cause :status :reconcile-pending)]
                   (swap! (runtime-state runtime) assoc-in
                          [:causes (:cause-id cause)] pending)
                   (emit! runtime {:event :incoming-reconciliation-result
                                   :cause pending :status :failure :error (str error)})
                   {:status :reconciliation-failed :cause pending :error error}))))]
      {:status :reconciliation-pending :cause reconciling :settled settled})))

(defn observe-watcher!
  "Record a raw watcher event and match it only against a unique complete
  retained cause. Zero/multiple matches remain ordinary."
  [type dir path content stat global-dir]
  (when (enabled?)
    (let [runtime (current-runtime)
          observation {:type type :dir dir :path path :content content
                       :stat stat :global-dir global-dir}]
      (emit! runtime {:event :raw-watcher-observation :observation observation})
      (if (blocked? runtime)
        {:status :ordinary :code :coordination-blocked}
        (let [complete (invoke-sync-port runtime :complete-state!
                                         :watcher-complete-state observation)
              matches (when complete
                        (->> (:causes @(runtime-state runtime))
                             vals
                             (filter #(contains? #{:completed :reconcile-pending
                                                  :reconciling :reconciled}
                                                 (:status %)))
                             (filter #(complete-state-matches? % complete))
                             vec))]
          (cond
            (not= 1 (count matches))
            {:status :ordinary :match-count (count matches)}

            (= :local (:origin (first matches)))
            {:status :completed-local :cause (public-cause (first matches))}

            (= :reconciled (:status (first matches)))
            {:status :echo :cause (first matches)}

            (= :reconciling (:status (first matches)))
            {:status :reconciliation-pending :cause (first matches)}

            :else
            (reconcile-incoming! runtime (first matches) observation complete)))))))

(defn- exact-active-input?
  [inputs]
  (and (map? inputs)
       (= active-input-keys (set (keys inputs)))
       (string? (:graph-id inputs))
       (string? (:replica-id inputs))
       (map? (:source-snapshot inputs))
       (map? (:issued-preview inputs))
       (map? (:target inputs))
       (map? (:authoritative-plan inputs))
       (map? (:projected-snapshot inputs))
       (string? (:proposed-identity-bytes inputs))
       (string? (:basis-generation inputs))
       (string? (:target-generation inputs))
       (vector? (:operation-ids inputs))
       (every? string? (:operation-ids inputs))
       (map? (:working-journal-identity inputs))
       (map? (:graph-binding inputs))
       (vector? (:causes inputs))
       (every? #(and (map? %)
                     (string? (:cause-id %))
                     (string? (:operation-id %))
                     (contains? (set (:operation-ids inputs)) (:operation-id %))
                     (= (:graph-id inputs) (:graph-id %))
                     (contains? #{:create :update :rename :delete} (:kind %)))
               (:causes inputs))))

(defn- envelope-from-inputs
  [inputs]
  (let [body {:schema active-schema :inputs (canonical inputs)}]
    (assoc body :transaction-id (sha256 (canonical-string body))
           :phase :active
           :progress {:files-applied nil :reconciled {} :identity-acceptance nil})))

(defn serialize-active
  [envelope]
  (canonical-string envelope))

(defn deserialize-active
  [serialized]
  (let [value (reader/read-string serialized)]
    (when-not (map? value)
      (throw (ex-info "ACTIVE envelope is not a map" {:code :invalid-active})))
    value))

(defn- validate-progress-structure!
  [envelope]
  (let [progress (:progress envelope)
        causes (get-in envelope [:inputs :causes])
        causes-by-id (into {} (map (juxt :cause-id identity)) causes)
        reconciled (:reconciled progress)]
    (when-not (and (map? progress)
                   (= #{:files-applied :reconciled :identity-acceptance}
                      (set (keys progress)))
                   (map? reconciled)
                   (or (nil? (:files-applied progress))
                       (and (map? (:files-applied progress))
                            (= #{:transaction-id :receipt}
                               (set (keys (:files-applied progress))))
                            (= (:transaction-id envelope)
                               (get-in progress [:files-applied :transaction-id]))
                            (some? (get-in progress [:files-applied :receipt]))))
                   (or (nil? (:identity-acceptance progress))
                       (and (map? (:identity-acceptance progress))
                            (= #{:transaction-id :receipt}
                               (set (keys (:identity-acceptance progress))))
                            (= (:transaction-id envelope)
                               (get-in progress [:identity-acceptance :transaction-id]))
                            (some? (get-in progress [:identity-acceptance :receipt])))))
      (throw (ex-info "ACTIVE progress structure is invalid" {:code :invalid-progress})))
    (doseq [[cause-id entry] reconciled]
      (let [cause (get causes-by-id cause-id)]
        (when-not (and cause
                       (map? entry)
                       (= #{:transaction-id :cause-id :operation-id :receipt}
                          (set (keys entry)))
                       (= (:transaction-id envelope) (:transaction-id entry))
                       (= cause-id (:cause-id entry))
                       (= (:operation-id cause) (:operation-id entry))
                       (some? (:receipt entry)))
          (throw (ex-info "ACTIVE reconciliation progress is not transaction-bound"
                          {:code :invalid-progress :cause-id cause-id})))))
    envelope))

(defn- validate-envelope!
  [runtime envelope]
  (when-not (= #{:schema :transaction-id :phase :progress :inputs} (set (keys envelope)))
    (throw (ex-info "ACTIVE envelope fields are incompatible" {:code :invalid-active})))
  (when-not (and (= active-schema (:schema envelope))
                 (contains? #{:active :files-applied :identity-accepted} (:phase envelope))
                 (exact-active-input? (:inputs envelope)))
    (throw (ex-info "ACTIVE envelope schema or inputs are invalid" {:code :invalid-active})))
  (let [expected (envelope-from-inputs (:inputs envelope))]
    (when-not (= (:transaction-id expected) (:transaction-id envelope))
      (throw (ex-info "ACTIVE transaction inputs were altered" {:code :tampered-active}))))
  (validate-progress-structure! envelope)
  (let [revalidated (invoke-sync-port runtime :revalidate-plan! :revalidate-plan
                                      (:inputs envelope))]
    (when (blocked? runtime)
      (throw (ex-info "authoritative plan revalidation failed" {:code :coordination-blocked})))
    (when-not (= (canonical revalidated)
                 (canonical (get-in envelope [:inputs :authoritative-plan])))
      (throw (ex-info "serialized preview/plan is not authoritative" {:code :plan-mismatch}))))
  envelope)

(defn- blocked-result
  [code error]
  {:status :blocked :code code :error error})

(defn- verify-reconciliation-progress
  [runtime envelope]
  (let [causes-by-id (into {} (map (juxt :cause-id identity))
                           (get-in envelope [:inputs :causes]))]
    (reduce
     (fn [verified-promise [cause-id entry]]
       (p/let [verified verified-promise
               accepted? (invoke-async-port runtime :validate-reconciliation-progress!
                                            envelope (get causes-by-id cause-id) entry)]
         (cond-> verified (true? accepted?) (conj cause-id))))
     (p/resolved #{})
     (get-in envelope [:progress :reconciled]))))

(defn- recovered-envelope
  [runtime envelope]
  (p/let [binding-valid? (invoke-async-port runtime :validate-binding!
                                            (get-in envelope [:inputs :graph-binding]))
          _ (when-not (true? binding-valid?)
              (throw (ex-info "ACTIVE graph binding is not accepted"
                              {:code :binding-mismatch})))
          verified-causes (verify-reconciliation-progress runtime envelope)
          files-progress (get-in envelope [:progress :files-applied])
          files-valid? (if files-progress
                         (invoke-async-port runtime :validate-files-applied-progress!
                                            envelope files-progress)
                         false)
          acceptance-progress (get-in envelope [:progress :identity-acceptance])
          acceptance-valid? (if acceptance-progress
                              (invoke-async-port runtime
                                                 :validate-identity-acceptance-progress!
                                                 envelope acceptance-progress)
                              false)
          all-cause-ids (set (map :cause-id (get-in envelope [:inputs :causes])))
          all-reconciled? (= all-cause-ids verified-causes)
          identity-accepted? (and (= :identity-accepted (:phase envelope))
                                  (true? files-valid?)
                                  all-reconciled?
                                  (true? acceptance-valid?))
          safe-phase (cond
                       identity-accepted? :identity-accepted
                       (and (contains? #{:files-applied :identity-accepted} (:phase envelope))
                            (true? files-valid?))
                       :files-applied
                       :else :active)
          safe-reconciled (select-keys (get-in envelope [:progress :reconciled])
                                       verified-causes)]
    (assoc envelope
           :phase safe-phase
           :progress {:files-applied (when (true? files-valid?) files-progress)
                      :reconciled safe-reconciled
                      :identity-acceptance (when identity-accepted?
                                             acceptance-progress)})))

(defn start-active!
  [inputs]
  (when (enabled?)
    (let [runtime (current-runtime)]
      (if (blocked? runtime)
        (p/resolved (blocked-result :coordination-blocked nil))
        (try
          (when-not (exact-active-input? inputs)
            (throw (ex-info "ACTIVE inputs are incomplete" {:code :invalid-active-inputs})))
          ;; Input validation and envelope construction are pure with respect to
          ;; the active slot; ownership of that slot is claimed only inside the
          ;; coordination turn, before any asynchronous binding validation or
          ;; persistence. Two overlapping starts therefore reserve turns in
          ;; call order and the second deterministically observes the first.
          (let [envelope (validate-envelope! runtime (envelope-from-inputs inputs))]
            (serialized! runtime
              (fn []
                (let [prior (:active @(runtime-state runtime))]
                  (cond
                    (and prior (not= (:transaction-id prior) (:transaction-id envelope)))
                    (p/resolved (blocked-result :incompatible-active nil))

                    prior
                    (p/resolved {:status :already-active :envelope prior})

                    :else
                    (-> (p/let [binding-valid? (invoke-async-port
                                                runtime :validate-binding! (:graph-binding inputs))
                                _ (when-not (true? binding-valid?)
                                    (throw (ex-info "ACTIVE graph binding is not accepted"
                                                    {:code :binding-mismatch})))
                                _ (invoke-async-port runtime :save-active!
                                                     (serialize-active envelope))
                                ;; Ownership is reserved by this turn; the
                                ;; post-save check is documented defense against
                                ;; a future path that installs an active slot
                                ;; outside the coordination boundary.
                                _ (when (some? (active-transaction-id runtime))
                                    (throw (ex-info
                                            "active slot was claimed by another transaction"
                                            {:code :incompatible-active})))]
                          (swap! (runtime-state runtime)
                                 (fn [state]
                                   (reduce (fn [result cause]
                                             (assoc-in result [:causes (:cause-id cause)]
                                                       (assoc cause :origin :incoming
                                                              :status :reconcile-pending)))
                                           (assoc state :active envelope)
                                           (:causes inputs))))
                          {:status :active :envelope envelope})
                        (p/catch (fn [error]
                                   (blocked-result (or (:code (ex-data error))
                                                       :active-refused)
                                                   error)))))))))
          (catch :default error
            (p/resolved (blocked-result (or (:code (ex-data error)) :active-refused)
                                        error))))))))

(defn recover-active!
  "Recover only the exact serialized envelope, then recompute its authoritative
  plan and validate the current graph binding through injected ports. The whole
  recovery runs as one coordination turn, so it cannot race a start or install a
  recovered record over a newer active lifecycle."
  []
  (when (enabled?)
    (let [runtime (current-runtime)
          serialized* (atom nil)
          envelope* (atom nil)]
      (if (blocked? runtime)
        (p/resolved (blocked-result :coordination-blocked nil))
        (serialized! runtime
          (fn []
            (-> (p/let [serialized (invoke-async-port runtime :load-active!)]
                 (reset! serialized* serialized)
                 (if-not serialized
                   {:status :none}
                   (let [envelope (validate-envelope! runtime (deserialize-active serialized))]
                     (reset! envelope* envelope)
                     (p/let [safe-envelope (recovered-envelope runtime envelope)]
                       (swap! (runtime-state runtime)
                              (fn [state]
                                (reduce (fn [result cause]
                                          (let [reconciled? (contains?
                                                             (set (keys (get-in safe-envelope
                                                                                [:progress :reconciled])))
                                                             (:cause-id cause))]
                                            (assoc-in result [:causes (:cause-id cause)]
                                                      (assoc cause :origin :incoming
                                                             :status (if reconciled?
                                                                       :reconciled
                                                                       :reconcile-pending)))))
                                        (assoc state :active safe-envelope
                                                     :recovery-envelope envelope)
                                        (get-in envelope [:inputs :causes]))))
                       {:status :recovery-pending :envelope safe-envelope}))))
               (p/catch
                (fn [error]
                  (swap! (runtime-state runtime) assoc :recovery-evidence
                         {:serialized @serialized* :envelope @envelope*})
                  (block-runtime! runtime :recover-active error)
                  (blocked-result (or (:code (ex-data error)) :recovery-refused)
                                  error))))))))))

(defn mark-files-applied!
  [transaction-id]
  (when (enabled?)
    (let [runtime (current-runtime)]
      (if (blocked? runtime)
        (p/resolved (blocked-result :coordination-blocked nil))
        (serialized! runtime
          (fn []
            (let [active (:active @(runtime-state runtime))]
              (cond
                (not= transaction-id (:transaction-id active))
                (p/resolved (blocked-result :transaction-mismatch nil))

                ;; Idempotent: a recorded receipt never regresses the phase or
                ;; duplicates persistence for a repeated call.
                (get-in active [:progress :files-applied])
                (p/resolved {:status :files-applied})

                :else
                (-> (p/let [receipt (invoke-async-port runtime :record-files-applied! active)
                            _ (when (nil? receipt)
                                (throw (ex-info "files-applied receipt is missing"
                                                {:code :missing-files-receipt})))
                            ;; A reconciliation may have advanced the record
                            ;; while this turn awaited its receipt; publish the
                            ;; current phase, never an older one.
                            phase (if (contains? #{:files-applied :identity-accepted}
                                                 (:phase active))
                                    (:phase active)
                                    :files-applied)
                            updated (-> active
                                        (assoc :phase phase)
                                        (assoc-in [:progress :files-applied]
                                                  {:transaction-id (:transaction-id active)
                                                   :receipt (canonical receipt)}))
                            ;; Ownership is reserved by this turn; the pre-save
                            ;; check is documented defense against a future path
                            ;; that installs an active slot outside the boundary.
                            _ (when (not= transaction-id (active-transaction-id runtime))
                                (throw (ex-info
                                        "active slot no longer belongs to this transaction"
                                        {:code :transaction-mismatch})))
                            _ (invoke-async-port runtime :save-active!
                                                 (serialize-active updated))]
                      (swap! (runtime-state runtime) assoc :active updated)
                      {:status :files-applied})
                    (p/catch #(blocked-result :progress-recording-failed %)))))))))))

(defn accept-identity!
  "Synthetic identity acceptance requires the injected validator to check the
  complete file/sidecar/binding evidence. A snapshot checkpoint alone cannot
  satisfy this boundary."
  [transaction-id evidence]
  (when (enabled?)
    (let [runtime (current-runtime)]
      (if (blocked? runtime)
        (p/resolved (blocked-result :coordination-blocked nil))
        (serialized! runtime
          (fn []
            (let [active (:active @(runtime-state runtime))
                  active-cause-ids (set (map :cause-id (get-in active [:inputs :causes])))
                  incoming (keep #(get-in @(runtime-state runtime) [:causes %])
                                 active-cause-ids)]
              (cond
                (not= transaction-id (:transaction-id active))
                (p/resolved (blocked-result :transaction-mismatch nil))
                (not= :files-applied (:phase active))
                (p/resolved (blocked-result :files-not-applied nil))
                (some #(not= :reconciled (:status %)) incoming)
                (p/resolved (blocked-result :reconciliation-pending nil))
                :else
                (-> (p/let [accepted? (invoke-async-port runtime :validate-acceptance!
                                                        active evidence)]
                      (if-not (true? accepted?)
                        (blocked-result :identity-evidence-incomplete nil)
                        (p/let [receipt (invoke-async-port runtime
                                                           :record-identity-acceptance!
                                                           active evidence)
                                _ (when (nil? receipt)
                                    (throw (ex-info "identity acceptance receipt is missing"
                                                    {:code :missing-acceptance-receipt})))
                                accepted (-> active
                                             (assoc :phase :identity-accepted)
                                             (assoc-in [:progress :identity-acceptance]
                                                       {:transaction-id (:transaction-id active)
                                                        :receipt (canonical receipt)}))
                                ;; Ownership is reserved by this turn; the
                                ;; pre-save check is documented defense against
                                ;; a future path that installs an active slot
                                ;; outside the coordination boundary.
                                _ (when (not= transaction-id (active-transaction-id runtime))
                                    (throw (ex-info
                                            "active slot no longer belongs to this transaction"
                                            {:code :transaction-mismatch})))
                                _ (invoke-async-port runtime :save-active!
                                                     (serialize-active accepted))]
                          (swap! (runtime-state runtime) assoc :active accepted)
                          {:status :identity-accepted})))
                  (p/catch #(blocked-result :acceptance-recording-failed %)))))))))))

(defn finish-active!
  [transaction-id]
  (when (enabled?)
    (let [runtime (current-runtime)]
      (if (blocked? runtime)
        (p/resolved (blocked-result :coordination-blocked nil))
        (serialized! runtime
          (fn []
            (let [active (:active @(runtime-state runtime))]
              (if-not (and (= transaction-id (:transaction-id active))
                           (= :identity-accepted (:phase active)))
                (p/resolved (blocked-result :acceptance-pending nil))
                (-> (p/let [_ (invoke-async-port runtime :clear-active!)]
                      ;; Revalidation after the asynchronous clear: a stale
                      ;; completion must never clear an active slot that a
                      ;; newer lifecycle now owns.
                      (if-not (= transaction-id (active-transaction-id runtime))
                        (blocked-result :acceptance-pending nil)
                        (do (swap! (runtime-state runtime) dissoc :active)
                            {:status :complete})))
                    (p/catch #(blocked-result :clear-active-failed %)))))))))))
