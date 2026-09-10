'use strict';
//
// THE PLUGIN-LOADING DIAGNOSIS, STATED AS EXECUTABLE CLAIMS.
//
// The previous batch established that all three inventoried plugins enrol and
// then die with `handshake Timeout`, and left the cause open between two
// candidates inside the `lsp://` rewrite. These tests pin the answer, so that
// a later change cannot quietly move it:
//
//   * the dot-root detection (`iir`) is HEALTHY — the isolated build's
//     `dotConfigRoot` and the plugin's `localRoot` agree, including across a
//     path with spaces in it. Neither candidate condition is what fails;
//   * a THIRD condition, `!options.effect`, short-circuits in front of both,
//     and every inventoried plugin declares `"effect": true`;
//   * with that flag cleared the SHIPPED host does produce the intended
//     privileged `lsp://logseq.io/<id>/...` URL, so the rewrite itself and
//     `safetyPathJoin` are sound;
//   * the actual failure is the HOST RENDERER's origin, not the plugin's: a
//     `file://` parent serialises as `"null"` under this build's Electron and
//     `postMessage` rejects that, so Postmate's child can never reply;
//   * an `lsp://` parent completes the same handshake — and CANNOT load a
//     `file://` child, which is why the entry rewrite is required TOO and
//     neither half is a fix on its own.
//
// Nothing here launches the packaged or installed application, opens a graph,
// touches a profile, or runs plugin code.
//
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const H = require(path.join(__dirname, '..', 'checks', 'plugin-handshake.js'));
const REPO = H.REPO;

// A dot root shaped like the isolated build's real one — SPACES INCLUDED,
// because that is what `Application Support/Logseq OG F28 RefPath` contains and
// a prefix test is exactly the kind of code that a space is expected to break.
const DOT_ROOT = '/Users/probe/Library/Application Support/Logseq OG F28 RefPath/refpath-state/home/.logseq-og';
const PLUGIN_ID = 'logseq-readwise-official-plugin';
const PLUGIN_ROOT = `${DOT_ROOT}/plugins/${PLUGIN_ID}`;

/** The shipped plugin host: the packaged one if this checkout built it. */
function coreJs() {
  const packaged = path.join(REPO, 'out', 'Logseq-OG-F28-RefPath-darwin-x64',
                             'Logseq-OG-F28-RefPath.app', 'Contents', 'Resources', 'app',
                             'js', 'lsplugin.core.js');
  const staticOne = path.join(REPO, 'static', 'js', 'lsplugin.core.js');
  for (const p of [packaged, staticOne]) if (fs.existsSync(p)) return p;
  return null;
}

const BIN = H.electronBin(REPO);
const CORE = coreJs();

test('every inventoried plugin declares "effect": true, which is the flag that suppresses the rewrite', () => {
  const root = path.join(REPO, '..', '..', '..', 'generated', 'og-baseline', '2026-09-03-v5-01',
                         'profiles', 'plugin-all', 'home', '.logseq-og', 'plugins');
  if (!fs.existsSync(root)) return; // artifacts not retained in this clone
  const got = H.manifestEffects(root);
  const ids = Object.keys(got);
  assert.ok(ids.length >= 3, `expected the three inventoried plugins, saw ${ids.join(', ')}`);
  for (const [id, m] of Object.entries(got)) {
    assert.strictEqual(m.effect, true,
      `${id} was expected to declare effect:true — the diagnosis rests on it`);
    assert.match(m.main, /\.html$/, `${id} entry should be an html entry, saw ${m.main}`);
  }
});

test('the shipped host: iir is TRUE, and `effect` alone decides whether the lsp:// URL is produced',
  { skip: !BIN ? 'no Electron in this checkout' : (!CORE ? 'no lsplugin.core.js built' : false) },
  () => {
    const r = H.resolveEntry({ coreJs: CORE, dotRoot: DOT_ROOT, pluginRoot: PLUGIN_ROOT, bin: BIN });
    assert.ok(r.coreLoaded, `the plugin host bundle did not load: ${r.error || ''}`);
    assert.strictEqual(r.cases.length, 2);
    const [withEffect, withoutEffect] = r.cases;

    // The dot-root detection is not the fault, in either case, spaces and all.
    for (const c of r.cases) {
      assert.strictEqual(c.iir, true,
        'isInstalledInDotRoot must be true for a plugin under the dot root');
      assert.strictEqual(c.dotPluginsRoot, `${DOT_ROOT}/plugins`);
      assert.strictEqual(c.localRoot, PLUGIN_ROOT);
    }

    // effect:true — the state every real plugin is in today.
    assert.strictEqual(withEffect.manifestEffect, true);
    assert.strictEqual(withEffect.entry, `file://${PLUGIN_ROOT}/dist/index.html`,
      'with effect:true the entry is expected to stay a file:// URL');

    // effect:false — the rewrite and safetyPathJoin are sound.
    assert.strictEqual(withoutEffect.manifestEffect, false);
    assert.strictEqual(withoutEffect.entry, `lsp://logseq.io/${PLUGIN_ID}/dist/index.html`,
      'with effect cleared the host must produce the intended privileged URL');
    assert.strictEqual(withoutEffect.lsr, `lsp://logseq.io/${PLUGIN_ID}/`);
  });

test('the handshake dies on the HOST RENDERER origin, and only an lsp:// parent survives it',
  { skip: !BIN ? 'no Electron in this checkout' : false },
  () => {
    const r = H.originMatrix({ bin: BIN });
    const by = Object.fromEntries(r.results.map((x) => [x.label, x]));

    // 1. Today's configuration: file:// parent, file:// child.
    const a = by['file-parent/file-child'];
    assert.strictEqual(a.parentOrigin, 'file://', 'a file page still reports origin "file://" to itself');
    assert.ok(a.handshakeDelivered, 'the child must have been reached at all');
    assert.strictEqual(a.reply.seenParentOrigin, 'null',
      `the child is expected to see the parent origin as the string "null" under Electron ${r.electron}`);
    assert.match(a.reply.replyErr || '', /Invalid target origin 'null'/,
      'the reply to that origin must be rejected — this is the production failure, verbatim');

    // 2. Rewriting ONLY the plugin entry does not help: same parent, same null.
    const b = by['file-parent/lsp-child'];
    assert.strictEqual(b.reply.seenParentOrigin, 'null',
      'an lsp:// child still sees a null parent origin — the entry rewrite alone is not a fix');
    assert.match(b.reply.replyErr || '', /Invalid target origin 'null'/);

    // 3. Serving the parent over the privileged standard scheme is what fixes it.
    const c = by['lsp-parent/lsp-child'];
    assert.strictEqual(c.reply.seenParentOrigin, 'lsp://logseq.com');
    assert.strictEqual(c.reply.replyErr, null,
      'an lsp:// parent gives the child a real origin to reply to');

    // 4. ...and it forces the entry rewrite, because a standard+secure document
    //    may not load a file:// child at all.
    const d = by['lsp-parent/file-child'];
    assert.strictEqual(d.childLoaded, false,
      'an lsp:// parent must NOT be able to load a file:// child');
    assert.ok(d.blocked.length > 0, 'and Chromium should say so explicitly');
  });
