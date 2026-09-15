(ns frontend.fs.og-sync-e2e-adapter
  "Test-only adapter between the default-off og-sync-bridge runtime and the
  standalone f28-sync-prototype JavaScript modules.

  This namespace lives under src/test and is never imported by production
  code, so the standalone prototype is never bundled into the application.
  It loads the actual modules at runtime through Node's require (the compiled
  node-test bundle resolves it against the checkout root) and backs the
  injected bridge ports with their real pure logic:

  - plan validation recomputes the authoritative comparison plan with the
    actual snapshot-comparison module instead of echoing the caller's plan;
  - identity acceptance parses the retained sidecar bytes and validates them
    with the actual identity module against the recomputed projected snapshot;
  - working-file, checkpoint, sidecar and evidence stores are in-memory atoms.

  Everything that would touch a real filesystem, graph, watcher, OG database,
  native helper or network stays simulated: the working files, the snapshot
  checkpoint, the sidecar bytes and the evidence ledgers are atoms, and this
  adapter performs no filesystem or graph-data access at all. Only node:crypto
  is loaded, for the same sha256:<hex> content-hash format the identity module
  and the bridge cause tokens already use.

  Module data keeps the JSON string keys of the JavaScript modules; the bridge
  cause/input envelopes keep their keyword keys. No algorithm of a loaded
  module is duplicated here — the adapter only orchestrates the modules and
  converts data.")

(def ^:private proto-prefix
  "The compiled node-test bundle binds `require` to static/tests.js, so this
  relative prefix resolves against the checkout root. The dynamically
  constructed string also keeps the compiler from trying to bundle the
  standalone prototype into any build."
  "../f28-sync-prototype/src/")

(defn- proto-module
  [name]
  (js/require (str proto-prefix name ".js")))

(def ^:private core (proto-module "core"))
(def ^:private executor (proto-module "executor"))
(def ^:private planner (proto-module "planner"))
(def ^:private comparison-module (proto-module "snapshot-comparison"))
(def ^:private identity-module (proto-module "identity-capture"))
(def ^:private node-crypto (js/require "node:crypto"))

(defn <-js
  [value]
  (js->clj value))

(defn ->js
  [value]
  (clj->js value))

(defn content-hash
  "The sha256:<hex> content hash format shared by the identity module and the
  bridge cause tokens."
  [content]
  (let [hasher (.createHash node-crypto "sha256")]
    (.update hasher content "utf8")
    (str "sha256:" (.digest hasher "hex"))))

(defn stable-stringify
  [value]
  (.stableStringify core (->js value)))

(defn generation
  [character]
  (apply str (repeat 64 character)))

(defn- utf8-compare
  [left right]
  (.compare js/Buffer
            (.from js/Buffer left "utf8")
            (.from js/Buffer right "utf8")))

;; ---------------------------------------------------------------------------
;; Synthetic state construction (actual core module)
;; ---------------------------------------------------------------------------

(defn create-state
  [graph-id]
  (<-js (.createState core graph-id)))

(defn apply-operation!
  [state operation]
  (let [transition (<-js (.applyOperation core (->js state) (->js operation)))]
    (when-not (get transition "changed")
      (throw (ex-info "synthetic seed operation did not change the state"
                      {:operation operation})))
    (get transition "state")))

(defn seed-state
  [graph-id seed-files]
  (reduce (fn [state [index file]]
            (apply-operation! state
                              {"operationId" (str "seed-op-" index)
                               "kind" "create"
                               "fileId" (:file-id file)
                               "revisionId" (str "seed-rev-" index)
                               "parentRevisionId" nil
                               "path" (:path file)
                               "content" (:content file)}))
          (create-state graph-id)
          (map-indexed vector seed-files)))

(defn head-revision
  [state file-id]
  (get-in state ["revisions" (first (get-in state ["files" file-id "heads"]))]))

(defn live-files
  "The simulated working folder: {path content} for every live single head."
  [state]
  (into {}
        (comp (map (fn [[_file-id file]]
                     (let [revision (get-in state ["revisions" (first (get file "heads"))])]
                       (when-not (get revision "deleted")
                         [(get revision "path") (get revision "content")]))))
              (remove nil?))
        (get state "files")))

(defn- selected-files
  "The materialized file list of a selected snapshot, ordered exactly like the
  JavaScript validation orders it (UTF-8 path bytes)."
  [state]
  (->> (get state "files")
       (map (fn [[_file-id file]]
              (get-in state ["revisions" (first (get file "heads"))])))
       (remove #(get % "deleted"))
       (map (fn [revision] {"path" (get revision "path")
                            "content" (get revision "content")}))
       (sort (fn [left right] (utf8-compare (get left "path") (get right "path"))))
       vec))

(defn snapshot-fingerprint
  [state]
  (.snapshotFingerprint planner (->js state)))

(defn selected-snapshot
  [state generation]
  {"schema" "f28-selected-snapshot/1"
   "generation" generation
   "snapshotFingerprint" (snapshot-fingerprint state)
   "state" state
   "files" (selected-files state)})

;; ---------------------------------------------------------------------------
;; Identity enrollment and change capture (actual identity module)
;; ---------------------------------------------------------------------------

(defn enrollment-files
  [state]
  (mapv (fn [[file-id file]]
          (let [revision (get-in state ["revisions" (first (get file "heads"))])]
            {:file-id file-id
             :path (get revision "path")
             :content (get revision "content")
             :accepted-revision (get revision "id")}))
        (get state "files")))

(defn enroll-identity
  [selected {:keys [graph-id replica-id metadata-revision]} files]
  (let [result (<-js (.enrollIdentityMetadata
                      identity-module
                      (->js {"schema" "f28-identity-enrollment/1"
                             "complete" true
                             "graphId" graph-id
                             "replicaId" replica-id
                             "metadataRevision" metadata-revision
                             "files" (mapv (fn [{:keys [file-id path content accepted-revision]}]
                                            {"fileId" file-id
                                             "path" path
                                             "content" content
                                             "acceptedRevision" accepted-revision})
                                          files)})
                      (->js selected)))]
    {:metadata (get result "metadata")
     :replica (get result "replica")}))

(defn initialize-replica
  [metadata replica-id selected]
  (<-js (.initializeReplica identity-module (->js metadata) replica-id (->js selected))))

(defn capture-changes
  [{:keys [metadata replica selected expected-metadata-revision
           proposed-metadata-revision observations review-decisions]}]
  (<-js (.captureChanges
         identity-module
         (->js {"schema" "f28-capture-batch/1"
                "metadata" metadata
                "replica" replica
                "acceptedSnapshot" selected
                "expectedMetadataRevision" expected-metadata-revision
                "proposedMetadataRevision" proposed-metadata-revision
                "observations" (vec observations)
                "reviewDecisions" (vec (or review-decisions []))}))))

(defn metadata-valid?
  "Run the actual identity validator over a metadata/selected-snapshot pair."
  [metadata selected]
  (try
    (.validateMetadata identity-module (->js metadata) (->js selected))
    true
    (catch :default _error
      false)))

(defn identity-bytes
  [metadata]
  (stable-stringify metadata))

(defn parse-identity-bytes
  [bytes]
  (<-js (.parse js/JSON bytes)))

;; ---------------------------------------------------------------------------
;; Comparison and execution (actual comparison/executor modules)
;; ---------------------------------------------------------------------------

(defn compare-snapshots
  [selected target]
  (<-js (.compareSnapshots comparison-module (->js selected) (->js target))))

(defn execute-plan
  [source-state events plan]
  (<-js (.executePlan executor
                      (->js {"sourceSnapshot" source-state
                             "events" events
                             "plan" plan
                             "destinationSnapshot" source-state}))))

(defn derive-transaction
  "Recompute the authoritative comparison plan for a selected/target pair and
  execute exactly that plan in memory. Returns the comparison, the plan, the
  executor result, the projected state and its materialized working files.
  Throws when the comparison is ineligible or the executor refuses, so no
  caller can plan a transaction from partial or conflicting data."
  [selected target]
  (let [comparison (compare-snapshots selected target)]
    (when-not (get-in comparison ["eligibility" "eligible"])
      (throw (ex-info "snapshot comparison is not eligible"
                      {:code :comparison-not-eligible})))
    (let [plan (get comparison "plan")]
      (when-not plan
        (throw (ex-info "eligible comparison exposes no executable plan"
                        {:code :no-executable-plan})))
      (let [execution (execute-plan (get selected "state")
                                    (get comparison "proposedEvents")
                                    plan)]
        (when-not (contains? #{"applied" "already-applied"} (get execution "status"))
          (throw (ex-info "the authoritative plan execution was refused"
                          {:code :execution-refused
                           :execution (dissoc execution "state")})))
        (let [projected (get execution "state")]
          {:comparison comparison
           :plan plan
           :execution execution
           :projected projected
           :projected-files (live-files projected)})))))

(defn recompute-authoritative-plan
  "Bridge plan-validation port body: recompute the comparison plan from the
  retained source snapshot and target with the actual comparison module. It
  never returns or trusts the plan supplied by the caller."
  [inputs]
  (let [comparison (compare-snapshots (:source-snapshot inputs)
                                      (:target inputs))]
    (when-not (get-in comparison ["eligibility" "eligible"])
      (throw (ex-info "retained snapshot/target pair is not eligible"
                      {:code :comparison-not-eligible})))
    (let [plan (get comparison "plan")]
      (when-not plan
        (throw (ex-info "eligible retained comparison exposes no plan"
                        {:code :no-executable-plan})))
      plan)))

(defn operation-ids
  [plan]
  (mapv #(get-in % ["operation" "operationId"]) (get plan "actions")))

;; ---------------------------------------------------------------------------
;; Simulated world and bridge runtime
;; ---------------------------------------------------------------------------

(defn e2e-world
  "One simulated replica: the accepted snapshot/metadata basis and the fake
  in-memory stores that stand in for working files, the snapshot checkpoint,
  the identity sidecar, the ACTIVE record store and the authoritative
  evidence ledgers. No real file, graph or profile is touched."
  [{:keys [graph-id seed-files basis-generation replica-id metadata-revision]}]
  (let [state (seed-state graph-id seed-files)
        selected (selected-snapshot state basis-generation)
        {:keys [metadata replica]} (enroll-identity
                                    selected
                                    {:graph-id graph-id
                                     :replica-id replica-id
                                     :metadata-revision metadata-revision}
                                    (enrollment-files state))]
    {:graph-id graph-id
     :state state
     :selected selected
     :metadata metadata
     :replica replica
     :binding (atom {:root-id "synthetic-root" :graph-id graph-id})
     :working-files (atom (live-files state))
     :checkpoint (atom selected)
     :identity-bytes (atom nil)
     :stored (atom nil)
     :progress-evidence (atom #{})
     :files-evidence (atom #{})
     :acceptance-evidence (atom #{})
     :reconcile-calls (atom [])
     :clear-failure (atom nil)}))

(defn- projected-cause-check
  "Reconciliation body: the observed incoming cause must be an operation of the
  recomputed authoritative plan, and the plan's projected head for its file
  must carry exactly the cause's path and content hash."
  [state* cause]
  (let [active (:active @state*)
        inputs (:inputs active)
        derived (derive-transaction (:source-snapshot inputs) (:target inputs))
        action (some #(when (= (:operation-id cause)
                               (get-in % ["operation" "operationId"]))
                        %)
                     (get-in derived [:plan "actions"]))]
    (when-not action
      (throw (ex-info "reconciliation cause is not part of the authoritative plan"
                      {:code :cause-operation-unknown})))
    (let [file-id (get-in action ["operation" "fileId"])
          revision (head-revision (:projected derived) file-id)]
      (if (get revision "deleted")
        (when-not (and (= :delete (:kind cause))
                       (= (:old-path cause) (get revision "path")))
          (throw (ex-info "delete cause does not match the projected tombstone"
                          {:code :projected-path-mismatch})))
        (do
          (when-not (= (:content-hash cause)
                       (content-hash (get revision "content")))
            (throw (ex-info "observed content does not match the projected head"
                            {:code :projected-content-mismatch})))
          (when-not (= (or (:new-path cause) (:path cause)) (get revision "path"))
            (throw (ex-info "cause path does not match the projected head path"
                            {:code :projected-path-mismatch})))))
      :ok)))

(defn- acceptance-valid?
  "Identity-acceptance body: every piece of accepted evidence must agree with
  the actual recomputation over the retained envelope inputs — the projected
  working files, the sidecar metadata validated by the real identity module
  against the projected snapshot, the snapshot checkpoint and the graph
  binding. A snapshot checkpoint alone, or any tampered file, projection,
  sidecar or binding, refuses acceptance."
  [world active evidence]
  (let [inputs (:inputs active)
        derived (derive-transaction (:source-snapshot inputs) (:target inputs))
        projected (:projected derived)
        next-selected (selected-snapshot projected (:target-generation inputs))
        sidecar (parse-identity-bytes (:proposed-identity-bytes inputs))]
    (boolean
     (and
      ;; Files: evidence, simulated working folder and the materialized heads
      ;; of the recomputed projection are byte-identical.
      (= (:files-match evidence) @(:working-files world) (:projected-files derived))
      ;; The retained projection in the envelope equals the recomputed one.
      (= (:projected-snapshot inputs) projected)
      ;; Identity: the evidence sidecar is the retained envelope bytes and
      ;; validates over the projected snapshot with the actual module.
      (= (:identity-bytes-match evidence) @(:identity-bytes world)
         (:proposed-identity-bytes inputs))
      (metadata-valid? sidecar next-selected)
      ;; Checkpoint: evidence and durable checkpoint are the selected snapshot
      ;; over the recomputed projection at the exact target generation.
      (= (:checkpoint-match evidence) @(:checkpoint world) next-selected)
      ;; Binding: evidence equals the enrolled binding and the projected graph.
      (= (:binding-match evidence) @(:binding world))
      (= (:graph-id world) (:graph-id (:binding-match evidence)))))))

(defn e2e-runtime
  "A bridge test runtime whose ports run the actual prototype logic over the
  simulated world. The adapter port records the single event-map argument it
  receives (never nil/undefined). Plan revalidation recomputes the comparison
  plan; identity acceptance validates the actual sidecar bytes; reconciliation
  checks the cause against the recomputed plan projection; complete state is
  derived from the working folder only — rename evidence requires old-path
  absence plus byte-identical new-path content against a retained cause, and
  incomplete, contradictory or ambiguous evidence never infers a rename. The
  storage, evidence and working-file ports are the fake in-memory stores of
  the world."
  [world]
  (let [state* (atom {:causes {} :writes {}})
        events (atom [])
        counter (atom 0)]
    {:state state*
     :events events
     :world world
     :adapter! (fn [event]
                ;; The bridge port contract passes exactly one argument — the
                ;; event map itself; the kind keyword is the port phase. A
                ;; recorder with the wrong arity would silently store
                ;; undefined, so any non-event argument is kept as a loud
                ;; invalid marker that no event assertion can filter past.
                (swap! events conj
                       (if (and (map? event) (keyword? (:event event)))
                         event
                         {:event :invalid-event-record
                          :recorded-argument event})))
     :next-id! (fn [kind] (str (name kind) "-" (swap! counter inc)))
     :rename-content-hash! (fn [_graph path]
                             (content-hash (get @(:working-files world) path "")))
     :complete-state!
     (fn [observation]
       (let [path (:path observation)
             working @(:working-files world)
             graph-id (:graph-id world)
             ;; Complete rename evidence: a retained rename cause whose new
             ;; path is the observed path, whose old path is absent from the
             ;; working folder and whose exact unchanged content hash the new
             ;; path holds. Content alone never infers a rename — the cause's
             ;; own old/new paths and content hash must all agree.
             rename-candidates
             (when (contains? working path)
               (let [hash (content-hash (get working path))]
                 (->> (vals (:causes @state*))
                      (filter #(= :rename (:kind %)))
                      (filter #(= path (:new-path %)))
                      (filter #(and (not (contains? working (:old-path %)))
                                    (= hash (:content-hash %))))
                      vec)))]
         (if (contains? working path)
           (cond
             (= 1 (count rename-candidates))
             (let [cause (first rename-candidates)]
               {:graph-id graph-id
                :old-path (:old-path cause)
                :old-present false
                :new-path (:new-path cause)
                :new-present true
                :new-content-hash (:content-hash cause)})

             (zero? (count rename-candidates))
             ;; Ordinary new-path presence: save/update/create evidence only.
             ;; A rename cause with incomplete or contradictory folder
             ;; evidence deliberately does not match this map.
             {:graph-id graph-id
              :new-path path
              :new-present true
              :new-content-hash (content-hash (get working path))}

             ;; Several retained rename causes fit the same evidence. Only
             ;; when they agree on the old path is the shared evidence
             ;; emitted, so the bridge itself sees the multi-cause ambiguity
             ;; (match-count > 1 stays :ordinary). Contradictory old paths
             ;; are refused outright: no identity may be guessed.
             :else
             (let [old-paths (set (map :old-path rename-candidates))]
               (when (= 1 (count old-paths))
                 {:graph-id graph-id
                  :old-path (first old-paths)
                  :old-present false
                  :new-path path
                  :new-present true
                  :new-content-hash (content-hash (get working path))})))
           ;; The observed path is absent from the working folder: only
           ;; old-path absence evidence exists, which can settle a delete
           ;; cause and stays deliberately incomplete for a rename.
           {:graph-id graph-id
            :old-path path
            :old-present false})))
     :reconcile!
     (fn [cause _observation _complete]
       (swap! (:reconcile-calls world) conj (:cause-id cause))
       (projected-cause-check state* cause))
     :record-reconciliation-progress!
     (fn [active cause _result]
       (let [receipt {:transaction-id (:transaction-id active)
                      :cause-id (:cause-id cause)
                      :operation-id (:operation-id cause)}]
         (swap! (:progress-evidence world) conj receipt)
         receipt))
     :validate-reconciliation-progress!
     (fn [_active _cause entry]
       (contains? @(:progress-evidence world) (:receipt entry)))
     :record-files-applied!
     (fn [active]
       (let [receipt {:transaction-id (:transaction-id active)}]
         (swap! (:files-evidence world) conj receipt)
         receipt))
     :validate-files-applied-progress!
     (fn [_active entry]
       (contains? @(:files-evidence world) (:receipt entry)))
     :record-identity-acceptance!
     (fn [active _evidence]
       (let [receipt {:transaction-id (:transaction-id active)}]
         (swap! (:acceptance-evidence world) conj receipt)
         receipt))
     :validate-identity-acceptance-progress!
     (fn [_active entry]
       (contains? @(:acceptance-evidence world) (:receipt entry)))
     :save-active! (fn [serialized] (reset! (:stored world) serialized))
     :load-active! (fn [] @(:stored world))
     :clear-active!
     (fn []
       (case @(:clear-failure world)
         :fail-without-clear
         (throw (js/Error. "synthetic clear failed before removing the record"))
         :fail-after-clear
         (do (reset! (:stored world) nil)
             (throw (js/Error. "synthetic clear failed after removing the record")))
         (reset! (:stored world) nil)))
     :revalidate-plan! (fn [inputs] (recompute-authoritative-plan inputs))
     :validate-binding! (fn [binding] (boolean (= binding @(:binding world))))
     :validate-acceptance!
     (fn [active evidence]
       (boolean
        (when (and (map? evidence)
                   (= #{:files-match :identity-bytes-match
                        :checkpoint-match :binding-match}
                      (set (keys evidence))))
          (acceptance-valid? world active evidence))))}))

(def ^:const invalid-event-record-kind
  "The recorded kind for an adapter argument that was not an event map. A
  recorder with the wrong arity stores undefined; this marker makes that
  visible instead of silently filterable."
  :invalid-event-record)

(defn event-records
  "Every entry the runtime's adapter port recorded, in completion order. The
  bridge delivers exactly one argument per event — the event map itself — so
  every real record is a map with an :event kind keyword. Anything else is
  kept as an {:event :invalid-event-record} marker."
  [runtime]
  @(:events runtime))

(defn event-kinds
  "The recorded event kinds, in the order the adapter received them."
  [runtime]
  (mapv :event (event-records runtime)))

(defn valid-event-records?
  "True only when every recorded entry is a real bridge event map: a map with
  an :event kind keyword and no invalid marker. A recorder that passed
  nil/undefined through, or stored the wrong argument, fails this check."
  [runtime]
  (boolean
   (every? (fn [entry]
             (and (map? entry)
                  (keyword? (:event entry))
                  (not= invalid-event-record-kind (:event entry))))
           (event-records runtime))))

(defn events-of-kind
  "The recorded event maps of one kind, in order."
  [runtime kind]
  (filterv #(= kind (:event %)) (event-records runtime)))

(defn first-event-of-kind
  "The first recorded event map of one kind, or nil."
  [runtime kind]
  (first (events-of-kind runtime kind)))

(defn transaction-inputs
  "Assemble the ACTIVE input envelope from the actual capture/derivation
  result. The values are the real module outputs; the bridge recomputes the
  plan and validates the acceptance against them."
  [{:keys [graph-id replica-id selected target derived identity-bytes
           target-generation causes preview-id binding]}]
  (let [plan (:plan derived)]
    {:graph-id graph-id
     :replica-id replica-id
     :source-snapshot selected
     :issued-preview {:preview-id preview-id
                      :comparison-schema "f28-snapshot-comparison/2"
                      :basis {:generation (get selected "generation")
                              :snapshotFingerprint (get selected "snapshotFingerprint")}}
     :target target
     :authoritative-plan plan
     :projected-snapshot (:projected derived)
     :proposed-identity-bytes identity-bytes
     :basis-generation (get selected "generation")
     :target-generation target-generation
     :operation-ids (operation-ids plan)
     :working-journal-identity {:journal-id (str "journal-" preview-id)
                                :plan-id (get plan "planId")
                                :projected-snapshot-fingerprint
                                (get plan "projectedSnapshotFingerprint")}
     :graph-binding binding
     :causes (vec causes)}))

(defn apply-transaction-to-world!
  "Simulate the application steps a real deployment would perform through the
  stable working helper and sidecar writer: materialize the projected files
  into the simulated working folder, write the snapshot checkpoint over the
  projected state and store the proposed sidecar bytes. All in memory."
  [world derived target-generation identity-bytes]
  (reset! (:working-files world) (:projected-files derived))
  (reset! (:checkpoint world) (selected-snapshot (:projected derived) target-generation))
  (reset! (:identity-bytes world) identity-bytes))

(defn acceptance-evidence
  "The durable artifacts acceptance must validate: the applied working files,
  the written sidecar bytes, the snapshot checkpoint and the graph binding."
  [world]
  {:files-match @(:working-files world)
   :identity-bytes-match @(:identity-bytes world)
   :checkpoint-match @(:checkpoint world)
   :binding-match @(:binding world)})