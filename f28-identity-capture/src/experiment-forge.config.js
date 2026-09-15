const path = require('path')

// Same packaging rules as the observation build: no makers, no publishers, no
// signing, local Electron archive only, and its own out directory so no
// existing package can be overwritten.
module.exports = {
  outDir: path.resolve(__dirname, '..', '..', 'out-f28-identity-capture'),
  packagerConfig: {
    name: 'Logseq-OG-F28-IdentityCapture',
    icon: './icons/pilot.icns',
    buildVersion: '92-f28identitycapture',
    appBundleId: 'com.logseq.logseq-og.f28identitycapture',
    appCategoryType: 'public.app-category.productivity',
    prune: false,
    electronZipDir: process.env.F28_IDENTITY_CAPTURE_ELECTRON_ZIP_DIR,
    ignore: [
      '^/out/',
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