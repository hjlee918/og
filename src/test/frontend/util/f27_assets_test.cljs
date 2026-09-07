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
            [frontend.util.f27-assets :as a]))

;; ---------------------------------------------------------------------------
;; Recognising a graph-local asset
;; ---------------------------------------------------------------------------

(deftest a-graph-local-asset-is-recognised-in-every-form-the-parser-emits
  (testing "the four prefixes OG's own parser produces"
    (is (true? (a/graph-local? "../assets/pic.png")))
    (is (true? (a/graph-local? "./assets/pic.png")))
    (is (true? (a/graph-local? "assets/pic.png")))
    (is (true? (a/graph-local? "/assets/pic.png"))))
  (testing "and Korean and spaced names are no different"
    (is (true? (a/graph-local? "../assets/집중 노트.png")))
    (is (true? (a/graph-local? "../assets/집중%20노트.png"))))
  (testing "something that is not in the graph's asset directory is not one"
    (is (false? (a/graph-local? "https://example.com/a.png")))
    (is (false? (a/graph-local? "pages/Deep Work.md")))
    (is (false? (a/graph-local? nil)))
    (is (false? (a/graph-local? "")))))

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

(deftest a-file-is-looked-for-under-both-spellings-of-its-name
  ;; `../assets/집중%20노트.png` and `../assets/집중 노트.png` are the same file.
  ;; A live run showed the encoded spelling reported as "(file not found)" while
  ;; the literal one loaded, because the existence probe never decoded it.
  (testing "an encoded name is looked for decoded FIRST, and undecoded second"
    (is (= ["assets/집중 노트.png" "assets/집중%20노트.png"]
           (a/repo-relative-paths "../assets/집중%20노트.png"))))
  (testing "a name that needs no decoding is looked for once"
    (is (= ["assets/집중 노트.png"] (a/repo-relative-paths "../assets/집중 노트.png")))
    (is (= ["assets/pic.png"] (a/repo-relative-paths "assets/pic.png")))
    (is (= ["assets/pic.png"] (a/repo-relative-paths "./assets/pic.png")))
    (is (= ["assets/pic.png"] (a/repo-relative-paths "/assets/pic.png"))))
  (testing "a name that genuinely contains a percent sign is not mangled"
    (is (= ["assets/100%done.png"] (a/repo-relative-paths "../assets/100%done.png"))))
  (testing "nothing to look for is an empty list, not a lookup of the graph root"
    (is (= [] (a/repo-relative-paths nil)))
    (is (= [] (a/repo-relative-paths "")))))

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
