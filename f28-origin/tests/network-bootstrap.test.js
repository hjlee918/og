'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const REPO = path.resolve(__dirname, '../..');
const bin = require(path.join(REPO, 'node_modules/electron'));
const bootstrap = path.join(REPO, 'f28-origin/src/network-bootstrap.js');
function run(fail) {
  // Refuse before spawning if static/ is an ordinary or stale experimental build.
  assert.match(fs.readFileSync(path.join(REPO,'static/js/preload.js'),'utf8'), /origin-experiment-refuse/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f28-origin-net-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({main:'main.js'}));
  fs.writeFileSync(path.join(dir, 'local.html'), '<html><body>LOCAL_OK</body></html>');
  fs.writeFileSync(path.join(dir, 'main.js'), `
const fs = require('fs');
const e = require('electron');
e.app.setPath('userData', ${JSON.stringify(dir)} + '/profile');
e.app.setPath('sessionData', ${JSON.stringify(dir)} + '/session');
e.protocol.registerSchemesAsPrivileged([{scheme:'lsp',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
if (${JSON.stringify(fail)} === 'session') e.app.on('session-created', s => Object.defineProperty(s.webRequest,'onBeforeRequest',{value:()=>{throw Error('synthetic install failure')},configurable:false,writable:false}));
if (${JSON.stringify(fail)} === true) Object.defineProperty(e.net, 'request', {value:e.net.request,writable:false,configurable:false});
try { require(${JSON.stringify(bootstrap)}).install(e); } catch (_) { e.app.exit(78); }
e.app.on('window-all-closed', () => {});
e.app.on('ready', async () => {
 try {
  e.ipcMain.handle('main', () => 'UNBLOCKED');
  const r = {activeBeforeWindow:global.__expNet.active, probes:[]};
  async function probe(name, fn) { try { await fn(); r.probes.push({name,refused:false}); } catch (_) { r.probes.push({name,refused:true}); } }
  await probe('http', () => require('http').get('http://127.0.0.1:9/synthetic'));
  await probe('node-fetch', () => require(${JSON.stringify(path.join(REPO,'static/node_modules/node-fetch'))})('https://example.invalid/synthetic'));
  await probe('electron-net', () => e.net.fetch('https://example.invalid'));
  await probe('shell', () => e.shell.openExternal('https://example.invalid'));
  await probe('child-process', () => require('child_process').spawn('synthetic-no-command'));
  for (const partition of ['', 'synthetic-other']) {
   const s = e.session.fromPartition(partition);
   const proxyBefore=global.__expNet.totalRefused;
   const proxy=await s.resolveProxy('https://example.invalid/synthetic');
   await s.setProxy({mode:'pac_script',pacScript:'https://example.invalid/synthetic.pac'});
   await s.forceReloadProxyConfig();
   r.probes.push({name:'proxy-native-'+partition,refused:proxy==='DIRECT' && global.__expNet.totalRefused===proxyBefore+3});
   s.protocol.registerFileProtocol('lsp', (req, cb) => cb({path:${JSON.stringify(dir)} + '/local.html'}));
   const w = new e.BrowserWindow({show:false,webPreferences:{session:s,sandbox:false,nodeIntegration:false,contextIsolation:true,preload:${JSON.stringify(path.join(REPO,'static/js/preload.js'))}}});
   await w.loadURL('lsp://logseq.com/local.html');
   r.probes.push({name:'local-'+partition,usable:(await w.webContents.executeJavaScript('document.body.textContent'))==='LOCAL_OK'});
   for (const url of ['https://example.invalid/synthetic','http://127.0.0.1:54321/synthetic']) {
    const before=global.__expNet.totalRefused;
    const refused=await w.webContents.executeJavaScript("fetch("+JSON.stringify(url)+").then(()=>false,()=>true)");
    r.probes.push({name:'renderer-'+partition,refused:refused && global.__expNet.totalRefused>before});
   }
   const wsBefore=global.__expNet.totalRefused;
   const wsRefused=await w.webContents.executeJavaScript("new Promise(r=>{const s=new WebSocket('ws://127.0.0.1:54321/synthetic');s.onerror=()=>r(true);s.onopen=()=>{s.close();r(false)};setTimeout(()=>r(false),1500)})");
   r.probes.push({name:'websocket-'+partition,refused:wsRefused && global.__expNet.totalRefused>wsBefore});
   for (const op of ['httpRequest','httpFetchJSON','runCli','fetch-remote-files']) {
    r.probes.push({name:op,refused:await w.webContents.executeJavaScript("window.apis.doAction(["+JSON.stringify(op)+"]).then(()=>false,()=>true)")});
   }
   r.probes.push({name:'preload-external',refused:await w.webContents.executeJavaScript("window.apis.openExternal('https://example.invalid').then(()=>false,()=>true)")});
   w.destroy();
  }
  for(let i=0;i<105;i++) { try { e.shell.openExternal('https://example.invalid/synthetic'); } catch (_) {} }
  r.evidence=global.__expNet;
  fs.writeFileSync(${JSON.stringify(path.join(dir,'result.json'))},JSON.stringify(r));
  e.app.exit(0);
 } catch (error) { console.error(error.message); e.app.exit(79); }
});
`);
  const p = spawnSync(bin,[dir],{timeout:30000,encoding:'utf8',env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'1'}});
  return {dir,status:p.status,error:p.error && p.error.message,stderr:p.stderr,result:fs.existsSync(path.join(dir,'result.json'))?JSON.parse(fs.readFileSync(path.join(dir,'result.json'))):null};
}
test('real Electron: bootstrap before navigation, main/renderer refusal, two sessions, local resources', () => {
 const r=run(false); assert.equal(r.status,0,JSON.stringify(r));
 assert.equal(r.result.activeBeforeWindow,true);
 for(const p of r.result.probes) assert.equal(p.refused ?? p.usable,true,p.name);
 assert.equal(r.result.evidence.sessions,2);
 assert.ok(r.result.evidence.totalRefused>100);
 assert.equal(r.result.evidence.refused.length,100);
 assert.ok(!JSON.stringify(r.result.evidence).includes('example.invalid'));
});
test('real Electron: incomplete install exits before any window or activation', () => {
 const r=run(true); assert.equal(r.status,78,JSON.stringify(r)); assert.equal(r.result,null);
});

test('real Electron: session installation failure exits before the first window', () => { const r=run('session'); assert.equal(r.status,78,JSON.stringify(r)); assert.equal(r.result,null); });
