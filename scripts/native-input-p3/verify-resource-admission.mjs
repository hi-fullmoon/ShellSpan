// Real packager invocations: default denial, retained previous output on a
// stale-source failure, and an explicitly scoped frozen validation bundle.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,readdir,mkdir,open} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {captureValidationSources} from '../native-input-p2/frozen-validation.mjs';
const root=resolve(process.argv[2]),sources=captureValidationSources(root),directory=resolve(root,'.artifacts/tests/native-input-p3/resource-admission',randomUUID());await mkdir(directory,{recursive:true});
async function tree(folder,result={}){for(const entry of await readdir(folder,{withFileTypes:true})){const path=resolve(folder,entry.name);assert(!entry.isSymbolicLink());if(entry.isDirectory())await tree(path,result);else result[relative(root,path)]=createHash('sha256').update(await readFile(path)).digest('hex');}return result;}
async function run(name,args){const log=await open(resolve(directory,`${name}.log`),'wx');const child=spawn(process.execPath,['scripts/prepare-native-input-resources.mjs','--no-build',...args],{cwd:root,stdio:['ignore',log.fd,log.fd]});const exit=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});await log.close();return exit;}
const production=resolve(root,'src-tauri/resources/native-input/generated');
const defaultExit=await run('default-unaccepted-host',['--target','x86_64-pc-windows-msvc']);assert.equal(defaultExit,0);
const actual=JSON.parse(await readFile(resolve(production,'resource-manifest.json'),'utf8'));assert.deepEqual(actual.targets,[]);assert(actual.unsupportedHost&&!actual.validationOnly);
const entries=await readdir(production);assert(!entries.some(name=>name.startsWith('editors-')||name.includes('zsh-')||name.includes('psreadline-')));
const bashExit=await run('default-bash',[]);if(bashExit===0){const manifest=JSON.parse(await readFile(resolve(production,'resource-manifest.json'),'utf8'));assert(manifest.targets.every(value=>value.startsWith('catalogue-'))&&!manifest.validationOnly);}
const previous=await tree(production),failureExit=await run('stale-windows-validation',['--validation-editor','windows-x64']);assert.notEqual(failureExit,0,'Actual stale Windows inputs unexpectedly passed');assert.deepEqual(await tree(production),previous,'Failed preparation modified the previous published output');
const validationExit=await run('explicit-validation',['--validation-editor','macos-arm64','--validation-editor','linux-aarch64-glibc-2.36']);
let validation;
if(validationExit===0){const text=await readFile(resolve(directory,'explicit-validation.log'),'utf8');validation=JSON.parse(text.trim());assert(validation.validationOnly&&validation.directory!==production);const manifest=JSON.parse(await readFile(resolve(validation.directory,'resource-manifest.json'),'utf8'));assert(manifest.validationOnly);assert.deepEqual(manifest.validationEditorTargets,['macos-arm64','linux-aarch64-glibc-2.36']);assert.deepEqual(await tree(production),previous,'Validation preparation changed the normal app output');}
assert.deepEqual(captureValidationSources(root),sources);
await writeFile(resolve(directory,'result.json'),JSON.stringify({root,sourceCount:Object.keys(sources).length,defaultExit,defaultManifest:actual,bashExit,failureExit,previousOutputRetained:true,validationExit,validation,scope:'resource admission/copy/source-package only; no platform execution or native-App acceptance'},null,2));
console.log(JSON.stringify({directory,defaultExit,failureExit,validationExit,validation}));assert.equal(validationExit,0);
