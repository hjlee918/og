'use strict';
//
// STATE ISOLATION, ESTABLISHED AND VERIFIED BEFORE ANY OG CODE LOADS.
//
// Logseq OG computes every per-user location at namespace load time, not
// lazily:
//
//   electron/configs.cljs:10  dot-root  = <app.getPath("home")>/.logseq-og
//   electron/configs.cljs:11  cfg-root  = app.getPath("userData")
//   electron/core.cljs:33     PLUGINS_ROOT = <dot-root>/plugins
//
// `dot-root` holds the graph registry, per-graph git repositories, plugins and
// settings. Sharing it would mean sharing the installed application's graph
// registry, which is precisely what this pilot must not do. Because those are
// `defonce` top-levels they are evaluated the instant `require('./electron.js')`
// runs, so a wrapper that runs before that require is the only place the
// ordering can be guaranteed. Node's `require` is synchronous, so this ordering
// is a property of the program, not a hope.
//
// Nothing here reads an environment variable, so a launch from Finder, the
// Dock, Spotlight or `open(1)` behaves exactly like a launch from a terminal.
//
// OWNERSHIP. The pilot root is claimed only when it is genuinely new. An
// existing directory is adopted only if it already carries this pilot's own
// ownership marker. An unknown directory, a symlinked root, a symlinked child,
// a malformed marker or a marker belonging to something else all refuse the
// launch, and nothing is written into a directory that was not established as
// pilot-owned -- including failure reports.
//
const fsDefault = require('fs');
const osDefault = require('os');
const pathDefault = require('path');

const ID = require('./pilot-identity.js');

const CONFIG_SEED =
  '{:auto-update false, :server/autostart false, :server/port 12399}\n';

// Path names understood by app.getPath. Audited even when not overridden, so
// the report says what the pilot's whole path surface looked like rather than
// only the parts it changed.
const ALL_PATH_NAMES = [
  'home', 'appData', 'userData', 'sessionData', 'temp', 'exe', 'module',
  'desktop', 'documents', 'downloads', 'music', 'pictures', 'videos',
  'recent', 'logs', 'crashDumps',
];

class Refusal extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
  }
}

function establish(opts) {
  const app = opts.app;
  const fs = opts.fs || fsDefault;
  const os = opts.os || osDefault;
  const path = opts.path || pathDefault;
  const env = opts.env || process.env;

  const steps = [];
  const step = (name, detail) => { steps.push({ name, detail: String(detail) }); };

  const readPath = (name) => {
    try { return app.getPath(name); } catch (e) { return { error: e.code || e.message }; }
  };
  const snapshotPaths = () => {
    const out = {};
    for (const n of ALL_PATH_NAMES) out[n] = readPath(n);
    return out;
  };

  // ---- 1. real OS identity, recorded BEFORE anything is overridden -------
  // os.homedir() honours $HOME and so is not by itself proof of anything.
  // os.userInfo().homedir comes from the password database and is the
  // authoritative real home; all four are recorded and compared later.
  let realOsHome = null;
  try { realOsHome = os.userInfo().homedir; } catch (e) { realOsHome = null; }
  const preOverride = {
    osUserInfoHome: realOsHome,
    osHomedir: os.homedir(),
    envHOME: env.HOME || null,
    paths: snapshotPaths(),
  };
  step('recorded-real-os-identity', preOverride.osUserInfoHome);

  if (!realOsHome) {
    throw new Refusal('no-real-home', 'os.userInfo() did not yield a home directory');
  }

  // ---- 2. name, then the root, derived from appData (never from $HOME) ---
  app.setName(ID.PRODUCT_NAME);
  step('app-name-set', ID.PRODUCT_NAME);

  const appDataRaw = app.getPath('appData');
  let appDataReal;
  try {
    appDataReal = fs.realpathSync(appDataRaw);
  } catch (e) {
    throw new Refusal('appdata-unresolvable', `${appDataRaw}: ${e.code || e.message}`);
  }
  const ROOT = path.join(appDataReal, ID.PRODUCT_NAME);
  step('root-resolved', ROOT);

  // ---- 3. ownership: claim only what is genuinely new --------------------
  const markerPath = path.join(ROOT, ID.OWNERSHIP_MARKER);
  let ownership;

  let rootStat = null;
  try {
    rootStat = fs.lstatSync(ROOT);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw new Refusal('root-unstattable', `${ROOT}: ${e.code || e.message}`);
    }
  }

  if (rootStat && rootStat.isSymbolicLink()) {
    throw new Refusal('root-is-symlink',
      `${ROOT} is a symbolic link; refusing to write through it`);
  }
  if (rootStat && !rootStat.isDirectory()) {
    throw new Refusal('root-not-a-directory', `${ROOT} exists and is not a directory`);
  }

  if (!rootStat) {
    // Genuinely new: create it, then it is ours and evidence may be written.
    try {
      fs.mkdirSync(ROOT, { recursive: false });
    } catch (e) {
      throw new Refusal('root-uncreatable', `${ROOT}: ${e.code || e.message}`);
    }
    ownership = { state: 'created', markerPath };
    step('root-created', ROOT);
  } else {
    // Pre-existing: adopt ONLY on a valid marker of our own. Never write a
    // marker into a directory we did not create.
    let markerRaw;
    try {
      const st = fs.lstatSync(markerPath);
      if (st.isSymbolicLink()) {
        throw new Refusal('marker-is-symlink', markerPath);
      }
      markerRaw = fs.readFileSync(markerPath, 'utf8');
    } catch (e) {
      if (e instanceof Refusal) throw e;
      throw new Refusal('unknown-existing-directory',
        `${ROOT} already exists and carries no ${ID.OWNERSHIP_MARKER}; ` +
        'refusing to claim a directory this pilot did not create');
    }
    let marker;
    try {
      marker = JSON.parse(markerRaw);
    } catch (e) {
      throw new Refusal('ownership-marker-unparseable', `${markerPath}: ${e.message}`);
    }
    if (marker.schema !== ID.SCHEMA ||
        marker.bundleId !== ID.BUNDLE_ID ||
        marker.productName !== ID.PRODUCT_NAME) {
      throw new Refusal('ownership-marker-mismatch',
        `${markerPath} does not identify this pilot ` +
        `(schema=${marker.schema} bundleId=${marker.bundleId})`);
    }
    ownership = { state: 'reused', markerPath, createdAt: marker.createdAt || null };
    step('root-ownership-validated', `${ROOT} (created ${marker.createdAt})`);
  }

  // ---- 4. canonical containment of the root ------------------------------
  let rootReal;
  try {
    rootReal = fs.realpathSync(ROOT);
  } catch (e) {
    throw new Refusal('root-unresolvable', `${ROOT}: ${e.code || e.message}`);
  }
  if (rootReal !== ROOT) {
    throw new Refusal('root-not-canonical',
      `${ROOT} resolves to ${rootReal}; refusing a relocated root`);
  }
  if (!(rootReal === appDataReal || rootReal.startsWith(appDataReal + path.sep))) {
    throw new Refusal('root-outside-appdata', `${rootReal} is not inside ${appDataReal}`);
  }
  step('root-canonical', rootReal);

  const inside = (p) => p === rootReal || p.startsWith(rootReal + path.sep);

  // ---- 5. children: create or validate, rejecting symlink escape ---------
  const childNames = ID.ISOLATED_PATHS.concat([ID.LOGS_DIR]);
  const childDirs = {};
  for (const name of childNames) {
    const dir = path.join(rootReal, name);
    let st = null;
    try {
      st = fs.lstatSync(dir);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw new Refusal('child-unstattable', `${dir}: ${e.code || e.message}`);
      }
    }
    if (st && st.isSymbolicLink()) {
      throw new Refusal('child-is-symlink', `${dir} is a symbolic link`);
    }
    if (st && !st.isDirectory()) {
      throw new Refusal('child-not-a-directory', `${dir} exists and is not a directory`);
    }
    if (!st) {
      try {
        fs.mkdirSync(dir, { recursive: false });
      } catch (e) {
        throw new Refusal('child-uncreatable', `${dir}: ${e.code || e.message}`);
      }
    }
    const real = fs.realpathSync(dir);
    if (real !== dir || !inside(real)) {
      throw new Refusal('child-escapes-root', `${dir} resolves to ${real}`);
    }
    childDirs[name] = real;
  }
  step('children-ready', childNames.join(', '));

  // ---- 6. ownership evidence (only now, in a directory we own) -----------
  if (ownership.state === 'created') {
    const marker = {
      schema: ID.SCHEMA,
      productName: ID.PRODUCT_NAME,
      bundleId: ID.BUNDLE_ID,
      packageName: ID.PACKAGE_NAME,
      pilotBuildId: opts.pilotBuildId || null,
      createdAt: new Date().toISOString(),
      note: 'Created by the Logseq OG F27 Pilot entry. Rollback tooling ' +
            'verifies this file before moving anything.',
    };
    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n');
    ownership.createdAt = marker.createdAt;
    step('ownership-marker-written', markerPath);
  }

  // ---- 7. apply the overrides, `home` first ------------------------------
  for (const name of ID.ISOLATED_PATHS) {
    app.setPath(name, childDirs[name]);
    step(`setPath:${name}`, childDirs[name]);
  }
  app.setAppLogsPath(childDirs[ID.LOGS_DIR]);
  step('setAppLogsPath', childDirs[ID.LOGS_DIR]);

  // ---- 8. seed OG's own configuration (belt and braces beside the guards) -
  const cfgPath = path.join(childDirs.userData, 'configs.edn');
  let seeded = false;
  if (!fs.existsSync(cfgPath)) {
    fs.writeFileSync(cfgPath, CONFIG_SEED);
    seeded = true;
  }
  step('configs.edn', seeded ? `seeded ${cfgPath}` : `left as found ${cfgPath}`);

  // ---- 9. verify by reading back, then refuse on any failure -------------
  const postOverride = snapshotPaths();
  const failures = [];

  // A path that cannot be read or resolved is a verification FAILURE, never an
  // exception: the caller must get a stated refusal and a written report, not a
  // stack trace. This matters most in exactly the case the plan flagged as its
  // contingency -- a platform that silently ignores setPath leaves `logs`
  // pointing at a directory that does not exist.
  const safeReal = (p) => {
    try { return fs.realpathSync(p); } catch (e) { return null; }
  };

  const checkContained = (name) => {
    const got = postOverride[name];
    if (typeof got !== 'string') {
      failures.push(`${name}: unreadable after override (${JSON.stringify(got)})`);
      return;
    }
    const real = safeReal(got);
    if (real === null) {
      failures.push(`${name}: ${got} could not be resolved after override`);
      return;
    }
    if (!inside(real)) failures.push(`${name}: ${real} is outside ${rootReal}`);
  };

  for (const name of ID.ISOLATED_PATHS) checkContained(name);
  checkContained('logs');

  // The point of the whole exercise: OG's dot-root must not be the real one.
  const homeAfter = postOverride.home;
  const dotRoot = path.join(String(homeAfter), '.logseq-og');
  const realDotRoot = path.join(realOsHome, '.logseq-og');
  if (!inside(dotRoot)) {
    failures.push(`derived dot-root ${dotRoot} is outside ${rootReal}`);
  }
  if (dotRoot === realDotRoot) {
    failures.push(`derived dot-root equals the real one (${realDotRoot})`);
  }
  if (String(homeAfter) === realOsHome) {
    failures.push(`home was not overridden (still ${realOsHome})`);
  }
  if (String(homeAfter) === preOverride.paths.home) {
    failures.push(`home is unchanged from its pre-override value`);
  }
  if (String(homeAfter) === os.homedir()) {
    failures.push(`home equals os.homedir() (${os.homedir()})`);
  }

  const audit = {};
  for (const name of ALL_PATH_NAMES) {
    const v = postOverride[name];
    audit[name] = {
      value: v,
      overridden: ID.ISOLATED_PATHS.includes(name) || name === 'logs',
      insideRoot: typeof v === 'string' ? inside(v) : null,
    };
  }

  const report = {
    schema: ID.SCHEMA,
    productName: ID.PRODUCT_NAME,
    bundleId: ID.BUNDLE_ID,
    pilotBuildId: opts.pilotBuildId || null,
    at: new Date().toISOString(),
    root: rootReal,
    ownership,
    realOsIdentity: {
      osUserInfoHome: preOverride.osUserInfoHome,
      osHomedir: preOverride.osHomedir,
      envHOME: preOverride.envHOME,
      appHomeBeforeOverride: preOverride.paths.home,
    },
    derived: { dotRoot, realDotRoot, dotRootIsolated: inside(dotRoot) },
    pathsBefore: preOverride.paths,
    pathsAfter: postOverride,
    audit,
    steps,
    refusedPaths: failures,
    ok: failures.length === 0,
  };

  if (failures.length) {
    // The root is established as ours, so recording the refusal here is safe.
    try {
      fs.writeFileSync(path.join(rootReal, ID.STARTUP_REPORT),
        JSON.stringify(report, null, 2) + '\n');
    } catch (e) { /* reported through the throw below regardless */ }
    throw new Refusal('path-verification-failed', failures.join('; '));
  }

  fs.writeFileSync(path.join(rootReal, ID.STARTUP_REPORT),
    JSON.stringify(report, null, 2) + '\n');

  return { root: rootReal, report, childDirs };
}

module.exports = { establish, Refusal, ALL_PATH_NAMES, CONFIG_SEED };
