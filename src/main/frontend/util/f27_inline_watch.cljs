(ns frontend.util.f27-inline-watch
  "The subscription an OPEN F27 inline-context panel holds on a datascript
  connection, and the decision of when it matters.

  It is separated from `frontend.util.f27-inline` because that namespace is pure
  and reads nothing; this one owns a connection listener. It is separated from
  the component because a listener whose ownership and cleanup are asserted with
  a REAL connection needs no renderer — every function here is exercised in
  `frontend.util.f27-inline-watch-test` against `d/create-conn`.

  Three properties matter and are all tested:

    * THE DECISION READS NO DATABASE. `touches?` answers from the transaction's
      own datoms and a set of entity ids gathered when the panel last rendered.
      There is no query, no walk and no pull per transaction — a panel that is
      open costs one pass over the datoms of each transaction and nothing else.

    * THE EXACT CONNECTION IS RETAINED. Cleanup unlistens from the connection
      that was actually subscribed, never from whatever `db/get-db` happens to
      return later. A re-index REPLACES the connection, so asking again at
      unmount would remove a key from the new connection and leave the listener
      on the old one forever.

    * A REPLACED CONNECTION IS REBOUND, NOT ABANDONED. `rebind!` moves the
      subscription when the graph's connection is no longer the one held, and
      removes it when there is no connection at all, so a panel can never stay
      attached to a connection that is not its graph's."
  (:require [datascript.core :as d]))

(def ref-attrs
  "The attributes whose VALUE is another entity, and whose change can alter what
  a panel shows without touching the target itself.

  `:block/parent` and `:block/left` are how a child arrives, leaves or is
  reordered under the target; `:block/page` is how it moves between pages;
  `:block/refs` and `:block/path-refs` are how something starts or stops
  referring to it.

  The set exists so a value is only read as an entity reference when the
  attribute says it is one. Without it a plain number — a journal day, an
  ordinal — could collide with an entity id and invalidate a panel for nothing."
  #{:block/parent :block/left :block/page :block/refs :block/path-refs})

(defn touches?
  "Whether `tx-data` mentions any entity in `watched`.

  A datom counts when it is ABOUT a watched entity (`:e`), or when it POINTS at
  one through a reference attribute (`:v`). The first covers the target's own
  text, its retraction, and a change to an ancestor whose breadcrumb the panel
  displays; the second covers a child appearing under it and a block starting to
  refer to it.

  Pure, and short-circuits: no database is read, and the walk stops at the first
  datom that matters."
  [watched tx-data]
  (boolean
   (when (and (seq watched) (seq tx-data))
     (reduce (fn [_ datom]
               (if (or (contains? watched (:e datom))
                       (and (contains? ref-attrs (:a datom))
                            (contains? watched (:v datom))))
                 (reduced true)
                 false))
             false
             tx-data))))

(defn watch!
  "Listen on `conn`, calling `on-change` with each transaction report.

  Returns the HANDLE to keep — the connection and the key, together — because
  those two are what cleanup needs and neither can be re-derived safely later.
  Returns nil for no connection, so a caller need not special-case it."
  [conn on-change]
  (when conn
    (let [k (keyword "f27-inline" (str (gensym "panel")))]
      (d/listen! conn k on-change)
      {:conn conn :key k})))

(defn unwatch!
  "Remove `handle`'s listener from the connection it was actually added to.

  Deliberately takes the handle rather than a repo: asking the application for
  `the` connection at unmount time answers with whichever connection is current,
  which after a re-index is not the one this listener is on."
  [handle]
  (when-let [{:keys [conn key]} handle]
    (when (and conn key)
      (d/unlisten! conn key)))
  nil)

(defn rebind!
  "The handle this panel should hold for `conn`.

  * no connection at all — remove what is held and hold nothing;
  * the same connection — keep the handle, add nothing;
  * a DIFFERENT connection — remove the old listener from the OLD connection
    first, then listen on the new one.

  Identity, not equality: two connections are the same connection only when they
  are the same object."
  [handle conn on-change]
  (cond
    (nil? conn) (do (unwatch! handle) nil)
    (and handle (identical? (:conn handle) conn)) handle
    :else (do (unwatch! handle) (watch! conn on-change))))

(defn listener-keys
  "Every listener key this feature currently has on `conn`, read out of
  datascript's own listener table.

  Exists so cleanup can be PROVEN — by a test with a real connection, and by the
  packaged scenario reading the live application — rather than assumed from the
  fact that an unmount hook was written."
  [conn]
  (if-let [listeners (some-> conn meta :listeners deref)]
    (into #{} (filter #(= "f27-inline" (namespace %))) (keys listeners))
    #{}))

(defn listening?
  "Whether `handle`'s own key is still registered on its own connection."
  [handle]
  (boolean
   (when-let [{:keys [conn key]} handle]
     (contains? (listener-keys conn) key))))
