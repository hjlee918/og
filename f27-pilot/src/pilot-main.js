'use strict';
//
// Logseq OG F27 Pilot -- application entry point.
//
// This file is the packaged app's `main`. It exists so that two things happen
// in an order that the compiled main process cannot arrange for itself:
//
//   1. the build identity of the compiled main bundle is established WITHOUT
//      loading it, and
//   2. every per-user path is relocated into the pilot's own root,
//
// both strictly before `require('./electron.js')`. That require is the moment
// OG's `defonce` top-levels compute `dot-root`, `cfg-root` and `PLUGINS_ROOT`,
// so anything later would be too late.
//
// There is no fallback. If either stage refuses, the process exits without
// loading OG and without opening a window. That is the same posture the
// project's existing guarded launcher and build-identity gate already take.
//
// WHAT LOADS BEFORE THE CHECK, AND WHY IT IS THE SMALLEST POSSIBLE SET.
// `pilot-isolation.js` is required only AFTER the preflight has verified it, so
// a tampered isolation module cannot run any top-level code. Only this file,
// `pilot-identity.js` and `pilot-preflight.js` are loaded before verification,
// because they are what performs the verification -- a bootstrap that cannot be
// removed. Their bytes are still covered by the manifest, so tampering with any
// of them is detected before Logseq OG loads; the honest limitation is that the
// detection happens after their own top-level code has run. All three are
// deliberately side-effect-free at module scope: constants, pure functions and
// requires of node built-ins only.
//
const path = require('path');

const ID = require('./pilot-identity.js');
const preflight = require('./pilot-preflight.js');

function fail(stage, reason, detail) {
  const lines = [
    '',
    '  Logseq OG F27 Pilot refused to start.',
    '',
    `    stage:  ${stage}`,
    `    reason: ${reason}`,
    `    detail: ${detail}`,
    '',
    '  No Logseq OG code was loaded and no window was opened.',
    '',
  ];
  process.stderr.write(lines.join('\n') + '\n');
}

function main() {
  let electron;
  try {
    electron = require('electron');
  } catch (e) {
    fail('startup', 'electron-unavailable', e.message);
    process.exit(1);
    return;
  }

  const app = electron && electron.app;
  if (!app || typeof app.setPath !== 'function' || typeof app.getPath !== 'function') {
    fail('startup', 'no-electron-app',
      'the electron module did not provide an app object with getPath/setPath');
    process.exit(1);
    return;
  }

  const exit = (code) => {
    if (typeof app.exit === 'function') app.exit(code);
    else process.exit(code);
  };

  // ---- stage 1: build identity, without executing the bundle -------------
  const pre = preflight.verify(__dirname);
  if (!pre.ok) {
    fail('preflight', pre.reason, pre.detail);
    exit(1);
    return;
  }

  // ---- stage 2: isolation, before OG's namespaces can read a path --------
  // Loaded only now: its bytes were just verified above.
  const isolation = require('./pilot-isolation.js');
  let established;
  try {
    established = isolation.establish({
      app,
      pilotBuildId: pre.manifest.pilotBuildId,
    });
  } catch (e) {
    fail('isolation', e.reason || 'isolation-error', e.detail || e.message);
    exit(1);
    return;
  }

  process.stdout.write(
    `[pilot] build ${pre.manifest.pilotBuildId} verified; ` +
    `state root ${established.root}\n`);

  // ---- stage 3: only now does any Logseq OG code load --------------------
  require(path.join(__dirname, ID.MAIN_BUNDLE));
}

main();
