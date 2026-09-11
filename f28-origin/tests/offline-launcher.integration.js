'use strict';
// One bounded Intel integration run using only fresh generated Logseq Test data.
const fs=require('fs'),path=require('path'),{execFileSync,spawn}=require('child_process');
const B=require('../../f27-pilot/checks/allowed-root');
const CG=require('../../f28-refpath/checks/make-reforder-graph');
const GH=require('../../f27-pilot/checks/graph-hash');
const FP=require('../../f28-refpath/checks/fresh-profile');
const ID=require('../src/experiment-identity');
const APP=path.resolve(__dirname,'../../../out-launcher/Logseq OG Test — Offline.app');
const EXEC=path.join(APP,'Contents/MacOS/Logseq OG Test — Offline');
const EVIDENCE=path.resolve(__dirname,'../../../evidence');
const ACTIVE=path.join(EVIDENCE,'origin-preview-active.json');
const LOCK=path.join(EVIDENCE,'origin-offline-launcher-active.json');
const PREVIEW=path.resolve(__dirname,'../checks/preview.js');
const baseEnv={...process.env,F28_OFFLINE_TEST_NO_DIALOG:'1'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function assert(v,m){if(!v)throw Error(m);}
function run(args,env={}){return execFileSync(args[0],args.slice(1),{env:{...baseEnv,...env},encoding:'utf8',stdio:['ignore','pipe','pipe']});}
async function waitFor(present,file,ms=180000){
  const end=Date.now()+ms;while(Date.now()<end){if(fs.existsSync(file)===present)return;await sleep(250);}throw Error('Timed out waiting for '+file);
}
function latestFor(graph){
  return fs.readdirSync(EVIDENCE).filter(n=>/^origin-preview-.*\.json$/.test(n))
    .map(n=>path.join(EVIDENCE,n)).filter(p=>{try{return JSON.parse(fs.readFileSync(p)).graph===graph;}catch(e){return false;}})
    .sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];
}
async function main(){
  assert(!fs.existsSync(ACTIVE)&&!fs.existsSync(LOCK),'An existing preview/launcher lease is active');
  assert(fs.existsSync(EXEC),'Launcher application missing');
  const built=CG.build({kind:'offline-launcher-integration'}),graph=built.graph;
  const css=B.assertInsideAllowedRoot('synthetic local CSS',path.join(graph,'logseq','custom.css'));
  fs.writeFileSync(css,'body { --f28-offline-custom-css-probe: loaded; }\n',{flag:'wx'});
  const before=GH.snapshot(graph);
  const escapeRoot=B.assertInsideAllowedRoot('symlink refusal fixture',path.join(B.allowedRootReal(),
    'f28-offline-launcher-symlink-'+new Date().toISOString().replace(/[:.]/g,'-')));
  fs.mkdirSync(escapeRoot,{recursive:false});
  const escape=path.join(escapeRoot,'escape');fs.symlinkSync('/private/tmp',escape);
  const report={schema:'f28-offline-launcher-integration/1',graph,escapeRoot,checks:[]};
  const check=(name,ok,detail)=>{report.checks.push({name,ok,detail});assert(ok,name);};
  let child=null;
  const displaced=FP.swapAside(ID,{stamp:'before-offline-launcher-integration-'+new Date().toISOString().replace(/[:.]/g,'-')});
  try{
    run(['/usr/bin/open','-W','-n',APP],{F28_OFFLINE_TEST_CANCEL:'1'});
    check('LaunchServices double-click path handles picker cancellation',!fs.existsSync(ACTIVE)&&!fs.existsSync(LOCK));
    for(const [name,selection] of [['outside-root refusal','/private/tmp'],['symlink-escape refusal',escape]]){
      let refused=false;try{run([EXEC],{F28_OFFLINE_TEST_SELECTION:selection,F28_OFFLINE_TEST_AUTOCLOSE:'1'});}catch(e){refused=true;}
      check(name,refused&&!fs.existsSync(ACTIVE)&&!fs.existsSync(LOCK));
    }
    const env={F28_OFFLINE_TEST_SELECTION:graph,F28_OFFLINE_TEST_AUTOCLOSE:'1',
      F28_OFFLINE_TEST_CSS_PROPERTY:'--f28-offline-custom-css-probe',F28_OFFLINE_TEST_CSS_VALUE:'loaded'};
    run(['/usr/bin/open','-W','-n',APP],env);
    let evidence=latestFor(graph),first=JSON.parse(fs.readFileSync(evidence));
    check('valid double-click selection and exact LIVE graph',first.status==='closed'&&first.liveGraph?.ok&&first.graph===graph);
    check('pinned Dracula theme loaded and selected locally',first.checks.some(c=>c.id==='P3T'&&c.ok)&&first.themeActivation?.background==='#282a36');
    check('local custom.css loaded',first.checks.some(c=>c.id==='P6'&&c.ok));
    check('import inputs disabled',first.importGuard?.enabled===true);
    check('safe Quit retains persistent profile',first.restoration?.persistent===true&&first.restoration.ok);
    check('no fixture injection or graph-content change',GH.compare(before,GH.snapshot(graph)).content.length===0);
    run([EXEC],env);evidence=latestFor(graph);const second=JSON.parse(fs.readFileSync(evidence));
    check('repeat launch reuses owned TEST profile',second.profile?.preExisting===true&&second.seed?.skipped===true&&second.status==='closed');
    child=spawn(EXEC,[],{env:{...baseEnv,F28_OFFLINE_TEST_SELECTION:graph},stdio:'ignore'});
    await waitFor(true,ACTIVE);await sleep(1000);
    let overlap=false;try{run([EXEC],{F28_OFFLINE_TEST_SELECTION:graph,F28_OFFLINE_TEST_AUTOCLOSE:'1'});}catch(e){overlap=true;}
    check('overlapping launch refused',overlap&&fs.existsSync(ACTIVE)&&child.exitCode===null);
    run([process.execPath,PREVIEW,'close']);
    await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('launcher quit timeout')),180000);child.once('exit',()=>{clearTimeout(t);resolve();});});child=null;
    check('safe Quit clears leases',!fs.existsSync(ACTIVE)&&!fs.existsSync(LOCK));
    check('existing synthetic graph content still unchanged',GH.compare(before,GH.snapshot(graph)).content.length===0);
  }finally{
    if(child&&child.exitCode===null){try{run([process.execPath,PREVIEW,'close']);}catch(e){} await sleep(3000);}
    if(!fs.existsSync(ACTIVE)&&!fs.existsSync(LOCK)){
      const archived=FP.swapAside(ID,{stamp:'integration-'+new Date().toISOString().replace(/[:.]/g,'-')});
      const restored=displaced.preserved?FP.restore(displaced):{ok:true,restored:false};
      report.checks.push({name:'integration TEST profile retained and prior owned TEST profile restored after exit',
        ok:!!archived.preserved&&fs.existsSync(archived.preserved)&&restored.ok,
        detail:{archived:archived.preserved,restored:restored.restored}});
    }else report.checks.push({name:'integration TEST profile retained and prior owned TEST profile restored after exit',
      ok:false,detail:'active lease preserved; restoration refused'});
    report.finishedAt=new Date().toISOString();report.ok=report.checks.every(c=>c.ok);
    fs.writeFileSync(path.join(EVIDENCE,'f28-offline-launcher-integration-'+Date.now()+'.json'),JSON.stringify(report,null,2)+'\n');
  }
  console.log(JSON.stringify({ok:report.ok,checks:report.checks.length}));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
