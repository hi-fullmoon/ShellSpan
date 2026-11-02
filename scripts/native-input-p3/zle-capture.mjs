import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile,copyFile,chmod,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {captureValidationSources} from '../native-input-p2/frozen-validation.mjs';
import {auditEditorResources} from './editor-resources.mjs';
assert.equal(process.platform,'darwin');
const root=resolve(import.meta.dirname,'../..');const directory=resolve(root,'.native-input-p3/geometry-capture',randomUUID());await mkdir(directory,{recursive:true});
assert.equal(JSON.parse(await readFile(resolve(root,'.native-input-p3/snapshot-index.json'),'utf8')).root,root,'Use a complete isolated source snapshot');
const eof=process.argv[2]==='eof',guards=process.argv[2]==='guards';assert(process.argv.length===2||eof||guards);
const expectedCases=guards?5:eof?14:1;
const resourcesBefore=auditEditorResources(root,'macos-arm64');assert(resourcesBefore.selectedValid);
const sources=captureValidationSources(root);const target=process.env.CARGO_TARGET_DIR;assert(target,'Explicit owned component build cache required');
const build=spawn('cargo',['test','--locked','--manifest-path','src-tauri/Cargo.toml','--lib','--no-run','--message-format=json-render-diagnostics'],{cwd:root,stdio:['ignore','pipe','pipe']});
let executable;const diagnostics=[];build.stderr.on('data',bytes=>diagnostics.push(bytes));
const built=new Promise((resolve,reject)=>{build.once('error',reject);build.once('exit',resolve);});
for await(const line of createInterface({input:build.stdout})){
  if(!line.trim())continue;const event=JSON.parse(line);
  if(event.reason==='compiler-message'&&event.message.rendered)diagnostics.push(Buffer.from(event.message.rendered));
  if(event.reason==='compiler-artifact'&&event.profile.test&&event.executable){assert(!executable||executable===event.executable);executable=event.executable;}
}
const buildCode=await built;await writeFile(resolve(directory,'build.log'),Buffer.concat(diagnostics));assert.equal(buildCode,0);assert(executable);
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const shellSha256=await hash('/bin/zsh');
const binary=resolve(directory,'native-zle-tests');const digest=await hash(executable);await copyFile(executable,binary);await chmod(binary,0o700);assert.equal(await hash(binary),digest);
const actual=resolve(root,guards?'.native-input-p3/zle-guards':eof?'.native-input-p3/zle-eof':'.native-input-p3/production-zle');await mkdir(actual,{recursive:true});
const results=[];
for(const entry of(guards?[{columns:100,stage:'guards'}]:eof?[{columns:100,stage:'eof'}]:[...[32,40,100,180].map(columns=>({columns,stage:'running'})),{columns:100,stage:'handoff'}])){
  const before=new Set(await readdir(actual));const log=await open(resolve(directory,`${entry.columns}-${entry.stage}.log`),'wx');
  const child=spawn(binary,[guards?'terminal_command::zle_tests::native_zle_private_namespace_guards_preserve_user_definitions':eof?'terminal_command::zle_tests::native_zle_private_eof_preserves_ordinary_input_and_user_hooks':'terminal_command::zle_tests::native_zle_production_startup_parent_parser_and_jobs','--ignored','--exact'],{cwd:root,stdio:['ignore',log.fd,log.fd],
    env:{...process.env,SHELLSPAN_P3_TEST_COLUMNS:String(entry.columns),SHELLSPAN_P3_INTERRUPT_STAGE:entry.stage}});
  const exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});await log.close();
  const created=(await readdir(actual)).filter(name=>!before.has(name));assert(created.length>0&&created.length<=expectedCases);
  const observations=[];for(const name of created){const evidence=resolve(actual,name);observations.push({evidence,...JSON.parse(await readFile(resolve(evidence,'result.json'),'utf8'))});}
  const evidence=actual;const observed={ok:observations.every(value=>value.ok)&&observations.length===expectedCases,observations};
  assert.equal(await hash(binary),digest,'Actual component test executable changed during execution');
  results.push({...entry,exitCode,evidence,observed});
}
assert.deepEqual(captureValidationSources(root),sources,'Complete component source set changed');
assert.deepEqual(auditEditorResources(root,'macos-arm64'),resourcesBefore);assert.equal(await hash('/bin/zsh'),shellSha256);
await writeFile(resolve(directory,'result.json'),JSON.stringify({binarySha256:digest,shellSha256,sourceCount:Object.keys(sources).length,resources:resourcesBefore,results},null,2));
console.log(JSON.stringify({directory,results:results.map(({columns,stage,exitCode,evidence})=>({columns,stage,exitCode,evidence}))}));
assert(results.every(value=>value.exitCode===0&&value.observed.ok),'An actual component round failed; each original result is retained');
