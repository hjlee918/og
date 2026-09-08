(ns frontend.util.f27-inline-watch-test
  "The open panel's connection subscription, exercised against a REAL datascript
  connection.

  This is the instrumented part of the lifecycle evidence that does not need a
  renderer: it reads datascript's own listener table, so cleanup and ownership
  are proved rather than assumed from the presence of an unmount hook.

  What these pin:

    * a transaction that touches nothing the panel shows does not invalidate it,
      and one that touches the target, a child arriving under it, or a block
      starting to refer to it does;
    * a value is only read as an entity reference when its attribute says so, so
      an ordinary number cannot collide with an entity id;
    * cleanup removes the listener from the connection it was ADDED to — the
      case that matters is a connection REPLACED underneath the panel, where
      asking the application again would unlisten from the wrong one;
    * a replaced connection is rebound, leaving no listener on the old one and
      none of the panel's own state attached to a connection that is not the
      graph's."
  (:require [cljs.test :refer [deftest testing is]]
            [datascript.core :as d]
            [frontend.util.f27-inline-watch :as w]))

(def ^:private schema
  {:block/uuid {:db/unique :db.unique/identity}
   :block/parent {:db/valueType :db.type/ref}
   :block/left {:db/valueType :db.type/ref}
   :block/page {:db/valueType :db.type/ref}
   :block/refs {:db/valueType :db.type/ref :db/cardinality :db.cardinality/many}
   :block/path-refs {:db/valueType :db.type/ref :db/cardinality :db.cardinality/many}})

(defn- fresh []
  (let [conn (d/create-conn schema)]
    (d/transact! conn [{:db/id -1 :block/uuid "page" :block/name "a page"}
                       {:db/id -2 :block/uuid "parent" :block/content "the parent" :block/page -1}
                       {:db/id -3 :block/uuid "target" :block/content "the target"
                        :block/parent -2 :block/page -1}
                       {:db/id -4 :block/uuid "other" :block/content "unrelated" :block/page -1}])
    conn))

(defn- eid [conn uuid] (:db/id (d/entity @conn [:block/uuid uuid])))

(defn- datoms-of [conn tx]
  (:tx-data (d/transact! conn tx)))

;; ---------------------------------------------------------------------------
;; What counts as a change worth showing
;; ---------------------------------------------------------------------------

(deftest a-transaction-that-touches-nothing-shown-does-not-invalidate
  (let [conn (fresh)
        watched #{(eid conn "target")}
        tx (datoms-of conn [{:db/id (eid conn "other") :block/content "still unrelated"}])]
    (is (false? (w/touches? watched tx)))))

(deftest the-targets-own-text-invalidates
  (let [conn (fresh)
        watched #{(eid conn "target")}
        tx (datoms-of conn [{:db/id (eid conn "target") :block/content "edited"}])]
    (is (true? (w/touches? watched tx)))))

(deftest an-ancestor-the-breadcrumb-shows-invalidates
  (testing "the target's own text is untouched, and the breadcrumb still changes"
    (let [conn (fresh)
          watched #{(eid conn "target") (eid conn "parent") (eid conn "page")}
          tx (datoms-of conn [{:db/id (eid conn "parent") :block/content "renamed parent"}])]
      (is (true? (w/touches? watched tx))))))

(deftest a-child-arriving-under-the-target-invalidates
  (testing "the child is a NEW entity; only its :block/parent names the target"
    (let [conn (fresh)
          watched #{(eid conn "target")}
          tx (datoms-of conn [{:db/id -9 :block/uuid "kid" :block/content "a child"
                               :block/parent (eid conn "target")
                               :block/page (eid conn "page")}])]
      (is (true? (w/touches? watched tx))))))

(deftest something-starting-to-refer-to-the-target-invalidates
  (let [conn (fresh)
        watched #{(eid conn "target")}
        tx (datoms-of conn [{:db/id (eid conn "other")
                             :block/refs [(eid conn "target")]}])]
    (is (true? (w/touches? watched tx)))))

(deftest reparenting-the-target-invalidates-though-its-identity-and-text-are-unchanged
  (let [conn (fresh)
        before (d/pull @conn '[:db/id :block/content] (eid conn "target"))
        watched #{(eid conn "target")}
        tx (datoms-of conn [{:db/id (eid conn "target")
                             :block/parent (eid conn "other")}])
        after (d/pull @conn '[:db/id :block/content] (eid conn "target"))]
    (is (true? (w/touches? watched tx)))
    (testing "and the pair the first implementation watched did NOT change — which is
              exactly why that snapshot was too narrow"
      (is (= before after)))))

(deftest retracting-the-target-invalidates
  (let [conn (fresh)
        watched #{(eid conn "target")}
        tx (datoms-of conn [[:db/retractEntity (eid conn "target")]])]
    (is (true? (w/touches? watched tx)))))

(deftest a-plain-number-cannot-collide-with-an-entity-id
  (testing "a non-reference attribute whose value happens to equal a watched id"
    (let [conn (fresh)
          target (eid conn "target")
          tx (datoms-of conn [{:db/id (eid conn "other") :block/journal-day target}])]
      (is (false? (w/touches? #{target} tx))
          "only an attribute that IS a reference may be read as one"))))

(deftest nothing-watched-or-nothing-transacted-is-never-a-change
  (let [conn (fresh)
        tx (datoms-of conn [{:db/id (eid conn "target") :block/content "edited"}])]
    (is (false? (w/touches? #{} tx)))
    (is (false? (w/touches? nil tx)))
    (is (false? (w/touches? #{(eid conn "target")} [])))
    (is (false? (w/touches? #{(eid conn "target")} nil)))))

(deftest every-reference-attribute-that-can-change-the-panel-is-listed
  (is (= #{:block/parent :block/left :block/page :block/refs :block/path-refs}
         w/ref-attrs)))

;; ---------------------------------------------------------------------------
;; Ownership and cleanup
;; ---------------------------------------------------------------------------

(deftest a-watch-is-registered-and-fires
  (let [conn (fresh)
        fired (atom 0)
        handle (w/watch! conn (fn [_] (swap! fired inc)))]
    (is (some? handle))
    (is (true? (w/listening? handle)))
    (is (= #{(:key handle)} (w/listener-keys conn)))
    (d/transact! conn [{:db/id (eid conn "target") :block/content "edited"}])
    (is (= 1 @fired))
    (w/unwatch! handle)
    (is (false? (w/listening? handle)))
    (is (= #{} (w/listener-keys conn)))
    (testing "and it stops firing"
      (d/transact! conn [{:db/id (eid conn "target") :block/content "again"}])
      (is (= 1 @fired)))))

(deftest two-panels-on-one-connection-own-separate-listeners
  (let [conn (fresh)
        a (w/watch! conn (fn [_]))
        b (w/watch! conn (fn [_]))]
    (is (not= (:key a) (:key b)))
    (is (= 2 (count (w/listener-keys conn))))
    (w/unwatch! a)
    (is (= #{(:key b)} (w/listener-keys conn))
        "closing one panel must not remove another's listener")
    (w/unwatch! b)
    (is (= #{} (w/listener-keys conn)))))

(deftest cleanup-uses-the-connection-that-was-subscribed-not-the-current-one
  ;; The case this exists for: a re-index REPLACES the graph's connection. A
  ;; cleanup that asked the application for `the` connection would unlisten a key
  ;; from the NEW connection — where it was never registered — and leave the
  ;; listener on the old one forever.
  (let [old-conn (fresh)
        new-conn (fresh)
        handle (w/watch! old-conn (fn [_]))]
    (is (= 1 (count (w/listener-keys old-conn))))
    (is (= #{} (w/listener-keys new-conn)))
    (w/unwatch! handle)
    (is (= #{} (w/listener-keys old-conn)) "removed from the one it was added to")
    (is (= #{} (w/listener-keys new-conn)))))

(deftest rebinding-moves-the-subscription-and-leaves-nothing-behind
  (let [old-conn (fresh)
        new-conn (fresh)
        fired (atom 0)
        on-change (fn [_] (swap! fired inc))
        handle (w/watch! old-conn on-change)
        moved (w/rebind! handle new-conn on-change)]
    (is (not= (:key handle) (:key moved)))
    (is (= #{} (w/listener-keys old-conn)) "no listener is left on the replaced connection")
    (is (= #{(:key moved)} (w/listener-keys new-conn)))
    (testing "the old connection can no longer reach this panel"
      (d/transact! old-conn [{:db/id (eid old-conn "target") :block/content "edited"}])
      (is (= 0 @fired)))
    (testing "and the new one can"
      (d/transact! new-conn [{:db/id (eid new-conn "target") :block/content "edited"}])
      (is (= 1 @fired)))
    (w/unwatch! moved)
    (is (= #{} (w/listener-keys new-conn)))))

(deftest rebinding-to-the-same-connection-changes-nothing
  (let [conn (fresh)
        handle (w/watch! conn (fn [_]))
        same (w/rebind! handle conn (fn [_]))]
    (is (identical? handle same))
    (is (= 1 (count (w/listener-keys conn)))
        "asking again must not accumulate a second listener")))

(deftest rebinding-to-no-connection-removes-what-is-held
  (let [conn (fresh)
        handle (w/watch! conn (fn [_]))]
    (is (nil? (w/rebind! handle nil (fn [_]))))
    (is (= #{} (w/listener-keys conn)))))

(deftest a-panel-that-never-had-a-connection-cleans-up-harmlessly
  (is (nil? (w/watch! nil (fn [_]))))
  (is (nil? (w/unwatch! nil)))
  (is (false? (w/listening? nil)))
  (is (= #{} (w/listener-keys nil))))
