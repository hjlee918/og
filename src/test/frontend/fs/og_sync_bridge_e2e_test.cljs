(ns frontend.fs.og-sync-bridge-e2e-test
  "End-to-end in-memory verification of the default-off OG bridge against the
  actual f28-sync-prototype modules, loaded through the test-only adapter.

  Previous bridge tests injected stand-ins for plan validation and identity
  acceptance. These tests connect those boundaries to the real pure prototype
  logic: bridge save/rename evidence feeds the actual capture module, the
  authoritative plan is recomputed from the retained source/target pair with
  the actual comparison module, the exact plan is executed in memory by the
  actual executor, and identity acceptance validates the retained sidecar
  bytes with the actual identity module over the recomputed projection.

  The adapter port receives exactly one argument per event — the event map —
  and every recorded entry is asserted as a real event map with kind, cause
  identity and completion order. One synthetic rename round trip exercises
  local rename intent/completion, actual capture/comparison/plan/execution, a
  simulated incoming rename through the review decision path, reconciliation,
  metadata acceptance and the next capture from the accepted basis. The
  complete-state adapter supplies rename evidence from the working folder
  only: old-path absence plus new-path byte-identical content matched against
  a retained cause; incomplete, contradictory or ambiguous evidence never
  infers a rename.

  Working files, the snapshot checkpoint, the sidecar, ACTIVE storage and the
  evidence ledgers are simulated in-memory atoms. No filesystem, graph,
  profile, application, native helper or network is accessed; Korean page
  names and content exercise exact byte handling without any file access."
  (:require [cljs.test :refer [is]]
            [frontend.fs.og-sync-bridge :as bridge]
            [frontend.fs.og-sync-e2e-adapter :as adapter]
            [frontend.test.helper :include-macros true :refer [deftest-async]]
            [promesa.core :as p]))

(def ^:private graph-id "e2e-graph")

(def ^:private korean-file
  {:file-id "file-a"
   :path "pages/한글-문서.md"
   :content "# 첫 문서\n\n기존 내용입니다.\n"})

(def ^:private notes-file
  {:file-id "file-b"
   :path "pages/notes.md"
   :content "notes v1\n"})

(defn- bc
  "Call a bridge entry point with the runtime bound. Promise continuations do
  not inherit dynamic bindings, so every entry call rebinds."
  [runtime f & args]
  (binding [bridge/*test-runtime* runtime]
    (apply f args)))

(defn- e2e-basis
  []
  (adapter/e2e-world {:graph-id graph-id
                       :seed-files [korean-file notes-file]
                       :basis-generation (adapter/generation \a)
                       :replica-id "replica-a"
                       :metadata-revision "meta-1"}))

(defn- prepare-local-save
  "Drive one local save into the actual modules: the bridge's save-completion
  evidence (cause ID and content) becomes the capture observations, and the
  capture result is re-derived through the actual comparison/executor. No
  bridge lifecycle state is touched."
  [world runtime {:keys [file-id path new-content proposed-metadata-revision]}]
  (let [cause (bc runtime bridge/save-pending! (:graph-id world) path new-content)
        _ (bc runtime bridge/save-completed! cause :ok)
        accepted-revision (get-in world [:metadata "files" file-id "acceptedRevision"])
        observations
        [{"observationId" (str "obs-save-" (:cause-id cause))
          "type" "save-complete"
          "saveId" (:cause-id cause)
          "fileId" file-id
          "path" path
          "content" new-content
          "parentRevisionId" accepted-revision
          "revisionId" (str "causal-" (:cause-id cause))}
         {"observationId" (str "obs-read-" (:cause-id cause))
          "type" "stable-read"
          "causeType" "save"
          "causeId" (:cause-id cause)
          "path" path
          "content" new-content
          "stable" true}]
        result (adapter/capture-changes
                {:metadata (:metadata world)
                 :replica (:replica world)
                 :selected (:selected world)
                 :expected-metadata-revision (get-in world [:metadata "metadataRevision"])
                 :proposed-metadata-revision proposed-metadata-revision
                 :observations observations})]
    (when-not (get-in result ["eligibility" "eligible"])
      (throw (ex-info "local save capture was not eligible"
                      {:invalid (get result "invalid")
                       :review-items (get result "reviewItems")})))
    (let [derived (adapter/derive-transaction (:selected world) (get result "target"))]
      {:result result
       :derived derived
       :cause cause
       :observations observations
       :identity-bytes (adapter/identity-bytes (get result "proposedMetadata"))})))

(defn- prepare-incoming-transaction
  "A remote replica saves a file; its eligible target (produced by the actual
  capture module) arrives at this replica, whose actual comparison/executor
  result defines the authoritative plan, the incoming cause and the identity
  bytes for the sidecar. No bridge lifecycle state is touched."
  [world {:keys [remote-content cause-id]}]
  (let [remote-enrollment (adapter/enroll-identity
                           (:selected world)
                           {:graph-id (:graph-id world)
                            :replica-id "replica-b"
                            :metadata-revision (get-in world [:metadata "metadataRevision"])}
                           (adapter/enrollment-files (:state world)))
        remote-metadata (:metadata remote-enrollment)
        remote-replica (:replica remote-enrollment)
        accepted-file-b (get-in world [:metadata "files" "file-b" "acceptedRevision"])
        remote-save (adapter/capture-changes
                     {:metadata remote-metadata
                      :replica remote-replica
                      :selected (:selected world)
                      :expected-metadata-revision (get-in world [:metadata "metadataRevision"])
                      :proposed-metadata-revision "meta-remote-2"
                      :observations
                      [{"observationId" "obs-remote-save"
                        "type" "save-complete"
                        "saveId" "remote-save-1"
                        "fileId" "file-b"
                        "path" "pages/notes.md"
                        "content" remote-content
                        "parentRevisionId" accepted-file-b
                        "revisionId" "remote-causal-rev-1"}
                       {"observationId" "obs-remote-read"
                        "type" "stable-read"
                        "causeType" "save"
                        "causeId" "remote-save-1"
                        "path" "pages/notes.md"
                        "content" remote-content
                        "stable" true}]})
        target (get remote-save "target")
        derived (adapter/derive-transaction (:selected world) target)
        incoming-op (get-in derived [:plan "actions" 0 "operation"])
        incoming-capture (adapter/capture-changes
                          {:metadata (:metadata world)
                           :replica (:replica world)
                           :selected (:selected world)
                           :expected-metadata-revision (get-in world [:metadata "metadataRevision"])
                           :proposed-metadata-revision "meta-2"
                           :observations
                           [{"observationId" "obs-incoming-applied"
                             "type" "external-change"
                             "fileId" "file-b"
                             "path" "pages/notes.md"
                             "content" remote-content
                             "stable" true
                             "parentRevisionId" accepted-file-b
                             "revisionId" (get incoming-op "revisionId")}]})]
    (when-not (get-in remote-save ["eligibility" "eligible"])
      (throw (ex-info "remote capture was not eligible" {})))
    (when-not (get-in incoming-capture ["eligibility" "eligible"])
      (throw (ex-info "incoming capture was not eligible" {})))
    {:result incoming-capture
     :remote-result remote-save
     :target target
     :derived derived
     :incoming-op incoming-op
     :identity-bytes (adapter/identity-bytes (get incoming-capture "proposedMetadata"))
     :cause {:cause-id (or cause-id "incoming-save-1")
             :operation-id (get incoming-op "operationId")
             :graph-id (:graph-id world)
             :kind :update
             :path "pages/notes.md"
             :content-hash (adapter/content-hash remote-content)}}))

(defn- prepare-local-rename
  "Drive one local rename into the actual modules: the bridge's rename cause
  (cause ID, old/new paths, unchanged content hash) becomes the capture
  observations — rename intent, completion and a stable read asserting old
  path absence — and the capture result is re-derived through the actual
  comparison/executor. The simulated working folder supplies the file move;
  no bridge lifecycle state and no filesystem are touched."
  [world runtime {:keys [file-id old-path new-path content
                          proposed-metadata-revision]}]
  (let [cause (bc runtime bridge/rename-intent! (:graph-id world) old-path new-path)
        _ (swap! (:working-files world)
                 #(-> (dissoc % old-path) (assoc new-path content)))
        _ (bc runtime bridge/rename-completed! cause :ok)
        accepted-revision (get-in world [:metadata "files" file-id "acceptedRevision"])
        observations
        [{"observationId" (str "obs-rename-intent-" (:cause-id cause))
          "type" "rename-intent"
          "renameId" (:cause-id cause)
          "fileId" file-id
          "oldPath" old-path
          "newPath" new-path
          "parentRevisionId" accepted-revision
          "revisionId" (str "causal-" (:cause-id cause))}
         {"observationId" (str "obs-rename-complete-" (:cause-id cause))
          "type" "rename-complete"
          "renameId" (:cause-id cause)
          "succeeded" true}
         {"observationId" (str "obs-rename-read-" (:cause-id cause))
          "type" "stable-read"
          "causeType" "rename"
          "causeId" (:cause-id cause)
          "path" new-path
          "content" content
          "stable" true
          "oldPathAbsent" true}]
        result (adapter/capture-changes
                {:metadata (:metadata world)
                 :replica (:replica world)
                 :selected (:selected world)
                 :expected-metadata-revision (get-in world [:metadata "metadataRevision"])
                 :proposed-metadata-revision proposed-metadata-revision
                 :observations observations})]
    (when-not (get-in result ["eligibility" "eligible"])
      (throw (ex-info "local rename capture was not eligible"
                      {:invalid (get result "invalid")
                       :review-items (get result "reviewItems")})))
    {:result result
     :derived (adapter/derive-transaction (:selected world) (get result "target"))
     :cause cause
     :content content
     :identity-bytes (adapter/identity-bytes (get result "proposedMetadata"))}))

(defn- prepare-incoming-rename
  "A remote replica renames a known file through the actual modules; its
  eligible target arrives at this replica, which observes only the watcher
  effects — the old path unlinked and a new path added with byte-identical
  content. Both effects require review; the review decision binds them into
  one rename at the revision the authoritative comparison plan names. Returns
  the destination capture, the derivation, both observations and the bridge
  cause. No bridge lifecycle state is touched."
  [world {:keys [file-id old-path new-path content cause-id
                 proposed-metadata-revision enrollment-state]}]
  (let [selected (:selected world)
        remote-enrollment (adapter/enroll-identity
                           selected
                           {:graph-id (:graph-id world)
                            :replica-id "replica-b"
                            :metadata-revision (get-in world [:metadata "metadataRevision"])}
                           (adapter/enrollment-files (or enrollment-state (:state world))))
        remote-metadata (:metadata remote-enrollment)
        remote-replica (:replica remote-enrollment)
        remote-accepted (get-in remote-metadata ["files" file-id "acceptedRevision"])
        remote-rename (adapter/capture-changes
                       {:metadata remote-metadata
                        :replica remote-replica
                        :selected selected
                        :expected-metadata-revision (get-in remote-metadata ["metadataRevision"])
                        :proposed-metadata-revision "meta-remote-rename"
                        :observations
                        [{"observationId" "obs-remote-rename-intent"
                          "type" "rename-intent"
                          "renameId" "remote-rename-1"
                          "fileId" file-id
                          "oldPath" old-path
                          "newPath" new-path
                          "parentRevisionId" remote-accepted
                          "revisionId" "remote-causal-rename-1"}
                         {"observationId" "obs-remote-rename-complete"
                          "type" "rename-complete"
                          "renameId" "remote-rename-1"
                          "succeeded" true}
                         {"observationId" "obs-remote-rename-read"
                          "type" "stable-read"
                          "causeType" "rename"
                          "causeId" "remote-rename-1"
                          "path" new-path
                          "content" content
                          "stable" true
                          "oldPathAbsent" true}]})
        target (get remote-rename "target")
        derived (adapter/derive-transaction selected target)
        rename-op (get-in derived [:plan "actions" 0 "operation"])
        unlink-obs {"observationId" "obs-incoming-rename-unlink"
                    "type" "external-unlink"
                    "fileId" file-id
                    "path" old-path}
        add-obs {"observationId" "obs-incoming-rename-add"
                 "type" "external-add"
                 "fileId" file-id
                 "path" new-path
                 "content" content
                 "stable" true
                 "parentRevisionId" remote-accepted
                 "revisionId" "remote-causal-rename-1"}
        capture-base {:metadata (:metadata world)
                      :replica (:replica world)
                      :selected selected
                      :expected-metadata-revision (get-in world [:metadata "metadataRevision"])
                      :proposed-metadata-revision proposed-metadata-revision}
        first-capture (adapter/capture-changes
                       (merge capture-base {:observations [unlink-obs add-obs]}))
        review-items (get first-capture "reviewItems")
        pending-ids (mapv #(get % "pendingId") review-items)
        incoming-capture (adapter/capture-changes
                          (merge capture-base
                                 {:observations [unlink-obs add-obs]
                                  :review-decisions
                                  [{"decisionId" "decision-rename-1"
                                    "pendingIds" pending-ids
                                    "metadataRevision" (get-in world [:metadata "metadataRevision"])
                                    "action" "rename"
                                    "fileId" file-id
                                    "revisionId" (get rename-op "revisionId")}]}))]
    (when-not (get-in remote-rename ["eligibility" "eligible"])
      (throw (ex-info "remote rename capture was not eligible" {})))
    (when-not (get-in incoming-capture ["eligibility" "eligible"])
      (throw (ex-info "incoming rename capture was not eligible"
                      {:invalid (get incoming-capture "invalid")
                       :review-items (get incoming-capture "reviewItems")})))
    {:result incoming-capture
     :first-capture first-capture
     :remote-result remote-rename
     :target target
     :derived derived
     :rename-op rename-op
     :unlink-obs unlink-obs
     :add-obs add-obs
     :identity-bytes (adapter/identity-bytes (get incoming-capture "proposedMetadata"))
     :cause {:cause-id (or cause-id "incoming-rename-1")
             :operation-id (get rename-op "operationId")
             :graph-id (:graph-id world)
             :kind :rename
             :old-path old-path
             :new-path new-path
             :content-hash (adapter/content-hash content)}}))

(defn- inputs-for
  [world prepared {:keys [preview-id target-generation causes]}]
  (adapter/transaction-inputs
   {:graph-id (:graph-id world)
    :replica-id "replica-a"
    :selected (:selected world)
    :target (or (:target prepared) (get-in prepared [:result "target"]))
    :derived (:derived prepared)
    :identity-bytes (:identity-bytes prepared)
    :target-generation target-generation
    :causes (vec (or causes []))
    :preview-id preview-id
    :binding @(:binding world)}))

(defn- start-and-apply!
  "Publish ACTIVE for the prepared transaction and simulate the working-file
  application, snapshot checkpoint write and sidecar write over the world."
  [world runtime inputs derived {:keys [target-generation identity-bytes]}]
  (p/let [started (bc runtime bridge/start-active! inputs)]
    (when-not (= :active (:status started))
      (throw (ex-info "transaction start was refused" {:started started})))
    (adapter/apply-transaction-to-world! world derived target-generation identity-bytes)
    {:transaction-id (get-in started [:envelope :transaction-id])
     :started started}))

(defn- complete-lifecycle!
  [world runtime transaction-id]
  (p/let [marked (bc runtime bridge/mark-files-applied! transaction-id)
          accepted (bc runtime bridge/accept-identity!
                      transaction-id (adapter/acceptance-evidence world))
          finished (bc runtime bridge/finish-active! transaction-id)]
    {:marked marked :accepted accepted :finished finished}))

;; ---------------------------------------------------------------------------
;; Scenario 1: local save
;; ---------------------------------------------------------------------------

(deftest-async local-save-executes-the-authoritative-plan-and-derives-identity
  (let [world (e2e-basis)
        runtime (adapter/e2e-runtime world)
        new-content "# 첫 문서\n\n기존 내용입니다.\n\n두 번째 문단을 로컬에서 저장했습니다.\n"
        target-generation (adapter/generation \b)]
    (p/let [prepared (prepare-local-save
                      world runtime
                      {:file-id "file-a"
                       :path "pages/한글-문서.md"
                       :new-content new-content
                       :proposed-metadata-revision "meta-2"})
            started (start-and-apply!
                     world runtime
                     (inputs-for world prepared {:preview-id "preview-e2e-save-1"
                                                 :target-generation target-generation})
                     (:derived prepared)
                     {:target-generation target-generation
                      :identity-bytes (:identity-bytes prepared)})
            lifecycle (complete-lifecycle! world runtime (:transaction-id started))]
      (is (= :files-applied (:status (:marked lifecycle))))
      (is (= :identity-accepted (:status (:accepted lifecycle))))
      (is (= :complete (:status (:finished lifecycle))))
      (is (nil? @(:stored world)))
      ;; The recomputed derivation equals the capture's own comparison.
      (is (= (get-in prepared [:derived :plan])
             (get-in prepared [:result "comparison" "plan"])))
      (is (= 1 (count (get-in prepared [:derived :plan "actions"]))))
      ;; Exact identity: the plan operation, the projected head and the
      ;; proposed metadata name the same revision, path and Korean content.
      (let [operation (get-in prepared [:derived :plan "actions" 0 "operation"])
            head (adapter/head-revision (get-in prepared [:derived :projected]) "file-a")
            proposed (get-in prepared [:result "proposedMetadata" "files" "file-a"])]
        (is (= "update" (get operation "kind")))
        (is (= "file-a" (get operation "fileId")))
        (is (= new-content (get head "content")))
        (is (= "pages/한글-문서.md" (get head "path")))
        (is (= (get operation "revisionId") (get proposed "acceptedRevision")))
        (is (= (get head "id") (get proposed "acceptedRevision")))
        (is (= (adapter/content-hash new-content) (get proposed "acceptedContentHash")))
        (is (= "meta-2" (get-in prepared [:result "proposedMetadata" "metadataRevision"]))))
      ;; The actual identity validator accepts the proposed sidecar over the
      ;; recomputed checkpoint snapshot.
      (is (true? (adapter/metadata-valid? (get-in prepared [:result "proposedMetadata"])
                                           @(:checkpoint world))))
      (is (= (:identity-bytes prepared) @(:identity-bytes world)))
      (is (= {"pages/한글-문서.md" new-content
              "pages/notes.md" "notes v1\n"}
             @(:working-files world)))
      (is (= target-generation (get @(:checkpoint world) "generation")))
      (is (= (get-in prepared [:derived :plan "projectedSnapshotFingerprint"])
             (get @(:checkpoint world) "snapshotFingerprint")))
      ;; The completed local edit is never reapplied as an incoming write: its
      ;; watcher observation classifies as a completed local cause and no
      ;; reconciliation is ever requested.
      (is (= :completed-local
             (:status (bc runtime bridge/observe-watcher!
                          "change" "/synthetic" "pages/한글-문서.md"
                          new-content {} false))))
      (is (empty? @(:reconcile-calls world)))
      ;; The adapter recorded real event maps — never nil/undefined records
      ;; from a mismatched recorder — with exact cause identity and
      ;; completion order.
      (is (adapter/valid-event-records? runtime))
      (is (= [:save-pending :save-completed :raw-watcher-observation]
             (adapter/event-kinds runtime)))
      (let [save-pending (adapter/first-event-of-kind runtime :save-pending)
            save-completed (adapter/first-event-of-kind runtime :save-completed)
            raw-observation (adapter/first-event-of-kind runtime :raw-watcher-observation)]
        (is (= {:cause-id "save-1" :origin :local :kind :save
                :graph-id graph-id :path "pages/한글-문서.md"
                :content-hash (adapter/content-hash new-content) :status :pending}
               (:cause save-pending)))
        (is (= {:cause-id "save-1" :origin :local :kind :save
                :graph-id graph-id :path "pages/한글-문서.md"
                :content-hash (adapter/content-hash new-content)
                :status :completed}
               (:cause save-completed)))
        (is (= :ok (:result save-completed)))
        (is (= {:type "change" :dir "/synthetic" :path "pages/한글-문서.md"
                :content new-content :stat {} :global-dir false}
               (:observation raw-observation)))
        ;; The local save never became an incoming cause or reconciliation.
        (is (empty? (adapter/events-of-kind runtime :incoming-cause-pending)))
        (is (empty? (adapter/events-of-kind runtime :incoming-reconciliation-request)))
        (is (empty? (adapter/events-of-kind runtime :incoming-reconciliation-result))))
      ;; Replaying the same completed save against the reinitialized accepted
      ;; basis is refused by the actual capture module: the accepted revision
      ;; moved, so the old evidence cannot capture or reapply anything.
      (let [next-metadata (get-in prepared [:result "proposedMetadata"])
            next-selected @(:checkpoint world)
            next-replica (adapter/initialize-replica next-metadata "replica-a" next-selected)
            replay (adapter/capture-changes
                    {:metadata next-metadata
                     :replica next-replica
                     :selected next-selected
                     :expected-metadata-revision "meta-2"
                     :proposed-metadata-revision "meta-3"
                     :observations (:observations prepared)})]
        (is (= [] (get next-replica "pendingObservations")))
        (is (false? (get-in replay ["eligibility" "eligible"])))
        (is (nil? (get replay "target")))
        (is (some #(= "save-evidence-mismatch" (get % "code"))
                  (get replay "reviewItems")))))))

;; ---------------------------------------------------------------------------
;; Scenario 2: incoming change
;; ---------------------------------------------------------------------------

(deftest-async incoming-change-completes-with-exact-ids-paths-revisions-content
  (let [world (e2e-basis)
        runtime (adapter/e2e-runtime world)
        remote-content "notes v2 — 원격 복제본에서 저장한 변경입니다.\n"
        target-generation (adapter/generation \b)
        prepared (prepare-incoming-transaction world {:remote-content remote-content})
        incoming-op (:incoming-op prepared)
        inputs (inputs-for world prepared
                           {:preview-id "preview-e2e-incoming"
                            :target-generation target-generation
                            :causes [(:cause prepared)]})]
    ;; Cross-replica determinism: both replicas derive the same plan and the
    ;; same target from the same basis and content.
    (is (= (:plan (:derived prepared))
           (get-in prepared [:remote-result "comparison" "plan"])))
    (is (= (:target prepared) (get-in prepared [:result "target"])))
    (is (= (:plan (:derived prepared))
           (get-in prepared [:result "comparison" "plan"])))
    (p/let [started (bc runtime bridge/start-active! inputs)
            _ (is (= :active (:status started)))
            transaction-id (get-in started [:envelope :transaction-id])
            _ (adapter/apply-transaction-to-world!
               world (:derived prepared) target-generation (:identity-bytes prepared))
            observation (bc runtime bridge/observe-watcher!
                            "change" "/synthetic" "pages/notes.md" remote-content {} false)
            _ (is (= :reconciliation-pending (:status observation)))
            settled (:settled observation)
            _ (is (= :reconciled (:status settled)))
            echo (bc runtime bridge/observe-watcher!
                     "change" "/synthetic" "pages/notes.md" remote-content {} false)
            _ (is (= :echo (:status echo)))
            _ (is (= 1 (count @(:reconcile-calls world))))
            marked (bc runtime bridge/mark-files-applied! transaction-id)
            accepted (bc runtime bridge/accept-identity!
                        transaction-id (adapter/acceptance-evidence world))
            finished (bc runtime bridge/finish-active! transaction-id)]
      (is (= :files-applied (:status marked)))
      (is (= :identity-accepted (:status accepted)))
      (is (= :complete (:status finished)))
      (is (nil? @(:stored world)))
      ;; Exact identity: operation, projected head and accepted sidecar name
      ;; the same revision, path and content. The untouched Korean file keeps
      ;; its basis revision.
      (let [head (adapter/head-revision (get-in prepared [:derived :projected]) "file-b")
            untouched (adapter/head-revision (get-in prepared [:derived :projected]) "file-a")
            sidecar (get-in prepared [:result "proposedMetadata" "files" "file-b"])]
        (is (= "update" (get incoming-op "kind")))
        (is (= "file-b" (get incoming-op "fileId")))
        (is (= (get-in world [:metadata "files" "file-b" "acceptedRevision"])
               (get incoming-op "parentRevisionId")))
        (is (= "compare-revision-"
               (subs (get incoming-op "revisionId") 0 (count "compare-revision-"))))
        (is (= remote-content (get head "content")))
        (is (= "pages/notes.md" (get head "path")))
        (is (= (get incoming-op "revisionId")
               (get head "id")
               (get sidecar "acceptedRevision")))
        (is (= (adapter/content-hash remote-content) (get sidecar "acceptedContentHash")))
        (is (= "pages/notes.md" (get sidecar "path")))
        (is (= "seed-rev-0" (get untouched "id")))
        (is (= "pages/한글-문서.md" (get untouched "path"))))
      (is (= {"pages/한글-문서.md" "# 첫 문서\n\n기존 내용입니다.\n"
              "pages/notes.md" remote-content}
             @(:working-files world)))
      (is (= target-generation (get @(:checkpoint world) "generation")))
      ;; Transaction-bound receipts were recorded for reconciliation, files
      ;; application and identity acceptance.
      (is (contains? @(:progress-evidence world)
                     {:transaction-id transaction-id
                      :cause-id "incoming-save-1"
                      :operation-id (get incoming-op "operationId")}))
      (is (contains? @(:files-evidence world) {:transaction-id transaction-id}))
      (is (contains? @(:acceptance-evidence world) {:transaction-id transaction-id}))
      ;; Real recorded event maps: the raw observation, the reconciliation
      ;; request with cause/observation/complete-state identity, the success
      ;; result, and the echo's raw observation — in that exact order.
      (is (adapter/valid-event-records? runtime))
      (is (= [:raw-watcher-observation :incoming-reconciliation-request
              :incoming-reconciliation-result :raw-watcher-observation]
             (adapter/event-kinds runtime)))
      (let [request (adapter/first-event-of-kind runtime :incoming-reconciliation-request)
            result (adapter/first-event-of-kind runtime :incoming-reconciliation-result)]
        (is (= "incoming-save-1" (get-in request [:cause :cause-id])))
        (is (= :incoming (get-in request [:cause :origin])))
        (is (= :update (get-in request [:cause :kind])))
        (is (= graph-id (get-in request [:cause :graph-id])))
        (is (= "pages/notes.md" (get-in request [:cause :path])))
        (is (= (get incoming-op "operationId") (get-in request [:cause :operation-id])))
        (is (= (adapter/content-hash remote-content) (get-in request [:cause :content-hash])))
        (is (= {:type "change" :dir "/synthetic" :path "pages/notes.md"
                :content remote-content :stat {} :global-dir false}
               (:observation request)))
        (is (= {:graph-id graph-id :new-path "pages/notes.md" :new-present true
                :new-content-hash (adapter/content-hash remote-content)}
               (:complete-state request)))
        (is (= :success (:status result)))
        (is (= :reconciled (get-in result [:cause :status])))
        (is (= "incoming-save-1" (get-in result [:cause :cause-id])))
        (is (= :ok (:result result)))))))

;; ---------------------------------------------------------------------------
;; Scenario 3: subsequent operation from the accepted result
;; ---------------------------------------------------------------------------

(deftest-async subsequent-transaction-runs-from-the-reinitialized-accepted-basis
  (let [world (e2e-basis)
        runtime (adapter/e2e-runtime world)
        first-content "# 첫 문서\n\n기존 내용입니다.\n\n첫 트랜잭션에서 저장했습니다.\n"
        second-content "notes v2 — 두 번째 트랜잭션의 로컬 저장입니다.\n"]
    (p/let [prepared-1 (prepare-local-save
                        world runtime
                        {:file-id "file-a"
                         :path "pages/한글-문서.md"
                         :new-content first-content
                         :proposed-metadata-revision "meta-2"})
            started-1 (start-and-apply!
                       world runtime
                       (inputs-for world prepared-1
                                   {:preview-id "preview-e2e-next-1"
                                    :target-generation (adapter/generation \b)})
                       (:derived prepared-1)
                       {:target-generation (adapter/generation \b)
                        :identity-bytes (:identity-bytes prepared-1)})
            lifecycle-1 (complete-lifecycle! world runtime (:transaction-id started-1))
            ;; Initialize the next replica from the actually accepted result.
            next-metadata (get-in prepared-1 [:result "proposedMetadata"])
            next-selected @(:checkpoint world)
            next-replica (adapter/initialize-replica next-metadata "replica-a" next-selected)
            _ (is (= :complete (:status (:finished lifecycle-1))))
            _ (is (= [] (get next-replica "pendingObservations")))
            advanced-world (assoc world
                                  :metadata next-metadata
                                  :replica next-replica
                                  :selected next-selected)
            ;; Process another edit from that accepted basis.
            prepared-2 (prepare-local-save
                        advanced-world runtime
                        {:file-id "file-b"
                         :path "pages/notes.md"
                         :new-content second-content
                         :proposed-metadata-revision "meta-3"})
            started-2 (start-and-apply!
                       advanced-world runtime
                       (inputs-for advanced-world prepared-2
                                   {:preview-id "preview-e2e-next-2"
                                    :target-generation (adapter/generation \c)})
                       (:derived prepared-2)
                       {:target-generation (adapter/generation \c)
                        :identity-bytes (:identity-bytes prepared-2)})
            lifecycle-2 (complete-lifecycle! advanced-world runtime
                                             (:transaction-id started-2))]
      (is (= :identity-accepted (:status (:accepted lifecycle-2))))
      (is (= :complete (:status (:finished lifecycle-2))))
      (let [final-metadata (get-in prepared-2 [:result "proposedMetadata"])
            final-state (get-in prepared-2 [:derived :projected])]
        (is (= "meta-3" (get final-metadata "metadataRevision")))
        ;; Accepted metadata and snapshot revisions agree for every file:
        ;; each acceptedRevision is exactly the current head revision.
        (doseq [[file-id entry] (get final-metadata "files")]
          (let [head (adapter/head-revision final-state file-id)]
            (is (= (get entry "acceptedRevision") (get head "id")))
            (is (= (get entry "path") (get head "path")))
            (is (= (get entry "acceptedContentHash")
                   (adapter/content-hash (get head "content"))))))
        ;; The whole accepted identity map validates over the final snapshot.
        (is (true? (adapter/metadata-valid? final-metadata @(:checkpoint world))))
        (is (= (adapter/identity-bytes final-metadata) @(:identity-bytes world)))
        (is (= (set (map #(get % "acceptedRevision")
                         (vals (get final-metadata "files"))))
               (set (map (fn [file-id]
                           (get (adapter/head-revision final-state file-id) "id"))
                         (keys (get final-metadata "files"))))))))))

;; ---------------------------------------------------------------------------
;; Scenario 4: restart
;; ---------------------------------------------------------------------------

(deftest-async restart-recovers-incomplete-work-with-the-recomputed-plan
  (let [world (e2e-basis)
        runtime (adapter/e2e-runtime world)
        remote-content "notes v2 — 재시작 전에 도착한 원격 변경입니다.\n"
        target-generation (adapter/generation \b)
        prepared (prepare-incoming-transaction world {:remote-content remote-content})
        inputs (inputs-for world prepared
                           {:preview-id "preview-e2e-restart"
                            :target-generation target-generation
                            :causes [(:cause prepared)]})]
    (p/let [started (bc runtime bridge/start-active! inputs)
            _ (is (= :active (:status started)))
            transaction-id (get-in started [:envelope :transaction-id])
            ;; Simulated restart: a fresh runtime over the retained fake
            ;; storage and evidence ledgers only.
            restarted (adapter/e2e-runtime world)
            recovery (bc restarted bridge/recover-active!)
            _ (is (= :recovery-pending (:status recovery)))
            _ (is (= transaction-id (get-in recovery [:envelope :transaction-id])))
            ;; No files/acceptance receipt existed, so the recovered phase
            ;; stays :active — serialized claims alone prove nothing. The plan
            ;; was revalidated by recomputation from the retained pair.
            _ (is (= :active (get-in recovery [:envelope :phase])))
            _ (is (= :reconcile-pending
                     (get-in @(:state restarted) [:causes "incoming-save-1" :status])))
            ;; An incompatible batch is refused while the recovered ACTIVE
            ;; holds the slot.
            incompatible (bc restarted bridge/start-active!
                            (assoc inputs :target-generation (adapter/generation \z)))
            _ (is (= :incompatible-active (:code incompatible)))
            ;; Continue the incomplete work to completion on the restarted
            ;; runtime.
            _ (adapter/apply-transaction-to-world!
               world (:derived prepared) target-generation (:identity-bytes prepared))
            observation (bc restarted bridge/observe-watcher!
                           "change" "/synthetic" "pages/notes.md" remote-content {} false)
            settled (:settled observation)
            _ (is (= :reconciled (:status settled)))
            marked (bc restarted bridge/mark-files-applied! transaction-id)
            accepted (bc restarted bridge/accept-identity!
                        transaction-id (adapter/acceptance-evidence world))
            finished (bc restarted bridge/finish-active! transaction-id)]
      (is (= :files-applied (:status marked)))
      (is (= :identity-accepted (:status accepted)))
      (is (= :complete (:status finished)))
      (is (nil? @(:stored world)))
      ;; A restarted runtime also refuses a record whose retained target was
      ;; altered: the recomputed transaction digest no longer matches.
      (p/let [prepared-2 (prepare-incoming-transaction
                          world {:remote-content "notes v3 — 새 원격 변경입니다.\n"
                                 :cause-id "incoming-save-2"})
              second-started (bc restarted bridge/start-active!
                                 (inputs-for world prepared-2
                                             {:preview-id "preview-e2e-restart-2"
                                              :target-generation (adapter/generation \c)
                                              :causes [(:cause prepared-2)]}))
              _ (is (= :active (:status second-started)))
              tampered (-> (bridge/deserialize-active @(:stored world))
                           (assoc-in [:inputs :target "files" 1 "content"]
                                     "위조된 내용입니다.\n")
                           bridge/serialize-active)
              tampered-runtime (adapter/e2e-runtime
                               (assoc world :stored (atom tampered)))
              tampered-result (bc tampered-runtime bridge/recover-active!)]
        (is (= :tampered-active (:code tampered-result)))))))

(deftest-async forged-progress-downgrades-to-pending-evidence
  (let [world (e2e-basis)
        runtime (adapter/e2e-runtime world)
        target-generation (adapter/generation \b)]
    (p/let [prepared (prepare-local-save
                      world runtime
                      {:file-id "file-a"
                       :path "pages/한글-문서.md"
                       :new-content "# 첫 문서\n\n기존 내용입니다.\n\n위조 방지 검사용 저장입니다.\n"
                       :proposed-metadata-revision "meta-2"})
            started (bc runtime bridge/start-active!
                        (inputs-for world prepared
                                    {:preview-id "preview-e2e-forged"
                                     :target-generation target-generation}))
            _ (is (= :active (:status started)))
            transaction-id (get-in started [:envelope :transaction-id])
            ;; Forge a serialized files-applied claim with no ledger receipt.
            forged (-> (bridge/deserialize-active @(:stored world))
                       (assoc :phase :files-applied)
                       (assoc-in [:progress :files-applied]
                                 {:transaction-id transaction-id
                                  :receipt {:transaction-id transaction-id
                                            :forged true}})
                       bridge/serialize-active)
            forged-runtime (adapter/e2e-runtime (assoc world :stored (atom forged)))
            recovery (bc forged-runtime bridge/recover-active!)]
      ;; The plan and inputs revalidate through recomputation, but the
      ;; unproven progress claim is downgraded to pending evidence.
      (is (= :recovery-pending (:status recovery)))
      (is (= transaction-id (get-in recovery [:envelope :transaction-id])))
      (is (= :active (get-in recovery [:envelope :phase])))
      (is (nil? (get-in recovery [:envelope :progress :files-applied])))
      ;; The genuine record is retained untouched by the original store.
      (is (some? @(:stored world)))
      (is (= :active (:phase (bridge/deserialize-active @(:stored world))))))))

(deftest-async uncertain-clear-resolves-only-through-validated-recovery
  ;; Branch 1: the clear failed and the record survived.
  (let [world (e2e-basis)
        runtime (adapter/e2e-runtime world)
        target-generation (adapter/generation \b)]
    (p/let [prepared (prepare-local-save
                      world runtime
                      {:file-id "file-a"
                       :path "pages/한글-문서.md"
                       :new-content "# 첫 문서\n\n기존 내용입니다.\n\n불확실 완료 검사용 저장입니다.\n"
                       :proposed-metadata-revision "meta-2"})
            started (start-and-apply!
                     world runtime
                     (inputs-for world prepared
                                 {:preview-id "preview-e2e-unclear-1"
                                  :target-generation target-generation})
                     (:derived prepared)
                     {:target-generation target-generation
                      :identity-bytes (:identity-bytes prepared)})
            transaction-id (:transaction-id started)
            _ (bc runtime bridge/mark-files-applied! transaction-id)
            _ (bc runtime bridge/accept-identity! transaction-id
                  (adapter/acceptance-evidence world))
            _ (reset! (:clear-failure world) :fail-without-clear)
            failed-finish (bc runtime bridge/finish-active! transaction-id)
            _ (is (= :clear-active-uncertain (:code failed-finish)))
            repeat-finish (bc runtime bridge/finish-active! transaction-id)
            _ (is (= :clear-active-uncertain (:code repeat-finish)))
            prepared-2 (prepare-local-save
                        world runtime
                        {:file-id "file-b"
                         :path "pages/notes.md"
                         :new-content "notes v2 — 예약 중에는 시작이 거부됩니다.\n"
                         :proposed-metadata-revision "meta-2"})
            ;; While the reservation stands, no other transaction is admitted:
            ;; the retained accepted record still owns the active slot.
            refused-start (bc runtime bridge/start-active!
                            (inputs-for world prepared-2
                                        {:preview-id "preview-e2e-unclear-refused"
                                         :target-generation (adapter/generation \c)}))
            _ (is (= :incompatible-active (:code refused-start)))
            ;; Validated recovery: the record survived the failed clear.
            recovery (bc runtime bridge/recover-active!)
            _ (is (= :recovery-pending (:status recovery)))
            _ (is (= :identity-accepted (get-in recovery [:envelope :phase])))
            ;; The reservation is resolved; the clear can now be retried.
            _ (reset! (:clear-failure world) nil)
            finished (bc runtime bridge/finish-active! transaction-id)]
      (is (= :complete (:status finished)))
      (is (nil? @(:stored world)))
      ;; Branch 2: the clear removed the record but never acknowledged.
      (p/let [world-2 (e2e-basis)
              runtime-2 (adapter/e2e-runtime world-2)
              prepared-3 (prepare-local-save
                          world-2 runtime-2
                          {:file-id "file-a"
                           :path "pages/한글-문서.md"
                           :new-content "# 첫 문서\n\n기존 내용입니다.\n\n두 번째 불확실 완료 검사입니다.\n"
                           :proposed-metadata-revision "meta-2"})
              started-2 (start-and-apply!
                         world-2 runtime-2
                         (inputs-for world-2 prepared-3
                                     {:preview-id "preview-e2e-unclear-2"
                                      :target-generation target-generation})
                         (:derived prepared-3)
                         {:target-generation target-generation
                          :identity-bytes (:identity-bytes prepared-3)})
              _ (bc runtime-2 bridge/mark-files-applied! (:transaction-id started-2))
              _ (bc runtime-2 bridge/accept-identity! (:transaction-id started-2)
                    (adapter/acceptance-evidence world-2))
              _ (reset! (:clear-failure world-2) :fail-after-clear)
              failed (bc runtime-2 bridge/finish-active! (:transaction-id started-2))
              _ (is (= :clear-active-uncertain (:code failed)))
              recovery-2 (bc runtime-2 bridge/recover-active!)]
        (is (= :none (:status recovery-2)))
        (is (= :uncertain-clear (:resolved recovery-2)))
        (is (nil? @(:stored world-2)))
        ;; The runtime is idle again; a new transaction over the reinitialized
        ;; accepted basis is admitted.
        (p/let [;; The reinitialized accepted basis after the resolved clear.
              next-metadata (get-in prepared-3 [:result "proposedMetadata"])
              next-selected @(:checkpoint world-2)
              next-replica (adapter/initialize-replica next-metadata "replica-a" next-selected)
              advanced-world (assoc world-2
                                    :metadata next-metadata
                                    :replica next-replica
                                    :selected next-selected)
              prepared-5 (prepare-local-save
                          advanced-world runtime-2
                          {:file-id "file-b"
                           :path "pages/notes.md"
                           :new-content "notes v2 — 예약 해소 후 새 트랜잭션입니다.\n"
                           :proposed-metadata-revision "meta-3"})
              new-start (bc runtime-2 bridge/start-active!
                            (inputs-for advanced-world prepared-5
                                        {:preview-id "preview-e2e-unclear-3"
                                         :target-generation (adapter/generation \c)}))]
          (is (= :active (:status new-start))))))))

;; ---------------------------------------------------------------------------
;; Scenario 5: refusals
;; ---------------------------------------------------------------------------

(deftest-async changed-plan-is-refused-by-recomputation
  (let [world (e2e-basis)
        runtime (adapter/e2e-runtime world)
        prepared (prepare-local-save
                  world runtime
                  {:file-id "file-a"
                   :path "pages/한글-문서.md"
                   :new-content "# 첫 문서\n\n기존 내용입니다.\n\n계획 변경 거부 검사용 저장입니다.\n"
                   :proposed-metadata-revision "meta-2"})
        genuine-plan (get-in prepared [:derived :plan])
        altered-plan (assoc-in genuine-plan ["actions" 0 "reasons"] [])
        genuine-inputs (inputs-for world prepared
                                    {:preview-id "preview-e2e-refusal-plan"
                                     :target-generation (adapter/generation \b)})]
    (p/let [refused (bc runtime bridge/start-active!
                        (assoc genuine-inputs :authoritative-plan altered-plan))]
      (is (= :plan-mismatch (:code refused)))
      ;; Nothing was persisted and no false success remains.
      (is (nil? @(:stored world)))
      (is (nil? (get-in @(:state runtime) [:active])))
      ;; The runtime is not latched: the genuine transaction still starts.
      (p/let [started (bc runtime bridge/start-active! genuine-inputs)]
        (is (= :active (:status started)))))))

(deftest-async changed-projection-and-identity-metadata-are-refused-at-acceptance
  ;; A changed projected snapshot inside the retained envelope.
  (let [world (e2e-basis)
        runtime (adapter/e2e-runtime world)
        target-generation (adapter/generation \b)]
    (p/let [prepared (prepare-local-save
                      world runtime
                      {:file-id "file-a"
                       :path "pages/한글-문서.md"
                       :new-content "# 첫 문서\n\n기존 내용입니다.\n\n투영 변경 거부 검사용 저장입니다.\n"
                       :proposed-metadata-revision "meta-2"})
            inputs (inputs-for world prepared
                               {:preview-id "preview-e2e-refusal-projection"
                                :target-generation target-generation})
            ;; The retained projection is replaced by the basis state.
            started (bc runtime bridge/start-active!
                        (assoc inputs :projected-snapshot (:state world)))
            _ (is (= :active (:status started)))
            transaction-id (get-in started [:envelope :transaction-id])
            _ (adapter/apply-transaction-to-world!
               world (:derived prepared) target-generation (:identity-bytes prepared))
            _ (bc runtime bridge/mark-files-applied! transaction-id)
            refused (bc runtime bridge/accept-identity!
                      transaction-id (adapter/acceptance-evidence world))
            _ (is (= :identity-evidence-incomplete (:code refused)))
            ;; Evidence is preserved: the serialized record still holds the
            ;; transaction at files-applied, and no false success is possible.
            retained (bridge/deserialize-active @(:stored world))
            _ (is (some? @(:stored world)))
            _ (is (= :files-applied (:phase retained)))
            _ (is (nil? (get-in retained [:progress :identity-acceptance])))
            blocked-finish (bc runtime bridge/finish-active! transaction-id)]
      (is (= :acceptance-pending (:code blocked-finish)))
      ;; A changed identity sidecar is refused by the actual validator on a
      ;; fresh runtime.
      (p/let [world-2 (e2e-basis)
              runtime-2 (adapter/e2e-runtime world-2)
              prepared-2 (prepare-local-save
                          world-2 runtime-2
                          {:file-id "file-a"
                           :path "pages/한글-문서.md"
                           :new-content "# 첫 문서\n\n기존 내용입니다.\n\n정체성 변경 거부 검사용 저장입니다.\n"
                           :proposed-metadata-revision "meta-2"})
              tampered-metadata (assoc-in
                                 (get-in prepared-2 [:result "proposedMetadata"])
                                 ["files" "file-a" "acceptedRevision"]
                                 "위조-개정-id")
              tampered-bytes (adapter/identity-bytes tampered-metadata)
              inputs-2 (inputs-for world-2 prepared-2
                                    {:preview-id "preview-e2e-refusal-identity"
                                     :target-generation target-generation})
              started-2 (bc runtime-2 bridge/start-active!
                           (assoc inputs-2 :proposed-identity-bytes tampered-bytes))
              _ (is (= :active (:status started-2)))
              transaction-id-2 (get-in started-2 [:envelope :transaction-id])
              _ (adapter/apply-transaction-to-world!
                 world-2 (:derived prepared-2) target-generation tampered-bytes)
              _ (bc runtime-2 bridge/mark-files-applied! transaction-id-2)
              refused-2 (bc runtime-2 bridge/accept-identity!
                           transaction-id-2 (adapter/acceptance-evidence world-2))
              _ (is (= :identity-evidence-incomplete (:code refused-2)))
              _ (is (some? @(:stored world-2)))
              blocked-finish-2 (bc runtime-2 bridge/finish-active! transaction-id-2)]
        (is (= :acceptance-pending (:code blocked-finish-2)))))))

(deftest-async different-local-edit-stays-ordinary-and-preserves-retryable-evidence
  (let [world (e2e-basis)
        runtime (adapter/e2e-runtime world)
        remote-content "notes v2 — 다른 로컬 편집 검사용 원격 변경입니다.\n"
        target-generation (adapter/generation \b)
        prepared (prepare-incoming-transaction world {:remote-content remote-content})
        inputs (inputs-for world prepared
                           {:preview-id "preview-e2e-local-edit"
                            :target-generation target-generation
                            :causes [(:cause prepared)]})]
    (p/let [started (bc runtime bridge/start-active! inputs)
            _ (is (= :active (:status started)))
            transaction-id (get-in started [:envelope :transaction-id])
            _ (adapter/apply-transaction-to-world!
               world (:derived prepared) target-generation (:identity-bytes prepared))
            ;; Acceptance before the files-applied phase is refused.
            premature (bc runtime bridge/accept-identity!
                         transaction-id (adapter/acceptance-evidence world))
            _ (is (= :files-not-applied (:code premature)))
            _ (bc runtime bridge/mark-files-applied! transaction-id)
            ;; The exact applied content settles the incoming cause once.
            first-observation (bc runtime bridge/observe-watcher!
                                 "change" "/synthetic" "pages/notes.md" remote-content {} false)
            first-settled (:settled first-observation)
            _ (is (= :reconciled (:status first-settled)))
            ;; Incomplete acceptance evidence is refused.
            incomplete (bc runtime bridge/accept-identity!
                          transaction-id (dissoc (adapter/acceptance-evidence world)
                                                 :checkpoint-match))
            _ (is (= :identity-evidence-incomplete (:code incomplete)))
            ;; A different local edit at the cause path is an ordinary
            ;; observation: no new reconciliation starts and the reconciled
            ;; cause evidence is preserved.
            _ (swap! (:working-files world) assoc "pages/notes.md"
                     "notes v3 — 다른 로컬 편집입니다.\n")
            ordinary (bc runtime bridge/observe-watcher!
                        "change" "/synthetic" "pages/notes.md"
                        "notes v3 — 다른 로컬 편집입니다.\n" {} false)
            _ (is (= :ordinary (:status ordinary)))
            _ (is (= :reconciled
                     (get-in @(:state runtime) [:causes "incoming-save-1" :status])))
            _ (is (= 1 (count @(:reconcile-calls world))))
            ;; The divergent working files prevent false success at
            ;; acceptance while the retained evidence stays preserved.
            blocked-accept (bc runtime bridge/accept-identity!
                              transaction-id (adapter/acceptance-evidence world))
            _ (is (= :identity-evidence-incomplete (:code blocked-accept)))
            _ (is (some? @(:stored world)))
            ;; Restoring the exact applied content classifies the next
            ;; observation as an echo and completes the transaction.
            _ (swap! (:working-files world) assoc "pages/notes.md" remote-content)
            retry (bc runtime bridge/observe-watcher!
                     "change" "/synthetic" "pages/notes.md" remote-content {} false)
            _ (is (= :echo (:status retry)))
            accepted (bc runtime bridge/accept-identity!
                         transaction-id (adapter/acceptance-evidence world))
            finished (bc runtime bridge/finish-active! transaction-id)]
      (is (= 1 (count @(:reconcile-calls world))))
      (is (= :identity-accepted (:status accepted)))
      (is (= :complete (:status finished)))
      (is (nil? @(:stored world))))))

;; ---------------------------------------------------------------------------
;; Adapter event-record contract
;; ---------------------------------------------------------------------------

(deftest-async event-recorder-records-the-single-event-map-argument
  ;; The bridge's adapter port receives exactly one argument — the event map
  ;; itself; the kind keyword is the port phase. A recorder with a mismatched
  ;; arity would store undefined; the loud marker keeps that visible so no
  ;; nil/undefined record can pass unnoticed.
  (let [world (e2e-basis)
        runtime (adapter/e2e-runtime world)
        record (:adapter! runtime)]
    (p/let [_ (do (record {:event :save-pending :cause {:cause-id "synthetic-1"}})
                  (record nil)
                  (record "not-an-event")
                  nil)]
      (is (= [:save-pending :invalid-event-record :invalid-event-record]
             (adapter/event-kinds runtime)))
      (is (false? (adapter/valid-event-records? runtime)))
      (let [records (adapter/event-records runtime)]
        (is (= {:event :save-pending :cause {:cause-id "synthetic-1"}}
               (first records)))
        (is (= {:event :invalid-event-record :recorded-argument nil}
               (second records)))
        (is (= {:event :invalid-event-record :recorded-argument "not-an-event"}
               (nth records 2)))))))

;; ---------------------------------------------------------------------------
;; Scenario 6: synthetic rename round trip through the actual modules
;; ---------------------------------------------------------------------------

(deftest-async synthetic-rename-round-trip-runs-through-the-actual-modules
  (let [world (e2e-basis)
        runtime (adapter/e2e-runtime world)
        korean-content (:content korean-file)
        notes-content (:content notes-file)
        renamed-path "pages/바뀐-이름.md"
        incoming-renamed-path "pages/메모-바뀐-이름.md"]
    (p/let [;; Local rename: the bridge registers intent over the working
            ;; folder and the actual capture/derivation runs over the
            ;; recorded evidence.
            prepared (prepare-local-rename
                      world runtime
                      {:file-id "file-a"
                       :old-path "pages/한글-문서.md"
                       :new-path renamed-path
                       :content korean-content
                       :proposed-metadata-revision "meta-2"})
            cause (:cause prepared)
            _ (is (= "rename-1" (:cause-id cause)))
            _ (is (= :rename (:kind cause)))
            _ (is (= "pages/한글-문서.md" (:old-path cause)))
            _ (is (= renamed-path (:new-path cause)))
            _ (is (= (adapter/content-hash korean-content) (:content-hash cause)))
            ;; The actual comparison plan is one pure rename of Korean paths
            ;; with unchanged content and a deterministic revision.
            _ (is (= 1 (count (get-in prepared [:derived :plan "actions"]))))
            rename-op (get-in prepared [:derived :plan "actions" 0 "operation"])
            _ (is (= "rename" (get rename-op "kind")))
            _ (is (= "file-a" (get rename-op "fileId")))
            _ (is (= renamed-path (get rename-op "path")))
            _ (is (= (get-in world [:metadata "files" "file-a" "acceptedRevision"])
                     (get rename-op "parentRevisionId")))
            head (adapter/head-revision (get-in prepared [:derived :projected]) "file-a")
            _ (is (= renamed-path (get head "path")))
            _ (is (= korean-content (get head "content")))
            _ (is (= (get rename-op "revisionId") (get head "id")))
            ;; The recorded bridge events carry the exact rename identity in
            ;; completion order.
            _ (is (adapter/valid-event-records? runtime))
            _ (is (= [:rename-intent :rename-completed]
                     (adapter/event-kinds runtime)))
            _ (is (= {:cause-id "rename-1" :origin :local :kind :rename
                      :graph-id graph-id :old-path "pages/한글-문서.md"
                      :new-path renamed-path
                      :content-hash (adapter/content-hash korean-content)
                      :status :pending}
                     (:cause (adapter/first-event-of-kind runtime :rename-intent))))
            _ (is (= {:cause-id "rename-1" :origin :local :kind :rename
                      :graph-id graph-id :old-path "pages/한글-문서.md"
                      :new-path renamed-path
                      :content-hash (adapter/content-hash korean-content)
                      :status :completed}
                     (:cause (adapter/first-event-of-kind runtime :rename-completed))))
            _ (is (= :ok (:result (adapter/first-event-of-kind runtime :rename-completed))))
            ;; The transaction over the actual rename plan completes and the
            ;; accepted sidecar names the renamed Korean path.
            started (start-and-apply!
                     world runtime
                     (inputs-for world prepared {:preview-id "preview-e2e-rename-local"
                                                 :target-generation (adapter/generation \b)})
                     (:derived prepared)
                     {:target-generation (adapter/generation \b)
                      :identity-bytes (:identity-bytes prepared)})
            lifecycle (complete-lifecycle! world runtime (:transaction-id started))
            _ (is (= :identity-accepted (:status (:accepted lifecycle))))
            _ (is (= :complete (:status (:finished lifecycle))))
            _ (is (= renamed-path
                     (get-in prepared [:result "proposedMetadata" "files" "file-a" "path"])))
            _ (is (= (get rename-op "revisionId")
                     (get-in prepared [:result "proposedMetadata" "files" "file-a" "acceptedRevision"])))
            _ (is (= (adapter/content-hash korean-content)
                     (get-in prepared [:result "proposedMetadata" "files" "file-a" "acceptedContentHash"])))
            ;; The complete-state port derives rename evidence from the
            ;; working folder alone: old-path absence plus byte-identical
            ;; new-path content matched against the retained cause.
            complete ((:complete-state! runtime)
                      {:path renamed-path :content korean-content})
            _ (is (= {:graph-id graph-id :old-path "pages/한글-문서.md"
                      :old-present false :new-path renamed-path :new-present true
                      :new-content-hash (adapter/content-hash korean-content)}
                     complete))
            ;; The local watcher observation at the new path is an echo of the
            ;; completed local rename; no reconciliation ever starts.
            local-echo (bc runtime bridge/observe-watcher!
                           "change" "/synthetic" renamed-path korean-content {} false)
            _ (is (= :completed-local (:status local-echo)))
            _ (is (= "rename-1" (get-in local-echo [:cause :cause-id])))
            _ (is (empty? @(:reconcile-calls world)))
            ;; The accepted basis of the incoming phase: reinitialize the
            ;; replica from the actually accepted metadata/snapshot pair.
            next-metadata (get-in prepared [:result "proposedMetadata"])
            next-selected @(:checkpoint world)
            next-replica (adapter/initialize-replica next-metadata "replica-a" next-selected)
            advanced-world (assoc world :metadata next-metadata
                                  :replica next-replica :selected next-selected)
            ;; Simulated incoming rename: the remote replica renamed the
            ;; notes file; this replica sees only unlink-plus-add and a
            ;; review decision binds them into one rename.
            incoming-prepared (prepare-incoming-rename
                               advanced-world
                               {:file-id "file-b"
                                :old-path "pages/notes.md"
                                :new-path incoming-renamed-path
                                :content notes-content
                                :proposed-metadata-revision "meta-3"
                                :enrollment-state (get-in prepared [:derived :projected])})
            first-capture (:first-capture incoming-prepared)
            _ (is (false? (get-in first-capture ["eligibility" "eligible"])))
            _ (is (= 2 (count (get first-capture "reviewItems"))))
            _ (is (= #{"external-unlink-requires-review" "external-add-requires-review"}
                     (set (map #(get % "code") (get first-capture "reviewItems")))))
            ;; Cross-replica determinism: both replicas derive the same
            ;; rename plan and target from the same accepted basis.
            incoming-renamed-op (:rename-op incoming-prepared)
            _ (is (= "rename" (get incoming-renamed-op "kind")))
            _ (is (= "file-b" (get incoming-renamed-op "fileId")))
            _ (is (= incoming-renamed-path (get incoming-renamed-op "path")))
            _ (is (= (:plan (:derived incoming-prepared))
                     (get-in incoming-prepared [:remote-result "comparison" "plan"])))
            _ (is (= (:target incoming-prepared)
                     (get-in incoming-prepared [:result "target"])))
            _ (is (= (:plan (:derived incoming-prepared))
                     (get-in incoming-prepared [:result "comparison" "plan"])))
            ;; The bridge transaction carrying the incoming rename cause.
            incoming-inputs (inputs-for advanced-world incoming-prepared
                                        {:preview-id "preview-e2e-rename-incoming"
                                         :target-generation (adapter/generation \c)
                                         :causes [(:cause incoming-prepared)]})
            incoming-started (bc runtime bridge/start-active! incoming-inputs)
            _ (is (= :active (:status incoming-started)))
            transaction-id (get-in incoming-started [:envelope :transaction-id])
            _ (adapter/apply-transaction-to-world!
               advanced-world (:derived incoming-prepared) (adapter/generation \c)
               (:identity-bytes incoming-prepared))
            ;; Reconciliation: the watcher observation at the new Korean path
            ;; settles the rename cause through the recomputed plan.
            observation (bc runtime bridge/observe-watcher!
                            "change" "/synthetic" incoming-renamed-path
                            notes-content {} false)
            _ (is (= :reconciliation-pending (:status observation)))
            settled (:settled observation)
            _ (is (= :reconciled (:status settled)))
            echo (bc runtime bridge/observe-watcher!
                     "change" "/synthetic" incoming-renamed-path
                     notes-content {} false)
            _ (is (= :echo (:status echo)))
            _ (is (= 1 (count @(:reconcile-calls world))))
            marked (bc runtime bridge/mark-files-applied! transaction-id)
            accepted (bc runtime bridge/accept-identity!
                        transaction-id (adapter/acceptance-evidence advanced-world))
            finished (bc runtime bridge/finish-active! transaction-id)]
      (is (= :files-applied (:status marked)))
      (is (= :identity-accepted (:status accepted)))
      (is (= :complete (:status finished)))
      (is (nil? @(:stored world)))
      ;; The working folder holds both renamed Korean paths with the exact
      ;; byte-identical contents.
      (is (= {renamed-path korean-content
              incoming-renamed-path notes-content}
             @(:working-files world)))
      ;; The accepted metadata names both renamed paths with the compare
      ;; revisions and validates over the final checkpoint.
      (let [final-metadata (get-in incoming-prepared [:result "proposedMetadata"])]
        (is (= incoming-renamed-path
               (get-in final-metadata ["files" "file-b" "path"])))
        (is (= (get incoming-renamed-op "revisionId")
               (get-in final-metadata ["files" "file-b" "acceptedRevision"])))
        (is (= (adapter/content-hash notes-content)
               (get-in final-metadata ["files" "file-b" "acceptedContentHash"])))
        (is (= renamed-path (get-in final-metadata ["files" "file-a" "path"])))
        (is (= (get rename-op "revisionId")
               (get-in final-metadata ["files" "file-a" "acceptedRevision"])))
        (is (true? (adapter/metadata-valid? final-metadata @(:checkpoint world))))
        (is (= (adapter/identity-bytes final-metadata) @(:identity-bytes world))))
      ;; The full recorded event stream, in completion order: local rename
      ;; intent/completion, the local echo, the incoming observation, its
      ;; reconciliation request and success result, and the incoming echo.
      (is (adapter/valid-event-records? runtime))
      (is (= [:rename-intent :rename-completed :raw-watcher-observation
              :raw-watcher-observation :incoming-reconciliation-request
              :incoming-reconciliation-result :raw-watcher-observation]
             (adapter/event-kinds runtime)))
      (let [request (adapter/first-event-of-kind runtime :incoming-reconciliation-request)
            result (adapter/first-event-of-kind runtime :incoming-reconciliation-result)]
        (is (= "incoming-rename-1" (get-in request [:cause :cause-id])))
        (is (= :incoming (get-in request [:cause :origin])))
        (is (= :rename (get-in request [:cause :kind])))
        (is (= "pages/notes.md" (get-in request [:cause :old-path])))
        (is (= incoming-renamed-path (get-in request [:cause :new-path])))
        (is (= graph-id (get-in request [:cause :graph-id])))
        (is (= (get incoming-renamed-op "operationId")
               (get-in request [:cause :operation-id])))
        (is (= {:graph-id graph-id :old-path "pages/notes.md" :old-present false
                :new-path incoming-renamed-path :new-present true
                :new-content-hash (adapter/content-hash notes-content)}
               (:complete-state request)))
        (is (= :success (:status result)))
        (is (= :reconciled (get-in result [:cause :status])))
        (is (= "incoming-rename-1" (get-in result [:cause :cause-id])))
        (is (= :ok (:result result))))
      (is (contains? @(:progress-evidence world)
                     {:transaction-id transaction-id
                      :cause-id "incoming-rename-1"
                      :operation-id (get incoming-renamed-op "operationId")}))
      ;; The next capture from the reinitialized accepted replica: the old
      ;; unlink-plus-add evidence cannot capture anything anymore — the old
      ;; path owns no identity — while a fresh save at the renamed Korean
      ;; path captures cleanly.
      (let [final-metadata (get-in incoming-prepared [:result "proposedMetadata"])
            final-selected @(:checkpoint world)
            final-replica (adapter/initialize-replica
                           final-metadata "replica-a" final-selected)
            replay (adapter/capture-changes
                    {:metadata final-metadata
                     :replica final-replica
                     :selected final-selected
                     :expected-metadata-revision (get-in final-metadata ["metadataRevision"])
                     :proposed-metadata-revision "meta-4"
                     :observations [(:unlink-obs incoming-prepared)
                                    (:add-obs incoming-prepared)]})
            next-content "notes v2 — 개명 후 다음 캡처입니다.\n"
            next-save (adapter/capture-changes
                       {:metadata final-metadata
                        :replica final-replica
                        :selected final-selected
                        :expected-metadata-revision (get-in final-metadata ["metadataRevision"])
                        :proposed-metadata-revision "meta-4"
                        :observations
                        [{"observationId" "obs-next-rename-basis-save"
                          "type" "save-complete"
                          "saveId" "next-save-1"
                          "fileId" "file-b"
                          "path" incoming-renamed-path
                          "content" next-content
                          "parentRevisionId" (get-in final-metadata
                                                    ["files" "file-b" "acceptedRevision"])
                          "revisionId" "causal-next-save-1"}
                         {"observationId" "obs-next-rename-basis-read"
                          "type" "stable-read"
                          "causeType" "save"
                          "causeId" "next-save-1"
                          "path" incoming-renamed-path
                          "content" next-content
                          "stable" true}]})]
        (is (= [] (get final-replica "pendingObservations")))
        (is (false? (get-in replay ["eligibility" "eligible"])))
        (is (some #(= "external-identity-mismatch" (get % "code"))
                  (get replay "invalid")))
        (is (true? (get-in next-save ["eligibility" "eligible"])))
        (is (= "update"
               (get-in next-save ["comparison" "plan" "actions" 0 "operation" "kind"])))
        (is (= "file-b"
               (get-in next-save ["comparison" "plan" "actions" 0 "operation" "fileId"])))
        (is (= incoming-renamed-path
               (get (some (fn [entry] (when (= "file-b" (get entry "fileId")) entry))
                          (get-in next-save ["target" "files"]))
                    "path")))))))

;; ---------------------------------------------------------------------------
;; Scenario 7: rename evidence refusals
;; ---------------------------------------------------------------------------

(deftest-async incomplete-or-contradictory-rename-evidence-stays-ordinary
  ;; The complete-state adapter supplies rename evidence only from complete
  ;; working-folder facts: old-path absence plus byte-identical new-path
  ;; content matched against a retained cause. Missing, contradictory or
  ;; ambiguous old/new-path evidence never infers a rename.
  (let [notes-content (:content notes-file)]
    (p/let [;; No move happened: the old path is still present and the new
            ;; path absent. Observations on either side stay ordinary.
            world-a (e2e-basis)
            runtime-a (adapter/e2e-runtime world-a)
            cause-a (bc runtime-a bridge/rename-intent!
                        graph-id "pages/notes.md" "pages/옮기지-않음.md")
            _ (bc runtime-a bridge/rename-completed! cause-a :ok)
            new-side-a (bc runtime-a bridge/observe-watcher!
                           "change" "/synthetic" "pages/옮기지-않음.md"
                           notes-content {} false)
            old-side-a (bc runtime-a bridge/observe-watcher!
                           "change" "/synthetic" "pages/notes.md"
                           notes-content {} false)
            _ (is (= :ordinary (:status new-side-a)))
            _ (is (= :ordinary (:status old-side-a)))
            _ (is (= 0 (:match-count new-side-a)))
            _ (is (empty? @(:reconcile-calls world-a)))
            ;; A copy, not a move: both paths present, so the rename claim is
            ;; incomplete — the old path never disappeared.
            world-b (e2e-basis)
            runtime-b (adapter/e2e-runtime world-b)
            cause-b (bc runtime-b bridge/rename-intent!
                        graph-id "pages/notes.md" "pages/복사된-이름.md")
            _ (swap! (:working-files world-b) assoc "pages/복사된-이름.md" notes-content)
            _ (bc runtime-b bridge/rename-completed! cause-b :ok)
            new-side-b (bc runtime-b bridge/observe-watcher!
                           "change" "/synthetic" "pages/복사된-이름.md"
                           notes-content {} false)
            old-side-b (bc runtime-b bridge/observe-watcher!
                           "change" "/synthetic" "pages/notes.md"
                           notes-content {} false)
            _ (is (= :ordinary (:status new-side-b)))
            _ (is (= :ordinary (:status old-side-b)))
            _ (is (empty? @(:reconcile-calls world-b)))
            ;; The new path holds different content: contradictory evidence.
            ;; Content alone must never let a rename match.
            world-c (e2e-basis)
            runtime-c (adapter/e2e-runtime world-c)
            changed-content "notes v2 — 내용이 바뀌었습니다.\n"
            cause-c (bc runtime-c bridge/rename-intent!
                        graph-id "pages/notes.md" "pages/내용-바뀐-이름.md")
            _ (swap! (:working-files world-c)
                     #(-> (dissoc % "pages/notes.md")
                          (assoc "pages/내용-바뀐-이름.md" changed-content)))
            _ (bc runtime-c bridge/rename-completed! cause-c :ok)
            new-side-c (bc runtime-c bridge/observe-watcher!
                           "change" "/synthetic" "pages/내용-바뀐-이름.md"
                           changed-content {} false)
            _ (is (= :ordinary (:status new-side-c)))
            _ (is (empty? @(:reconcile-calls world-c)))
            ;; Two completed rename causes claim the same move: genuine
            ;; multi-cause ambiguity stays ordinary at the bridge.
            world-d (e2e-basis)
            runtime-d (adapter/e2e-runtime world-d)
            cause-d-1 (bc runtime-d bridge/rename-intent!
                          graph-id "pages/notes.md" "pages/중복-이름.md")
            cause-d-2 (bc runtime-d bridge/rename-intent!
                          graph-id "pages/notes.md" "pages/중복-이름.md")
            _ (swap! (:working-files world-d)
                     #(-> (dissoc % "pages/notes.md")
                          (assoc "pages/중복-이름.md" notes-content)))
            _ (bc runtime-d bridge/rename-completed! cause-d-1 :ok)
            _ (bc runtime-d bridge/rename-completed! cause-d-2 :ok)
            ambiguous (bc runtime-d bridge/observe-watcher!
                          "change" "/synthetic" "pages/중복-이름.md"
                          notes-content {} false)
            _ (is (= :ordinary (:status ambiguous)))
            _ (is (= 2 (:match-count ambiguous)))
            _ (is (empty? @(:reconcile-calls world-d)))]
      (is (adapter/valid-event-records? runtime-a))
      (is (adapter/valid-event-records? runtime-b))
      (is (adapter/valid-event-records? runtime-c))
      (is (adapter/valid-event-records? runtime-d)))))