import assert from 'node:assert/strict';
import {mkdir,writeFile,readdir,realpath,lstat,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {inside,hashFile} from './acceptance-inputs.mjs';

export function requireVisiblePackageViewport(value){
  assert(value&&Number.isFinite(value.width)&&Number.isFinite(value.height)&&value.width>0&&value.height>0,'Missing package viewport evidence');
  for(const rect of [value.host,value.terminal]){
    assert(rect&&['left','top','right','bottom','width','height'].every(key=>Number.isFinite(rect[key])),'Missing terminal bounds evidence');
    assert(rect.width>0&&rect.height>0&&rect.left>=-1&&rect.top>=-1&&rect.right<=value.width+1&&rect.bottom<=value.height+1,'Terminal evidence is outside the actual viewport');
  }
}

export async function retainUninstallResidue(owner,install,destination){
  const base=resolve(owner,'artifacts/tests');inside(base,install);inside(base,destination);
  assert.equal((await realpath(install)).toLowerCase(),resolve(install).toLowerCase(),'Linked installation residue rejected');
  const names=(await readdir(install)).sort();
  assert(names.length===0||names.length===1&&names[0]==='uninstall.exe','Unexpected files remain after normal uninstall');
  let sha256;
  if(names.length){const file=resolve(install,'uninstall.exe'),info=await lstat(file);assert(info.isFile()&&!info.isSymbolicLink());sha256=await hashFile(file);}
  try{await lstat(destination);throw Error('Uninstall evidence destination already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
  await rename(install,destination); // Retain the NSIS self-uninstaller; no irreversible deletion.
  if(sha256)assert.equal(await hashFile(resolve(destination,'uninstall.exe')),sha256);
  return {original:install,retained:destination,files:names,sha256:sha256??null,normalUninstallCompleted:true};
}

export function packageCargoLocation(owner,batchId){
  assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(batchId),'Exact batch identity required');
  const directory=resolve(owner,'artifacts/tests/cb',batchId.slice(0,8)),target=resolve(directory,'t');
  const opensslPath=target+'/x86_64-pc-windows-msvc/release/build/openssl-sys-0123456789abcdef/out/openssl-build/build/src/providers/implementations/ciphers/cipher_aes_cbc_hmac_sha512_etm_hw.c';
  assert(opensslPath.length<260,'Dedicated Cargo output exceeds the reviewed Windows OpenSSL path budget');
  return {directory,target};
}
export async function reservePackageCargo(owner,batchId,sourceRoot){
  const location=packageCargoLocation(owner,batchId);await mkdir(resolve(location.directory,'..'),{recursive:true});
  await mkdir(location.directory); // Collision rejects reuse; never adopt an output.
  await writeFile(resolve(location.directory,'owner.json'),JSON.stringify({batchId,sourceRoot,pid:process.pid,purpose:'Exclusive acceptance Cargo output'},null,2),{flag:'wx'});
  return location.target;
}

export async function allocateCase(parent){
  const token=randomUUID(),directory=resolve(parent,token.slice(0,8));await mkdir(directory);
  const paths=Object.fromEntries(['home','data','webview'].map(name=>[name,resolve(directory,name)]));
  for(const path of Object.values(paths))await mkdir(path);
  return {token,directory,paths};
}
export function packageLoader(origin,batchId){
  const parsed=new URL(origin);assert(parsed.protocol==='http:'&&parsed.hostname==='127.0.0.1'&&parsed.port&&parsed.origin===origin,'Exact owned loopback origin required');
  assert(/^[a-f0-9-]{36}$/.test(batchId),'Batch capability required');
  const source='/src/components/terminal/__tests__';
  return `let c;
try {
 const r=await fetch(${JSON.stringify(origin+'/'+batchId+'/bootstrap')});if(!r.ok)throw Error('Owned launch unavailable');c=await r.json();
 if(!['ordinary','preflight','semantics','file-chain'].includes(c.stage)||!['powerShell7','windowsPowerShell'].includes(c.shell)||c.validationOnly!==true||!/^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/[a-f0-9-]{36}$/.test(c.report)||new URL(c.report).origin!==${JSON.stringify(origin)})throw Error('Invalid owned launch configuration');
 globalThis.__shellspanPackageCase=c;history.replaceState(null,'','?'+new URLSearchParams(c.query));
 if(c.stage==='ordinary'){
  const {invokeListAiRoutes}=await import('/src/lib/ipc/tauri.ts');const routes=await invokeListAiRoutes();if(routes.routes.length||routes.defaultSelection)throw Error('Fresh route store required');
  await import(${JSON.stringify(source+'/native-input-package.native.ts')});
 }else if(c.stage==='preflight')await import(${JSON.stringify(source+'/native-model-preflight.native.ts')});
 else if(c.stage==='semantics')await import(${JSON.stringify(source+'/native-semantics.native.tsx')});
 else if(c.stage==='file-chain')await import(${JSON.stringify(source+'/native-file-chain.native.tsx')});
}catch(error){if(c?.report&&new URL(c.report).origin===${JSON.stringify(origin)})await fetch(c.report,{method:'POST',body:JSON.stringify({ok:false,error:String(error)})});else throw error;}
`;
}
export const packageDefines=Object.fromEntries(Object.entries({REPORT:'report',INSTALL_ROOT:'install',MANIFEST_SHA:'manifestSha',VALIDATION_ONLY:'validationOnly',NATIVE_SHA:'coreSha',SHELL_KIND:'shell',SHELL_VERSION:'version'})
  .map(([key,value])=>['__PACKAGE_'+key+'__','globalThis.__shellspanPackageCase.'+value]));
