import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,readdirSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import {isAbsolute,resolve,relative,sep} from 'node:path';

const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const within=(parent,path)=>{const child=relative(resolve(parent),resolve(path));return child!==''&&child!=='..'&&!child.startsWith(`..${sep}`)&&!isAbsolute(child);};
export function nativeValidationResourceDirectory(root,selected){
  const actual=realpathSync(resolve(root,selected??'.artifacts/tests/native-input-p2/resources/native-input'));
  assert(within(realpathSync(root),actual),'Selected validation resources must be a strict descendant of the frozen source root');
  return actual;
}
export function readValidationGit(root,args){
  assert(Array.isArray(args)&&['ls-files','check-ignore','rev-parse'].includes(args[0]),'Only read-only validation Git commands are allowed');
  const snapshotIndex=resolve(root,'.artifacts/tests/native-input-p3/snapshot-index.json');
  const snapshot=existsSync(snapshotIndex)?JSON.parse(readFileSync(snapshotIndex,'utf8')):undefined;
  if(snapshot){
    assert.equal(snapshot.root,resolve(root));
    assert(within(resolve(root,'.artifacts/tests/native-input-p3'),snapshot.index));
    assert.equal(sha(snapshot.index),snapshot.indexSha256,'Frozen source index changed');
  }
  return execFileSync('git',[
    ...(snapshot?[`--git-dir=${snapshot.gitDirectory}`,`--work-tree=${root}`]:[]),
    ...args],{
      cwd:root,maxBuffer:16*1024*1024,
      ...(snapshot?{env:{...process.env,GIT_INDEX_FILE:snapshot.index,GIT_OPTIONAL_LOCKS:'0'}}:{}),
    });
}
export function captureValidationSources(root){
  const paths=readValidationGit(root,['ls-files','-z','--cached','--others','--exclude-standard']).toString().split('\0').filter(Boolean);
  const sources={};
  for(const path of [...new Set(paths)].sort()){
    try{if(statSync(resolve(root,path)).isFile())sources[path]=sha(resolve(root,path));}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return sources;
}
export function captureValidationAssets(directory){
  const assets={};
  function visit(path){for(const entry of readdirSync(path,{withFileTypes:true})){
    const file=resolve(path,entry.name);
    if(entry.isDirectory())visit(file);
    else{assert(entry.isFile(),'Frozen assets must be regular files');assets[relative(directory,file)]=sha(file);}
  }}
  visit(directory);assert(Object.keys(assets).length>0,'Frozen frontend assets are empty');return assets;
}
export function writeFrozenCheckpoint(path,value){writeFileSync(path,JSON.stringify({capturedAt:new Date().toISOString(),...value},null,2),{flag:'wx',mode:0o600});}
function requireSameHashes(expected,actual,label){
  const changed=[...new Set([...Object.keys(expected),...Object.keys(actual)])].filter(path=>expected[path]!==actual[path]);
  assert.equal(changed.length,0,`${label}: ${changed.slice(0,20).join(', ')}${changed.length>20?' (additional paths omitted)':''}`);
}
export function verifyFrozenValidation(manifestPath,stage){
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  assert.equal(manifest.version,1);assert(manifest.root&&manifest.directory&&manifest.sources&&manifest.assets);
  const evidence=resolve(manifest.directory);const root=resolve(manifest.root);
  assert(within(resolve(root,'.artifacts/tests/native-input-p2'),evidence),'Frozen validation must use the isolated validation directory');
  assert(within(evidence,manifestPath));
  assert(within(evidence,manifest.assetsDirectory));
  requireSameHashes(manifest.sources,captureValidationSources(root),`Acceptance source drift at ${stage}`);
  requireSameHashes(manifest.assets,captureValidationAssets(manifest.assetsDirectory),`Acceptance asset drift at ${stage}`);
  if(manifest.nativeResourcesDirectory){
    assert(within(root,manifest.nativeResourcesDirectory));
    requireSameHashes(manifest.nativeResources,captureValidationAssets(manifest.nativeResourcesDirectory),`Native resource drift at ${stage}`);
  }
  return {stage,manifest:relative(root,manifestPath),manifestSha256:sha(manifestPath),sourceCount:Object.keys(manifest.sources).length,
    assetCount:Object.keys(manifest.assets).length,hmr:false,tauriWatch:false};
}

export function attachSingleUseValidationPage(server,pagePath,token){
  let served=false;
  server.middlewares.use((request,response,next)=>{
    const url=new URL(request.url,'http://127.0.0.1');
    if(url.pathname!==`/${pagePath}`){next();return;}
    if(request.method!=='GET'||url.searchParams.get('token')!==token){response.statusCode=404;response.end();return;}
    response.setHeader('Cache-Control','no-store');
    if(served){response.statusCode=409;response.end('This isolated validation page was already served. Create a new run; never replay an uncertain operation.');return;}
    served=true;next();
  });
}
