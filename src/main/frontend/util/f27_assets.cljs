(ns frontend.util.f27-assets
  "F27 local-asset slice — pure classification of the assets an F27 panel body
  may contain.

  The problem this exists for: inside an F27 panel, OG's own renderer takes an
  asset link to `resizable-image` or `asset-link`. That renders the asset at its
  natural size, hangs OG's action bar on it — delete, copy, maximize, and a
  resize handle whose mouse-up WRITES the block — and, for an `http` source,
  fetches it. None of that belongs in a read-only reference-context panel that
  the reader opened to read text.

  This namespace decides three things and nothing else:

    * is this node a GRAPH-LOCAL asset, a REMOTE one, or neither;
    * what is the file's readable name;
    * which of three kinds it is — `:image`, `:pdf` or `:file`.

  It is PURE. It reads no database and no filesystem, resolves no URL, renders
  nothing and writes nothing. Existence is a question for the caller, which owns
  the read; this only says what a name and a kind are.

  Audio and video are deliberately `:file` here. F27 names an attachment; it
  does not play one, and a classification that had an `:audio` kind would be the
  first half of a player."
  (:require [clojure.string :as string]
            [frontend.util.f27-crystal :as f27c]
            [logseq.graph-parser.config :as gp-config]))

(def ^:const max-badge-chars
  "Longest extension that may become a type badge.

  A badge says `PNG` or `DOCX`. Anything longer is not a file type a reader
  recognises, and a 40-character badge would be the very unbounded chrome this
  panel exists to avoid, so it is shown as no badge at all."
  5)

;; ---------------------------------------------------------------------------
;; Where the bytes are
;; ---------------------------------------------------------------------------

(defn graph-local?
  "True when `href` points inside the graph's own asset directory.

  Uses OG's own predicate, so F27 recognises exactly what OG recognises — the
  `../assets/`, `./assets/`, `assets/` and `/assets/` forms its parser emits —
  rather than introducing a second idea of what a local asset is."
  [href]
  (boolean (and (string? href)
                (not (string/blank? href))
                (gp-config/local-asset? href))))

(defn remote?
  "True when `href` names something that would be FETCHED to be displayed.

  `http`/`https` and an inline `data:` payload. Both are named rather than
  loaded inside a panel: opening a reference context must not issue a network
  request, and a base64 image is not a size a context row chooses."
  [href]
  (boolean (and (string? href)
                (re-find #"(?i)^(https?:|data:)" href))))

;; ---------------------------------------------------------------------------
;; What the file is called
;; ---------------------------------------------------------------------------

(defn- decode-once
  "Percent-decode `s`, or return it unchanged when it is not valid encoding.

  `../assets/집중%20노트.png` and `../assets/집중 노트.png` are the same file
  written two ways, and a reader should see one name for it. A filename that
  merely contains a `%` — `100%done.png` — is not encoded at all, and
  `decodeURIComponent` throws on it; the original is the right answer there."
  [s]
  (try (js/decodeURIComponent s) (catch :default _ s)))

(defn- basename
  "The last path segment of `href`, with any query or fragment removed.

  A path ending in a separator names a directory and has no basename.
  `string/split` drops the trailing empty segment, so without this test
  `../assets/` would be named after the directory it points at."
  [href]
  (when (string? href)
    (let [p (string/replace href #"[?#].*$" "")]
      (when-not (string/ends-with? p "/")
        (last (string/split p #"/"))))))

(defn asset-name
  "The file's own readable name, cut to `max-len` user-perceived characters.

  The name — not the path, and not the author's alt text. A path is chrome a
  reader did not write; the alt text is often empty and is kept as the chip's
  accessible name instead.

  Cut through `preview-text`, the same grapheme-aware helper every other F27
  label uses, so a Korean syllable or a joined emoji sequence is one character
  and is never split in half. Returns nil when there is no readable name, and
  the caller then says so in words rather than showing an empty chip."
  [href max-len]
  (let [n (some-> (basename href) decode-once string/trim)]
    (when-not (string/blank? n)
      (let [s (f27c/preview-text n max-len)]
        (when-not (string/blank? s) s)))))

(defn repo-relative-paths
  "Where the file could be, relative to the graph's own directory.

  `../assets/집중%20노트.png` and `../assets/집중 노트.png` are the same file
  written two ways. A live run showed the encoded spelling reported as
  \"(file not found)\" while the literal one loaded, because the probe looked for
  the name exactly as written.

  The decoded spelling is looked for FIRST, because that is what is on disk when
  an editor wrote the encoded form. The written spelling is kept as a second
  candidate rather than replaced, because a file whose name genuinely contains a
  `%` sequence — `100%done.png` — is not encoded at all, and decoding it would
  be the same mistake in the other direction.

  Returns an empty vector when there is nothing to look for, so a caller never
  ends up asking whether the graph directory itself exists and calling that an
  asset."
  [href]
  (if (or (not (string? href)) (string/blank? href))
    []
    (let [rel (string/replace href #"^[./]+" "")
          decoded (decode-once rel)]
      (->> (if (= decoded rel) [rel] [decoded rel])
           (remove string/blank?)
           distinct
           vec))))

(defn- extension
  "The file's extension in lower case, or nil. Never the whole name: a file
  called `.gitignore` has no extension a badge should claim."
  [href]
  (let [n (some-> (basename href) decode-once)]
    (when (and n (string/includes? n "."))
      (let [e (-> n (string/split #"\.") last string/lower-case string/trim)]
        (when-not (string/blank? e) e)))))

;; ---------------------------------------------------------------------------
;; What kind of thing it is
;; ---------------------------------------------------------------------------

(defn asset-kind
  "`:image`, `:pdf` or `:file`.

  The image set is `gp-config/img-formats` — the same set `asset-link` itself
  consults to decide something is an image — so F27 shows a thumbnail for
  exactly what OG would have shown an image for, and nothing else.

  Everything that is not an image or a PDF is `:file`, audio and video
  included. They are named; they are not played."
  [href]
  (let [e (some-> (extension href) keyword)]
    (cond
      (contains? (gp-config/img-formats) e) :image
      (= :pdf e) :pdf
      :else :file)))

(defn asset-badge
  "The short type badge shown beside a name — `PNG`, `PDF`, `DOCX` — or nil.

  nil rather than a guess: a file with no extension gets no badge, and neither
  does one whose extension is too long to be a type a reader recognises."
  [href]
  (when-let [e (extension href)]
    (when (<= (count e) max-badge-chars)
      (string/upper-case e))))

;; ---------------------------------------------------------------------------
;; Reading one parsed node
;; ---------------------------------------------------------------------------

(defn node-href
  "The href carried by one parsed link payload map, when it is a plain path.

  OG's parser gives a graph-local asset `[\"Search\" \"../assets/x.png\"]`. Every
  other `:url` shape — a block reference, a page reference, a `Complex`
  protocol map — is not a local path and is not answered here."
  [m]
  (when (map? m)
    (let [[kind payload] (:url m)]
      (when (and (= "Search" kind) (string? payload)) payload))))

(defn local-asset-node?
  "True when one parsed link payload map is a graph-local asset.

  This is what lets the budget charge an asset what its chip actually shows,
  and what lets a body renderer present it without re-deriving OG's own
  `show-link?` rules."
  [m]
  (boolean (some-> (node-href m) graph-local?)))
