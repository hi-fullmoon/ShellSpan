// Read-only readiness check. It cannot install, launch, reserve a port or replay a case.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs,promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {dependencyInventory,hashFile} from './acceptance-inputs.mjs';
import {readReusablePackage} from './acceptance-package-reuse.mjs';

const {values}=parseArgs({options:{root:{type:'string'},artifact:{type:'string'},output:{type:'string'}}});
assert(values.root&&values.artifact&&values.output,'Explicit frozen root, artifact directory and new output required');
const owner=resolve(import.meta.dirname,'../../..'),root=fs.realpathSync(values.root),output=resolve(values.output);
assert(!fs.existsSync(output),'Never overwrite a prior verification result');
const execute=promisify(execFile),started=performance.now(),phases=[];
let report;
try{
  const before=performance.now(),dependencies=await dependencyInventory(resolve(root,'node_modules'));
  phases.push({name:'dependency-inventory',durationMs:performance.now()-before,files:Object.keys(dependencies.files).length,links:Object.keys(dependencies.links).length});
  const env={...process.env,RUSTUP_TOOLCHAIN:'1.95.0-x86_64-pc-windows-msvc'};
  const toolchain={node:process.version,rustc:(await execute('rustc',['-vV'],{env,windowsHide:true})).stdout,cargo:(await execute('cargo',['-V'],{env,windowsHide:true})).stdout,
    lockSha256:await hashFile(resolve(root,'pnpm-lock.yaml')),cargoLockSha256:await hashFile(resolve(root,'src-tauri/Cargo.lock'))};
  const verifyStarted=performance.now(),pkg=await readReusablePackage(owner,values.artifact,root,dependencies,toolchain);
  phases.push({name:'source-config-assets-resources-artifacts',durationMs:performance.now()-verifyStarted});
  report={ok:true,artifactSourceRoot:root,artifactDirectory:pkg.directory,artifactBatchId:pkg.batchId,origin:pkg.origin,install:pkg.plan.install,
    artifacts:pkg.artifacts,dependencySha256:dependencies.sha256,generatedOutputs:dependencies.generatedOutputs};
}catch(error){report={ok:false,error:String(error)};}
const auditorSources=Object.fromEntries(await Promise.all(['verify-retained-package.mjs','acceptance-package-reuse.mjs','acceptance-inputs.mjs'].map(async path=>[path,await hashFile(resolve(import.meta.dirname,path))])));
fs.mkdirSync(resolve(output,'..'),{recursive:true});
fs.writeFileSync(output,JSON.stringify({...report,phases,auditorSources,durationMs:performance.now()-started,execution:false,installed:false,appLaunched:false,
  nativeAcceptance:false,fullAcceptancePassed:false,runDeferredByUser:true},null,2),{flag:'wx'});
console.log(JSON.stringify({ok:report.ok,output,durationMs:performance.now()-started,error:report.error}));process.exitCode=report.ok?0:1;
