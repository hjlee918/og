(ns electron.origin-experiment
  "The ORIGIN EXPERIMENT flag.

   `ORIGIN_EXPERIMENT` is a closure-define whose value is `false` in every
   ordinary build, and `true` only in the experimental package built by
   `f28-origin/scripts/build-experiment.js`:

     --config-merge '{:closure-defines {electron.origin-experiment/ORIGIN_EXPERIMENT true}}'

   It exists because Chromium 146 serialises a `file:` origin as the string
   \"null\", which `postMessage` rejects as a target origin, so no plugin
   sandbox can ever answer the host's handshake while the renderer is a
   `file://` document. See
   `project-notes/baseline/F28_PLUGIN_LOADING_DIAGNOSIS_READINESS.md`.

   When it is true the renderer is served from `lsp://logseq.com/` instead —
   the privileged, standard, secure scheme this application already registers
   and already routes to its own bundled resources. Plugins keep their OWN
   origin, `lsp://logseq.io/`, so the application and plugin origins stay
   separate and mutually cross-origin exactly as they are today.

   This is a CANDIDATE, not an accepted architecture. Being a compile-time
   constant is what keeps an ordinary build byte-unchanged: an unused branch is
   removed outright by `:advanced` dead-code elimination, and reverting the
   experiment is reverting the commits that set it."
  (:require [electron.utils :refer [dev?]]))

(goog-define ORIGIN_EXPERIMENT false)

;; Keep in step with electron.core/STATIC_URL. Stated here rather than required
;; from `electron.core`, because `electron.window` must not depend on it.
(def ^:const APP_URL "lsp://logseq.com/")

(defn main-window-entry
  "The URL the main window loads.

   Ordinary builds keep the historical `file://` entry EXACTLY as it was; only
   the experiment moves it, and it moves it to the same document either way."
  [file-url-fn]
  (let [page (if dev? "index.html" "electron.html")]
    (if ORIGIN_EXPERIMENT
      (str APP_URL page)
      (file-url-fn page))))
