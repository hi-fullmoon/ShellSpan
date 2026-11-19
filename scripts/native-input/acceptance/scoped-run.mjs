// External audit runner for sealed experimental source. No production routing.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile,writeFile,mkdir,readdir,copyFile,chmod,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {captureValidationSources} from '../integration/frozen-validation.mjs';
import {auditEditorResources} from './editor-resources.mjs';
import {editorValidationEnvironment} from './editor-validation.mjs';
const root=resolve(process.argv[2]),mode=process.argv[3];assert(['normal','eof','guards','binding','paths','admission','bash'].includes(mode));assert(process.env.CARGO_TARGET_DIR);
const expectedCases=Number(process.argv[4]??(['normal','binding','paths','admission','bash'].includes(mode)?1:mode==='eof'?14:11));assert(Number.isSafeInteger(expectedCases)&&expectedCases>0&&expectedCases<=64);
const stage=JSON.parse(await readFile(resolve(root,'artifacts/tests/native-input/acceptance/candidate-stage.json'),'utf8'));assert(stage.sealed&&stage.root===root&&stage.nativeAcceptance===false);
const sources=captureValidationSources(root);assert.deepEqual(sources,JSON.parse(await readFile(resolve(stage.directory,'sources.json'),'utf8')));
const resources=auditEditorResources(root,'macos-arm64');assert(resources.selectedValid);
const selectedResources=process.env.SHELLSPAN_P3_PACKAGED_RESOURCE_ROOT??resolve(root,'artifacts/tests/native-input/integration/resources/native-input');
const validation=mode==='admission'?{}:await editorValidationEnvironment(root,selectedResources,['macos-arm64']);
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
assert.equal(await hash('/bin/zsh'),stage.mainSha256);assert.equal(await hash(stage.core),stage.coreSha256);
const directory=resolve(root,'artifacts/tests/native-input/acceptance/scoped-runs',randomUUID());await mkdir(directory,{recursive:true});
const build=spawn('cargo',['test','--locked','--manifest-path','src-tauri/Cargo.toml','--lib','--no-run','--message-format=json-render-diagnostics'],{cwd:root,stdio:['ignore','pipe','pipe']});const diagnostics=[];build.stderr.on('data',bytes=>diagnostics.push(bytes));
const built=new Promise((resolve,reject)=>{build.once('error',reject);build.once('exit',resolve);});let executable;
for await(const line of createInterface({input:build.stdout})){if(!line.trim())continue;const event=JSON.parse(line);if(event.reason==='compiler-message'&&event.message.rendered)diagnostics.push(Buffer.from(event.message.rendered));if(event.reason==='compiler-artifact'&&event.profile.test&&event.executable){assert(!executable||executable===event.executable);executable=event.executable;}}
const buildCode=await built;await writeFile(resolve(directory,'build.log'),Buffer.concat(diagnostics));assert.equal(buildCode,0);assert(executable);
const binary=resolve(directory,'actual-scoped-nip-tests'),binarySha256=await hash(executable);await copyFile(executable,binary);await chmod(binary,0o700);assert.equal(await hash(binary),binarySha256);
const folder=resolve(root,mode==='normal'?'artifacts/tests/native-input/acceptance/production-zle':mode==='eof'?'artifacts/tests/native-input/acceptance/zle-eof':mode==='binding'?'artifacts/tests/native-input/acceptance/broker-display-binding':mode==='paths'?'artifacts/tests/native-input/acceptance/manifest-paths':mode==='admission'?'artifacts/tests/native-input/acceptance/editor-admission':mode==='bash'?'artifacts/tests/native-input/acceptance/prepared-bash':'artifacts/tests/native-input/acceptance/zle-guards');await mkdir(folder,{recursive:true});const before=new Set(await readdir(folder));
const name=mode==='normal'?'native_zle_production_startup_parent_parser_and_jobs':mode==='eof'?'native_zle_private_eof_preserves_ordinary_input_and_user_hooks':mode==='binding'?'native_zle_actual_broker_display_binding':mode==='paths'?'native_zle_manifest_paths_reject_before_prepare':mode==='admission'?'native_zle_stock_shell_is_admitted_without_validation':mode==='bash'?'prepared_bash_real_submit_draft_cancel_and_running_interrupt':'native_zle_private_namespace_guards_preserve_user_definitions';
const environment={...process.env,...validation,SHELLSPAN_P3_INTERRUPT_STAGE:'running'};if(mode==='admission')delete environment.SHELLSPAN_NATIVE_EDITOR_VALIDATION_ROOT;
const log=await open(resolve(directory,'test.log'),'wx');const child=spawn(binary,[`terminal_command::${mode==='bash'?'local_tests':'zle_tests'}::${name}`,'--ignored','--exact'],{cwd:root,stdio:['ignore',log.fd,log.fd],env:environment});
const exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});await log.close();
const observations=[];for(const name of(await readdir(folder)).filter(name=>!before.has(name))){const evidence=resolve(folder,name);observations.push({evidence,...JSON.parse(await readFile(resolve(evidence,'result.json'),'utf8'))});}
assert.equal(await hash(binary),binarySha256);assert.equal(await hash(stage.core),stage.coreSha256);assert.equal(await hash('/bin/zsh'),stage.mainSha256);assert.deepEqual(captureValidationSources(root),sources);assert.deepEqual(auditEditorResources(root,'macos-arm64'),resources);
await writeFile(resolve(directory,'result.json'),JSON.stringify({root,mode,directory,exitCode,expectedCases,binarySha256,coreSha256:stage.coreSha256,mainSha256:stage.mainSha256,sourceCount:Object.keys(sources).length,nativeAcceptance:false,productionBindingChanged:false,observations},null,2));
console.log(JSON.stringify({directory,mode,exitCode,cases:observations.length}));
assert.equal(exitCode,0);assert.equal(observations.length,expectedCases);assert(observations.every(value=>value.ok));
