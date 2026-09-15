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
  return (stage) => {
    const retained = [...new Set(trees.flat())];
    const aliveTree = retained.filter(alive);
    const byName = ownedProcesses(built.exe, deps);
    if (byName === null) {
      return { closed: false, uncertain: true, stage,
        reason: 'process state could not be read; it is treated as unknown, never as closed' };
    }
    return {
      closed: aliveTree.length === 0 && byName.length === 0,
      stage,
      retainedTreeAlive: aliveTree,
      byExactExecutableName: byName.length,
      excludes: 'only the owned experimental build; not Finder, cloud agents, external editors or a later launch',
    };
  };
}

module.exports = { makeGate, ownedProcesses };
