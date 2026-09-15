'use strict';

// Dedicated identity for the one approved observation-only runtime. It cannot
// claim or reuse the OriginExp, accepted RefPath, installed Logseq, or personal
// profile namespaces.
module.exports = Object.freeze({
  SCHEMA: 'f28-bridge-observation/1',
  PRODUCT_NAME: 'Logseq OG F28 Observation',
  BUNDLE_ID: 'com.logseq.logseq-og.f28observation',
  PACKAGE_NAME: 'logseq-og-f28-observation',
  ACTIVE_MARKER: 'LOGSEQ-OG-F27-PILOT-GUARDS-ACTIVE-1',
  INERT_MARKER: 'LOGSEQ-OG-F27-PILOT-GUARDS-INERT-1',
  STATE_DIR: 'observation-state',
  MANIFEST_FILE: 'f28-observation-build-manifest.json',
  BOUNDARY_FILE: 'pilot-boundary.json',
  BOUNDARY_SCHEMA: 'f27-pilot/boundary/1',
  GRAPH_ROOT_SEGMENTS: ['Library', 'Mobile Documents', 'com~apple~CloudDocs',
                        'Logseq Test'],
  MAIN_BUNDLE: 'electron.js',
  OWNERSHIP_MARKER: 'F28-OBSERVATION-OWNED.json',
  STARTUP_REPORT: 'startup-report.json',
  ISOLATED_PATHS: ['home', 'userData', 'sessionData', 'temp', 'crashDumps'],
  LOGS_DIR: 'logs',
  EXPERIMENT: 'bridge-observation-only',
  APP_ORIGIN: 'lsp://logseq.com',
  PLUGIN_ORIGIN: 'lsp://logseq.io',
});
