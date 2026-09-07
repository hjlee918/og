(ns frontend.util.f27-assets
  "F27 local-asset slice — pure classification of the assets an F27 panel body
  may contain.

  The problem this exists for: inside an F27 panel, OG's own renderer takes an
  asset link to `resizable-image` or `asset-link`. That renders the asset at its
  natural size, hangs OG's action bar on it — delete, copy, maximize, and a
  resize handle whose mouse-up WRITES the block — and, for an `http` source,
  fetches it. None of that belongs in a read-only reference-context panel that
  the reader opened to read text.

  This namespace decides four things and nothing else:

    * is this node a GRAPH-LOCAL asset, a REMOTE one, or neither;
    * what is the file's readable name;
    * which of three kinds it is — `:image`, `:pdf` or `:file`;
    * what a directory listing the caller already holds PROVES about the graph's
      asset directory and the files in it.

  It is PURE. It reads no database and no filesystem, resolves no URL, renders
  nothing and writes nothing. Existence is a question for the caller, which owns
  the read; this only says what a name and a kind are, and what a listing the
  caller hands it means.

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

(defn recognized-local?
  "True when `href` is written in the syntax OG calls a local asset.

  This is OG's own predicate, so F27 handles exactly the nodes OG would have
  handled — the `../assets/`, `./assets/`, `assets/` and `/assets/` forms its
  parser emits. It is a PREFIX RECOGNISER and nothing more: `^[./]*assets`
  matches `../assets/../../outside.png` and `../assets-other/x.png` just as
  happily as a real asset.

  **Recognition routes a node to F27's renderer. It does not authorise reading
  a path.** `contained-paths` below is the only answer a caller may act on."
  [href]
  (boolean (and (string? href)
                (not (string/blank? href))
                (gp-config/local-asset? href))))

;; ---------------------------------------------------------------------------
;; Containment. This is the authorisation, and it fails closed.
;; ---------------------------------------------------------------------------

(def ^:const max-decode-rounds
  "How many times a spelling is decoded while looking for a hidden separator.

  `%2e%2e` is `..` to anything that decodes before it looks, and `%252e%252e`
  is `%2e%2e` to anything that decodes once. Every round is checked, so a
  traversal has to survive being read at every level to be authorised — which
  it cannot, because one escaping form refuses the whole href."
  4)

(def ^:private unsafe-char-re
  "Control characters and NUL. None of these belongs in a filename a note wrote,
  and none of them may reach a filesystem call."
  #"[\u0000-\u001f\u007f]")

(def ^:private protocol-re
  "A leading scheme — `https:`, `file:`, `assets:`, and a Windows drive letter,
  which is the same shape. An address is not a graph-relative path."
  #"^[a-zA-Z][a-zA-Z0-9+.\-]*:")

(def ^:private prefix-segments
  "The leading segments OG itself writes in front of the asset directory. A
  block file lives in `pages/`, so `../assets/…` is the ordinary spelling.
  These are dropped BEFORE the boundary is checked, and nothing else is: a
  directory really called `....` is a directory, not a traversal."
  #{"" "." ".."})

(defn- decoded-forms
  "`s` and every form it decodes to, up to `max-decode-rounds`.

  All of them are checked. A spelling is authorised only if it stays inside the
  asset directory however many times it is read, because the code that finally
  opens a file is not necessarily the code that decoded it."
  [s]
  (loop [out [s], cur s, n 0]
    (let [d (try (js/decodeURIComponent cur) (catch :default _ cur))]
      (if (or (= d cur) (>= n max-decode-rounds))
        out
        (recur (conj out d) d (inc n))))))

(defn- contained-relative
  "The graph-relative path ONE spelling names, or nil when it is not provably
  inside the graph's own asset directory.

  Segment-wise, never by stripping a prefix with a regular expression: the
  leading `../` OG writes is dropped as SEGMENTS, so `..../assets/x.png` keeps
  its `....` directory and is refused rather than silently rewritten.

  After the prefix, the first segment must be the asset directory EXACTLY —
  `assets-other` is a different directory — and every segment after it must be
  an ordinary name. `..`, `.` and an empty segment are all refused, so no
  spelling can climb out and no spelling can be read two ways."
  [s]
  (when (and (string? s)
             (not (string/blank? s))
             (not (re-find unsafe-char-re s))
             (not (re-find protocol-re s)))
    (let [segs (-> s
                   ;; A backslash is a separator somewhere, so it is treated as
                   ;; one here rather than as part of a name.
                   (string/replace "\\" "/")
                   (string/split #"/" -1))
          rest' (drop-while prefix-segments segs)]
      (when (and (= gp-config/local-assets-dir (first rest'))
                 (seq (rest rest'))
                 (every? #(and (not (string/blank? %))
                               (not (contains? #{"." ".."} %)))
                         (rest rest')))
        ;; A graph-relative KEY, normalised to one spelling for comparison —
        ;; deliberately not an OS path, so a path-joining helper is the wrong
        ;; tool and would reintroduce the separator handling just removed.
        #_{:clj-kondo/ignore [:path-invalid-construct/string-join]}
        (string/join "/" rest')))))

(defn contained-paths
  "The graph-relative paths a caller may probe, load or reveal for `href`.

  Empty when the href is not provably inside the graph's own asset directory —
  and empty is the whole answer: there is no partial authorisation and no
  fallback to the spelling the author typed.

  When it IS contained, the decoded spelling comes first and the written one
  second, because they can be two spellings of one file: a live run showed
  `../assets/%EC%A7%91…png` and `../assets/집중 노트.png` naming the same
  picture. A name that genuinely contains a `%` is why the written spelling is
  kept as well as, not instead of, the decoded one.

  Every returned path begins with the asset directory and contains no traversal,
  so a caller cannot pass the raw href to the filesystem by accident."
  [href]
  (let [forms (when (and (string? href) (not (string/blank? href)))
                (decoded-forms href))
        rels (map contained-relative forms)]
    (if (and (seq forms) (every? some? rels))
      (vec (distinct (remove nil? [(last rels) (first rels)])))
      [])))

(defn contained?
  "True when `href` names something inside the graph's own asset directory.
  The one question a caller may act on."
  [href]
  (boolean (seq (contained-paths href))))

(defn remote?
  "True when `href` names something that would be FETCHED to be displayed.

  `http`/`https` and an inline `data:` payload. Both are named rather than
  loaded inside a panel: opening a reference context must not issue a network
  request, and a base64 image is not a size a context row chooses."
  [href]
  (boolean (and (string? href)
                (re-find #"(?i)^(https?:|data:)" href))))

;; ---------------------------------------------------------------------------
;; The asset ROOT. Containment above decides what a SPELLING may name; this
;; decides whether the directory that spelling is anchored to is a real
;; directory of this graph at all.
;; ---------------------------------------------------------------------------

(defn normalize-name
  "One spelling of a name, for comparison only.

  macOS hands back a Korean filename decomposed while a name decoded from a note
  is composed. Without this the same file has two names and one of them is never
  found. Comparison only: nothing displayed goes through here."
  [s]
  (let [s (str s)]
    (try (.normalize s "NFC") (catch :default _ s))))

(defn graph-root
  "The graph directory with exactly one trailing separator, or nil.

  Every path below is compared by prefix, so the separator has to be there
  exactly once: without it `/g/assets2` would read as a path inside `/g/assets`."
  [dir]
  (let [d (some-> dir str string/trim)]
    (when-not (string/blank? d)
      (str (string/replace d #"/+$" "") "/"))))

(defn asset-dir
  "This graph's asset directory, with no trailing separator, or nil."
  [dir]
  (when-let [root (graph-root dir)]
    (str root gp-config/local-assets-dir)))

(defn asset-prefix
  "The prefix every path inside this graph's asset directory begins with."
  [dir]
  (when-let [root (graph-root dir)]
    (str root gp-config/local-assets-dir "/")))

(defn asset-root-real?
  "Does the GRAPH'S OWN listing prove that `<graph>/assets` is a real directory
  of this graph, rather than a symbolic link pointing out of it?

  `logseq.common.graph/readdir` removes symbolic links among the entries it
  FINDS, but it seeds its walk with `[true root-dir]` and never asks whether the
  directory it was handed is itself a link. F27 hands it `<graph>/assets`
  directly, so a symlinked asset directory was walked and everything behind it
  was listed as though it were inside the graph — and every path under it is
  lexically contained, so the pure gate passes it too.

  The authority does not change; it is applied ONE LEVEL UP. A symlinked
  `assets` is removed among the graph root's own children, so nothing under
  `<root>/assets/` appears in the graph's listing at all.

  `paths` is that listing. Fails closed: an unreadable directory, a blank graph
  path and a listing with nothing under `assets/` all answer false.

  A real but EMPTY asset directory also answers false, and that is not a false
  refusal: it contributes no file, so there was no file for the listing gate to
  authorise either."
  [dir paths]
  (boolean
   (when-let [prefix (asset-prefix dir)]
     (some #(string/starts-with? (str %) prefix) paths))))

(defn asset-index
  "The listing of `<graph>/assets`, as a map from the graph-relative path to the
  absolute path the filesystem reported.

  Membership in it answers three questions at once: the file exists, it is
  inside the asset directory, and it is a real file rather than a way out of
  one. Anything the listing reports from outside the graph root is dropped
  rather than trusted — the walker is recursive, so a path that does not begin
  at the root is not a path this graph is describing."
  [dir paths]
  (if-let [root (graph-root dir)]
    (reduce (fn [acc p]
              (let [abs (str p)]
                (if (string/starts-with? abs root)
                  (assoc acc (normalize-name (subs abs (count root))) abs)
                  acc)))
            {}
            (or paths []))
    {}))

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
  "True when one parsed link payload map is written as a graph-local asset.

  Recognition, not authorisation: this is what lets the budget charge an asset
  what its chip actually shows, and what lets a body renderer present it without
  re-deriving OG's own `show-link?` rules. A node that is recognised but NOT
  contained still renders a bounded chip — one that says so and offers nothing —
  so the same charge is still what reaches the screen."
  [m]
  (boolean (some-> (node-href m) recognized-local?)))
