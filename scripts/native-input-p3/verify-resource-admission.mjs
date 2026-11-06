// Run real preparation in a sealed source copy. Corrupt and restore the
// negative resource explicitly; current Windows inputs need not be stale.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,readdir,mkdir,open,copyFile,chmod} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';
import {captureValidationSources} from '../native-input-p2/frozen-validation.mjs';
import {nativeInputReleaseDirectory} from '../native-input-p2/resource-paths.mjs';
import {createIndexReader} from './index-reader.mjs';

const {values,positionals}=parseArgs({allowPositionals:true,options:{'validation-editor':{type:'string',multiple:true}}});
assert.equal(positionals.length,1,'Provide one sealed source root');
const root=resolve(positionals[0]);
const stage=JSON.parse(await readFile(resolve(root,'.artifacts/tests/native-input-p3/candidate-stage.json'),'utf8'));
assert(stage.sealed&&resolve(stage.root)===root,'Resource admission requires a sealed source copy');
const policy=JSON.parse(await readFile(resolve(root,'protocol/agent/runtime/native-editor-admission.json'),'utf8'));
assert.deepEqual(policy.productionProfiles,[],'This denial regression must not alter production admission');
const host=process.platform==='win32'&&process.arch==='x64'?'windows-x64':process.platform==='darwin'&&process.arch==='arm64'?'macos-arm64':process.platform==='linux'&&process.arch==='arm64'?'linux-aarch64-glibc-2.36':undefined;
assert(host,'An actual supported build host is required');
const validationTargets=values['validation-editor']??[host];
assert(validationTargets.length>0&&new Set(validationTargets).size===validationTargets.length);
assert(validationTargets.every(t=>['windows-x64','macos-arm64','linux-aarch64-glibc-2.36'].includes(t)));
const target=host==='windows-x64'?'x86_64-pc-windows-msvc':host==='macos-arm64'?'aarch64-apple-darwin':'aarch64-unknown-linux-gnu';
const sources=captureValidationSources(root),directory=resolve(root,'.artifacts/tests/native-input-p3/resource-admission',randomUUID());
await mkdir(directory,{recursive:true});
const sha=b=>createHash('sha256').update(b).digest('hex');
async function tree(folder,result={}){for(const entry of await readdir(folder,{withFileTypes:true})){const path=resolve(folder,entry.name);assert(!entry.isSymbolicLink());if(entry.isDirectory())await tree(path,result);else result[relative(root,path)]=sha(await readFile(path));}return result;}
async function run(name,args,cwd=root){const log=await open(resolve(directory,`${name}.log`),'wx');const child=spawn(process.execPath,['scripts/prepare-native-input-resources.mjs','--no-build',...args],{cwd,stdio:['ignore',log.fd,log.fd]});const exit=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});await log.close();return exit;}
const production=nativeInputReleaseDirectory(root);
const defaultExit=await run('default-denial',['--target','x86_64-pc-windows-msvc']);assert.equal(defaultExit,0);
const actual=JSON.parse(await readFile(resolve(production,'resource-manifest.json'),'utf8'));assert.deepEqual(actual.targets,[]);assert(actual.unsupportedHost&&!actual.validationOnly);
assert.deepEqual((await readdir(production)).sort(),['resource-manifest.json']);
const previous=await tree(production),cataloguePath=resolve(root,`.artifacts/tests/native-input-p2/resources/native-input/editors-${validationTargets[0]}.json`);
const original=await readFile(cataloguePath),stale=JSON.parse(original.toString('utf8'));
// Keep the independent Windows Git reader below MAX_PATH as well as the parent
// snapshot. A deeply nested second snapshot makes Git reject its own GIT_DIR.
const negativeDirectory=resolve(root,'.artifacts/tests/n',randomUUID()),negativeRoot=resolve(negativeDirectory,'s');
await mkdir(negativeRoot,{recursive:true});
for(const name of Object.keys(sources)){await mkdir(resolve(negativeRoot,name,'..'),{recursive:true});await copyFile(resolve(root,name),resolve(negativeRoot,name));}
const meta=resolve(negativeRoot,'.artifacts/tests/native-input-p3');await mkdir(meta,{recursive:true});
const parentIndex=JSON.parse(await readFile(resolve(root,'.artifacts/tests/native-input-p3/snapshot-index.json'),'utf8'));
const {gitDirectory,index}=createIndexReader(meta,parentIndex.index,stage.head);
await chmod(index,0o400);
await writeFile(resolve(meta,'snapshot-index.json'),JSON.stringify({root:negativeRoot,index,indexSha256:sha(await readFile(index)),gitDirectory}));
await writeFile(resolve(negativeDirectory,'sources.json'),JSON.stringify(sources));
await writeFile(resolve(meta,'candidate-stage.json'),JSON.stringify({root:negativeRoot,directory:negativeDirectory,owner:root,sealed:true}));
assert.deepEqual(captureValidationSources(negativeRoot),sources,'The negative source copy differs');
const negativeCatalogue=resolve(negativeRoot,relative(root,cataloguePath));await mkdir(resolve(negativeCatalogue,'..'),{recursive:true});
for(const profile of stale.profiles)for(const name of [profile.module,profile.shell,profile.relay,profile.core,profile.coreLicense].filter(Boolean)){
  assert(name.startsWith(`${profile.profile.verifiedProfileId}/`)&&!name.includes('..')&&!name.includes('\\'),'Invalid negative resource path');
  const path=resolve(negativeRoot,'.artifacts/tests/native-input-p2/resources/native-input',name);await mkdir(resolve(path,'..'),{recursive:true});await copyFile(resolve(root,'.artifacts/tests/native-input-p2/resources/native-input',name),path);
}
const sourceName=Object.keys(stale.sources)[0];assert(sourceName,'The negative must corrupt an actual pinned source');
stale.sources[sourceName]=stale.sources[sourceName]==='0'.repeat(64)?'1'.repeat(64):'0'.repeat(64);
const corrupted=Buffer.from(JSON.stringify(stale));await writeFile(negativeCatalogue,corrupted);
const failureExit=await run('explicit-stale-editor',['--target',target,'--validation-editor',validationTargets[0]],negativeRoot);assert.notEqual(failureExit,0,'Corrupted source metadata unexpectedly passed');
assert((await readFile(resolve(directory,'explicit-stale-editor.log'),'utf8')).includes(`Stale editor source: ${sourceName}`),'The negative failed outside the intended stale-source check');
assert.deepEqual(await tree(production),previous,'A failed validation replaced production output');
const validationExit=await run('explicit-validation',['--target',target,...validationTargets.flatMap(t=>['--validation-editor',t])]);assert.equal(validationExit,0,'Current scoped validation preparation failed');
const validation=JSON.parse((await readFile(resolve(directory,'explicit-validation.log'),'utf8')).trim());
assert(validation.validationOnly&&validation.directory!==production);
const manifest=JSON.parse(await readFile(resolve(validation.directory,'resource-manifest.json'),'utf8'));assert(manifest.validationOnly);assert.deepEqual(manifest.validationEditorTargets,validationTargets);
assert.deepEqual(await tree(production),previous,'Scoped validation changed production output');
assert.deepEqual(await readFile(cataloguePath),original,'The negative resource was not restored');
assert.deepEqual(captureValidationSources(root),sources,'Source inventory drift');
await writeFile(resolve(directory,'result.json'),JSON.stringify({root,sourceCount:Object.keys(sources).length,defaultExit,defaultManifest:actual,failureExit,negative:{root:negativeRoot,catalogue:relative(negativeRoot,negativeCatalogue),sourceName,originalSha256:sha(original),corruptedSha256:sha(corrupted),validInputUnchanged:true},previousOutputRetained:true,validationExit,validationTargets,validation,scope:'Actual resource admission/copy/vendor-source preparation; no platform execution, App or model acceptance'},null,2));
console.log(JSON.stringify({directory,defaultExit,failureExit,validationExit,validationTargets,validation}));
