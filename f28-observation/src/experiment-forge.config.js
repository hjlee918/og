const path = require('path')

module.exports = {
  outDir: path.resolve(__dirname, '..', '..', 'out-f28-observation'),
  packagerConfig: {
    name: 'Logseq-OG-F28-Observation',
    icon: './icons/pilot.icns',
    buildVersion: '92-f28observation',
    appBundleId: 'com.logseq.logseq-og.f28observation',
    appCategoryType: 'public.app-category.productivity',
    prune: false,
    electronZipDir: process.env.F28_OBSERVATION_ELECTRON_ZIP_DIR,
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
