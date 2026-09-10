'use strict';
// First-party, experiment-only. Install synchronously before requiring OG.
// No URL, host, path, options, headers, bodies or credentials enter the log.
const VERSION = 'f28-origin-network/1';
function install(electron) {
  const {app, session, webContents, ipcMain, shell, net} = electron;
  if (app.isReady() || webContents.getAllWebContents().length) throw Error('network bootstrap too late');
  const evidence = {version: VERSION, active: false, allowed: 0, totalRefused: 0, refused: [], sessions: 0, navigations: 0};
  const sessions = new WeakSet();
  function deny(kind) {
    evidence.totalRefused++;
    if (evidence.refused.length < 100) evidence.refused.push({kind});
    return Object.assign(Error('Origin experiment refused: ' + kind), {code: 'ERR_ORIGIN_NETWORK_REFUSED'});
  }
  function lock(obj, key, value) {
    if (typeof obj[key] !== 'function') throw Error('missing control: ' + key);
    Object.defineProperty(obj, key, {value, writable: false, configurable: false});
    if (obj[key] !== value) throw Error('failed control: ' + key);
  }
  function refuse(obj, keys, prefix) {
    for (const key of keys) lock(obj, key, () => { throw deny(prefix + '.' + key); });
  }
  // node-fetch uses http(s).request. Lock before its module is evaluated.
  for (const name of ['http', 'https']) refuse(require(name), ['request', 'get'], name);
  refuse(require('net').Socket.prototype, ['connect'], 'node-socket');
  refuse(require('dgram'), ['createSocket'], 'node-datagram');
  if (global.fetch) lock(global, 'fetch', async () => { throw deny('node-fetch-global'); });
  refuse(net, ['request', 'fetch'], 'electron-net');
  refuse(shell, ['openExternal', 'openPath', 'showItemInFolder'], 'shell');
  // Includes the `open` dependency's browser/service-launch path.
  refuse(require('child_process'), ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'], 'child-process');
  if (electron.utilityProcess) refuse(electron.utilityProcess, ['fork'], 'utility-process');
  const blocked = new Set(['httpRequest', 'httpFetchJSON', 'runCli', 'runGit',
    'runGitWithinCurrentGraph', 'installMarketPlugin', 'updateMarketPlugin', 'relaunchApp', 'quitAndInstall',
    'set-env', 'fetch-remote-files', 'update-local-files', 'download-version-files',
    'delete-remote-files', 'update-remote-files', 'server/do', 'server/set-config']);
  ipcMain.handle('origin-experiment-refuse', () => { throw deny('preload-external'); });
  const originalHandle = ipcMain.handle.bind(ipcMain);
  lock(ipcMain, 'handle', (channel, fn) => originalHandle(channel, (event, ...args) => {
    if (['call-application', 'check-for-updates', 'install-updates'].includes(channel) ||
        (channel === 'main' && blocked.has(args[0] && args[0][0]))) throw deny('ipc-service');
    return fn(event, ...args);
  }));
  function local(url) {
    try {
      const u = new URL(url);
      // Canonical file containment is enforced by existing G5 protocol handlers.
      // Raw file resources are refused, never passed to Chromium's file loader.
      return (u.protocol === 'lsp:' && ['logseq.com', 'logseq.io'].includes(u.hostname) && !u.username && !u.password && !u.port) ||
        u.protocol === 'assets:' || u.protocol === 'data:' || u.protocol === 'blob:' || url === 'about:blank';
    } catch (_) { return false; }
  }
  function installSession(s) {
    if (sessions.has(s)) return;
    const wr = s.webRequest;
    wr.onBeforeRequest({urls: ['<all_urls>']}, (d, cb) => {
      const allowed = local(d.url);
      if (allowed) evidence.allowed++; else deny('chromium-request');
      cb({cancel: !allowed});
    });
    lock(wr, 'onBeforeRequest', () => { throw deny('replace-request-control'); });
    s.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    s.setPermissionCheckHandler(() => false);
    sessions.add(s); evidence.sessions++;
  }
  const fatal = () => { evidence.active = false; app.exit(78); throw Error('network installation incomplete'); };
  app.on('session-created', s => { try { installSession(s); } catch (_) { fatal(); } });
  app.prependOnceListener('ready', () => {
    try { installSession(session.defaultSession); evidence.active = true; } catch (_) { fatal(); }
  });
  app.on('web-contents-created', (_event, wc) => {
    if (!evidence.active || !sessions.has(wc.session)) fatal();
    const noOpen = () => { deny('window-open'); return {action: 'deny'}; };
    wc.setWindowOpenHandler(noOpen);
    lock(wc, 'setWindowOpenHandler', () => wc); // later application setup cannot replace refusal
    wc.on('will-navigate', (ev, url) => { if (!local(url)) { ev.preventDefault(); deny('navigation'); } });
    wc.on('will-attach-webview', ev => { ev.preventDefault(); deny('webview'); });
    wc.on('did-start-navigation', () => { if (!evidence.active) fatal(); evidence.navigations++; });
  });
  global.__expNet = evidence;
  return evidence;
}
module.exports = {VERSION, install};
