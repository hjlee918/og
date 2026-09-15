(ns frontend.fs.og-sync-bridge-e2e-test
  "End-to-end in-memory verification of the default-off OG bridge against the
  actual f28-sync-prototype modules, loaded through the test-only adapter.

  Previous bridge tests injected stand-ins for plan validation and identity
  acceptance. These tests connect those boundaries to the real pure prototype
  logic: bridge save evidence feeds the actual capture module, the
  authoritative plan is recomputed from the retained source/target pair with
  the actual comparison module, the exact plan is executed in memory by the
  actual executor, and identity acceptance validates the retained sidecar
  bytes with the actual identity module over the recomputed projection.

  Working files, the snapshot checkpoint, the sidecar, ACTIVE storage and the
  evidence ledgers are simulated in-memory atoms. No filesystem, graph,
  profile, application, native helper or network is accessed; Korean page
  names and content exercise exact byte handling without any file access."
  (:require [cljs.test :refer [deftest is]]
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
      (is (zero? (count (filter #(= :incoming-reconciliation-request (:event %))
                                 @(:events runtime)))))
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
      (is (contains? @(:acceptance-evidence world) {:transaction-id transaction-id})))))

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