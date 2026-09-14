(ns frontend.fs.og-sync-bridge
  "Default-off, removable seams for the synthetic OG synchronization experiment.

  Production callers never install a runtime.  All state and every operational
  port belong to an explicitly bound test runtime; the disabled path therefore
  constructs no event payload, allocates no coordination state and performs no
  asynchronous work."
  (:require [cljs.reader :as reader]
            [clojure.set :as set]
            [goog.crypt :as crypt]
            [goog.crypt.Sha256]))

(goog-define ENABLE-OG-SYNC-BRIDGE false)

(def ^:dynamic *test-runtime* nil)
(defonce ^:private enabled-runtime*
  (when ENABLE-OG-SYNC-BRIDGE (atom nil)))

(def active-schema "frontend.fs.og-sync-bridge.active/1")

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

(defn- invoke-port
  [runtime port phase & args]
  (when-not (blocked? runtime)
    (try
      (when-let [f (get runtime port)]
        (apply f args))
      (catch :default error
        (block-runtime! runtime phase error)))))

(defn- emit!
  [runtime event]
  (invoke-port runtime :adapter! (:event event) event))

(defn- next-id!
  [runtime kind]
  (or (invoke-port runtime :next-id! :allocate-cause-id kind)
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
          (let [content-hash (invoke-port runtime :rename-content-hash!
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
     (some (fn [[_ cause]]
             (and (= :pending (:status cause))
                  (= graph-id (:graph-id cause))
                  (seq (set/intersection paths (cause-paths cause)))))
           (:writes @(runtime-state runtime))))))

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

(defn- reconcile-incoming!
  [runtime cause observation complete]
  (emit! runtime {:event :incoming-reconciliation-request
                  :cause cause :observation observation :complete-state complete})
  (if (blocked? runtime)
    {:status :ordinary :code :coordination-blocked}
    (try
      (let [result ((:reconcile! runtime) cause observation complete)
            reconciled (assoc cause :status :reconciled)
            active (:active @(runtime-state runtime))
            updated-active (when active
                             (assoc-in active [:progress :reconciled (:cause-id cause)] true))]
        ;; The retained success is written before this observation can become an
        ;; echo. Only later exact observations are eligible for deduplication.
        (when updated-active
          ((:save-active! runtime) (serialize-active updated-active)))
        (swap! (runtime-state runtime)
               (fn [state]
                 (cond-> (assoc-in state [:causes (:cause-id cause)] reconciled)
                   updated-active (assoc :active updated-active))))
        (emit! runtime {:event :incoming-reconciliation-result
                        :cause reconciled :status :success :result result})
        {:status :reconciled :cause reconciled :result result})
      (catch :default error
        (emit! runtime {:event :incoming-reconciliation-result
                        :cause cause :status :failure :error (str error)})
        {:status :reconciliation-failed :cause cause :error error}))))

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
        (let [complete (invoke-port runtime :complete-state!
                                    :watcher-complete-state observation)
              matches (when complete
                        (->> (:causes @(runtime-state runtime))
                             vals
                             (filter #(contains? #{:completed :reconcile-pending :reconciled}
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
           :phase :active :progress {:reconciled {}})))

(defn serialize-active
  [envelope]
  (canonical-string envelope))

(defn deserialize-active
  [serialized]
  (let [value (reader/read-string serialized)]
    (when-not (map? value)
      (throw (ex-info "ACTIVE envelope is not a map" {:code :invalid-active})))
    value))

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
  (let [revalidated (invoke-port runtime :revalidate-plan! :revalidate-plan (:inputs envelope))]
    (when (blocked? runtime)
      (throw (ex-info "authoritative plan revalidation failed" {:code :coordination-blocked})))
    (when-not (= (canonical revalidated)
                 (canonical (get-in envelope [:inputs :authoritative-plan])))
      (throw (ex-info "serialized preview/plan is not authoritative" {:code :plan-mismatch}))))
  (when-not (true? (invoke-port runtime :validate-binding! :validate-binding
                                (get-in envelope [:inputs :graph-binding])))
    (throw (ex-info "ACTIVE graph binding is not accepted" {:code :binding-mismatch})))
  envelope)

(defn start-active!
  [inputs]
  (when (enabled?)
    (let [runtime (current-runtime)]
      (try
        (when-not (exact-active-input? inputs)
          (throw (ex-info "ACTIVE inputs are incomplete" {:code :invalid-active-inputs})))
        (let [envelope (validate-envelope! runtime (envelope-from-inputs inputs))
              prior (:active @(runtime-state runtime))]
          (when (and prior (not= (:transaction-id prior) (:transaction-id envelope)))
            (throw (ex-info "an incompatible ACTIVE batch is pending"
                            {:code :incompatible-active})))
          (when-not prior
            ((:save-active! runtime) (serialize-active envelope))
            (swap! (runtime-state runtime)
                   (fn [state]
                     (reduce (fn [result cause]
                               (assoc-in result [:causes (:cause-id cause)]
                                         (assoc cause :origin :incoming
                                                :status :reconcile-pending)))
                             (assoc state :active envelope)
                             (:causes inputs)))))
          {:status (if prior :already-active :active) :envelope (or prior envelope)})
        (catch :default error
          {:status :blocked :code (or (:code (ex-data error)) :active-refused)
           :error error})))))

(defn recover-active!
  "Recover only the exact serialized envelope, then recompute its authoritative
  plan and validate the current graph binding through injected ports."
  []
  (when (enabled?)
    (let [runtime (current-runtime)]
      (try
        (if-let [serialized ((:load-active! runtime))]
          (let [envelope (validate-envelope! runtime (deserialize-active serialized))]
            (swap! (runtime-state runtime)
                   (fn [state]
                     (reduce (fn [result cause]
                               (assoc-in result [:causes (:cause-id cause)]
                                         (assoc cause :origin :incoming
                                                :status (if (or (= :identity-accepted (:phase envelope))
                                                                (get-in envelope [:progress :reconciled
                                                                                  (:cause-id cause)]))
                                                          :reconciled
                                                          :reconcile-pending))))
                             (assoc state :active envelope)
                             (get-in envelope [:inputs :causes]))))
            {:status :recovery-pending :envelope envelope})
          {:status :none})
        (catch :default error
          {:status :blocked :code (or (:code (ex-data error)) :recovery-refused)
           :error error})))))

(defn mark-files-applied!
  [transaction-id]
  (when (enabled?)
    (let [runtime (current-runtime)
          active (:active @(runtime-state runtime))]
      (if (= transaction-id (:transaction-id active))
        (let [updated (assoc active :phase :files-applied)]
          ((:save-active! runtime) (serialize-active updated))
          (swap! (runtime-state runtime) assoc :active updated)
          {:status :files-applied})
        {:status :blocked :code :transaction-mismatch}))))

(defn accept-identity!
  "Synthetic identity acceptance requires the injected validator to check the
  complete file/sidecar/binding evidence. A snapshot checkpoint alone cannot
  satisfy this boundary."
  [transaction-id evidence]
  (when (enabled?)
    (let [runtime (current-runtime)
          active (:active @(runtime-state runtime))
          active-cause-ids (set (map :cause-id (get-in active [:inputs :causes])))
          incoming (keep #(get-in @(runtime-state runtime) [:causes %]) active-cause-ids)]
      (cond
        (not= transaction-id (:transaction-id active))
        {:status :blocked :code :transaction-mismatch}
        (not= :files-applied (:phase active))
        {:status :blocked :code :files-not-applied}
        (some #(not= :reconciled (:status %)) incoming)
        {:status :blocked :code :reconciliation-pending}
        (not (true? (invoke-port runtime :validate-acceptance!
                                 :validate-acceptance active evidence)))
        {:status :blocked :code :identity-evidence-incomplete}
        :else
        (let [accepted (assoc active :phase :identity-accepted)]
          ((:save-active! runtime) (serialize-active accepted))
          (swap! (runtime-state runtime) assoc :active accepted)
          {:status :identity-accepted})))))

(defn finish-active!
  [transaction-id]
  (when (enabled?)
    (let [runtime (current-runtime)
          active (:active @(runtime-state runtime))]
      (if (and (= transaction-id (:transaction-id active))
               (= :identity-accepted (:phase active)))
        (do
          ((:clear-active! runtime))
          (swap! (runtime-state runtime) dissoc :active)
          {:status :complete})
        {:status :blocked :code :acceptance-pending}))))
