// Real Vite assets, HTTP requests and file drift; no WebView/native receipts.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,cpSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {build,preview} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {captureValidationSources,captureValidationAssets,writeFrozenCheckpoint,verifyFrozenValidation,attachSingleUseValidationPage} from './frozen-validation.mjs';

const root=resolve(import.meta.dirname,'../..');
const directory=resolve(root,'.artifacts/tests/native-input-p2/frozen-check',randomUUID());mkdirSync(directory,{recursive:true,mode:0o700});
const output=resolve(directory,'frontend');const token=randomUUID();
const {values}=parseArgs({options:{page:{type:'string'}}});
const pages={initialize:'native-data-initialize',history:'native-input-p2-history',jobs:'native-jobs',contention:'terminal-contention',interactive:'native-input-p2-interactive'};
const selected=values.page??'initialize';assert(selected in pages,'Unsupported actual validation page');
const page=`src/components/terminal/__tests__/${pages[selected]}.native.html`;
const sources=captureValidationSources(root);
await build({configFile:false,root,logLevel:'error',resolve:{alias:{'@':resolve(root,'src')}},plugins:[react(),tailwindcss()],build:{outDir:output,emptyOutDir:true,rolldownOptions:{input:resolve(root,page)}}});
const assets=captureValidationAssets(output);
assert(!readFileSync(resolve(output,page),'utf8').includes('/@vite/client'));
const manifest=resolve(directory,'manifest.json');writeFrozenCheckpoint(manifest,{version:1,root,directory,entry:page,assetsDirectory:output,sources,assets,hmr:false,tauriWatch:false});
verifyFrozenValidation(manifest,'after-real-build');
const server=await preview({configFile:false,root,build:{outDir:output},plugins:[{name:'single-use-real-acceptance-entry',configurePreviewServer(server){attachSingleUseValidationPage(server,page,token);}}],preview:{host:'127.0.0.1',port:0}});
try{
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  assert.equal((await fetch(`${origin}/${page}`)).status,404,'A request without the owned token claimed the page');
  const first=await fetch(`${origin}/${page}?token=${token}`);assert.equal(first.status,200);await first.text();
  const second=await fetch(`${origin}/${page}?token=${token}`);assert.equal(second.status,409,'A reload could reexecute the validation page');
  const asset=Object.keys(assets).find(path=>path.endsWith('.js'));assert(asset,'Actual JavaScript bundle missing');
  assert.equal((await fetch(`${origin}/${asset}`)).status,200,'Actual static JavaScript was not served');
  const path=resolve(output,asset);const original=readFileSync(path);
  try{
    writeFileSync(path,Buffer.concat([original,Buffer.from('\n// owned asset-drift injection\n')]));
    assert.throws(()=>verifyFrozenValidation(manifest,'actual-file-drift'),/Acceptance asset drift/,'A real modified asset was accepted');
  }finally{writeFileSync(path,original);}
  const final=verifyFrozenValidation(manifest,'after-restoring-owned-test-artifact');
  // A separate real Git checkout contains copies of actual production files.
  // Inject source drift only there; never edit the user's checkout for a test.
  const sourceRoot=resolve(directory,'copied-source');mkdirSync(sourceRoot);
  for(const file of['package.json','.gitignore'])copyFileSync(resolve(root,file),resolve(sourceRoot,file));
  const entry=resolve(sourceRoot,'entry.ts');copyFileSync(resolve(root,'src/components/terminal/__tests__/native-data-initialize.native.ts'),entry);
  execFileSync('git',['init','--quiet',sourceRoot]);
  const sourceDirectory=resolve(sourceRoot,'.artifacts/tests/native-input-p2/check');mkdirSync(sourceDirectory,{recursive:true});
  const sourceAssets=resolve(sourceDirectory,'frontend');cpSync(output,sourceAssets,{recursive:true});
  const sourceManifest=resolve(sourceDirectory,'manifest.json');
  writeFrozenCheckpoint(sourceManifest,{version:1,root:sourceRoot,directory:sourceDirectory,assetsDirectory:sourceAssets,sources:captureValidationSources(sourceRoot),assets:captureValidationAssets(sourceAssets)});
  verifyFrozenValidation(sourceManifest,'copied-real-source');
  const originalSource=readFileSync(entry);
  try{writeFileSync(entry,Buffer.concat([originalSource,Buffer.from('\n')]));assert.throws(()=>verifyFrozenValidation(sourceManifest,'actual-copied-source-drift'),/Acceptance source drift/,'A real modified source was accepted');}
  finally{writeFileSync(entry,originalSource);}
  verifyFrozenValidation(sourceManifest,'restored-copied-real-source');
  writeFrozenCheckpoint(resolve(directory,'result.json'),{ok:true,page:selected,scope:'OFFLINE BUILD/HTTP/DRIFT ONLY — no native application acceptance',firstLoad:200,reload:409,realAssetDriftRejected:true,realSourceDriftRejected:true,...final});
  console.log(JSON.stringify({directory,ok:true,nativeAcceptance:false}));
}finally{await new Promise((resolveClose,reject)=>server.httpServer.close(error=>error?reject(error):resolveClose()));}
