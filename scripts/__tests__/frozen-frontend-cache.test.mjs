import fs from 'node:fs';
import p from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {expect,it} from 'vitest';
import {buildFrozenFrontend} from '../native-input-p3/frozen-frontend-cache.mjs';
import {captureValidationAssets,captureValidationSources} from '../native-input-p2/frozen-validation.mjs';

const artifacts=p.resolve(import.meta.dirname,'../../.artifacts/tests/frozen-frontend-cache');
function fixture(){
  const root=p.join(artifacts,randomUUID());fs.mkdirSync(root,{recursive:true});
  execFileSync('git',['init','--quiet',root]);
  fs.writeFileSync(p.join(root,'.gitignore'),'.artifacts/\nnode_modules/\n');
  fs.writeFileSync(p.join(root,'entry.html'),'<html>source</html>');
  fs.mkdirSync(p.join(root,'node_modules/pkg'),{recursive:true});
  fs.writeFileSync(p.join(root,'node_modules/pkg/input.js'),'dependency-v1');
  const cacheRoot=p.join(root,'.artifacts/tests/frontend-cache');
  let compiled=0;
  function options(){
    const evidence=p.join(root,'.artifacts/tests/native-input-p2',randomUUID());fs.mkdirSync(evidence,{recursive:true});
    const output=p.join(evidence,'frontend');
    return{root,output,entry:'entry.html',sources:captureValidationSources(root),cacheRoot,build:async()=>{
      compiled++;fs.mkdirSync(p.join(output,'assets'),{recursive:true});
      fs.writeFileSync(p.join(output,'entry.html'),'<script src="assets/app.js"></script>');
      fs.writeFileSync(p.join(output,'assets/app.js'),'window.componentOnly=true;');
    }};
  }
  return{root,cacheRoot,options,count:()=>compiled};
}
it('reuses identical static bytes in a new case while retaining a separate receipt',async()=>{
  const f=fixture(),first=f.options(),built=await buildFrozenFrontend(first),second=f.options(),reused=await buildFrozenFrontend(second);
  expect(f.count()).toBe(1);expect(built.reused).toBe(false);expect(reused.reused).toBe(true);
  expect(reused.manifestSha256).toBe(built.manifestSha256);
  expect(captureValidationAssets(second.output)).toEqual(captureValidationAssets(first.output));
  expect(second.output).not.toBe(first.output);
});
it('builds separately when source, installed dependency, entry, or build environment changes',async()=>{
  const f=fixture(),first=await buildFrozenFrontend(f.options());
  fs.writeFileSync(p.join(f.root,'entry.html'),'<html>changed source</html>');
  const source=await buildFrozenFrontend(f.options());expect(source.key).not.toBe(first.key);
  fs.writeFileSync(p.join(f.root,'node_modules/pkg/input.js'),'dependency-v2');
  const dependency=await buildFrozenFrontend(f.options());expect(dependency.key).not.toBe(source.key);
  fs.writeFileSync(p.join(f.root,'second.html'),'<html>second entry</html>');
  const options=f.options();options.entry='second.html';
  const entry=await buildFrozenFrontend(options);expect(entry.key).not.toBe(dependency.key);
  fs.writeFileSync(p.join(f.root,'.env.production'),'VITE_COMPONENT_ONLY=changed\n');
  const environment=await buildFrozenFrontend({...f.options(),entry:'second.html'});expect(environment.key).not.toBe(entry.key);
  expect(f.count()).toBe(5);
});
it('refuses corrupted cached bytes without silently rebuilding',async()=>{
  const f=fixture(),built=await buildFrozenFrontend(f.options());
  fs.writeFileSync(p.join(p.dirname(built.manifest),'assets/assets/app.js'),'corrupt');
  await expect(buildFrozenFrontend(f.options())).rejects.toThrow('asset integrity changed');
  expect(f.count()).toBe(1);
});
it('refuses an unexpected cached asset and altered manifest provenance',async()=>{
  const f=fixture(),built=await buildFrozenFrontend(f.options()),directory=p.dirname(built.manifest);
  fs.writeFileSync(p.join(directory,'assets/extra.js'),'extra');
  await expect(buildFrozenFrontend(f.options())).rejects.toThrow('asset integrity changed');
  const g=fixture(),record=await buildFrozenFrontend(g.options()),manifest=JSON.parse(fs.readFileSync(record.manifest));
  manifest.inputs.pipeline='other';fs.writeFileSync(record.manifest,JSON.stringify(manifest));
  await expect(buildFrozenFrontend(g.options())).rejects.toThrow('input provenance changed');
});
it('refuses an incomplete cache publication without silently recompiling',async()=>{
  const f=fixture(),built=await buildFrozenFrontend(f.options());
  fs.renameSync(built.manifest,built.manifest+'.component-interrupted');
  await expect(buildFrozenFrontend(f.options())).rejects.toThrow();
  expect(f.count()).toBe(1);
});
it('refuses source and dependency drift during compilation before publishing a reusable result',async()=>{
  for(const input of ['entry.html','node_modules/pkg/input.js']){
    const f=fixture(),options=f.options(),compile=options.build;
    options.build=async()=>{await compile();fs.writeFileSync(p.join(f.root,input),'changed during compilation');};
    await expect(buildFrozenFrontend(options)).rejects.toThrow(/changed during build/);
    expect(fs.readdirSync(f.cacheRoot)).toEqual([]);
  }
});
it('refuses paths outside the owned scope, linked cache roots, and overwriting case output',async()=>{
  const f=fixture(),outside={...f.options(),cacheRoot:p.join(f.root,'outside')};
  await expect(buildFrozenFrontend(outside)).rejects.toThrow('owned test artifacts');
  const first=f.options();await buildFrozenFrontend(first);
  await expect(buildFrozenFrontend(first)).rejects.toThrow('Never overwrite');
  const link=p.join(f.root,'.artifacts/tests/cache-link');fs.symlinkSync(f.cacheRoot,link,process.platform==='win32'?'junction':'dir');
  await expect(buildFrozenFrontend({...f.options(),cacheRoot:link})).rejects.toThrow('must not be a link');
});
it('preserves ordinary compilation when cache is not explicitly enabled',async()=>{
  let called=0;expect(await buildFrozenFrontend({build:async()=>{called++;}})).toEqual({enabled:false,reused:false});expect(called).toBe(1);
});
it('refuses linked cache ancestors before creating a missing directory at their target',async()=>{
  const f=fixture(),foreign=p.join(f.root,'outside-cache-scope'),link=p.join(f.root,'.artifacts/tests/cache-parent');
  fs.mkdirSync(foreign);fs.mkdirSync(p.dirname(link),{recursive:true});
  fs.symlinkSync(foreign,link,process.platform==='win32'?'junction':'dir');
  await expect(buildFrozenFrontend({...f.options(),cacheRoot:p.join(link,'must-not-exist')})).rejects.toThrow(/link/);
  expect(fs.existsSync(p.join(foreign,'must-not-exist'))).toBe(false);expect(f.count()).toBe(0);
});
it('matches Vite initializing an absent NODE_ENV without losing reuse or changing explicit values',async()=>{
  const previous=process.env.NODE_ENV,previousUser=process.env.VITE_USER_NODE_ENV;
  try{
    delete process.env.NODE_ENV;delete process.env.VITE_USER_NODE_ENV;
    const f=fixture(),first=f.options(),compile=first.build;
    first.build=async()=>{process.env.NODE_ENV='production';await compile();};
    const built=await buildFrozenFrontend(first),reused=await buildFrozenFrontend(f.options());
    expect(reused.key).toBe(built.key);expect(reused.reused).toBe(true);
    process.env.NODE_ENV='development';
    const changed=await buildFrozenFrontend(f.options());expect(changed.key).not.toBe(built.key);
  }finally{
    if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;
    if(previousUser===undefined)delete process.env.VITE_USER_NODE_ENV;else process.env.VITE_USER_NODE_ENV=previousUser;
  }
});
