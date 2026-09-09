#!/usr/bin/env node
'use strict';
//
// A NARROW, RESTORED LOOKUP FAULT — for the one negative path this project
// cannot reach any other way.
//
// WHY THIS EXISTS, AND WHAT IT IS NOT.
//
// The source-path disclosure re-resolves a step's identity at the moment it is
// activated, and refuses when the answer is not a readable block. To see that
// refusal on screen, a destination has to be unavailable — and every other way
// of arranging that changes the reader's notes:
//
//   * deleting the ancestor removes it from the ancestor walk too, so the row
//     is gone before it can be pressed, and the whole reference usually goes
//     with it;
//   * moving it changes the path OG shows, which is a different measurement.
//
// So the fault is injected at the LOOKUP, in the page, for ONE identity, for
// the length of one press, and is removed again. **Evidence produced with it is
// SIMULATED and is labelled as such wherever it is recorded.** It proves that
// the product's refusal path works when a lookup answers badly. It does NOT
// prove that any particular graph condition produces such an answer.
//
// WHAT MAKES IT NARROW, and how that is shown rather than asserted:
//
//   * it wraps ONE function and delegates every other call to the original,
//     unchanged, including every other arity;
//   * it acts only on a lookup whose ref is exactly `[:block/uuid <target>]`;
//   * it counts every call it sees and every call it acted on, so a run can
//     show that thousands of lookups passed through untouched while a handful
//     hit the target;
//   * the original is retained and restored, and restoration is verified by
//     object identity, not by hope.
//
// NOTHING HERE TOUCHES A GRAPH. It installs no handler on the filesystem, opens
// nothing, and writes nothing: it is a function wrapper inside the renderer,
// removed before the run continues.
//
// The seams are `frontend.db/entity` (the destination lookup) and
// `frontend.db/get-block-parent` (the ancestor walk's one step upward). Both
// are resolved from the namespace object at every call site in this build, so
// wrapping the property is enough and no call site is edited.
//

/** The two functions this may wrap, and how a target is recognised in each. */
const SEAMS = {
  entity: { ns: 'entity', by: 'lookup-ref' },
  parent: { ns: 'get_block_parent', by: 'uuid-arg' },
};

/** The answers a faulted lookup may give. */
const MODES = ['missing', 'throw', 'placeholder'];

/**
 * Install one fault in the page.
 *
 * @param page    the Playwright page
 * @param seam    'entity' | 'parent'
 * @param uuid    the ONE identity this acts on
 * @param mode    'missing'     -> the lookup answers with nothing
 *                'throw'       -> the lookup cannot be performed
 *                'placeholder' -> the lookup answers with an identity-only
 *                                 entity: `{:block/uuid u :db/id n}`, the exact
 *                                 shape the supervisor named
 * @returns {{ok:boolean, reason?:string, seam:string, mode:string, target:string}}
 */
async function install(page, seam, uuid, mode) {
  if (!SEAMS[seam]) throw new Error(`unknown seam ${seam}`);
  if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
  return page.evaluate(([seamName, prop, by, target, faultMode]) => {
    const g = window;
    if (g.__f28Fault) return { ok: false, reason: 'a fault is already installed' };
    const ns = g.frontend && g.frontend.db;
    const core = g.cljs && g.cljs.core;
    if (!ns || typeof ns[prop] !== 'function') {
      return { ok: false, reason: `no seam: frontend.db.${prop}` };
    }
    if (!core || typeof core.keyword !== 'function' || typeof core.uuid !== 'function') {
      return { ok: false, reason: 'the cljs runtime is not reachable from the page' };
    }
    const orig = ns[prop];
    const state = { calls: 0, hits: 0, seam: seamName, mode: faultMode, target };

    const kw = (a, b) => (core.keyword.cljs$core$IFn$_invoke$arity$2
      ? core.keyword.cljs$core$IFn$_invoke$arity$2(a, b)
      : core.keyword.call(null, a, b));
    const nth = (v, i) => (core.nth.cljs$core$IFn$_invoke$arity$2
      ? core.nth.cljs$core$IFn$_invoke$arity$2(v, i)
      : core.nth.call(null, v, i));
    const assoc3 = (m, k, v) => (core.assoc.cljs$core$IFn$_invoke$arity$3
      ? core.assoc.cljs$core$IFn$_invoke$arity$3(m, k, v)
      : core.assoc.call(null, m, k, v));

    /** Is THIS call the one identity this fault acts on? Everything else passes. */
    const isTarget = (a, b) => {
      try {
        if (by === 'uuid-arg') return String(b) === target;
        if (!core.vector_QMARK_(b)) return false;
        if (core.count(b) !== 2) return false;
        return String(nth(b, 0)) === ':block/uuid' && String(nth(b, 1)) === target;
      } catch (e) { return false; }
    };

    const passThrough2 = (a, b) => (orig.cljs$core$IFn$_invoke$arity$2
      ? orig.cljs$core$IFn$_invoke$arity$2(a, b)
      : orig.call(null, a, b));

    const two = (a, b) => {
      state.calls += 1;
      if (!isTarget(a, b)) return passThrough2(a, b);
      state.hits += 1;
      if (faultMode === 'missing') return null;
      if (faultMode === 'throw') throw new Error('F28 SIMULATED lookup fault');
      // An identity-only entity: it exists, its uuid matches, and nobody has
      // written anything at it.
      let m = core.PersistentArrayMap.EMPTY;
      m = assoc3(m, kw('block', 'uuid'), core.uuid(target));
      m = assoc3(m, kw('db', 'id'), 123);
      return m;
    };

    const patched = function (a, b) {
      if (arguments.length === 2) return two(a, b);
      state.calls += 1;
      return orig.cljs$core$IFn$_invoke$arity$1
        ? orig.cljs$core$IFn$_invoke$arity$1(a)
        : orig.call(null, a);
    };
    patched.cljs$core$IFn$_invoke$arity$2 = two;
    patched.cljs$core$IFn$_invoke$arity$1 = function (a) {
      state.calls += 1;
      return orig.cljs$core$IFn$_invoke$arity$1
        ? orig.cljs$core$IFn$_invoke$arity$1(a)
        : orig.call(null, a);
    };

    ns[prop] = patched;
    g.__f28Fault = { prop, orig, patched, state };
    return { ok: true, seam: seamName, mode: faultMode, target,
             installed: ns[prop] === patched };
  }, [seam, SEAMS[seam].ns, SEAMS[seam].by, uuid, mode]);
}

/** What the installed fault has seen so far. */
async function status(page) {
  return page.evaluate(() => {
    const f = window.__f28Fault;
    if (!f) return { installed: false };
    const ns = window.frontend.db;
    return { installed: ns[f.prop] === f.patched,
             calls: f.state.calls, hits: f.state.hits,
             seam: f.state.seam, mode: f.state.mode, target: f.state.target };
  }).catch(() => ({ installed: false, unreadable: true }));
}

/** Remove the fault and prove the original is back, by object identity. */
async function remove(page) {
  return page.evaluate(() => {
    const f = window.__f28Fault;
    if (!f) return { removed: false, reason: 'nothing was installed' };
    const ns = window.frontend.db;
    ns[f.prop] = f.orig;
    const restored = ns[f.prop] === f.orig;
    const seen = { calls: f.state.calls, hits: f.state.hits,
                   seam: f.state.seam, mode: f.state.mode, target: f.state.target };
    delete window.__f28Fault;
    return { removed: true, restored, seen };
  }).catch((e) => ({ removed: false, reason: String(e.message) }));
}

/** Remove whatever is installed, and say nothing if nothing was. Used in finally. */
async function removeQuietly(page) {
  try { return await remove(page); } catch (e) { return { removed: false }; }
}

module.exports = { install, remove, removeQuietly, status, SEAMS, MODES };
