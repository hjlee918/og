'use strict';

/*
 * Reading OG's own idle signals, and observing its reconciliation, through the
 * automation channel the harness already uses.
 *
 * Nothing here adds an application permission: these are the same page
 * evaluations the accepted coordinator already performs for page creation and
 * for flushing the outliner writer. They are a TEST AFFORDANCE. A real user's
 * application exposes none of this, so nothing measured here is a product
 * mechanism.
 *
 * Every signal below is EVIDENCE, not exclusion. See the source notes on each.
 */

const OBSERVATION_API = '__LOGSEQ_OG_BRIDGE_OBSERVATION__';

/*
 * Idle signals, read live.
 *
 *  editing        state/get-edit-input-id non-nil => a block is in edit mode NOW
 *                 with an uncommitted buffer whose truth is the DOM input value.
 *  composing      state/editor-in-composition? => OG's save-current-block!
 *                 refuses to save at all. This is the Korean IME case.
 *  inputIdle      state/input-idle? is NOT a quiet-period proof: it returns true
 *                 whenever no block is in edit mode, regardless of elapsed time.
 *                 It is read with an explicit :diff of at least the outliner's
 *                 1000 ms batch interval, and reported alongside the raw
 *                 last-input age so the weakness is visible in evidence.
 *  writesFinished outliner-file/*writes-finished? marks that a batch was
 *                 DISPATCHED. write-files! -> do-write-file! -> save-tree! ->
 *                 alter-files-handler! returns a promise nobody awaits, so true
 *                 does NOT mean the IPC writes landed. Absence is nil, not true.
 *  pendingCauses  bridge causes only exist once a write reached
 *                 write-file-impl!, so this covers the last leg only.
 */
async function readIdleSignals(page, repo) {
  return page.evaluate(({repo}) => {
    const state = window.frontend && window.frontend.state;
    const core = window.cljs && window.cljs.core;
    const outlinerFile = window.frontend && window.frontend.modules
      && window.frontend.modules.outliner && window.frontend.modules.outliner.file;
    if (!state) throw new Error('frontend.state is unavailable');
    const unreadable = [];
    const read = (label, fn) => {
      try {
        const value = fn();
        if (value === undefined) { unreadable.push(label); return null; }
        return value;
      } catch (error) { unreadable.push(`${label}:${String(error)}`); return null; }
    };

    /*
     * `get-edit-input-id` returning nil means NO block is in edit mode, which is
     * exactly the idle condition -- it is not a read failure. Absence of the
     * function is the read failure.
     */
    let editReadable = true;
    const editInputId = read('edit-input-id', () => {
      if (!state.get_edit_input_id) { editReadable = false; return undefined; }
      const value = state.get_edit_input_id();
      return value === undefined ? null : value;
    });
    const composing = read('composition',
      () => (state.editor_in_composition_QMARK_
        ? Boolean(state.editor_in_composition_QMARK_()) : undefined));
    // Single arity: OG's own default :diff is 1000 ms, exactly the outliner
    // batch interval. Passing keyword arguments from JS is not attempted.
    const inputIdle = read('input-idle',
      () => (state.input_idle_QMARK_ ? Boolean(state.input_idle_QMARK_(repo)) : undefined));

    /*
     * `*writes-finished?` is a ClojureScript atom holding a ClojureScript map.
     * `cljs.core` is not exposed on `window` in this build, so several access
     * paths are attempted and the one that worked is reported. If none works the
     * signal is null, the gate refuses, and the claim is narrowed rather than
     * assumed -- it is never treated as satisfied.
     */
    let writesFinishedVia = null;
    const writesFinished = read('writes-finished', () => {
      const atom = outlinerFile && outlinerFile._STAR_writes_finished_QMARK_;
      if (!atom) return undefined;
      const raw = (core && core.deref) ? core.deref(atom)
        : (typeof atom.deref === 'function' ? atom.deref()
          : ('state' in atom ? atom.state : undefined));
      if (raw === undefined) return undefined;
      if (raw === null) { writesFinishedVia = 'empty-map'; return null; }
      let entry;
      if (core && core.get) { entry = core.get(raw, repo); writesFinishedVia = 'cljs.core.get'; }
      else if (typeof raw.get === 'function') { entry = raw.get(repo); writesFinishedVia = 'map.get'; }
      else if (typeof raw.cljs$core$ILookup$_lookup$arity$2 === 'function') {
        entry = raw.cljs$core$ILookup$_lookup$arity$2(raw, repo);
        writesFinishedVia = 'ILookup';
      } else { entry = raw[repo]; writesFinishedVia = 'plain-object'; }
      if (entry === null || entry === undefined) {
        // No batch has ever been queued for this repo. Absence is NOT proof of
        // an empty queue, so it is reported as null, not as true.
        return null;
      }
      let value;
      if (core && core.get && core.keyword) value = core.get(entry, core.keyword('value'));
      else if (typeof entry.cljs$core$ILookup$_lookup$arity$2 === 'function') {
        value = entry.cljs$core$ILookup$_lookup$arity$2(entry, 'value');
      } else value = entry.value;
      return value === true;
    });

    return {
      repo,
      editing: editReadable ? Boolean(editInputId) : null,
      editInputId: editInputId || null,
      composing,
      inputIdle,
      inputIdleDiffMs: 1000,
      writesFinished,
      writesFinishedVia,
      unreadable,
    };
  }, {repo});
}

/* Pending local save/rename causes, from the read-only observation stream. */
async function pendingLocalCauses(page, graphId) {
  return page.evaluate(({name, graphId}) => {
    const api = window[name];
    if (!api || typeof api.read !== 'function') return null;
    const events = api.read() || [];
    const open = new Map();
    // The sanitized record carries `event`, `cause` and `observation` as
    // SIBLINGS -- `event` is the event name, not a container.
    for (const record of events) {
      const cause = record && record.cause;
      if (!cause || !cause['cause-id']) continue;
      if (graphId && cause['graph-id'] && cause['graph-id'] !== graphId) continue;
      const kind = cause.kind;
      if (kind !== 'save' && kind !== 'rename') continue;
      open.set(cause['cause-id'], cause.status);
    }
    let pending = 0;
    let failed = 0;
    for (const status of open.values()) {
      if (status === 'pending') pending += 1;
      if (status === 'failed') failed += 1;
    }
    return {pending, failed, total: open.size};
  }, {name: OBSERVATION_API, graphId});
}

/*
 * A bounded settle observation, used where `*writes-finished?` cannot be read.
 *
 * Any queued save that eventually flushes reaches write-file-impl! and produces
 * a save cause in the observation stream. So: sample the stream, wait longer
 * than the outliner's 1000 ms batch interval, sample again, and require that no
 * new cause appeared and none is pending.
 *
 * This is WEAKER than reading the queue. It shows that nothing surfaced during
 * the window; it does not prove the channel was empty, and a save queued after
 * the second sample is outside it entirely. It is evidence, not exclusion.
 */
async function observeSettled(page, graphId, {windowMs = 2500, attempts = 6} = {}) {
  const sample = () => page.evaluate(name => {
    const api = window[name];
    return api && typeof api.read === 'function' ? (api.read() || []).length : null;
  }, OBSERVATION_API);
  let before = await sample();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, windowMs));
    const after = await sample();
    const causes = await pendingLocalCauses(page, graphId);
    if (before === null || after === null || causes === null) {
      return {settled: null, reason: 'the observation stream was unreadable'};
    }
    if (after === before && causes.pending === 0) {
      return {
        settled: true, eventsBefore: before, eventsAfter: after, windowMs, attempt,
        pending: causes.pending, failed: causes.failed,
        limitation: 'nothing surfaced during this window; the queue itself was not read and a later save is outside it',
      };
    }
    before = after;
  }
  return {settled: false, reason: `activity continued for ${attempts} windows`,
    windowMs, attempts, lastCount: before};
}

/*
 * Has OG taken the change?
 *
 * Bounded sampling with an explicit post-match settle window, so a regression
 * is actually reachable rather than being dead code behind an immediate return:
 *
 *   1. poll the DATABASE for the exact path until it equals the approved target
 *      or the wait expires;
 *   2. on a first match, keep sampling for `settleMs` and report a regression if
 *      it moves away again;
 *   3. report every sample count so the coverage is visible.
 *
 * Typed outcomes: `reconciled`, `reconciliation-timeout`,
 * `reconciliation-regressed`, `reconciliation-failed`.
 *
 * WHAT THIS DOES NOT ESTABLISH. It says the database agreed throughout the
 * observed window. It is NOT protection against a delayed or stale watcher
 * payload arriving after the window closes, and no such protection is claimed.
 * Rendering is NOT checked here -- visible content is verified separately by the
 * caller, in the live cases where it matters.
 */
async function awaitOgReconciliation(page, {repo, path, expectedContent,
  timeoutMs = 20000, intervalMs = 250, settleMs = 1500}) {
  const started = Date.now();
  const readDb = () => page.evaluate(({repo, path}) => {
    const db = window.frontend && window.frontend.db;
    if (!db || !db.get_file) throw new Error('frontend.db.get_file is unavailable');
    const content = db.get_file(repo, path);
    return typeof content === 'string' ? content : null;
  }, {repo, path}).then(value => ({value}), error => ({error: String(error)}));

  let polls = 0;
  let matchedAtMs = null;
  for (;;) {
    polls += 1;
    const observed = await readDb();
    if (observed.error) {
      return {reconciled: false, code: 'reconciliation-failed', reason: observed.error,
        polls, elapsedMs: Date.now() - started};
    }
    if (observed.value === expectedContent) { matchedAtMs = Date.now() - started; break; }
    if (Date.now() - started > timeoutMs) {
      return {reconciled: false, code: 'reconciliation-timeout',
        reason: `OG did not take the change within ${timeoutMs} ms`,
        polls, elapsedMs: Date.now() - started,
        observedLength: observed.value === null ? null : observed.value.length};
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  // Post-match settle: this is what makes a regression observable at all.
  const settleStarted = Date.now();
  let settleSamples = 0;
  while (Date.now() - settleStarted < settleMs) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    settleSamples += 1;
    polls += 1;
    const again = await readDb();
    if (again.error) {
      return {reconciled: false, code: 'reconciliation-failed', reason: again.error,
        polls, settleSamples, matchedAtMs, elapsedMs: Date.now() - started};
    }
    if (again.value !== expectedContent) {
      return {reconciled: false, code: 'reconciliation-regressed',
        reason: 'the database matched the approved target and then moved away during the settle window',
        polls, settleSamples, matchedAtMs, elapsedMs: Date.now() - started,
        observedLength: again.value === null ? null : again.value.length};
    }
  }
  return {reconciled: true, polls, settleSamples, matchedAtMs, settleMs,
    elapsedMs: Date.now() - started,
    bounded: 'the database agreed throughout the observed window; a payload arriving after it is not excluded'};
}

/*
 * A single later boundary sample: does the database STILL hold the approved
 * target now? Used at the completion boundary, where re-running the full wait
 * would hide a regression behind a fresh match.
 */
async function sampleOgContent(page, {repo, path, expectedContent}) {
  const observed = await page.evaluate(({repo, path}) => {
    const db = window.frontend && window.frontend.db;
    if (!db || !db.get_file) throw new Error('frontend.db.get_file is unavailable');
    const content = db.get_file(repo, path);
    return typeof content === 'string' ? content : null;
  }, {repo, path}).then(value => ({value}), error => ({error: String(error)}));
  if (observed.error) {
    return {reconciled: false, code: 'reconciliation-failed', reason: observed.error};
  }
  if (observed.value !== expectedContent) {
    return {reconciled: false, code: 'reconciliation-regressed',
      reason: 'the database no longer holds the approved target at the completion boundary',
      observedLength: observed.value === null ? null : observed.value.length};
  }
  return {reconciled: true, boundarySample: true};
}

/*
 * Is the approved content VISIBLE in the rendered page? Checked separately from
 * the database, and only in the live cases where it matters.
 */
async function renderedContains(session, pageName, expected) {
  await session.goTo(pageName);
  return session.page.evaluate(value => document.body.innerText.includes(value), expected);
}

/*
 * Count RAW WATCHER OBSERVATIONS recorded by the read-only observation stream
 * for one exact graph and one exact graph-relative path.
 *
 * These are NOT reconciliation invocations. OG's internal
 * `reconcile-from-disk!` calls are not instrumented by the observation-only
 * package, and counting them would require changing it, which is out of scope.
 * Reconciliation invocation and completion counts are therefore reported as
 * UNAVAILABLE; watcher observations and backup files are different quantities
 * and are never substituted for them.
 *
 * The match is bound to OG's exact repo identifier and the exact graph-relative
 * path. A suffix match was previously used, which could have counted an
 * identically named file in a different graph.
 */
async function watcherObservationsFor(page, ogRepo, path) {
  return page.evaluate(({name, ogRepo, path}) => {
    const api = window[name];
    if (!api || typeof api.read !== 'function') return null;
    const events = api.read() || [];
    let count = 0;
    for (const record of events) {
      const observation = record && record.observation;
      if (!observation || observation.path !== path) continue;
      // The stream records OG's own repo identifier, which is what identifies
      // the graph directory here -- not the sidecar's graph id.
      if (ogRepo && observation['graph-id'] !== ogRepo) continue;
      count += 1;
    }
    return count;
  }, {name: OBSERVATION_API, ogRepo, path});
}

/* A bounded sample of observation paths, for diagnosing count mismatches. */
async function observationPathSample(page, limit = 12) {
  return page.evaluate(({name, limit}) => {
    const api = window[name];
    if (!api || typeof api.read !== 'function') return null;
    const events = api.read() || [];
    const paths = [];
    for (let index = events.length - 1; index >= 0 && paths.length < limit; index -= 1) {
      const record = events[index];
      const observation = record && record.observation;
      if (observation && typeof observation.path === 'string') {
        paths.push({kind: record.event, path: observation.path,
          graphId: observation['graph-id'] ?? null});
      }
    }
    return paths;
  }, {name: OBSERVATION_API, limit});
}

module.exports = {
  OBSERVATION_API, awaitOgReconciliation, observationPathSample, observeSettled,
  pendingLocalCauses, readIdleSignals, renderedContains, sampleOgContent,
  watcherObservationsFor,
};
