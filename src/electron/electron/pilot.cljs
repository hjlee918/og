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

   Internal `assets://` and `lsp://` file protocols and
   `registerSchemesAsPrivileged` are deliberately NOT guarded: they grant
   in-process privileges rather than OS registration, and F27 asset display
   depends on them.

   Every guard decision is journalled to `<userData>/pilot-guard-journal.jsonl`
   so that a check can read what the main process actually did. The journal is
   corroborating evidence only; the validation harness observes each guard's
   real side effects independently."
  (:require [electron.logger :as logger]
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
