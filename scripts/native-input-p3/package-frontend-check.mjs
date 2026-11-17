// Independent compilation only. A stale native catalogue is neither admitted
// nor rebuilt here; this cannot produce package/App/model acceptance evidence.
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildPackageFrontend} from './package-frontend.mjs';
import {captureValidationSources} from '../native-input-p2/frozen-validation.mjs';
import {inside,hashFile} from './acceptance-inputs.mjs';

const owner=resolve(import.meta.dirname,'../..'),root=await realpath(process.argv[2]);inside(resolve(owner,'artifacts/tests/p3'),root);
const before=captureValidationSources(root),frozen=JSON.parse(await readFile(resolve(root,'../sources.json'),'utf8'));assert.deepEqual(before,frozen);
const id=randomUUID(),directory=resolve(root,'artifacts/tests/frontend-check',id);await mkdir(directory,{recursive:true});
let result;
try{const built=await buildPackageFrontend(root,directory,'http://127.0.0.1:12345',id);assert.deepEqual(captureValidationSources(root),before);result={ok:true,assets:built.assets,durationMs:built.durationMs};}
catch(error){result={ok:false,error:String(error)};}
const controllerSources=Object.fromEntries(await Promise.all(['package-frontend-check.mjs','package-frontend.mjs','package-launch.mjs'].map(async path=>[path,await hashFile(resolve(import.meta.dirname,path))])));
await writeFile(resolve(directory,'result.json'),JSON.stringify({...result,controllerSources,validation:'frontend-compilation-only',appLaunched:false,modelCalls:0,nativeAcceptance:false,fullAcceptancePassed:false},null,2),{flag:'wx'});
console.log(JSON.stringify({directory,ok:result.ok,assetCount:result.assets?Object.keys(result.assets).length:0,durationMs:result.durationMs,error:result.error}));process.exitCode=result.ok?0:1;
