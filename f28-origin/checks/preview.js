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
const EXISTING_TITLE='INTEL DISPOSABLE GRAPH · 인텔 폐기용 그래프 · OFFLINE';
const PLUGIN='logseq-readwise-official-plugin';
function assert(v,m){if(!v)throw Error(m);}
function save(file,value){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n');fs.renameSync(tmp,file);}
function runningPackage(exe){return execFileSync('ps',['-axo','pid=,comm='],{encoding:'utf8'}).split('\n').filter(s=>s.includes(exe));}
function redactExistingGraphErrors(rows){
  return rows.map(({kind,phase,operation,seq,text})=>({
    kind,phase,operation,seq,
    category:/ERR_BLOCKED_BY_CLIENT/.test(text)?'blocked-resource':
      /outside every permitted root/.test(text)?'expected-boundary-refusal':
      /frontend\.handler\.web\.nfs/.test(text)?'filesystem-handler':
      'other-runtime-error',
    textSha256:crypto.createHash('sha256').update(String(text)).digest('hex'),
    textRedacted:true,
  }));
}
async function restoreAfterExit(handle,owned,alive,restore){
  assert(!owned.some(alive),'Profile restoration refused: owned application process still alive');
  return restore(handle,{label:'offline-preview'});
}
function packageIdentity(){
  const b=NET.assertReady(),m=b.preflight.manifest;
  assert(m.pilotBuildId==='2026-09-10T22-15-35-426Z-4cf82a57','Wrong preview build');
  assert(m.builtFrom.commit==='cb04131613e1640ca0e64c47e07b3afca81c47f6'&&!m.builtFrom.dirty,'Wrong preview source');
  const hash=crypto.createHash('sha256').update(fs.readFileSync(path.join(b.resApp,'origin-experiment-build-manifest.json'))).digest('hex');
  assert(hash==='a1b50f3ed77cbdee9bf8e407c78d63b154d735349f2a11bf60284dbca105cbf3','Manifest changed');
  return b;
}
function canonicalExistingGraph(input){
  assert(typeof input==='string'&&path.isAbsolute(input),'Existing graph requires an exact absolute path');
  const graph=B.assertInsideAllowedRoot('existing disposable preview graph',input);
  const st=fs.lstatSync(input);
  assert(!st.isSymbolicLink(),'Existing graph symlink refused');
  assert(st.isDirectory(),'Existing graph is not a directory');
  assert(fs.realpathSync(input)===graph,'Existing graph canonical path mismatch');
  return graph;
}
async function start({smokeClose=false,existingGraph=null,persistentProfile=false}={}){
  const built=packageIdentity();
  const requestedGraph=existingGraph?canonicalExistingGraph(existingGraph):null;
  assert(!runningPackage(built.exe).length,'Existing experimental process: no profile changes allowed');
  fs.mkdirSync(EVIDENCE,{recursive:true});
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const file=path.join(EVIDENCE,'origin-preview-'+stamp+'.json');
  const closeFile=file+'.close';
  const lease={schema:'origin-preview/1',supervisorPid:process.pid,evidence:file,closeFile};
  fs.writeFileSync(ACTIVE,JSON.stringify(lease,null,2),{flag:'wx'});
  const out={...lease,stamp,status:'preparing',build:built.preflight.manifest.pilotBuildId,
    productSource:built.preflight.manifest.builtFrom,checks:[],
    title:requestedGraph?EXISTING_TITLE:TITLE,noInspectionTimeout:true,
    mode:requestedGraph?'existing-disposable-graph':'synthetic-reference-preview',
    profileMode:persistentProfile?'persistent-test-profile':'preserve-and-restore'};
  let handle,session,seed,graph,before,pluginBefore,settingsFile;
  let requestClose=false;
  const signal=()=>{requestClose=true;};
  process.on('SIGTERM',signal);process.on('SIGINT',signal);
  const record=(id,title,ok,detail)=>{out.checks.push({id,title,ok,detail});save(file,out);console.log((ok?'PASS ':'FAIL ')+id+' '+title);assert(ok,title);};
  const errors=REC.createRecorder();
  try{
    if(persistentProfile){
      const state=FP.stateRootFor(built.identity);
      const preExisting=fs.existsSync(state.root);
      handle={identity:built.identity,root:state.root,productDir:state.productDir,stamp,
        preserved:null,marker:preExisting?FP.assertOurs(state.root,built.identity):null,
        preExisting,persistent:true};
    }else handle=FP.swapAside(built.identity,{stamp});
    out.profile=handle;save(file,out);
    if(!fs.existsSync(handle.root)){
      // Let the unchanged application establish its ownership marker before placement.
      seed=await NET.launchWith(o=>_electron.launch(o))({executablePath:built.exe,timeout:120000});
      const seedPid=seed.process().pid,seedTree=OP.descendants(seedPid);
      out.seed={pid:seedPid,owned:seedTree};save(file,out);
      await seed.firstWindow();FP.assertOurs(handle.root,built.identity);
      out.seed.cleanup=await APP.close({app:seed,appPid:seedPid,ownedTree:seedTree});seed=null;
      assert(!out.seed.cleanup.stillAlive.length,'Seed process remains');
    }else out.seed={skipped:true,reason:'reused ownership-verified persistent TEST profile'};
    const plugins=FP.pluginsDirIn(handle.root);
    const present=fs.existsSync(plugins)?fs.readdirSync(plugins).filter(n=>n!=='.DS_Store'):[];
    if(present.length){
      assert(present.length===1&&present[0]===PLUGIN,'Persistent profile contains an unexpected plugin');
      const verified=PA.verify(PLUGIN,plugins);assert(verified.ok,'Persistent Readwise artifact changed');
      out.artifact=[{id:PLUGIN,reused:true,treeSha256:verified.measured.treeSha256,
        manifestSha256:verified.measured.manifestSha256}];
    }else out.artifact=PA.installInto(plugins,[PLUGIN]).installed;
    const settings=path.join(handle.root,'home','.logseq-og','settings');fs.mkdirSync(settings,{recursive:true});
    settingsFile=path.join(settings,PLUGIN+'.json');
    // Disable plugin automatic polling in addition to unconditional startup refusal.
    // No token field; original defaults/previous settings are never imported.
    if(!fs.existsSync(settingsFile))
      fs.writeFileSync(settingsFile,JSON.stringify({isLoadAuto:false,isResyncDeleted:false}),{flag:'wx'});
    const retainedSettings=JSON.parse(fs.readFileSync(settingsFile));
    const hasCredential=Object.entries(retainedSettings).some(([k,v])=>/token|secret|password|api.?key/i.test(k)&&v);
    assert(retainedSettings.isLoadAuto===false,'Persistent profile enables Readwise automatic import');
    assert(retainedSettings.isResyncDeleted===false,'Persistent profile enables Readwise deleted-item resync');
    assert(!hasCredential,'Persistent profile contains a credential');
    out.settingsBeforeActivation={isLoadAuto:false,isResyncDeleted:retainedSettings.isResyncDeleted,
      reused:persistentProfile&&handle.preExisting};
    pluginBefore=PA.snapshot(plugins);
    if(requestedGraph){
      // Existing-graph preparation is deliberately content-blind and non-mutating.
      // Do not seed, hash, list, annotate, screenshot, or navigate its notes here.
      graph=requestedGraph;out.graph=graph;out.preparation='canonical containment only; existing contents preserved';
    }else{
      graph=B.assertInsideAllowedRoot('fresh preview graph',CG.build({kind:'offline-readwise-preview'}).graph);
      XA.placeAssetProbe(graph);
      const anchor=B.assertInsideAllowedRoot('preview instructions',path.join(graph,'pages',CG.ANCHOR+'.md'));
      fs.appendFileSync(anchor,'\n- **OFFLINE PREVIEW / 오프라인 미리보기** — Synthetic examples only / 예제 전용\n- Readwise import and sync are disabled. / Readwise 가져오기·동기화는 비활성화되어 있습니다.\n- Below: Linked References / 연결된 참조 — compare source paths and child context. / 출처 경로와 하위 문맥을 살펴보세요.\n- Close with Command-Q or the documented close command. / Command-Q 또는 안내된 종료 명령으로 닫으세요.\n');
      before=GH.snapshot(graph);out.baseline=before;
    }
    save(file,out);
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
    record('P4','Automatic import/resync disabled and no credential',settingsNow.isLoadAuto===false&&settingsNow.isResyncDeleted===false&&!Object.entries(settingsNow).some(([k,v])=>/token|secret|password|api.?key/i.test(k)&&v),{isLoadAuto:settingsNow.isLoadAuto,isResyncDeleted:settingsNow.isResyncDeleted,credentialsPresent:false});
    await live();
    if(requestedGraph){
      // Chromium file inputs expose bytes directly to the renderer and do not
      // pass through the main-process path guard. Disable all importer inputs
      // rather than claim their native picker is contained.
      await session.page.addInitScript(()=>document.addEventListener('click',e=>{
        const input=e.target?.closest?.('label')?.querySelector?.('input[type="file"]');
        if(input&&/^import-(roam|lsq|opml)$/.test(input.id)){e.preventDefault();e.stopImmediatePropagation();}
      },true));
      await session.page.evaluate(()=>document.addEventListener('click',e=>{
        const input=e.target?.closest?.('label')?.querySelector?.('input[type="file"]');
        if(input&&/^import-(roam|lsq|opml)$/.test(input.id)){e.preventDefault();e.stopImmediatePropagation();}
      },true));
      out.importGuard={enabled:true,reason:'native renderer file input is not path-contained; import unavailable'};
    }
    if(requestedGraph){
      record('P5','Exact LIVE disposable graph before handoff',out.liveGraph?.ok===true,{reason:out.liveGraph.reason,source:out.liveGraph.source});
      out.operatorInteractions='none after LIVE identity assertion';
      const cssProperty=process.env.F28_OFFLINE_TEST_CSS_PROPERTY;
      if(cssProperty){
        assert(/^--[a-z0-9-]+$/.test(cssProperty),'Invalid CSS test property');
        const cssValue=await session.page.evaluate(p=>getComputedStyle(document.body).getPropertyValue(p).trim(),cssProperty);
        record('P6','Existing local custom.css loaded',cssValue===process.env.F28_OFFLINE_TEST_CSS_VALUE,
          {property:cssProperty,value:cssValue});
      }
    }else{
      errors.phase('reference-preview','short-reference-journey');
    await session.goTo(CG.ANCHOR);await j.settle('preview');out.references=await RD.read(session.page);
    record('P5','Eight reference groups',out.references.present&&out.references.groups.length===8,{groups:out.references.groups.length});
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
    }
    const cls=EC.summarise(errors.entries(),{outsidePath:bad,graphPath:graph,phases:errors.phases()});
    const split=NOISE.partition(cls.unexpected,errors.entries(),await session.collectErrorEvidence());
    out.errors=requestedGraph?{
      entries:redactExistingGraphErrors(errors.entries()),
      expected:redactExistingGraphErrors(cls.expected),
      remaining:redactExistingGraphErrors(split.remaining),
      strictPassed:split.remaining.length===0,
      contentRedacted:true,
    }:{entries:errors.entries(),expected:cls.expected,remaining:split.remaining,strictPassed:split.remaining.length===0};
    // Do not reclassify startup failures or silently erase previous strict failures.
    out.historicalStrictFailuresRetained=true;
    await live();
    // Remove the folder-dialog test stub before inspection. Normal dialogs remain guarded.
    await session.app.evaluate(({dialog,BrowserWindow},title)=>{
      if(global.__pilotOrigShowOpenDialog){dialog.showOpenDialog=global.__pilotOrigShowOpenDialog;delete global.__pilotOrigShowOpenDialog;delete global.__pilotDialogPath;}
      for(const w of BrowserWindow.getAllWindows()){w.setTitle(title);w.show();w.focus();}
    },requestedGraph?EXISTING_TITLE:TITLE);
    await session.parkPointer();
    await session.page.keyboard.press('Escape');
    if(!requestedGraph){
      await session.page.evaluate(()=>{for(const e of document.querySelectorAll('*')){if(e._tippy)e._tippy.hide();}const m=document.querySelector('#main-content-container');if(m)m.scrollTop=0;window.scrollTo(0,0);});
      await OP.sleep(1500);
      await session.page.screenshot({path:file+'.png'});
    }
    errors.phase('user-inspection','no-scripted-interactions');
    out.status='open-for-inspection';out.startPage=requestedGraph?'application-selected page':CG.ANCHOR;save(file,out);console.log('PREVIEW READY '+file);
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
      if(handle&&persistentProfile){
        assert(!owned.some(OP.alive),'Persistent profile retained only after owned app exit');
        out.restoration={ok:true,persistent:true,root:handle.root,restored:false,
          note:'TEST preferences retained in the app-owned profile'};
      }else if(handle)out.restoration=await restoreAfterExit(handle,owned,OP.alive,FP.restore);
      if(graph&&before)out.finalIntegrity=GH.compare(before,GH.snapshot(graph));
      out.finalErrorEntries=requestedGraph?redactExistingGraphErrors(errors.entries()):errors.entries();
      out.status=out.error?'failed-closed':'closed';
      if(out.restoration&&!out.restoration.ok)throw Error('Profile restoration needs review');
      fs.unlinkSync(ACTIVE);
    }catch(e){out.cleanupError=e.message;out.status='cleanup-pending';process.exitCode=1;}
    out.closedAt=new Date().toISOString();save(file,out);console.log('PREVIEW '+out.status+' '+file);
    process.removeListener('SIGTERM',signal);process.removeListener('SIGINT',signal);
  }
  return out;
}
function closeRequest(){
  const lease=JSON.parse(fs.readFileSync(ACTIVE));
  assert(lease.schema==='origin-preview/1'&&path.dirname(lease.evidence)===EVIDENCE&&lease.closeFile===lease.evidence+'.close','Invalid preview lease');
  assert(OP.alive(lease.supervisorPid),'Supervisor absent: preserve state; manual owned-process review required');
  fs.writeFileSync(lease.closeFile,'User requested preview close\n',{flag:'a'});console.log('Close requested; supervisor will restore only after the app exits. '+lease.evidence);
}
if(require.main===module){
  const cmd=process.argv[2];
  if(cmd==='close')closeRequest();
  else if(cmd==='start'||cmd==='smoke-close')start({smokeClose:cmd==='smoke-close'}).catch(e=>{console.error(e.stack);process.exitCode=1;});
  else if(cmd==='start-existing'){
    assert(process.argv[3]==='--graph'&&process.argv.length===5,'Use start-existing --graph /exact/absolute/path');
    start({existingGraph:process.argv[4]}).catch(e=>{console.error(e.stack);process.exitCode=1;});
  }else throw Error('Use start, start-existing --graph /exact/path, close, or smoke-close');
}
module.exports={start,restoreAfterExit,packageIdentity,canonicalExistingGraph,redactExistingGraphErrors};
