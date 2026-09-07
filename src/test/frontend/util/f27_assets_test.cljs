(ns frontend.util.f27-assets-test
  "F27 local-asset slice — focused tests for the pure classification a panel
  body uses to decide how an asset is presented.

  What these pin:

    * a graph-local asset is recognised in every form OG's own parser emits it
      in, and something that merely looks like a path is not;
    * the name a chip shows is the FILE's name, percent-decoded, so a Korean or
      spaced filename reads as the reader wrote it and is never split
      mid-character;
    * remote and inline-data sources are recognised so they can be named instead
      of fetched;
    * audio and video are ordinary attachments here — named, never played."
  (:require [cljs.test :refer [deftest testing is]]
            [clojure.string :as string]
            [frontend.util.f27-assets :as a]))

;; ---------------------------------------------------------------------------
;; Recognising a graph-local asset
;; ---------------------------------------------------------------------------

(deftest a-graph-local-asset-is-recognised-in-every-form-the-parser-emits
  (testing "the four prefixes OG's own parser produces"
    (is (true? (a/recognized-local? "../assets/pic.png")))
    (is (true? (a/recognized-local? "./assets/pic.png")))
    (is (true? (a/recognized-local? "assets/pic.png")))
    (is (true? (a/recognized-local? "/assets/pic.png"))))
  (testing "and Korean and spaced names are no different"
    (is (true? (a/recognized-local? "../assets/집중 노트.png")))
    (is (true? (a/recognized-local? "../assets/집중%20노트.png"))))
  (testing "something that is not in the graph's asset directory is not one"
    (is (false? (a/recognized-local? "https://example.com/a.png")))
    (is (false? (a/recognized-local? "pages/Deep Work.md")))
    (is (false? (a/recognized-local? nil)))
    (is (false? (a/recognized-local? "")))))

(deftest a-remote-or-inline-source-is-recognised-so-it-can-be-named-not-fetched
  (is (true? (a/remote? "https://example.com/a.png")))
  (is (true? (a/remote? "http://example.com/a.png")))
  (is (true? (a/remote? "data:image/png;base64,iVBORw0KGgo=")))
  (is (false? (a/remote? "../assets/pic.png")))
  (is (false? (a/remote? nil))))

;; ---------------------------------------------------------------------------
;; The name a chip shows
;; ---------------------------------------------------------------------------

(deftest the-name-shown-is-the-files-own-name
  (is (= "pic.png" (a/asset-name "../assets/pic.png" 40)))
  (is (= "pic.png" (a/asset-name "assets/pic.png" 40)))
  (testing "a spaced Korean name survives, in both the forms it is written in"
    (is (= "집중 노트.png" (a/asset-name "../assets/집중 노트.png" 40)))
    (is (= "집중 노트.png" (a/asset-name "../assets/집중%20노트.png" 40))))
  (testing "an emoji in a filename is not split into surrogate halves"
    (is (= "📚 자료.pdf" (a/asset-name "../assets/📚 자료.pdf" 40))))
  (testing "a percent sequence that is not valid encoding is left alone"
    (is (= "100%done.png" (a/asset-name "../assets/100%done.png" 40))))
  (testing "a long name is cut on user-perceived characters, with a cut mark"
    (let [n (a/asset-name (str "../assets/" (apply str (repeat 200 "가")) ".png") 40)]
      (is (= 41 (count n)) "40 characters and one ellipsis")
      (is (= "…" (subs n 40)))))
  (testing "nothing readable is nil, never an empty chip and never a path"
    (is (nil? (a/asset-name "../assets/" 40)))
    (is (nil? (a/asset-name nil 40)))))

;; ---------------------------------------------------------------------------
;; Containment. Recognising OG's syntax is not authorisation to read a path.
;; ---------------------------------------------------------------------------

(deftest recognition-is-separate-from-authorisation
  ;; OG's `local-asset?` matches `^[./]*assets`. It is a PREFIX RECOGNISER, and
  ;; the supervisor showed three inputs it calls local that are not inside the
  ;; graph's asset directory at all. Recognition still routes a node to F27's
  ;; renderer — that is how F27 gets the chance to refuse it — but it is not
  ;; what authorises a probe, a load or a reveal.
  (testing "OG's syntax is still recognised, so F27 still handles the node"
    (is (true? (a/recognized-local? "../assets/../../outside.png")))
    (is (true? (a/recognized-local? "../assets-other/x.png"))))
  (testing "but none of the supervisor's three inputs is authorised"
    (is (= [] (a/contained-paths "../assets/../../outside.png")))
    (is (= [] (a/contained-paths "../assets/%2e%2e/%2e%2e/outside.png")))
    (is (= [] (a/contained-paths "../assets-other/x.png"))))
  (testing "`contained?` is the one question a caller may act on"
    (is (false? (a/contained? "../assets/../../outside.png")))
    (is (true? (a/contained? "../assets/pic.png")))))

(deftest an-ordinary-asset-is-still-authorised
  (testing "every prefix OG's parser writes"
    (doseq [h ["../assets/pic.png" "./assets/pic.png" "assets/pic.png" "/assets/pic.png"]]
      (is (= ["assets/pic.png"] (a/contained-paths h)) h)))
  (testing "Korean, spaces and a subdirectory inside assets are ordinary"
    (is (= ["assets/집중 노트.png"] (a/contained-paths "../assets/집중 노트.png")))
    (is (= ["assets/sub dir/집중 노트.png"]
           (a/contained-paths "../assets/sub dir/집중 노트.png"))))
  (testing "an encoded name is still authorised under both spellings"
    (is (= ["assets/집중 노트.png" "assets/집중%20노트.png"]
           (a/contained-paths "../assets/집중%20노트.png"))))
  (testing "a filename with a literal percent sign is not mangled into a refusal"
    (is (= ["assets/100%done.png"] (a/contained-paths "../assets/100%done.png")))))

(deftest traversal-is-refused-in-every-spelling-it-can-be-written-in
  (testing "written parent segments INSIDE the asset directory"
    (is (= [] (a/contained-paths "assets/../secret.png")))
    (is (= [] (a/contained-paths "../assets/sub/../../outside.png"))))
  (testing "but a longer leading prefix is a spelling, not an escape"
    ;; OG anchors an asset at the graph root: `get-local-asset-absolute-path`
    ;; strips `^[./]*` outright and never resolves the href against anything.
    ;; The number of leading `..` segments therefore cannot move the anchor, and
    ;; refusing this would refuse a file OG itself reads correctly. What matters
    ;; is that the path AFTER the prefix cannot climb, which the cases above pin.
    (is (= ["assets/x.png"] (a/contained-paths "../../assets/x.png"))))
  (testing "percent-encoded parent segments, in either case"
    (is (= [] (a/contained-paths "../assets/%2e%2e/outside.png")))
    (is (= [] (a/contained-paths "../assets/%2E%2E/outside.png")))
    (is (= [] (a/contained-paths "../assets/%2e%2e%2foutside.png"))))
  (testing "doubly encoded parent segments"
    (is (= [] (a/contained-paths "../assets/%252e%252e/outside.png"))))
  (testing "a backslash is treated as a separator, not as part of a name"
    (is (= [] (a/contained-paths "..\\assets\\..\\..\\outside.png")))
    (is (= [] (a/contained-paths "../assets/..\\outside.png"))))
  (testing "an encoded separator does not smuggle a segment past the check"
    (is (= [] (a/contained-paths "../assets/%2f..%2foutside.png")))))

(deftest a-directory-that-merely-starts-with-assets-is-not-the-assets-directory
  (is (= [] (a/contained-paths "../assets-other/x.png")))
  (is (= [] (a/contained-paths "assetsbackup/x.png")))
  (is (= [] (a/contained-paths "../assets.old/x.png")))
  (testing "and a name that only looks like a traversal prefix is not stripped"
    (is (= [] (a/contained-paths "..../assets/x.png")))))

(deftest anything-that-is-not-a-graph-relative-path-is-refused
  (testing "an address, not a path"
    (is (= [] (a/contained-paths "https://example.invalid/assets/x.png")))
    (is (= [] (a/contained-paths "file:///etc/passwd")))
    (is (= [] (a/contained-paths "assets:///Users/somebody/assets/x.png"))))
  (testing "a Windows drive or a UNC share"
    (is (= [] (a/contained-paths "C:\\assets\\x.png")))
    (is (= [] (a/contained-paths "//server/assets/x.png"))))
  (testing "empty and duplicated separators fail closed"
    (is (= [] (a/contained-paths "assets//x.png")))
    (is (= [] (a/contained-paths "assets/")))
    (is (= [] (a/contained-paths "assets"))))
  (testing "a control character or a NUL never reaches a filesystem call"
    (is (= [] (a/contained-paths "assets/x\u0000.png")))
    (is (= [] (a/contained-paths "assets/x\n.png"))))
  (testing "nothing at all"
    (is (= [] (a/contained-paths nil)))
    (is (= [] (a/contained-paths "")))
    (is (= [] (a/contained-paths "   ")))))

(deftest the-authorised-path-is-relative-to-the-graph-and-nothing-else
  ;; What a caller may act on is a path relative to the graph root, always
  ;; beginning with the asset directory. It is never the spelling the author
  ;; typed, so a caller cannot accidentally pass the raw href to the filesystem.
  (doseq [h ["../assets/pic.png" "/assets/pic.png" "assets/pic.png"]]
    (is (every? #(string/starts-with? % "assets/") (a/contained-paths h)) h)
    (is (every? #(not (string/includes? % "..")) (a/contained-paths h)) h)))

(deftest a-file-is-looked-for-under-both-spellings-of-its-name
  ;; `../assets/집중%20노트.png` and `../assets/집중 노트.png` are the same file.
  ;; A live run showed the encoded spelling reported as "(file not found)" while
  ;; the literal one loaded, because the existence probe never decoded it. Both
  ;; spellings are still looked for — decoded first — and both are now required
  ;; to stay inside the asset directory before either is used.
  (testing "an encoded name is looked for decoded FIRST, and undecoded second"
    (is (= ["assets/집중 노트.png" "assets/집중%20노트.png"]
           (a/contained-paths "../assets/집중%20노트.png"))))
  (testing "a name that needs no decoding is looked for once"
    (is (= ["assets/집중 노트.png"] (a/contained-paths "../assets/집중 노트.png")))))

;; ---------------------------------------------------------------------------
;; The kind, and the badge that names it
;; ---------------------------------------------------------------------------

(deftest an-image-is-the-only-kind-that-may-be-shown
  (testing "the image formats are OG's own — the set asset-link renders with"
    (doseq [e ["png" "jpg" "jpeg" "gif" "webp" "svg" "bmp"]]
      (is (= :image (a/asset-kind (str "../assets/pic." e))) e)))
  (testing "an upper-case extension is the same file"
    (is (= :image (a/asset-kind "../assets/PIC.PNG"))))
  (testing "a PDF is named, not viewed"
    (is (= :pdf (a/asset-kind "../assets/report.pdf"))))
  (testing "audio and video are ORDINARY attachments here — named, never played"
    (doseq [e ["mp3" "m4a" "wav" "flac" "mp4" "webm" "mov" "mkv"]]
      (is (= :file (a/asset-kind (str "../assets/clip." e))) e)))
  (testing "and so is everything else"
    (is (= :file (a/asset-kind "../assets/notes.docx")))
    (is (= :file (a/asset-kind "../assets/data.csv")))
    (is (= :file (a/asset-kind "../assets/no-extension")))))

(deftest the-badge-names-the-file-type-in-the-readers-own-alphabet
  (is (= "PNG" (a/asset-badge "../assets/pic.png")))
  (is (= "PNG" (a/asset-badge "../assets/PIC.PNG")) "one badge per type, not per spelling")
  (is (= "PDF" (a/asset-badge "../assets/report.pdf")))
  (is (= "DOCX" (a/asset-badge "../assets/notes.docx")))
  (testing "a name with no extension has no badge rather than a misleading one"
    (is (nil? (a/asset-badge "../assets/no-extension"))))
  (testing "an absurd extension is not turned into an absurd badge"
    (is (nil? (a/asset-badge (str "../assets/x." (apply str (repeat 40 "z"))))))))

;; ---------------------------------------------------------------------------
;; What a body renderer asks: is this node an asset at all?
;; ---------------------------------------------------------------------------

(deftest a-parsed-link-node-is-classified-from-its-own-payload
  (testing "the shape OG's parser gives a local asset"
    (let [m {:url ["Search" "../assets/집중 노트.png"]
             :label [["Plain" "집중"]] :full_text "![집중](../assets/집중 노트.png)"}]
      (is (true? (a/local-asset-node? m)))))
  (testing "a block reference is not an asset"
    (is (false? (a/local-asset-node? {:url ["Block_ref" "7f271000-0000-4000-8000-000000000001"]}))))
  (testing "a page reference is not an asset"
    (is (false? (a/local-asset-node? {:url ["Page_ref" "Deep Work"]}))))
  (testing "a remote link is not a GRAPH-LOCAL asset"
    (is (false? (a/local-asset-node? {:url ["Complex" {:protocol "https" :link "example.com/a.png"}]}))))
  (testing "and neither is something that is not a payload map at all"
    (is (false? (a/local-asset-node? nil)))
    (is (false? (a/local-asset-node? "../assets/pic.png")))))

;; ---------------------------------------------------------------------------
;; The asset ROOT gate.
;;
;; `logseq.common.graph/readdir` filters symbolic links among the entries it
;; FINDS, but it seeds its walk with `[true root-dir]` and never checks that
;; root. F27 hands it `<graph>/assets`, so an assets directory that is ITSELF a
;; symbolic link was walked and everything behind it was listed as though it
;; were inside the graph.
;;
;; These pin the pure half of the fix: what the graph's own listing, taken one
;; level up, PROVES about the asset directory. A symlinked `assets` is removed
;; among the root's own children, so it contributes nothing to that listing.
;; ---------------------------------------------------------------------------

(deftest the-graph-root-is-normalised-to-exactly-one-separator
  (testing "so a prefix comparison cannot read `/g/assets2` as inside `/g/assets`"
    (is (= "/g/" (a/graph-root "/g")))
    (is (= "/g/" (a/graph-root "/g/")))
    (is (= "/g/" (a/graph-root "/g///")))
    (is (= "/g/" (a/graph-root "  /g/  "))))
  (testing "and a graph with no directory has no root, no asset dir and no prefix"
    (is (nil? (a/graph-root nil)))
    (is (nil? (a/graph-root "")))
    (is (nil? (a/graph-root "   ")))
    (is (nil? (a/asset-dir nil)))
    (is (nil? (a/asset-prefix nil)))))

(deftest the-asset-directory-and-its-prefix-are-derived-from-the-graph-root
  (is (= "/g/assets" (a/asset-dir "/g")))
  (is (= "/g/assets" (a/asset-dir "/g/")))
  (is (= "/g/assets/" (a/asset-prefix "/g"))))

(deftest a-listing-that-contains-a-file-under-assets-proves-the-root-is-real
  (testing "the graph's own recursive listing carries the asset directory's files"
    (is (true? (a/asset-root-real? "/g" ["/g/pages/A.md" "/g/assets/pic.png"])))
    (is (true? (a/asset-root-real? "/g/" ["/g/assets/nested/deep.png"]))))
  (testing "a name that merely starts the same way proves nothing"
    (is (false? (a/asset-root-real? "/g" ["/g/assets-other/x.png"])))
    (is (false? (a/asset-root-real? "/g" ["/g/assets.old/x.png"])))
    (is (false? (a/asset-root-real? "/g" ["/g/assets"])))))

(deftest a-symlinked-asset-directory-contributes-nothing-so-the-root-is-refused
  (testing "this is the whole gate: OG's walker removes a symlinked `assets`
            among the graph root's own children, so nothing under it is listed"
    (is (false? (a/asset-root-real? "/g" ["/g/pages/A.md" "/g/journals/B.md"]))))
  (testing "and the files behind that link are not inside this graph, however
            they are spelled"
    (is (false? (a/asset-root-real? "/g" ["/elsewhere/assets/pic.png"
                                          "/elsewhere/pic.png"])))))

(deftest the-root-gate-fails-closed
  (testing "an unreadable directory, a blank graph path and an empty listing"
    (is (false? (a/asset-root-real? "/g" [])))
    (is (false? (a/asset-root-real? "/g" nil)))
    (is (false? (a/asset-root-real? nil ["/g/assets/pic.png"])))
    (is (false? (a/asset-root-real? "" ["/g/assets/pic.png"]))))
  (testing "a real but EMPTY asset directory is refused too, and that refuses
            nothing the listing gate could have authorised: it holds no file"
    (is (false? (a/asset-root-real? "/g" ["/g/pages/A.md"])))))

;; ---------------------------------------------------------------------------
;; The listing itself
;; ---------------------------------------------------------------------------

(deftest the-listing-becomes-a-map-from-the-graph-relative-path-to-what-was-found
  (is (= {"assets/pic.png" "/g/assets/pic.png"
          "assets/sub/deep.png" "/g/assets/sub/deep.png"}
         (a/asset-index "/g" ["/g/assets/pic.png" "/g/assets/sub/deep.png"])))
  (testing "a path the walker reported from outside the graph root is dropped
            rather than trusted"
    (is (= {} (a/asset-index "/g" ["/elsewhere/assets/pic.png"]))))
  (testing "and a graph with no directory indexes nothing"
    (is (= {} (a/asset-index nil ["/g/assets/pic.png"])))))

(deftest a-korean-filename-is-indexed-under-one-spelling
  (testing "macOS reports a decomposed name while a note writes a composed one;
            without one spelling the same file has two names and neither is found"
    (let [composed "집중 노트.png"
          decomposed (.normalize composed "NFD")
          idx (a/asset-index "/g" [(str "/g/assets/" decomposed)])]
      (is (not= composed decomposed))
      (is (= 1 (count idx)))
      (is (contains? idx (a/normalize-name (str "assets/" composed))))
      (is (= (str "/g/assets/" decomposed)
             (get idx (a/normalize-name (str "assets/" composed))))))))
