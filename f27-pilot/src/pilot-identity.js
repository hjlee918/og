'use strict';
//
// The pilot's identity constants.
//
// These are hard-coded in the shipped entry rather than read from the build
// manifest, so that a manifest belonging to some other build cannot rename the
// application into this one. The manifest supplies hashes; this file supplies
// the identity those hashes must belong to.
//
module.exports = Object.freeze({
  SCHEMA: 'f27-pilot/1',
  PRODUCT_NAME: 'Logseq OG F27 Pilot',
  BUNDLE_ID: 'com.logseq.logseq-og.f27pilot',
  PACKAGE_NAME: 'logseq-og-f27-pilot',

  // Written into the compiled main bundle by electron.pilot/build-marker.
  // Exactly one of the two is expected to survive a release build.
  ACTIVE_MARKER: 'LOGSEQ-OG-F27-PILOT-GUARDS-ACTIVE-1',
  INERT_MARKER: 'LOGSEQ-OG-F27-PILOT-GUARDS-INERT-1',

  // The pilot's own state root, nested inside the Electron product directory
  // because Chromium's crash handler creates that product directory before the
  // entry script runs. See pilot-isolation.js.
  STATE_DIR: 'pilot-state',

  MANIFEST_FILE: 'pilot-build-manifest.json',
  BOUNDARY_FILE: 'pilot-boundary.json',
  BOUNDARY_SCHEMA: 'f27-pilot/boundary/1',

  // The sole permitted graph-data location, expressed relative to the real OS
  // home rather than hard-coded to one machine. The entry validates it before
  // the main process is allowed to treat it as a root; if validation fails the
  // application refuses every graph path rather than falling back to anything.
  GRAPH_ROOT_SEGMENTS: ['Library', 'Mobile Documents', 'com~apple~CloudDocs',
                        'Logseq Test'],
  MAIN_BUNDLE: 'electron.js',
  OWNERSHIP_MARKER: 'PILOT-OWNED.json',
  STARTUP_REPORT: 'startup-report.json',

  // Every writable Electron path the pilot relocates into its own root.
  // 'logs' is applied with setAppLogsPath rather than setPath.
  ISOLATED_PATHS: ['home', 'userData', 'sessionData', 'temp', 'crashDumps'],
  LOGS_DIR: 'logs',
});
