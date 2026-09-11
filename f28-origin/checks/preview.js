'use strict';
// Owned offline preview supervisor. No detached/unrecorded watcher and no timeout.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {execFileSync}=require('child_process');
const APP=require('../../f28-refpath/checks/packaged-app');
const FP=require('../../f28-refpath/checks/fresh-profile');
const PA=require('../../f28-refpath/checks/plugin-artifacts');
const RJ=require('../../f28-refpath/checks/reference-journey');
const RD=require('../../f28-refpath/checks/reforder-read');
const CG=require('../../f28-refpath/checks/make-reforder-graph');
const B=require('../../f27-pilot/checks/allowed-root');
const GH=require('../../f27-pilot/checks/graph-hash');
const OP=require('../../f27-pilot/checks/owned-process');
const REC=require('../../f28-refpath/checks/recorder');
const EC=require('../../f27-inline/checks/error-classifier');
const NOISE=require('../../f28-refpath/checks/browser-noise');
const NET=require('./network-refusal');
const XA=require('./experiment-assertions');
const {_electron}=require('../../node_modules/playwright');
const EVIDENCE=path.resolve(__dirname,'../../../evidence');
const ACTIVE=path.join(EVIDENCE,'origin-preview-active.json');
const TITLE='OFFLINE PREVIEW · 오프라인 미리보기 · Readwise';
const PLUGIN='logseq-readwise-official-plugin';
function assert(v,m){if(!v)throw Error(m);}
function save(file,value){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n');fs.renameSync(tmp,file);}
function runningPackage(exe){return execFileSync('ps',['-axo','pid=,comm='],{encoding:'utf8'}).split('\n').filter(s=>s.includes(exe));}
async function restoreAfterExit(handle,owned,alive,restore){
  assert(!owned.some(alive),'Profile restoration refused: owned application process still alive');
  return restore(handle,{label:'offline-preview'});
}
function packageIdentity(){
  const b=NET.assertReady(),m=b.preflight.manifest;
  assert(m.pilotBuildId==='2026-09-11T22-07-22-370Z-4750cad0','Wrong preview build');
  assert(m.builtFrom.commit==='87b811663a298cb5a6ae4d4f73836a9ebc45a2a9'&&!m.builtFrom.dirty,'Wrong preview source');
  assert(process.arch==='arm64'&&m.host?.platform==='darwin'&&m.host?.arch==='arm64','Wrong preview architecture');
  const hash=crypto.createHash('sha256').update(fs.readFileSync(path.join(b.resApp,'origin-experiment-build-manifest.json'))).digest('hex');
  assert(hash==='8a3e818e851f7d3f6cce05cfb922198c5a7fe51f8d00a0cab784e5bd9d30dc23','Manifest changed');
  return b;
}
async function start({smokeClose=false}={}){
  const built=packageIdentity();
  assert(!runningPackage(built.exe).length,'Existing experimental process: no profile changes allowed');
  fs.mkdirSync(EVIDENCE,{recursive:true});
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const file=path.join(EVIDENCE,'origin-preview-'+stamp+'.json');
  const closeFile=file+'.close';
  const lease={schema:'origin-preview/1',supervisorPid:process.pid,evidence:file,closeFile};
  fs.writeFileSync(ACTIVE,JSON.stringify(lease,null,2),{flag:'wx'});
  const out={...lease,stamp,status:'preparing',build:built.preflight.manifest.pilotBuildId,
    productSource:built.preflight.manifest.builtFrom,checks:[],title:TITLE,noInspectionTimeout:true};
  let handle,session,seed,graph,before,pluginBefore,settingsFile;
  let requestClose=false;
  const signal=()=>{requestClose=true;};
  process.on('SIGTERM',signal);process.on('SIGINT',signal);
  const record=(id,title,ok,detail)=>{out.checks.push({id,title,ok,detail});save(file,out);console.log((ok?'PASS ':'FAIL ')+id+' '+title);assert(ok,title);};
  const errors=REC.createRecorder();
  try{
    handle=FP.swapAside(built.identity,{stamp});out.profile=handle;save(file,out);
    // Let the unchanged application establish its ownership marker before placement.
    seed=await NET.launchWith(o=>_electron.launch(o))({executablePath:built.exe,timeout:120000});
    const seedPid=seed.process().pid,seedTree=OP.descendants(seedPid);
    out.seed={pid:seedPid,owned:seedTree};save(file,out);
    await seed.firstWindow();FP.assertOurs(handle.root,built.identity);
    out.seed.cleanup=await APP.close({app:seed,appPid:seedPid,ownedTree:seedTree});seed=null;
    assert(!out.seed.cleanup.stillAlive.length,'Seed process remains');
    const plugins=FP.pluginsDirIn(handle.root);
    out.artifact=PA.installInto(plugins,[PLUGIN]).installed;
    const settings=path.join(handle.root,'home','.logseq-og','settings');fs.mkdirSync(settings,{recursive:true});
    settingsFile=path.join(settings,PLUGIN+'.json');
    // Disable plugin automatic polling in addition to unconditional startup refusal.
    // No token field; original defaults/previous settings are never imported.
    fs.writeFileSync(settingsFile,JSON.stringify({isLoadAuto:false,isResyncDeleted:false}),{flag:'wx'});
    out.settingsBeforeActivation={isLoadAuto:false,isResyncDeleted:false};
    pluginBefore=PA.snapshot(plugins);
    graph=B.assertInsideAllowedRoot('fresh preview graph',CG.build({kind:'offline-readwise-preview'}).graph);
    XA.placeAssetProbe(graph);
    const anchor=B.assertInsideAllowedRoot('preview instructions',path.join(graph,'pages',CG.ANCHOR+'.md'));
    fs.appendFileSync(anchor,'\n- **OFFLINE PREVIEW / 오프라인 미리보기** — Synthetic examples only / 예제 전용\n- Readwise import and sync are disabled. / Readwise 가져오기·동기화는 비활성화되어 있습니다.\n- Below: Linked References / 연결된 참조 — compare source paths and child context. / 출처 경로와 하위 문맥을 살펴보세요.\n- Close with Command-Q or the documented close command. / Command-Q 또는 안내된 종료 명령으로 닫으세요.\n');
    before=GH.snapshot(graph);out.graph=graph;out.baseline=before;save(file,out);
    const bad=path.join(path.dirname(B.allowedRootReal()),'f28-preview-inert-probe');
    session=await APP.open({built,graph,bad,errors,record,phase:(n,o)=>errors.phase(n,o),say:console.log,
      deps:{launch:NET.launchWith(o=>_electron.launch(o))}});
    out.appPid=session.appPid;out.ownedProcesses=session.ownedTree;save(file,out);
    out.isolation=await session.app.evaluate(({app})=>({userData:app.getPath('userData'),sessionData:app.getPath('sessionData')}));
    record('P1','Actual isolated profile paths',Object.values(out.isolation).every(p=>p.startsWith(handle.root+path.sep)),out.isolation);
    out.network=await NET.read(session.app);record('P2','Startup refusal active',out.network?.active&&out.network.sessions>=1,out.network);
    const live=async()=>{
      const r=await session.page.evaluate(()=>({api:window.logseq?.api?.get_current_graph?.(),liveRepo:window.frontend?.state?.get_current_repo?.()}));
      const v=APP.currentGraphVerdict({...r,approved:graph,allowedRoot:B.allowedRootReal()});assert(v.ok,'LIVE graph changed');out.liveGraph=v;
    };
    await live();
    const j=RJ.create({page:session.page,session,CG,say:console.log});
    errors.phase('plugin-host','observe-readwise');await OP.sleep(10000);out.plugin=await j.pluginState();
    record('P3','Readwise-only handshake, loaded state and actual UI',out.plugin.registered?.length===1&&out.plugin.registered[0]===PLUGIN&&out.plugin.plugins[0]?.loaded&&out.plugin.injectedUiNodes>0,out.plugin);
    const settingsNow=JSON.parse(fs.readFileSync(settingsFile));
    record('P4','Automatic import disabled and no credential',settingsNow.isLoadAuto===false&&!Object.entries(settingsNow).some(([k,v])=>/token|secret|password|api.?key/i.test(k)&&v),{isLoadAuto:settingsNow.isLoadAuto,credentialsPresent:false});
    await live();errors.phase('reference-preview','short-reference-journey');
    await session.goTo(CG.ANCHOR);await j.settle('preview');out.references=await RD.read(session.page);
    record('P5','Complete synthetic reference overview',out.references.present&&out.references.groups.length===8&&out.references.rows.length===22,
      {groups:out.references.groups.length,rows:out.references.rows.length});
    const originalOrder=RD.orderOf(out.references),originalInside=RD.insideOf(out.references);
    const liveTitles=out.references.groups.map(x=>({ref:x.ref,title:x.title}));
    const expectedAsc=CG.orderTitles(liveTitles,'title-asc').map(x=>x.ref);
    const expectedDesc=CG.orderTitles(liveTitles,'title-desc').map(x=>x.ref);
    const ascPick=await j.chooseOrder('title-asc');await j.settle('title ascending');const asc=await RD.read(session.page);
    const descPick=await j.chooseOrder('title-desc');await j.settle('title descending');const desc=await RD.read(session.page);
    const backPick=await j.chooseOrder('original');await j.settle('original restored');const back=await RD.read(session.page);
    const insideDiffs=(reading)=>{const got=RD.insideOf(reading);return [...new Set([...Object.keys(originalInside),...Object.keys(got)])]
      .filter(ref=>JSON.stringify(got[ref])!==JSON.stringify(originalInside[ref]));};
    out.ordering={original:originalOrder,expected:{ascending:expectedAsc,descending:expectedDesc},
      ascending:RD.orderOf(asc),descending:RD.orderOf(desc),restored:RD.orderOf(back),
      picks:{ascending:ascPick,descending:descPick,restored:backPick},
      insideDiffs:{ascending:insideDiffs(asc),descending:insideDiffs(desc),restored:insideDiffs(back)}};
    record('P5A','Ordering and child structure',Object.values(out.ordering.picks).every(x=>x.changed)&&
      JSON.stringify(out.ordering.ascending)===JSON.stringify(expectedAsc)&&JSON.stringify(out.ordering.descending)===JSON.stringify(expectedDesc)&&
      JSON.stringify(out.ordering.restored)===JSON.stringify(originalOrder)&&Object.values(out.ordering.insideDiffs).every(x=>x.length===0),out.ordering);
    let ds=await j.disclosureState();const id=Object.keys(ds.byId).find(k=>ds.byId[k].control);assert(id,'No context control');
    const ctrl=ds.byId[id];assert((await j.focusControl(ctrl.controlId)).ok,'Cannot focus context');
    await session.page.keyboard.press('Enter');await OP.sleep(1500);
    record('P6','Keyboard child-context disclosure',(await j.disclosureState()).byId[id].open!==ctrl.open);
    await session.page.keyboard.press('Enter');await OP.sleep(1000);
    const pathControl=session.page.locator('.f28-path-toggle').first();await pathControl.click();await OP.sleep(1000);
    record('P7','Source-path disclosure',(await j.disclosureState()).paths.some(p=>p.open));await pathControl.click();
    await j.setLanguage('ko');await OP.sleep(2500);out.koreanLabels=await j.readLabels();
    record('P8','Korean reference controls',/[가-힣]/.test(out.koreanLabels.ctxOpen)&&/[가-힣]/.test(out.koreanLabels.orderLabel),out.koreanLabels);
    await session.goTo(CG.ALIAS);await live();await session.goTo(CG.ANCHOR);await j.settle('starting page');
    out.asset=await XA.probeAsset(session.page,path.join(graph,'assets','f28-origin-probe.png'));record('P9','Local asset',out.asset.loaded,out.asset);
    out.integrity=GH.compare(before,GH.snapshot(graph));record('P10','Generated graph content unchanged',!out.integrity.content.length,out.integrity);
    record('P11','Plugin artifact unchanged',!PA.compareSnapshots(pluginBefore,PA.snapshot(plugins)).length);
    const cls=EC.summarise(errors.entries(),{outsidePath:bad,graphPath:graph,phases:errors.phases()});
    const split=NOISE.partition(cls.unexpected,errors.entries(),await session.collectErrorEvidence());
    out.errors={entries:errors.entries(),expected:cls.expected,remaining:split.remaining,strictPassed:split.remaining.length===0};
    // Do not reclassify startup failures or silently erase previous strict failures.
    out.historicalStrictFailuresRetained=true;
    await live();
    // Remove the folder-dialog test stub before inspection. Normal dialogs remain guarded.
    await session.app.evaluate(({dialog,BrowserWindow},title)=>{
      if(global.__pilotOrigShowOpenDialog){dialog.showOpenDialog=global.__pilotOrigShowOpenDialog;delete global.__pilotOrigShowOpenDialog;delete global.__pilotDialogPath;}
      for(const w of BrowserWindow.getAllWindows()){w.setTitle(title);w.show();w.focus();}
    },TITLE);
    await session.parkPointer();
    await session.page.keyboard.press('Escape');
    await session.page.evaluate(()=>{for(const e of document.querySelectorAll('*')){if(e._tippy)e._tippy.hide();}const m=document.querySelector('#main-content-container');if(m)m.scrollTop=0;window.scrollTo(0,0);});
    await OP.sleep(1500);
    await session.page.screenshot({path:file+'.png'});
    errors.phase('user-inspection','no-scripted-interactions');
    out.status='open-for-inspection';out.startPage=CG.ANCHOR;save(file,out);console.log('PREVIEW READY '+file);
    if(smokeClose)requestClose=true;
    // This supervisor is named in the lease and evidence; no timeout closes inspection.
    while(session.app.process().exitCode===null&&session.app.process().signalCode===null&&!requestClose&&!fs.existsSync(closeFile))await OP.sleep(1000);
  }catch(e){out.error=e.message;out.status='failed';process.exitCode=1;console.error(e.stack);}
  finally{
    try{
      if(seed){const pid=seed.process().pid;out.seedFailureCleanup=await APP.close({app:seed,appPid:pid,ownedTree:OP.descendants(pid)});}
      if(session)out.cleanup=await APP.close(session,{say:console.log});
      const owned=[...(out.ownedProcesses||[]),...(out.seed?.owned||[])];
      assert(!runningPackage(built.exe).length,'Package still running: preservation remains pending');
      if(handle)out.restoration=await restoreAfterExit(handle,owned,OP.alive,FP.restore);
      if(graph&&before)out.finalIntegrity=GH.compare(before,GH.snapshot(graph));
      out.finalErrorEntries=errors.entries();
      out.status=out.error?'failed-closed':'closed';
      if(out.restoration&&!out.restoration.ok)throw Error('Profile restoration needs review');
      fs.unlinkSync(ACTIVE);
    }catch(e){out.cleanupError=e.message;out.status='cleanup-pending';process.exitCode=1;}
    out.closedAt=new Date().toISOString();save(file,out);console.log('PREVIEW '+out.status+' '+file);
    process.removeListener('SIGTERM',signal);process.removeListener('SIGINT',signal);
  }
}
function closeRequest(){
  const lease=JSON.parse(fs.readFileSync(ACTIVE));
  assert(lease.schema==='origin-preview/1'&&path.dirname(lease.evidence)===EVIDENCE&&lease.closeFile===lease.evidence+'.close','Invalid preview lease');
  assert(OP.alive(lease.supervisorPid),'Supervisor absent: preserve state; manual owned-process review required');
  fs.writeFileSync(lease.closeFile,'User requested preview close\n',{flag:'a'});console.log('Close requested; supervisor will restore only after the app exits. '+lease.evidence);
}
if(require.main===module){const cmd=process.argv[2];if(cmd==='close')closeRequest();else if(cmd==='start'||cmd==='smoke-close')start({smokeClose:cmd==='smoke-close'}).catch(e=>{console.error(e.stack);process.exitCode=1;});else throw Error('Use start, close, or smoke-close');}
module.exports={restoreAfterExit,packageIdentity};
