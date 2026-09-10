'use strict';
//
// Identity constants for the ORIGIN EXPERIMENT build.
//
// Same mechanism as `f27-pilot/src/pilot-identity.js` and
// `f28-refpath/src/feature-identity.js`: the shipped entry hard-codes the
// identity, the manifest supplies only hashes, and `pilot-preflight.js` refuses
// a manifest whose identity is not this one.
//
// WHY A THIRD IDENTITY. This build changes the application's ORIGIN. Its
// renderer-side storage therefore lands in a different bucket from every other
// build's, and its profile must never be confused with — or claimed by — the
// ACCEPTED `Logseq OG F28 RefPath` build, whose package and profile this
// experiment is required to preserve untouched. A different product name,
// bundle id, package name, state directory, ownership marker and manifest
// schema make that unable to happen by accident rather than merely unintended.
//
// The GUARD MARKERS and the BOUNDARY contract are deliberately identical: they
// come from `electron.pilot`, whose source this experiment does not touch, and
// a different literal here would mean the guards were not the accepted ones.
//
module.exports = Object.freeze({
  SCHEMA: 'f28-originexp/1',
  PRODUCT_NAME: 'Logseq OG F28 OriginExp',
  BUNDLE_ID: 'com.logseq.logseq-og.f28originexp',
  PACKAGE_NAME: 'logseq-og-f28-originexp',

  ACTIVE_MARKER: 'LOGSEQ-OG-F27-PILOT-GUARDS-ACTIVE-1',
  INERT_MARKER: 'LOGSEQ-OG-F27-PILOT-GUARDS-INERT-1',

  STATE_DIR: 'originexp-state',

  MANIFEST_FILE: 'origin-experiment-build-manifest.json',

  // NOT this build's to rename: the compiled G5 guard reads
  // `<state-root>/pilot-boundary.json` and accepts it only when its schema is
  // exactly `f27-pilot/boundary/1`, failing closed otherwise.
  BOUNDARY_FILE: 'pilot-boundary.json',
  BOUNDARY_SCHEMA: 'f27-pilot/boundary/1',

  GRAPH_ROOT_SEGMENTS: ['Library', 'Mobile Documents', 'com~apple~CloudDocs',
                        'Logseq Test'],
  MAIN_BUNDLE: 'electron.js',
  OWNERSHIP_MARKER: 'F28-ORIGINEXP-OWNED.json',
  STARTUP_REPORT: 'startup-report.json',

  ISOLATED_PATHS: ['home', 'userData', 'sessionData', 'temp', 'crashDumps'],
  LOGS_DIR: 'logs',

  // What this build is FOR, recorded in its own manifest.
  EXPERIMENT: 'origin',
  APP_ORIGIN: 'lsp://logseq.com',
  PLUGIN_ORIGIN: 'lsp://logseq.io',
});
