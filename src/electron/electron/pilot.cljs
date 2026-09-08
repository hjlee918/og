(ns electron.pilot
  "Pilot-only guards for the isolated *Logseq OG F27 Pilot* desktop build.

   `PILOT` is a closure-define whose value is `false` in every ordinary build.
   Every guard in this namespace is therefore inert unless the pilot build sets
   it to true on the compiler command line
   (`--config-merge '{:closure-defines {electron.pilot/PILOT true}}'`).
   Ordinary Logseq OG behaviour is unchanged by this namespace.

   Guarded here, and only under `PILOT`:

     G1  OS default-protocol-client registration      (electron.core)
     G2  electron-deeplink initialisation             (electron.core)
     G3  automatic updater *and* both manual update
         IPC channels                                 (electron.updater)
     G4  API server start / restart                   (electron.server)
     G5  every main-process filesystem path that can
         reach graph data                             (electron.handler,
                                                       electron.core)

   Internal `assets://` and `lsp://` file protocols and
   `registerSchemesAsPrivileged` are deliberately NOT guarded: they grant
   in-process privileges rather than OS registration, and F27 asset display
   depends on them.

   Every guard decision is journalled to `<userData>/pilot-guard-journal.jsonl`
   so that a check can read what the main process actually did. The journal is
   corroborating evidence only; the validation harness observes each guard's
   real side effects independently."
  (:require [electron.logger :as logger]
            [clojure.string :as string]
            ["electron" :refer [^js app]]
            ["fs" :as ^js fs]
            ["path" :as ^js node-path]))

(goog-define PILOT false)

;; Exactly one of these two literals survives the release build, so that build
;; tooling can tell a pilot bundle from an ordinary one by reading the compiled
;; file without executing it. `PILOT` is a compile-time constant, so Closure
;; folds the `if` below and drops the branch that cannot be taken.
;;
;; `build-marker` must stay REACHABLE from live code for its literal to survive
;; `:advanced` dead-code elimination -- an unused def is removed outright, which
;; is exactly what happened on the first build of this pilot. It is therefore
;; stamped into every journal entry and every refusal object, both of which are
;; reached from the guards themselves.
;;
;; `scripts/build-pilot.js` asserts the active marker is present and the inert
;; marker is absent; the pilot entry re-checks both before the bundle is
;; required.
(def ^:const ACTIVE-MARKER "LOGSEQ-OG-F27-PILOT-GUARDS-ACTIVE-1")
(def ^:const INERT-MARKER "LOGSEQ-OG-F27-PILOT-GUARDS-INERT-1")

(def build-marker (if PILOT ACTIVE-MARKER INERT-MARKER))

(defonce ^:private *journal (atom []))

(defn- journal-path
  []
  (try
    (.join node-path (.getPath app "userData") "pilot-guard-journal.jsonl")
    (catch :default _e nil)))

(defn- append-journal!
  [entry]
  (when PILOT
    (when-let [p (journal-path)]
      (try
        (.appendFileSync fs p (str (js/JSON.stringify (clj->js entry)) "\n"))
        (catch :default e
          (logger/warn "[pilot] journal write failed" e))))))

(defn record!
  "Record a guard decision. Returns nil so call sites read as statements."
  [guard detail]
  (let [entry {:guard  (name guard)
               :detail (str detail)
               :marker build-marker
               :at     (js/Date.now)}]
    (swap! *journal conj entry)
    (append-journal! entry))
  nil)

(defn refuse-js
  "Record a refusal and return a structured-clone-safe refusal object suitable
   for returning across `ipcMain.handle`."
  [guard detail]
  (record! guard detail)
  (logger/info "[pilot] refused" (str (name guard) " / " detail))
  #js {:pilotRefused true
       :guard        (name guard)
       :detail       (str detail)
       :marker       build-marker})



;; ---------------------------------------------------------------------------
;; G5 -- the graph-data boundary, enforced inside the application
;;
;; A harness that only refuses to *ask* for an outside path is not a boundary:
;; anything else that reaches the main process -- a dialog result, a restored
;; recent graph, a serialized graph entry, a watcher, an asset URL -- would
;; still be honoured. So the refusal lives here, in front of the filesystem.
;;
;; THREE NARROW ROOTS, never a home-directory exemption:
;;
;;   graph      the sole permitted graph-data location, supplied by the pilot
;;              entry in <state-root>/pilot-boundary.json after it has
;;              validated it. Absent or malformed => every graph path is
;;              refused. Fail closed.
;;   state      the pilot's own isolated state root, derived from Electron
;;              itself (the parent of userData), so configuration, the graph
;;              registry, per-graph git, plugins and search indexes keep
;;              working without widening anything.
;;   resources  the application's own bundled files, so lsp:// static resources
;;              and bundled binaries keep working.
;;
;; The path arithmetic itself is in pilot-boundary.js, shipped beside the
;; compiled bundle, so that exactly the code running here can be driven from
;; Node with a mocked filesystem. See f27-pilot/tests/boundary.test.js, which
;; proves a lexically outside path is refused with ZERO filesystem calls, and
;; that a symlink escape is refused at the canonical stage.
;;
;; It is loaded with a runtime require rather than a namespace require, and only
;; from code that PILOT makes reachable. A namespace require would bundle the
;; module into ORDINARY builds too -- measured at 1,886 bytes -- and the whole
;; point of the closure define is that an ordinary build is unchanged. Its bytes
;; are covered by the build manifest, so the pre-load identity check verifies it
;; before the bundle that uses it is loaded.

(def ^:const BOUNDARY-SCHEMA "f27-pilot/boundary/1")
(def ^:const BOUNDARY-FILE "pilot-boundary.json")

(defn- read-graph-root
  "The one root Electron cannot tell us. Absent or malformed means every graph
   operation is refused; nothing falls back to a wider directory."
  [state-root]
  (let [cfg (when state-root (.join node-path state-root BOUNDARY-FILE))]
    (when (and cfg (.existsSync fs cfg))
      (try
        (let [^js j (js/JSON.parse (.toString (.readFileSync fs cfg)))]
          (when (= BOUNDARY-SCHEMA (.-schema j))
            (.-graphRoot j)))
        (catch :default e
          (logger/error "[pilot] boundary config unreadable" e)
          nil)))))

(defn- build-boundary
  []
  (let [state-root (try (.dirname node-path (.getPath app "userData"))
                        (catch :default _e nil))
        resources  (try (.getAppPath app) (catch :default _e nil))
        graph-root (read-graph-root state-root)]
    (when-not graph-root
      (logger/warn "[pilot]" (str "no permitted graph root is configured; "
                                  "every graph operation will be refused")))
    (let [^js m (js/require (.join node-path js/__dirname "pilot-boundary.js"))
          ^js impl (.boundaryFromCategories m #js {:graph     graph-root
                                                   :state     state-root
                                                   :resources resources})]
      (doseq [^js d (array-seq (.dropped impl))]
        (logger/error "[pilot] permitted root dropped, it could not be resolved"
                      (str (.-category d) " " (.-declared d) " " (.-code d))))
      {:graph-root graph-root :impl impl})))

(defonce ^:private *boundary (atom nil))

(defn boundary
  []
  (or @*boundary (reset! *boundary (build-boundary))))

(defn permitted-path?
  "`policy` names what the path is being used FOR, because the categories differ:
   `graph-select` accepts only a test-owned subfolder of the permitted graph
   root, `write` never reaches bundled resources, and so on. Passing one merged
   predicate for every operation is what let a state or resource path satisfy a
   graph gate in the previous version."
  [p policy]
  (if-not PILOT
    true
    (.permitted ^js (:impl (boundary)) p policy)))

(defn guard-fs!
  "Refuse `p` unless it is permitted for `policy`. Returns `p` when allowed and
   throws otherwise, so a refused operation fails instead of quietly reading or
   writing somewhere it must not. Call sites wrap this in `(when PILOT ...)`, so
   nothing here exists in an ordinary build."
  [op policy p]
  (if (permitted-path? p policy)
    p
    (let [^js verdict (.check ^js (:impl (boundary)) p policy)
          detail (str (name op) " [" policy "] " (pr-str p)
                      " [" (.-stage verdict) ": " (.-reason verdict) "]")]
      (record! :graph-boundary (str "refused " detail))
      (logger/warn "[pilot] refused a path outside the permitted roots" detail)
      (throw (js/Error. (str "Logseq OG F27 Pilot refused a path outside the "
                             "permitted graph-data root: " detail))))))

(defn guard-source!
  "A backup/version source as the backup code will actually interpret it: an
   absolute input stands alone, a relative input is relative to the REPO. It is
   deliberately never resolved against the process working directory, which
   would widen the check to wherever the app happens to have been started."
  [op repo relative-path]
  (when PILOT
    (guard-fs! op "graph-select" repo)
    (when-not (string? relative-path)
      (throw (js/Error. "Logseq OG F27 Pilot refused a non-string backup source")))
    (guard-fs! op "write"
               (if (.isAbsolute node-path relative-path)
                 relative-path
                 (.join node-path repo relative-path)))))

(defn permitted-graphs
  "Filter stored graph entries, dropping any whose directory is not a permitted
   graph selection. Used where restoration enumerates what it remembers: an
   outside graph must not come back, and one bad entry must not fail the call.

   `dir-fn` turns a stored entry into a directory, because the graph registry
   stores names (`logseq_local_++Users++...`), not paths."
  [entries dir-fn]
  (if-not PILOT
    (vec entries)
    (let [{allowed true refused false}
          (group-by #(boolean (permitted-path? (dir-fn %) "graph-select")) entries)]
      (when (seq refused)
        (record! :graph-boundary
                 (str "dropped " (count refused)
                      " remembered graph(s) that are not permitted graph selections")))
      (vec allowed))))
