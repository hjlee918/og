// Electron Forge configuration for the F28 SOURCE-PATH feature build.
//
// Identical in posture to `f27-pilot/src/pilot-forge.config.js` — no protocols,
// no signing, no notarization, no publishers, no makers, `prune: false` so
// packaging cannot reach the network — and different in exactly three places:
// the packaged name, the bundle id and the output directory, all of which
// belong to this feature build and must not collide with the accepted pilot's.
//
// Loaded by Electron Forge from the application directory it is copied into
// (`<clone>/static/forge.config.js`), never from this source location.
//   __dirname   <clone>/static
//   ..          <clone>                          (this checkout's root)
//   ../..       development/f27-inline-context   (the directory holding it —
//                                                 the F28 branch is cut in the
//                                                 SAME clone, on purpose)

const path = require('path')

const OUT_DIR = path.resolve(__dirname, '..', '..', 'out')

module.exports = {
  outDir: OUT_DIR,

  packagerConfig: {
    name: 'Logseq-OG-F28-RefPath',
    icon: './icons/pilot.icns',
    buildVersion: '92-f28refpath',
    appBundleId: 'com.logseq.logseq-og.f28refpath',
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
