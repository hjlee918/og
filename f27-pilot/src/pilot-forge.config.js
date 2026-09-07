// Electron Forge configuration for the isolated *Logseq OG F27 Pilot* build.
//
// This is a purpose-written pilot configuration rather than a patch of
// `resources/forge.config.js`, because the differences that matter are
// removals, and a removal is easier to review as an absence than as a diff:
//
//   * no `protocols` entry, so the bundle declares no CFBundleURLTypes and
//     cannot be offered by the OS as a handler for `logseq-og:`. This is the
//     second layer only; the first is guard G1 in electron/core.cljs, which
//     never calls setAsDefaultProtocolClient at all.
//   * no `osxSign` and no `osxNotarize`. The upstream configuration hard-codes
//     a Developer ID this machine does not hold (`security find-identity -v -p
//     codesigning` reports 0 valid identities), so packaging would fail with it
//     in place. The pilot is an unsigned local build and is never installed,
//     distributed or moved to another machine.
//   * no `publishers`, and no makers: this configuration is only ever used
//     through `electron-forge package`, never `make` and never `publish`.
//
// `prune: false` because pruning shells out to the package manager, which can
// reach the network and would mutate the checkout. The `ignore` list removes
// the build-only dependencies that pruning would otherwise have handled.
// NOTE: Forge spreads packagerConfig over its own defaults, so providing
// `ignore` replaces Forge's default `[/^\/out\//]` -- it is repeated below.

const path = require('path')

// This file is loaded by Electron Forge from the application directory it is
// copied into -- `<clone>/static/forge.config.js` -- never from its tracked
// source location. `scripts/build-pilot.js` copies it there and
// `scripts/package-pilot.js` asserts the resolved outDir before packaging, so a
// wrong location fails loudly instead of writing the app somewhere unexpected.
//   __dirname            <clone>/static
//   ..                   <clone>            (the pilot clone's repo root)
//   ../..                <clone>/..         (development/f27-pilot)
const OUT_DIR = path.resolve(__dirname, '..', '..', 'out')

module.exports = {
  // Packaged app lands beside the clone, never inside it.
  outDir: OUT_DIR,

  packagerConfig: {
    name: 'Logseq-OG-F27-Pilot',
    icon: './icons/pilot.icns',
    buildVersion: '92-f27pilot',
    appBundleId: 'com.logseq.logseq-og.f27pilot',
    appCategoryType: 'public.app-category.productivity',
    prune: false,
    ignore: [
      '^/out/',
      // Build-only toolchain. None of these is a runtime dependency of the
      // main process; the runtime dependencies in package.json are kept.
      '^/node_modules/electron($|/)',
      '^/node_modules/electron-builder($|/)',
      '^/node_modules/electron-forge-maker-appimage($|/)',
      '^/node_modules/@electron/',
      '^/node_modules/@electron-forge/',
      '^/node_modules/\\.bin($|/)',
      '^/node_modules/\\.cache($|/)',
    ],
  },

  makers: [],
  publishers: [],
}
