'use strict';

/*
 * The app-closed gate used by incoming application and recovery.
 *
 * It proves that ONE application has exited: the owned experimental build this
 * harness started. It does so by two independent means, both of which must
 * agree, and it is re-evaluated on every call so a stale verdict can never
 * authorize a later write:
 *
 *   1. every PID in the retained launch tree is dead;
 *   2. no running process carries the exact packaged executable's basename.
 *
 * (2) is a process check on one exact recorded executable name. It is never a
 * name pattern and never a shared-root listing.
 *
 * WHAT IT DOES NOT DO. It excludes one app. Finder, iCloud and other cloud
 * agents, external editors, a second coordinator, and the same application
 * launched again one millisecond after the check passes are all outside it. The
 * cooperative lock does not cover any of them either, and the helper's
 * check-then-rename race is unaffected by whether OG happens to be running.
 */

const path = require('path');
const { execFileSync } = require('child_process');
const OP = require('../../f27-pilot/checks/owned-process');

/*
 * Returns the matching `ps` lines, or null when process state cannot be read.
 * null is uncertainty, and the gate below never reads uncertainty as closed.
 */
function ownedProcesses(executable, deps = {}) {
  const run = deps.run || ((cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }));
  const name = path.basename(executable);
  let output;
  try { output = run('ps', ['-axo', 'pid=,comm=']); }
  catch (_error) { return null; }
  if (typeof output !== 'string' || output.trim() === '') return null;
  return output.split('\n').filter((line) => line.includes(name));
}

function makeGate(built, trees, deps = {}) {
  const alive = deps.alive || OP.alive;
  return (stage, mode = 'app-closed') => {
    const retained = [...new Set(trees.flat())];
    const aliveTree = retained.filter(alive);
    const byName = ownedProcesses(built.exe, deps);
    if (byName === null) {
      return { mode, closed: false, uncertain: true, stage,
        reason: 'process state could not be read; it is treated as unknown, never as closed' };
    }
    return {
      mode,
      closed: aliveTree.length === 0 && byName.length === 0,
      stage,
      retainedTreeAlive: aliveTree,
      byExactExecutableName: byName.length,
      excludes: 'only the owned experimental build; not Finder, cloud agents, external editors or a later launch',
    };
  };
}

/*
 * The app-idle gate. The application is OPEN; this reports evidence that it is
 * idle and NEVER reports closure, so an idle run can never be recorded as an
 * app-closed result.
 *
 * `readIdle()` returns the live signals the harness reads through the existing
 * automation channel. Every one of them is evidence, not exclusion:
 *   - `get-edit-input-id` nil says no block is in edit mode NOW;
 *   - `editor-in-composition?` false says no IME composition NOW (Korean
 *     composition is the case where OG itself refuses to save);
 *   - `input-idle?` returns true merely when nothing is being edited, so it is
 *     not a quiet-period proof;
 *   - `*writes-finished?` marks that a batch was DISPATCHED, not that its IPC
 *     writes landed, because alter-files-handler! returns a promise nobody
 *     awaits;
 *   - pending bridge causes cover only writes that already reached
 *     write-file-impl!.
 * Together they are evidence of an idle app. They do not prove that no save is
 * in flight and they exclude nothing else at all.
 */
function makeIdleGate(readIdle) {
  return async (stage, mode = 'app-idle') => {
    /*
     * FRESH at every boundary. `readIdle` is awaited, so a live gate takes a new
     * graph-bound reading each time it is called -- including between the first
     * and second note write, and again at the completion boundary after an
     * awaited reconciliation. Nothing here replays a value captured earlier.
     */
    let signals;
    try { signals = await readIdle(stage, mode); }
    catch (error) {
      return { mode, idle: false, uncertain: true, stage,
        reason: `idle signals could not be read: ${error.message}` };
    }
    if (!signals || typeof signals !== 'object') {
      return { mode, idle: false, uncertain: true, stage,
        reason: 'idle signals were unreadable' };
    }
    const failing = [];
    /*
     * A required signal that cannot be read is NEVER treated as satisfied and is
     * never substituted with a different, weaker observation. The weaker
     * observation is reported alongside, as its own field, so the distinction
     * stays visible in evidence.
     */
    for (const [key, label] of [['editing', 'edit-state-unreadable'],
      ['composing', 'composition-unreadable'], ['inputIdle', 'input-idle-unreadable'],
      ['writesFinished', 'writes-finished-unreadable'],
      ['pendingCauses', 'pending-causes-unreadable']]) {
      if (signals[key] === null || signals[key] === undefined) failing.push(label);
    }
    if (signals.editing) failing.push('editor-buffer-open');
    if (signals.composing) failing.push('ime-composition');
    if (signals.inputIdle === false) failing.push('recent-input');
    if (signals.writesFinished === false) failing.push('write-batch-not-dispatched');
    if (typeof signals.pendingCauses === 'number' && signals.pendingCauses !== 0) {
      failing.push('pending-bridge-cause');
    }
    if (signals.failedCauses) failing.push('failed-local-save');
    return {
      mode,
      idle: failing.length === 0,
      stage,
      signals,
      failing,
      evidenceOnly: 'these signals are evidence of an idle app, not proof that no save is in flight, and they exclude no other writer',
    };
  };
}

module.exports = { makeGate, makeIdleGate, ownedProcesses };
