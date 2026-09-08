'use strict';
//
// PRE-LOAD BUILD IDENTITY.
//
// This module answers one question before the compiled main process is loaded:
// *is the file next to me the pilot main bundle this entry was built against?*
//
// It must therefore never require, import or evaluate that bundle. It reads it
// as bytes only. A `:node-script` bundle starts running during `require`, so
// asking the bundle to describe itself would already have run it -- that is the
// ordering defect this module exists to avoid.
//
// What is actually proved, and what is not:
//
//   * PROVED: the bundle on disk is byte-for-byte the one recorded in the build
//     manifest; the manifest describes a build made with
//     `electron.pilot/PILOT true`; the bundle text carries the pilot guard
//     marker and does not carry the inert marker; the entry files beside it are
//     also unmodified; the identity in the manifest is this pilot's identity.
//
//   * NOT PROVED: authenticity. The manifest is an ordinary local file. Anyone
//     able to rewrite both the bundle and the manifest could produce a
//     consistent pair. This is local build consistency, not signed attestation,
//     and it is not claimed to be more.
//
// Every failure path returns a refusal. There is no fallback and no warn-and-
// continue: the caller exits without loading anything.
//
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID = require('./pilot-identity.js');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function refuse(reason, detail, extra) {
  return Object.assign({ ok: false, reason, detail: detail || '' }, extra || {});
}

/**
 * @param {string} dir directory holding the manifest, the entry files and the
 *                     compiled main bundle (the packaged `Resources/app`).
 * @returns {{ok:true, manifest:object, checks:object[]}
 *          |{ok:false, reason:string, detail:string}}
 */
function verify(dir) {
  const checks = [];
  const note = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok; };

  const manifestPath = path.join(dir, ID.MANIFEST_FILE);

  let raw;
  try {
    raw = fs.readFileSync(manifestPath);
  } catch (e) {
    return refuse('manifest-missing', `${manifestPath}: ${e.code || e.message}`, { checks });
  }
  note('manifest-readable', true, manifestPath);

  let m;
  try {
    m = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return refuse('manifest-unparseable', e.message, { checks });
  }
  note('manifest-parseable', true, '');

  if (m.schema !== ID.SCHEMA) {
    return refuse('manifest-schema-mismatch', `expected ${ID.SCHEMA}, found ${m.schema}`, { checks });
  }
  note('manifest-schema', true, ID.SCHEMA);

  if (m.pilot !== true) {
    return refuse('manifest-not-a-pilot-build', `pilot=${JSON.stringify(m.pilot)}`, { checks });
  }
  note('manifest-declares-pilot', true, '');

  // Identity comes from this file, never from the manifest.
  if (m.productName !== ID.PRODUCT_NAME) {
    return refuse('identity-mismatch', `productName ${JSON.stringify(m.productName)}`, { checks });
  }
  if (m.bundleId !== ID.BUNDLE_ID) {
    return refuse('identity-mismatch', `bundleId ${JSON.stringify(m.bundleId)}`, { checks });
  }
  note('identity-matches-entry', true, `${ID.PRODUCT_NAME} / ${ID.BUNDLE_ID}`);

  const defines = m.closureDefines || {};
  if (defines['electron.pilot/PILOT'] !== true) {
    return refuse('pilot-define-not-set',
      `electron.pilot/PILOT=${JSON.stringify(defines['electron.pilot/PILOT'])}`, { checks });
  }
  note('closure-define-recorded', true, 'electron.pilot/PILOT true');

  // ---- artifact hashes -------------------------------------------------
  const artifacts = m.artifacts;
  if (!artifacts || typeof artifacts !== 'object') {
    return refuse('manifest-malformed', 'no artifacts table', { checks });
  }
  if (!artifacts[ID.MAIN_BUNDLE]) {
    return refuse('manifest-malformed', `no entry for ${ID.MAIN_BUNDLE}`, { checks });
  }

  // Every entry file that participates in the guarded startup must itself be
  // covered, so a tampered isolation module cannot ride along on a valid
  // bundle hash.
  const required = [ID.MAIN_BUNDLE, 'pilot-main.js', 'pilot-preflight.js',
                    'pilot-isolation.js', 'pilot-identity.js', 'pilot-boundary.js'];
  for (const req of required) {
    if (!artifacts[req]) {
      return refuse('manifest-incomplete', `artifact not covered: ${req}`, { checks });
    }
  }

  let mainBundleText = null;
  for (const [name, want] of Object.entries(artifacts)) {
    const p = path.join(dir, name);
    let buf;
    try {
      buf = fs.readFileSync(p);
    } catch (e) {
      return refuse('artifact-missing', `${name}: ${e.code || e.message}`, { checks });
    }
    if (typeof want.bytes === 'number' && buf.length !== want.bytes) {
      return refuse('artifact-size-mismatch',
        `${name}: expected ${want.bytes} bytes, found ${buf.length}`, { checks });
    }
    const got = sha256(buf);
    if (got !== want.sha256) {
      return refuse('artifact-hash-mismatch',
        `${name}: expected ${want.sha256}, found ${got}`, { checks });
    }
    note(`artifact:${name}`, true, `${buf.length} bytes, sha256 ${got.slice(0, 16)}...`);
    if (name === ID.MAIN_BUNDLE) mainBundleText = buf.toString('utf8');
  }

  // ---- non-executing guard marker scan ---------------------------------
  // The literals come from this file, so a manifest cannot relax the test.
  if (mainBundleText.indexOf(ID.ACTIVE_MARKER) === -1) {
    return refuse('guards-absent-from-bundle',
      `${ID.MAIN_BUNDLE} does not contain ${ID.ACTIVE_MARKER}`, { checks });
  }
  if (mainBundleText.indexOf(ID.INERT_MARKER) !== -1) {
    return refuse('bundle-carries-inert-marker',
      `${ID.MAIN_BUNDLE} contains ${ID.INERT_MARKER}; guards are not active`, { checks });
  }
  note('guard-marker-in-bundle', true, ID.ACTIVE_MARKER);

  return { ok: true, manifest: m, checks };
}

module.exports = { verify, sha256 };
