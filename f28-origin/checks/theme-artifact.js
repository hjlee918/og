'use strict';
// Pinned, offline placement of the official dracula/logseq theme. The retained
// source is an unmodified checkout of the exact public commit below. Only files
// tracked by that commit are copied; .git metadata never enters the TEST profile.
const crypto=require('crypto'),fs=require('fs'),path=require('path');
const COMMIT='0064af84b7236676f6b4b6d1b37c355501c91111';
const DEST_ID='logseq-dracula-theme';
const MANIFEST_ID='dracula_logseq';
const SOURCE=path.resolve(__dirname,'../../../artifacts/dracula-logseq-official-'+COMMIT);
const FILES=Object.freeze({
  '.github/issue_template.md':['ede4e3dff6792f0109e5155b47ec35bb6af8560e04cd0adce6aa6b21813c9edb',93],
  '.github/pull_request_template.md':['eb63902850f654f88b06dea41e1069bc035c67d7ff4c75dfd61b1dd81f46a6f2',137],
  'INSTALL.md':['2b5f5e8c9380ead24375607956c6043870ec6fe779ea14c6a93b294ed0232697',518],
  'LICENSE':['4cdad101db975232dfef7ae7aa4058f676da365cabb45a19579f5e99aead9f30',1080],
  'README.md':['a3c4c7aeec0bc47a331278330f9c0145bd71c0540ccd2de35161d8d285231403',1442],
  'custom.css':['3ba529d41f2c5d5fc93f31630690f3e5ada1332cccb8eb74126e172d69b6260c',26051],
  'icon.svg':['b7379b44b58fdeca55ad1d84894e21c2c59d3dee5255aa6dff038560936e4f56',11147],
  'package.json':['2e3b6095c3a5f71e47cf1556f9236aabb3e4a5e1bfd508753440dd268206981d',449],
  'screenshot.png':['c0c652ef67b514c8fbf382346d016559dc1165fd8418ea5b38ab44e6f2dcfeaa',586591],
});
class ThemeArtifactRefusal extends Error{}
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function listed(root,{source=false}={}){
  const out=[];
  function walk(dir,rel=''){
    for(const e of fs.readdirSync(dir,{withFileTypes:true})){
      if(source&&!rel&&e.name==='.git')continue;
      const child=path.join(dir,e.name),next=rel?path.join(rel,e.name):e.name;
      if(e.isSymbolicLink())throw new ThemeArtifactRefusal('Theme artifact symlink refused: '+next);
      if(e.isDirectory())walk(child,next);else if(e.isFile())out.push(next);
      else throw new ThemeArtifactRefusal('Unsupported theme artifact entry: '+next);
    }
  }
  walk(root);return out.sort();
}
function verify(root=SOURCE,{source=root===SOURCE}={}){
  if(!fs.existsSync(root)||!fs.lstatSync(root).isDirectory())throw new ThemeArtifactRefusal('Pinned Dracula artifact is absent');
  const found=listed(root,{source}),expected=Object.keys(FILES).sort();
  if(JSON.stringify(found)!==JSON.stringify(expected))throw new ThemeArtifactRefusal('Pinned Dracula file inventory changed');
  for(const rel of expected){
    const p=path.join(root,rel),[wantHash,wantSize]=FILES[rel],st=fs.statSync(p);
    if(st.size!==wantSize||sha(p)!==wantHash)throw new ThemeArtifactRefusal('Pinned Dracula file changed: '+rel);
  }
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  if(manifest.name!==DEST_ID||manifest.version!=='0.1.0'||manifest.logseq?.id!==MANIFEST_ID||
     manifest.logseq?.themes?.length!==1||manifest.logseq.themes[0].url!=='./custom.css')
    throw new ThemeArtifactRefusal('Pinned Dracula manifest identity changed');
  return {ok:true,root,commit:COMMIT,id:DEST_ID,manifestId:MANIFEST_ID,version:'0.1.0',
    fileCount:expected.length,totalBytes:expected.reduce((n,k)=>n+FILES[k][1],0),
    packageSha256:FILES['package.json'][0],cssSha256:FILES['custom.css'][0],
    remoteAssetNote:'Google Fonts import is present and remains blocked offline'};
}
function installOrVerify(pluginsDir){
  const source=verify(),dest=path.join(pluginsDir,DEST_ID);
  if(fs.existsSync(dest))return {...verify(dest,{source:false}),reused:true,dest};
  fs.mkdirSync(pluginsDir,{recursive:true});
  const tmp=path.join(pluginsDir,'.'+DEST_ID+'.tmp-'+process.pid);
  if(fs.existsSync(tmp))throw new ThemeArtifactRefusal('Prior temporary Dracula placement requires review');
  fs.mkdirSync(tmp);
  try{
    for(const rel of Object.keys(FILES)){
      const to=path.join(tmp,rel);fs.mkdirSync(path.dirname(to),{recursive:true});
      fs.copyFileSync(path.join(SOURCE,rel),to);
    }
    verify(tmp,{source:false});fs.renameSync(tmp,dest);
  }catch(e){throw e;}
  return {...verify(dest,{source:false}),reused:false,dest};
}
module.exports={COMMIT,DEST_ID,MANIFEST_ID,SOURCE,FILES,ThemeArtifactRefusal,verify,installOrVerify};
