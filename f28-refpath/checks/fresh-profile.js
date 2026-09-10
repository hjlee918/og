'use strict';
//
// A GENUINELY FRESH ISOLATED PROFILE FOR THIS BUILD, AND THE SHARED ONE PUT
// BACK EXACTLY AS IT WAS.
//
// WHY THIS EXISTS AT ALL. `pilot-isolation.js` derives the isolated state root
// from Electron itself:
//
//   ROOT = <app.getPath('appData')>/<PRODUCT_NAME>/<STATE_DIR>
//
// and that is a FIXED path for a given build. A bounded probe in this batch
// launched the packaged build with `HOME` pointed at a scratch directory and
// read the application's own log: `appData` did NOT follow `HOME` (only
// `logs` did), and the run still landed in the real
// `~/Library/Application Support/Logseq OG F28 RefPath/refpath-state`. So a
// fresh profile cannot be obtained by redirecting the environment, and this
// module does the only other honest thing: it MOVES the shared root aside,
// lets the application create a new one, and moves the shared one back.
//
// WHY FRESHNESS IS NOT OPTIONAL HERE. Plugins persist. A plugin placed in the
// shared `refpath-state` would still be there for every later F28 packaged
// run, and each plugin writes its own default settings into the profile the
// first time it initialises. Installing into the shared profile would
// therefore silently change the conditions of every accepted scenario that
// reuses it. The swap is what keeps this batch from doing that.
//
// FAIL-CLOSED RULES, in the same spirit as `pilot-isolation`'s ownership rule:
//
//   * a root is moved ONLY when it carries this build's own ownership marker
//     with a matching schema, bundle id and product name — an unknown or
//     malformed directory is never touched;
//   * a symlinked root is refused rather than renamed through;
//   * nothing is ever deleted, overwritten or merged: the aside name must not
//     already exist, and restoration refuses to write over a directory;
//   * the run's own fresh root is KEPT (renamed, not removed) so its evidence
//     survives the batch;
//   * `restore` verifies the marker it puts back is the marker it took.
//
// This module touches ONE directory tree: the state root of the build named by
// the identity it is given. It never reads a graph, and it never goes near the
// installed application's own profile.
//
const fs = require('fs');
const os = require('os');
const path = require('path');

class ProfileRefusal extends Error {}

/** Where `pilot-isolation.js` will put this build's state root. */
function stateRootFor(identity, homeOverride) {
  const home = homeOverride || os.userInfo().homedir;
  return {
    productDir: path.join(home, 'Library', 'Application Support', identity.PRODUCT_NAME),
    root: path.join(home, 'Library', 'Application Support', identity.PRODUCT_NAME,
                    identity.STATE_DIR),
  };
}

/** OG's plugins directory inside such a root (`electron/configs.cljs` dot-root). */
function pluginsDirIn(root) {
  return path.join(root, 'home', '.logseq-og', 'plugins');
}

function readMarker(root, identity) {
  const p = path.join(root, identity.OWNERSHIP_MARKER);
  let st;
  try { st = fs.lstatSync(p); } catch (e) { return { ok: false, reason: 'no-marker', path: p }; }
  if (st.isSymbolicLink()) return { ok: false, reason: 'marker-is-symlink', path: p };
  let marker;
  try { marker = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return { ok: false, reason: 'marker-unparseable', path: p, detail: e.message }; }
  if (marker.schema !== identity.SCHEMA ||
      marker.bundleId !== identity.BUNDLE_ID ||
      marker.productName !== identity.PRODUCT_NAME) {
    return { ok: false, reason: 'marker-mismatch', path: p, marker };
  }
  return { ok: true, path: p, marker };
}

/** Refuse unless `root` is a real directory this build owns. */
function assertOurs(root, identity) {
  let st;
  try { st = fs.lstatSync(root); }
  catch (e) { throw new ProfileRefusal(`${root}: ${e.code || e.message}`); }
  if (st.isSymbolicLink()) throw new ProfileRefusal(`${root} is a symbolic link; refusing to move it`);
  if (!st.isDirectory()) throw new ProfileRefusal(`${root} is not a directory`);
  const m = readMarker(root, identity);
  if (!m.ok) {
    throw new ProfileRefusal(
      `${root} does not carry this build's ownership marker (${m.reason}); refusing to move a ` +
      'directory this batch did not establish as its own');
  }
  return m.marker;
}

/**
 * Move the shared root aside so the next launch creates a fresh one.
 *
 * Returns a handle the caller must pass to `restore`, whatever happens.
 * When no shared root exists there is nothing to preserve and the handle says
 * so — the launch will create a fresh root by itself either way.
 */
function swapAside(identity, opts = {}) {
  const stamp = opts.stamp || new Date().toISOString().replace(/[:.]/g, '-');
  const { root, productDir } = stateRootFor(identity, opts.homeOverride);
  const handle = { identity, root, productDir, stamp, preserved: null, marker: null,
                   preExisting: fs.existsSync(root) };

  if (!handle.preExisting) return handle;

  handle.marker = assertOurs(root, identity);
  const aside = `${root}.preserved-${stamp}`;
  if (fs.existsSync(aside)) {
    throw new ProfileRefusal(`${aside} already exists; refusing to overwrite a preserved profile`);
  }
  fs.renameSync(root, aside);
  handle.preserved = aside;
  if (fs.existsSync(root)) {
    throw new ProfileRefusal(`${root} still exists after being moved aside; refusing to continue`);
  }
  return handle;
}

/**
 * Keep this run's fresh root under its own name, then put the shared one back.
 *
 * Never throws for a missing fresh root: a launch that never happened leaves
 * nothing to keep, and the shared profile must still come home. Returns a
 * report; a caller that needs the restoration to have succeeded reads `ok`.
 */
function restore(handle, opts = {}) {
  const label = opts.label || 'run';
  const out = { kept: null, restored: false, ok: false, notes: [] };
  const { root, identity, stamp, preserved } = handle;

  if (fs.existsSync(root)) {
    const kept = `${root}.${label}-${stamp}`;
    if (fs.existsSync(kept)) {
      out.notes.push(`${kept} already exists; this run's fresh root was left in place at ${root}`);
    } else {
      try {
        fs.renameSync(root, kept);
        out.kept = kept;
      } catch (e) {
        out.notes.push(`could not keep this run's fresh root: ${e.code || e.message}`);
      }
    }
  } else {
    out.notes.push('this run created no state root to keep');
  }

  if (!preserved) {
    out.ok = !fs.existsSync(root) || out.kept === null;
    out.notes.push('no shared profile was preserved, because none existed before this run');
    return out;
  }

  if (fs.existsSync(root)) {
    out.notes.push(`${root} is occupied; refusing to write the preserved profile over it — ` +
                   `the preserved profile remains at ${preserved}`);
    return out;
  }
  try {
    fs.renameSync(preserved, root);
  } catch (e) {
    out.notes.push(`could not restore the preserved profile: ${e.code || e.message}; ` +
                   `it remains at ${preserved}`);
    return out;
  }
  const m = readMarker(root, identity);
  out.restored = true;
  out.ok = m.ok && !!handle.marker && m.marker.createdAt === handle.marker.createdAt;
  if (!out.ok) {
    out.notes.push('the restored profile does not carry the marker that was taken: ' +
                   `${m.ok ? `createdAt ${m.marker.createdAt}` : m.reason}`);
  }
  out.markerCreatedAt = m.ok ? m.marker.createdAt : null;
  return out;
}

module.exports = {
  ProfileRefusal, stateRootFor, pluginsDirIn, readMarker, assertOurs, swapAside, restore,
};
