// Actual NSIS package/install/run/uninstall in an owned sealed source case.
// Use an empty resource bundle for the raw editing control.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdir,readFile,writeFile,appendFile,readdir,realpath,cp} from 'node:fs/promises';
import {resolve,relative,isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {homedir} from 'node:os';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {captureValidationSources} from '../integration/frozen-validation.mjs';
import {nativeInputReleaseDirectory} from '../integration/resource-paths.mjs';
import {acquireNativeGui,assertNativeGuiAllowed} from '../integration/gui-lock.mjs';
import {verifyNsisInstalledImage} from './windows-package-image.mjs';
import {packageFrontendDirectory,validationPackageMarker,packageResourceMapping,assertPackageResourcePaths,windowsPackageHost,windowsPackageScenario} from './package-config.mjs';
import {windowsPackageFileWitness} from './windows-package-witness.mjs';
import {recordWitnessFailure} from './windows-witness-diagnostic.mjs';
import {windowsBootstrapWitness} from './windows-bootstrap-witness.mjs';
import {packageAdmissionCases,packageAdmissionFault,admissionBootstrapList} from './windows-package-admission.mjs';
import {manualWindowMilliseconds,manualWindowTransition} from './windows-manual-window.mjs';

assert.equal(process.platform,'win32');assert.equal(process.arch,'x64');
assertNativeGuiAllowed();
const owner=resolve(import.meta.dirname,'../../..'),root=await realpath(process.argv[2]);
const owned=relative(resolve(owner,'artifacts/tests/p3'),root);assert(owned&&!owned.startsWith('..')&&!isAbsolute(owned));
const stage=JSON.parse(await readFile(resolve(root,'artifacts/tests/native-input/acceptance/candidate-stage.json'),'utf8'));assert(stage.sealed&&stage.root===root);
const before=captureValidationSources(root),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const nativeResources=process.argv[3]?await realpath(process.argv[3]):undefined;
if(nativeResources){const child=relative(root,nativeResources);assert(child&&!child.startsWith('..')&&!isAbsolute(child),'Validation inputs must be inside the sealed source');}
const validationOnly=Boolean(nativeResources);
const expectedHost=windowsPackageHost(process.argv[4]);
const {modelChain,manualDisplay}=windowsPackageScenario(process.argv[5],validationOnly);
const resourceAdmission=process.argv[5]==='resource-admission';
const modelValidation=process.argv[5]==='model-validation';
const modelSemantics=process.argv[5]==='model-semantics'||modelValidation;
assert.equal(sha(await readFile(fileURLToPath(import.meta.url))),before['scripts/native-input/acceptance/windows-package-smoke.mjs'],'Controller differs from sealed source');
const id=randomUUID(),short=id.slice(0,8),directory=resolve(root,'artifacts/tests/pk',short),install=resolve(directory,'i');
assert(!fs.existsSync(directory));await mkdir(directory,{recursive:true});
for(const name of ['home','data','webview'])await mkdir(resolve(directory,name));
const binaryName=`ShellSpanPkg${short}`,productName=`ShellSpan Package Acceptance ${short}`,identifier=`com.shellspan.validation.package.${id}`;
const env={...process.env,RUSTUP_TOOLCHAIN:'1.95.0-x86_64-pc-windows-msvc',CARGO_TARGET_DIR:resolve(owner,'src-tauri/target'),CARGO_BUILD_JOBS:'4',
 CARGO_HOME:process.env.CARGO_HOME??resolve(homedir(),'.cargo'),RUSTUP_HOME:process.env.RUSTUP_HOME??resolve(homedir(),'.rustup'),
 PSModuleAnalysisCachePath:resolve(directory,'module.cache'),HOME:resolve(directory,'home'),USERPROFILE:resolve(directory,'home'),
 SHELLSPAN_DATA_DIR:resolve(directory,'data'),SHELLSPAN_LOCAL_HOME:resolve(directory,'home'),SHELLSPAN_LOCAL_SHELL:expectedHost.executable};
delete env.SHELLSPAN_NATIVE_EDITOR_VALIDATION_ROOT;
// Build tools keep their normal Windows profile/cache resolution. Only the
// installed application and its observation helpers use the isolated home.
const toolEnv={...env};
for(const name of ['HOME','USERPROFILE']){if(process.env[name]===undefined)delete toolEnv[name];else toolEnv[name]=process.env[name];}
const execute=promisify(execFile),runs=[];
async function run(name,command,args,options={}){
 const fd=fs.openSync(resolve(directory,name+'.log'),'wx'),startedAt=new Date().toISOString();
 const child=spawn(command,args,{cwd:root,env:toolEnv,windowsHide:true,stdio:['ignore',fd,fd],...options});
 const exitCode=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);});fs.closeSync(fd);
 runs.push({name,command,args,pid:child.pid,startedAt,finishedAt:new Date().toISOString(),exitCode});await writeFile(resolve(directory,'phases.json'),JSON.stringify(runs,null,2));
 assert.equal(exitCode,0,`${name} failed; no automatic retry`);return child;
}
let settle,lastEvidence,packageStage='ordinary';
let manualPhase='waiting',manualStartedAt;
let reported=new Promise(done=>{settle=done;});
const application=resolve(install,binaryName+'.exe');
const captureFile=resolve(directory,'native-window.png');
let admissionBase,admissionIndex=-1;
async function restoreAdmission(){if(!admissionBase)return;for(const entry of admissionBase.catalogue.profiles)await writeFile(resolve(install,'native-input/generated',entry.module),admissionBase.libraries.get(entry.profile.shell));await writeFile(resolve(install,'native-input/generated/editors-windows-x64.json'),admissionBase.catalogueBytes);}
const server=createServer(async(request,response)=>{
 response.setHeader('Access-Control-Allow-Origin','*');response.setHeader('Access-Control-Allow-Headers','Content-Type');
 if(request.method==='OPTIONS'){response.writeHead(204).end();return;}
 if(resourceAdmission&&request.url===`/${id}/admission`){
  try{
   if(request.method==='GET'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({index:admissionIndex,nativeBootstrap:admissionBootstrapList(windowsBootstrapWitness(resolve(directory,'data')))}));return;}
   assert(request.method==='POST'&&admissionBase,'Admission switch requires the installed owned input');let body='';for await(const chunk of request){body+=chunk.toString();assert(body.length<=1024);}
   const value=JSON.parse(body);assert(Object.keys(value).length===1&&Number.isInteger(value.index)&&value.index===admissionIndex+1&&value.index<packageAdmissionCases.length,'Admission case order mismatch');
   assert(admissionBootstrapList(windowsBootstrapWitness(resolve(directory,'data'))).length===0,'Previous native host bootstrap has not exited');
   await restoreAdmission();const name=packageAdmissionCases[value.index],fault=packageAdmissionFault(admissionBase.catalogue,expectedHost.shell,name,admissionBase.libraries.get(expectedHost.shell)),resources=resolve(install,'native-input/generated'),target=resolve(resources,fault.module);assertPackageResourcePaths(root,install,[fault.module]);await mkdir(resolve(target,'..'),{recursive:true});await writeFile(target,fault.bytes);
   if(!['baseline','restored'].includes(name))await writeFile(resolve(resources,'editors-windows-x64.json'),JSON.stringify(fault.catalogue,null,2));admissionIndex=value.index;
   const record={index:admissionIndex,name,module:fault.module,moduleSha256:sha(fault.bytes),catalogueSha256:sha(await readFile(resolve(resources,'editors-windows-x64.json'))),expectedNative:fault.expectedNative,expectedRaw:fault.expectedRaw,explicitAbiRefusal:fault.explicitAbiRefusal};await appendFile(resolve(directory,'admission-inputs.jsonl'),JSON.stringify(record)+'\n');response.setHeader('Content-Type','application/json');response.end(JSON.stringify(record));return;
  }catch(error){await writeFile(resolve(directory,'admission-control-error.json'),JSON.stringify({error:String(error)},null,2));response.writeHead(500).end('Owned admission fixture switch failed');return;}
 }
 if(modelChain&&request.method==='GET'&&request.url===`/${id}/stage`){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({stage:packageStage}));return;}
 if(modelChain&&request.method==='GET'&&request.url===`/__native-file-witness/${id}`){
  try{response.setHeader('Content-Type','application/json');response.end(JSON.stringify(await windowsPackageFileWitness(resolve(directory,'data'),resolve(directory,'home'),id,modelSemantics)));}
  catch(error){await recordWitnessFailure(directory,'scratch-file',error.witnessStage??'owned-root-check',error);response.writeHead(500).end('Owned scratch witness unavailable');}return;
 }
 if(request.method!=='POST'||![`/${id}`,`/${id}/capture`,...(modelChain?[`/__agent-stream-result/${id}`,`/__package-capture/${id}`]:[])].includes(request.url)){response.writeHead(404).end();return;}
 try{
  if(request.url.endsWith('/capture')||request.url===`/__package-capture/${id}`){
   const output=['file-chain','semantics'].includes(packageStage)?resolve(directory,'model-native-window.png'):captureFile;
   const captured=await execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',resolve(root,'scripts/fixtures/windows-desktop-capture.ps1'),'-Executable',application,'-Output',output],{env,windowsHide:true,timeout:15000,encoding:'utf8'});
   response.setHeader('Content-Type','application/json');response.end(captured.stdout);return;
  }
  let body='';for await(const bytes of request){body+=bytes.toString();assert(body.length<=1048576);}
  const value=JSON.parse(body);lastEvidence=value;
  if(manualDisplay){const transition=manualWindowTransition(manualPhase,value);manualPhase=transition.phase;if(transition.startOperatorTimer){manualStartedAt=Date.now();if(timer){clearTimeout(timer);timer=setTimeout(()=>settle({ok:false,error:'MANUAL_OPERATOR_INCOMPLETE',blocked:true}),manualWindowMilliseconds);}}}
  if(manualDisplay)await appendFile(resolve(directory,'manual-progress.jsonl'),JSON.stringify(value)+'\n');
  if(resourceAdmission)await appendFile(resolve(directory,'admission-progress.jsonl'),JSON.stringify(value)+'\n');
  if(packageStage==='ordinary'){await writeFile(resolve(directory,'webview-evidence.json'),JSON.stringify(value,null,2));if(manualDisplay&&value.ready===true)await writeFile(resolve(directory,'manual-ready.json'),JSON.stringify(value,null,2));}
  else{if(value.evidence)await writeFile(resolve(directory,packageStage+'-webview-evidence.json'),JSON.stringify(value.evidence,null,2));if(typeof value.ok==='boolean')await writeFile(resolve(directory,packageStage+'-outcome.json'),JSON.stringify(value,null,2));}
  response.end('ok');if(typeof value.ok==='boolean')settle(value);
 }catch(error){response.writeHead(500).end(String(error));}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const report=`http://127.0.0.1:${server.address().port}/${id}`;
const page=resourceAdmission?'src/components/terminal/__tests__/native-resource-admission.native.html':manualDisplay?'src/components/terminal/__tests__/native-display-manual.native.html':modelChain?'src/components/terminal/__tests__/native-input-package-model.native.html':'src/components/terminal/__tests__/native-input-package.native.html';
const pageUrl=modelChain?page+'?'+new URLSearchParams({token:id,nativeP3:expectedHost.shell,reportOrigin:new URL(report).origin,packageModel:'true',semanticVariant:modelValidation?'validation':'headers'}):page;
await writeFile(resolve(directory,'plan.json'),JSON.stringify({root,directory,install,binaryName,productName,identifier,expectedHost,modelChain,modelSemantics,modelValidation,manualDisplay,resourceAdmission,sourceCount:Object.keys(before).length,validationOnly,nativeResources:nativeResources??null,scope:resourceAdmission?'Explicit installed application resource-fault matrix with restored controls and ordinary terminal availability. No model,Agent command or production policy change.':modelValidation?'Explicit validation-only installed release model chain:fixed user-authored dot-source expressions with explicit good/bad parameter validation,body-absence and parent recovery. No adapter wrapper,parameter repair,credential copy or production policy change.':modelSemantics?'Explicit validation-only installed release:ordinary initialization,existing release model connection,then frozen four-command parent-parser/default-failure/recovery chain. No parameter repair,credential copy,production admission change or publication.':manualDisplay?'Explicit validation-only installed release,real TerminalPane and operator mouse/clipboard/history checks. Ordinary fixture output only;no model/Agent command. Missing operator input is pending,not a passing case.':modelChain?'Explicit validation-only installed release:ordinary initialization,existing release route metadata import,bounded connection preflight,then real model four-tool scratch/native file chain. No credential copy,production admission change or publication.':validationOnly?'Explicit validation-only installed native resource binding and ordinary user diagnostics;depends on the same retained sealed source context. No Agent/model command,production admission or publication.':'Actual installed release default policy and raw editing; no model/native editor execution, no production admission change, no publication'},null,2));
let app,appDone,timer,releaseGui,observer,observerDone,installed=false,failure,installerHash,manualPending=false;
const observation=resolve(directory,'foreground.jsonl');
const cleanup=[];
try{
 await run('prepare-raw-control',process.execPath,[resolve(root,'scripts/native-input/prepare-resources.mjs'),'--no-build','--target','unsupported']);
 let nativeModuleSha;
 if(nativeResources){
  await run('prepare-validation',process.execPath,[resolve(root,'scripts/native-input/prepare-resources.mjs'),'--no-build','--target','x86_64-pc-windows-msvc','--validation-editor','windows-x64']);
  const prepared=JSON.parse((await readFile(resolve(directory,'prepare-validation.log'),'utf8')).trim());assert(prepared.validationOnly);const generated=nativeInputReleaseDirectory(root);await cp(prepared.directory,generated,{recursive:true});
  const catalogue=JSON.parse(await readFile(resolve(nativeResources,'editors-windows-x64.json'),'utf8'));assert.equal(catalogue.version,1);assert(catalogue.profiles.length===2);
  for(const [name,digest]of Object.entries(catalogue.sources))assert.equal(sha(await readFile(resolve(root,name))),digest,'Candidate source mismatch');
  for(const profile of catalogue.profiles){assert(/^[a-zA-Z0-9][a-zA-Z0-9.-]+$/.test(profile.profile.verifiedProfileId)&&profile.module===`${profile.profile.verifiedProfileId}/shellspan_native_input_editors.dll`&&!profile.module.includes('..'));const bytes=await readFile(resolve(nativeResources,profile.module));assert.equal(sha(bytes),profile.moduleSha256);nativeModuleSha??=profile.moduleSha256;assert.equal(profile.moduleSha256,nativeModuleSha);await mkdir(resolve(generated,profile.module,'..'),{recursive:true});await writeFile(resolve(generated,profile.module),bytes);}
  await writeFile(resolve(generated,'editors-windows-x64.json'),JSON.stringify(catalogue,null,2));const sourceBytes=await readFile(resolve(stage.directory,'sources.json'));const installedResources=resolve(install,'native-input/generated');await writeFile(resolve(generated,'editor-validation.json'),JSON.stringify(validationPackageMarker(root,installedResources,sha(sourceBytes)),null,2));env.SHELLSPAN_NATIVE_EDITOR_VALIDATION_ROOT=installedResources;
 }
 const resourceFiles=(await readdir(nativeInputReleaseDirectory(root),{recursive:true,withFileTypes:true})).filter(entry=>entry.isFile()).map(entry=>relative(nativeInputReleaseDirectory(root),join(entry.parentPath,entry.name)));
 assertPackageResourcePaths(root,install,resourceFiles);
 await writeFile(resolve(directory,'path-budget.json'),JSON.stringify({fileCount:resourceFiles.length,maxInput:Math.max(...resourceFiles.map(file=>resolve(nativeInputReleaseDirectory(root),file).length)),maxInstalled:Math.max(...resourceFiles.map(file=>resolve(install,'native-input/generated',file).length))},null,2));
 const manifest=await readFile(resolve(nativeInputReleaseDirectory(root),'resource-manifest.json'));
 const frontend=resolve(directory,'frontend');
 await build({configFile:false,root,base:'/',logLevel:'error',resolve:{alias:{'@':resolve(root,'src')}},plugins:[react(),tailwindcss()],define:{__PACKAGE_REPORT__:JSON.stringify(report),__PACKAGE_INSTALL_ROOT__:JSON.stringify(install),__PACKAGE_MANIFEST_SHA__:JSON.stringify(sha(manifest)),__PACKAGE_VALIDATION_ONLY__:JSON.stringify(validationOnly),__PACKAGE_NATIVE_SHA__:JSON.stringify(nativeModuleSha??null),__PACKAGE_SHELL_KIND__:JSON.stringify(expectedHost.shell),__PACKAGE_SHELL_VERSION__:JSON.stringify(expectedHost.expectedVersion)},build:{outDir:frontend,emptyOutDir:true,rolldownOptions:{input:resolve(root,page)}}});
 const config={productName,mainBinaryName:binaryName,identifier,build:{beforeBuildCommand:'',frontendDist:packageFrontendDirectory(root,frontend)},app:{appDirectoriesOverride:resolve(directory,'data'),windows:[{label:'main',title:productName,url:pageUrl,width:1480,height:920,visible:true,focus:true,alwaysOnTop:false,dataDirectory:resolve(directory,'webview')}],security:{csp:`default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ipc: http://ipc.localhost ${new URL(report).origin}; font-src 'self' data:`}},bundle:{createUpdaterArtifacts:false,windows:{webviewInstallMode:{type:'skip'},nsis:{installMode:'currentUser',startMenuFolder:productName,displayLanguageSelector:false}}}};
 config.bundle.resources=packageResourceMapping(root);
 const configFile=resolve(directory,'tauri-config.json');await writeFile(configFile,JSON.stringify(config,null,2));
 const cli=createRequire(import.meta.url).resolve('@tauri-apps/cli/tauri.js');
 await run('bundle',process.execPath,[cli,'build','--target','x86_64-pc-windows-msvc','--bundles','nsis','--config',configFile]);
 assert.deepEqual(captureValidationSources(root),before,'Source drift after package build');
 const bundles=resolve(owner,'src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis');
 const matches=(await readdir(bundles)).filter(name=>name.includes(short)&&name.endsWith('.exe'));assert.equal(matches.length,1);
 const installer=resolve(bundles,matches[0]);installerHash=sha(await readFile(installer));
 await writeFile(resolve(directory,'installer.json'),JSON.stringify({path:installer,sha256:installerHash,configFile},null,2));
 releaseGui=await acquireNativeGui();
 observer=spawn('D:/Programs/PowerShell/7/pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',resolve(root,'scripts/fixtures/windows-foreground-observe.ps1'),'-Output',observation],{cwd:root,env,windowsHide:true,stdio:'ignore'});
 observerDone=new Promise(done=>observer.once('close',done));
 assert(!fs.existsSync(install),'Install target must be fresh');installed=true;
 await run('install',installer,['/S',`/D=${install}`]);assert(fs.existsSync(application));
 const installedManifest=await readFile(resolve(install,'native-input/generated/resource-manifest.json'));assert.equal(sha(installedManifest),sha(manifest));
 if(resourceAdmission){const catalogueBytes=await readFile(resolve(install,'native-input/generated/editors-windows-x64.json')),catalogue=JSON.parse(catalogueBytes),libraries=new Map();for(const entry of catalogue.profiles){const bytes=await readFile(resolve(install,'native-input/generated',entry.module));assert.equal(sha(bytes),entry.moduleSha256);libraries.set(entry.profile.shell,bytes);}admissionBase={catalogueBytes,catalogue,libraries};}
 const installedBytes=await readFile(application);
 const releaseDirectory=resolve(owner,'src-tauri/target/x86_64-pc-windows-msvc/release');
 const compiledCandidates=[resolve(releaseDirectory,binaryName+'.exe'),resolve(releaseDirectory,'ShellSpan.exe')];
 const compiled=compiledCandidates.find(file=>fs.existsSync(file));assert(compiled,'Actual compiled PE is missing');
 const imageProof=verifyNsisInstalledImage(await readFile(compiled),installedBytes);
 await writeFile(resolve(directory,'installed-image.json'),JSON.stringify({compiled,application,...imageProof,manifestSha256:sha(installedManifest)},null,2));
 async function stopOwned(){
  assert(app&&app.exitCode===null&&app.signalCode===null,'Owned application ended before its controlled stop');
  await execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',resolve(root,'scripts/native-input/acceptance/windows-image.ps1'),'-Action','Stop','-ApplicationPid',String(app.pid),'-RunnerPid',String(process.pid),'-Executable',application],{env,windowsHide:true,timeout:20000});await appDone;cleanup.push(`Owned ${packageStage} application and descendants stopped`);app=undefined;
 }
 async function launch(label,timeout){
  packageStage=label;lastEvidence=undefined;reported=new Promise(done=>{settle=done;});
  app=spawn(application,[],{cwd:install,env,windowsHide:true,stdio:'ignore'});app.once('error',error=>settle({ok:false,error:String(error)}));appDone=new Promise(done=>app.once('close',done));
  const inspect=await execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',resolve(root,'scripts/native-input/acceptance/windows-image.ps1'),'-Action','Inspect','-ApplicationPid',String(app.pid),'-RunnerPid',String(process.pid),'-Executable',application],{env,windowsHide:true,timeout:20000,encoding:'utf8'});
  assert.equal(JSON.parse(inspect.stdout).sha256,imageProof.installedSha256,'Running image changed between package stages');await writeFile(resolve(directory,label==='ordinary'?'application.json':`application-${label}.json`),inspect.stdout);
  const remaining=manualDisplay&&manualStartedAt!==undefined?Math.max(0,manualWindowMilliseconds-(Date.now()-manualStartedAt)):timeout;
  timer=setTimeout(()=>{const operatorMissing=manualDisplay&&fs.existsSync(resolve(directory,'manual-ready.json'));settle({ok:false,error:operatorMissing?(manualStartedAt===undefined?'MANUAL_OPERATOR_REQUIRED':'MANUAL_OPERATOR_INCOMPLETE'):`Installed ${label} evidence timed out`,blocked:operatorMissing});},remaining);
  const outcome=await reported;clearTimeout(timer);manualPending=outcome.blocked===true;assert.equal(outcome.ok,true,outcome.error);
 }
 await launch('ordinary',manualDisplay?manualWindowMilliseconds:resourceAdmission?300000:90000);assert(fs.existsSync(captureFile));
 if(modelChain){
  await stopOwned();
  await run('route-metadata',process.execPath,[resolve(root,'scripts/fixtures/windows-desktop-data.mjs'),'C:/Users/zhengbiwen/.shellspan/shellspan-main.db',resolve(directory,'data')]);
  await launch('preflight',60000);await stopOwned();
  const modelStage=modelSemantics?'semantics':'file-chain';await launch(modelStage,210000);
  const evidence=JSON.parse(await readFile(resolve(directory,modelStage+'-webview-evidence.json'),'utf8'));assert(!evidence.failed&&evidence.kind===(modelSemantics?'actual-native-parent-semantics':'actual-native-file-chain'));if(modelValidation)assert.equal(evidence.variant,'validation');assert.equal(evidence.loadedCore.sha256,nativeModuleSha);assert.equal(evidence.before.session.nativePeerProfile.shell,expectedHost.shell);assert.equal(evidence.before.session.nativePeerProfile.shellVersion,expectedHost.expectedVersion);assert(fs.existsSync(resolve(directory,'model-native-window.png')));
 }
}catch(error){failure=String(error);}
finally{
 clearTimeout(timer);
 if(app&&app.exitCode===null&&app.signalCode===null){try{await execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',resolve(root,'scripts/native-input/acceptance/windows-image.ps1'),'-Action','Stop','-ApplicationPid',String(app.pid),'-RunnerPid',String(process.pid),'-Executable',application],{env,windowsHide:true,timeout:20000});await appDone;cleanup.push('Owned application and descendants stopped');}catch(error){cleanup.push(String(error));failure??=String(error);}}
 if(observer){await writeFile(observation+'.stop','stop',{flag:'wx'});const code=await observerDone;if(code!==0)failure??='Passive foreground observer failed';}
 if(resourceAdmission){try{await restoreAdmission();cleanup.push('Owned admission catalogue and baseline modules restored');}catch(error){failure??=String(error);}}
 if(installed){const uninstaller=resolve(install,'uninstall.exe');if(fs.existsSync(uninstaller)){try{await run('uninstall',uninstaller,['/S',`_?=${install}`]);assert(!fs.existsSync(application),'Installed executable remains after uninstall');cleanup.push('Owned installer uninstalled its executable');}catch(error){cleanup.push(String(error));failure??=String(error);}}else{cleanup.push('Installer did not leave an uninstaller');failure??='No uninstaller for attempted installation';}}
 releaseGui?.();await new Promise(done=>server.close(done));
 const after=captureValidationSources(root);const drift=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(path=>before[path]!==after[path]);
 if(drift.length)failure??='Source drift after package smoke';
 await writeFile(resolve(directory,'result.json'),JSON.stringify({ok:!failure,failure,installerHash,runs,cleanup,sourceDrift:drift,webviewReported:Boolean(lastEvidence),validationOnly,modelChain,modelSemantics,modelValidation,manualDisplay,manualPending,resourceAdmission,nativeResources:nativeResources??null,productionAdmissionChanged:false,fullAcceptancePassed:false},null,2));
 console.log(JSON.stringify({directory,ok:!failure,failure,cleanup,sourceDrift:drift}));
}
process.exitCode=failure?1:0;
