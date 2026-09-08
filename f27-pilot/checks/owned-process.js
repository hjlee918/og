'use strict';
//
// Stopping only what this harness started.
//
// Every process acted on here is reached from a PID this harness retained at
// spawn time, walked down through `pgrep -P` (parent-PID, never a name or
// command-line pattern). Nothing is matched by name, and no bundle id is
// addressed -- an earlier diagnosis in this project did use `pkill -f` at the
// shell, which is exactly what this module exists to make unnecessary.
//
// Staging matters: SIGTERM to the main process ALONE was measured to leave a
// packaged Electron app's four processes running, which then held Electron's
// single-instance lock and made the next launch quit immediately. Signalling
// the whole retained tree is what actually stops it.
//
const { execFileSync } = require('child_process');

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return (e.stdout || '').toString();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

// Children by parent PID only. This is descent from a retained handle, not a
// search for processes that look like ours.
function descendants(pid) {
  const out = [pid];
  const seen = new Set(out);
  for (let i = 0; i < out.length; i++) {
    for (const line of sh('pgrep', ['-P', String(out[i])]).split('\n')) {
      const n = Number(line.trim());
      if (n && !seen.has(n)) { seen.add(n); out.push(n); }
    }
  }
  return out;
}

function listeningSockets(pids) {
  if (!pids.length) return [];
  return sh('lsof', ['-a', '-p', pids.join(','), '-i', '-P', '-n'])
    .split('\n').filter((l) => /LISTEN/.test(l)).map((l) => l.trim());
}

/**
 * Stop a process tree we started, gently first.
 * @returns {{tree:number[], stage:string, remaining:number[]}}
 */
async function stop(pid, log = () => {}) {
  const tree = descendants(pid);
  const remaining = () => tree.filter(alive);

  if (!remaining().length) return { tree, stage: 'already-exited', remaining: [] };

  // 1. SIGTERM the whole retained tree.
  for (const p of remaining()) { try { process.kill(p, 'SIGTERM'); } catch (e) { /* gone */ } }
  for (let i = 0; i < 150 && remaining().length; i++) await sleep(100);
  if (!remaining().length) {
    log(`stopped on SIGTERM (${tree.length} owned process(es))`);
    return { tree, stage: 'sigterm', remaining: [] };
  }

  // 2. Last resort, still only PIDs descended from the retained handle.
  const stubborn = remaining();
  log(`SIGKILL for ${stubborn.length} owned process(es) that ignored SIGTERM`);
  for (const p of stubborn) { try { process.kill(p, 'SIGKILL'); } catch (e) { /* gone */ } }
  for (let i = 0; i < 50 && remaining().length; i++) await sleep(100);
  const left = remaining();
  log(`stopped (${left.length} of ${tree.length} still alive)`);
  return { tree, stage: left.length ? 'failed' : 'sigkill', remaining: left };
}

module.exports = { descendants, listeningSockets, alive, stop, sleep };
