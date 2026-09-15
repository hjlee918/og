'use strict';

// Dedicated identity for the one approved live-capture runtime. The in-app
// bridge is exactly the established observation-only runtime; the capture and
// persistence live in the external test-owned coordinator and the anchored
// helper, never in this package. This identity cannot claim or reuse the
// OriginExp, Observation, accepted RefPath, installed Logseq, or personal
// profile namespaces, and it is distinct from the anchored
// "Logseq OG F28 IdentityExp" record root.
module.exports = Object.freeze({
  SCHEMA: 'f28-bridge-identity-capture/1',
  PRODUCT_NAME: 'Logseq OG F28 IdentityCapture',
  BUNDLE_ID: 'com.logseq.logseq-og.f28identitycapture',
  PACKAGE_NAME: 'logseq-og-f28-identitycapture',
  ACTIVE_MARKER: 'LOGSEQ-OG-F27-PILOT-GUARDS-ACTIVE-1',
  INERT_MARKER: 'LOGSEQ-OG-F27-PILOT-GUARDS-INERT-1',
  STATE_DIR: 'identity-capture-state',
  MANIFEST_FILE: 'f28-identity-capture-build-manifest.json',
  BOUNDARY_FILE: 'pilot-boundary.json',
  BOUNDARY_SCHEMA: 'f27-pilot/boundary/1',
  GRAPH_ROOT_SEGMENTS: ['Library', 'Mobile Documents', 'com~apple~CloudDocs',
                        'Logseq Test'],
  MAIN_BUNDLE: 'electron.js',
  OWNERSHIP_MARKER: 'F28-IDENTITY-CAPTURE-OWNED.json',
  STARTUP_REPORT: 'startup-report.json',
  ISOLATED_PATHS: ['home', 'userData', 'sessionData', 'temp', 'crashDumps'],
  LOGS_DIR: 'logs',
  EXPERIMENT: 'bridge-observation-with-external-identity-capture',
  APP_ORIGIN: 'lsp://logseq.com',
  PLUGIN_ORIGIN: 'lsp://logseq.io',
});