'use strict';
//
// Identity constants for the F28 SOURCE-PATH FEATURE build.
//
// This is the same mechanism `f27-pilot/src/pilot-identity.js` is: the shipped
// entry hard-codes the identity, the manifest supplies only hashes, and
// `pilot-preflight.js` refuses a manifest whose identity is not this one. The
// entry, preflight, isolation and boundary sources are the PILOT's, unchanged —
// only this constants module differs, and it is copied into the application
// directory as `pilot-identity.js`, which is the name those sources require.
//
// Why a separate identity at all: this build contains a REBUILT RENDERER, and a
// DIFFERENT one from the accepted F27 inline-context build that shares this
// checkout. It must never be mistaken for either — not in the Dock, not in
// Application Support, and not by an ownership marker. A different product
// name, bundle id, package name, state directory, ownership marker and manifest
// schema make the three builds unable to claim each other's state, which is
// what "no two pilot apps concurrently" needs in order to be checkable rather
// than merely intended.
//
// The checkout is shared on purpose: this feature branch is cut from the
// accepted F27 commit in the SAME clone, so nothing is duplicated. What must
// not be shared is the built application's identity, and that is this file.
//
// The GUARD MARKERS are deliberately identical: they come from
// `electron.pilot/build-marker`, whose source this feature does not touch, and
// a different literal here would mean the guards were not the accepted ones.
//
module.exports = Object.freeze({
  SCHEMA: 'f28-refpath/1',
  PRODUCT_NAME: 'Logseq OG F28 RefPath',
  BUNDLE_ID: 'com.logseq.logseq-og.f28refpath',
  PACKAGE_NAME: 'logseq-og-f28-refpath',

  // Unchanged from the pilot: same guard source, same compiled marker.
  ACTIVE_MARKER: 'LOGSEQ-OG-F27-PILOT-GUARDS-ACTIVE-1',
  INERT_MARKER: 'LOGSEQ-OG-F27-PILOT-GUARDS-INERT-1',

  STATE_DIR: 'refpath-state',

  MANIFEST_FILE: 'feature-build-manifest.json',

  // BOUNDARY_FILE and BOUNDARY_SCHEMA are NOT this build's to rename. They are
  // the contract between `pilot-isolation.js` and the COMPILED guard: G5 in
  // `src/electron/electron/pilot.cljs` reads `<state-root>/pilot-boundary.json`
  // and accepts it only when its schema is exactly `f27-pilot/boundary/1`,
  // failing closed otherwise. Changing the schema here — which the first
  // version of this file did — left `graphRoot` nil, so the application refused
  // EVERY graph path, the permitted one included. The live run caught it: the
  // good dialog result was journalled as
  // `no permitted root is configured for graph-select`.
  //
  // That is the guard working exactly as designed, and the lesson is the same
  // one the guard markers carry: what belongs to the guard is the guard's, and
  // only what belongs to this BUILD's identity may differ.
  BOUNDARY_FILE: 'pilot-boundary.json',
  BOUNDARY_SCHEMA: 'f27-pilot/boundary/1',

  // The sole permitted graph-data location, expressed relative to the real OS
  // home rather than hard-coded to one machine. Unchanged from the pilot: the
  // boundary is the project's, not this feature's.
  GRAPH_ROOT_SEGMENTS: ['Library', 'Mobile Documents', 'com~apple~CloudDocs',
                        'Logseq Test'],
  MAIN_BUNDLE: 'electron.js',
  OWNERSHIP_MARKER: 'F28-REFPATH-OWNED.json',
  STARTUP_REPORT: 'startup-report.json',

  ISOLATED_PATHS: ['home', 'userData', 'sessionData', 'temp', 'crashDumps'],
  LOGS_DIR: 'logs',
});
