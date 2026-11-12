// Additive batch runner. The original single-package/fault/manual acceptance
// remains available and unchanged. This never resumes an existing batch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdir,readFile,writeFile,readdir,realpath,copyFile,unlink} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify,parseArgs} from 'node:util';
import {createServer} from 'node:http';
import {captureValidationSources,captureValidationAssets} from '../native-input-p2/frozen-validation.mjs';
import {nativeInputReleaseDirectory} from '../native-input-p2/resource-paths.mjs';
import {acquireNativeGui,assertNativeGuiAllowed} from '../native-input-p2/gui-lock.mjs';
import {verifyNsisInstalledImage} from './windows-package-image.mjs';
import {selectWindowsProfiles} from './windows-profiles.mjs';
import {packageFrontendDirectory,validationPackageMarker,packageResourceMapping,assertPackageResourcePaths} from './package-config.mjs';
import {windowsPackageFileWitness} from './windows-package-witness.mjs';
import {windowsBootstrapWitness} from './windows-bootstrap-witness.mjs';
import {hashFile,fingerprint,fingerprints,verifyRetainedArtifacts,inside,dependencyInventory,stageToolchains} from './acceptance-inputs.mjs';
import {withLease,runInstalledCases,backgroundQueue,watchBatchCancellation} from './acceptance-queue.mjs';
import {summarize,sealCase,retainSealedCase,modelEvidenceMetrics} from './acceptance-evidence.mjs';
import {packageCases,checklistObligations} from './acceptance-plan.mjs';
import {allocateCase,reservePackageCargo,retainUninstallResidue,requireVisiblePackageViewport} from './package-launch.mjs';
import {buildPackageFrontend} from './package-frontend.mjs';
import {readReusablePackage,assertArtifactSourceContext} from './acceptance-package-reuse.mjs';
import {assertNativeGuiIdle} from './acceptance-gui-readiness.mjs';

const owner=resolve(import.meta.dirname,'../..'),execute=promisify(execFile);
const {values}=parseArgs({options:{root:{type:'string'},host:{type:'string',multiple:true},scenario:{type:'string',multiple:true},
  'list-only':{type:'boolean'},'frontend-only':{type:'boolean'},'route-database':{type:'string'},'reuse-package-from':{type:'string'},'controller-root':{type:'string'}}});
const selected=values.scenario??['ordinary'],hosts=values.host??['powerShell7'];
if(values['list-only']){
  console.log(JSON.stringify({execution:false,cases:packageCases({hosts,selected,artifact:{binding:'new-batch-required'},inputs:{binding:'freeze-before-execution'}}),
    checklist:checklistObligations(await readFile(resolve(owner,'docs/design/agent-terminal-input-acceptance-checklist.md'),'utf8'))},null,2));
}else await main();

async function main(){
  assert.equal(process.platform,'win32');assert.equal(process.arch,'x64');if(!values['frontend-only'])assertNativeGuiAllowed();
  assert(!(values['frontend-only']&&values['reuse-package-from']),'Choose compilation-only or retained-package execution');
  assert(values.root,'A fresh sealed source snapshot is required');
  const root=await realpath(values.root);inside(resolve(owner,'.artifacts/tests/p3'),root);
  const read=async path=>JSON.parse(await readFile(path,'utf8'));
  const stage=await read(resolve(root,'.artifacts/tests/native-input-p3/candidate-stage.json'));
  assertArtifactSourceContext(stage);
  assert(stage.sealed&&stage.root===root);const sources=await read(resolve(stage.directory,'sources.json'));
  assert.deepEqual(captureValidationSources(root),sources,'Full frozen source changed');
  const controllerRoot=values['controller-root']?await realpath(values['controller-root']):root;
  assert(values['reuse-package-from']||controllerRoot===root||stage.contextKind==='artifact-revision','Separate controller context requires a declared artifact revision or retained artifact');
  inside(resolve(owner,'.artifacts/tests/p3'),controllerRoot);
  const controllerStage=await read(resolve(controllerRoot,'.artifacts/tests/native-input-p3/candidate-stage.json'));
  assert(controllerStage.sealed&&controllerStage.root===controllerRoot);
  const controllerSources=await read(resolve(controllerStage.directory,'sources.json'));
  assert.deepEqual(captureValidationSources(controllerRoot),controllerSources,'Controller snapshot drift');
  if(!values['reuse-package-from']&&controllerRoot!==root){
    for(const path of ['scripts/native-input-p3/package-frontend.mjs','scripts/native-input-p3/package-launch.mjs','scripts/native-input-p3/acceptance-inputs.mjs','scripts/native-input-p2/frozen-validation.mjs'])
      assert.equal(sources[path],controllerSources[path],`Artifact build recipe differs from its controller: ${path}`);
  }
  // The controller and all helper modules must belong to this exact snapshot.
  const controllerPaths=Object.keys(controllerSources).filter(path=>path.startsWith('scripts/native-input-p3/')||['scripts/native-input-p2/frozen-validation.mjs','scripts/native-input-p2/resource-paths.mjs','scripts/native-input-p2/gui-lock.mjs'].includes(path));
  for(const path of controllerPaths)assert.equal(await hashFile(resolve(owner,path)),controllerSources[path],`Controller differs from sealed source: ${path}`);
  const runId=randomUUID(),directory=resolve(root,'.artifacts/tests/pk',runId.slice(0,8));let id=runId,short=id.slice(0,8),install=resolve(directory,'i');
  await mkdir(resolve(directory,'..'),{recursive:true});await mkdir(directory,{recursive:false});const write=(path,value)=>writeFile(path,JSON.stringify(value,null,2),{flag:'wx'});
  const phases=[],audits=backgroundQueue(2),abort=new AbortController(),cancelRequest=resolve(directory,'cancel.request.json');
  const stopPolling=watchBatchCancellation(cancelRequest,runId,abort);
  const onCancel=()=>abort.abort(new Error('Batch cancelled; do not resume or replay'));
  process.once('SIGINT',onCancel);process.once('SIGTERM',onCancel);process.once('exit',stopPolling);
  await write(resolve(directory,'run-state.json'),{runId,directory,cancelRequest,stage:'preparing',appLaunched:false});
  const casesRoot=resolve(directory,'cases'),retained=resolve(directory,'retained-cases');await mkdir(casesRoot);await mkdir(retained);
  // A dedicated Cargo output is mandatory. Never touch the original session's
  // target, cache locks, package output or retained binaries.
  const cargoTarget=values['reuse-package-from']?resolve(directory,'unused-cargo-target'):await reservePackageCargo(owner,id,root);
  const env={...process.env,RUSTUP_TOOLCHAIN:'1.95.0-x86_64-pc-windows-msvc',CARGO_TARGET_DIR:cargoTarget,CARGO_BUILD_JOBS:'4'};
  const toolchain={node:process.version,rustc:(await execute('rustc',['-vV'],{env,windowsHide:true})).stdout,
    cargo:(await execute('cargo',['-V'],{env,windowsHide:true})).stdout,
    lockSha256:await hashFile(resolve(root,'pnpm-lock.yaml')),cargoLockSha256:await hashFile(resolve(root,'src-tauri/Cargo.lock'))};
  let dependencies;
  try{dependencies=await phase('dependency-inventory',()=>dependencyInventory(resolve(root,'node_modules'),{signal:abort.signal}));}
  catch(error){
    await write(resolve(directory,'startup-failure.json'),{runId,status:abort.signal.aborted?'blocked':'fail',reason:String(error),executed:0,appLaunched:false,fullAcceptancePassed:false});
    stopPolling();process.removeListener('SIGINT',onCancel);process.removeListener('SIGTERM',onCancel);throw error;
  }
  toolchain.installedDependencySha256=dependencies.sha256;
  const toolchains=stageToolchains(toolchain,await hashFile(resolve(root,'src-tauri/native-input-editors/Cargo.lock')));
  await write(resolve(directory,'installed-dependencies.json'),dependencies);
  let reusable;
  if(values['reuse-package-from']){
    assert(values['controller-root'],'Artifact reuse requires a separately sealed controller snapshot');
    reusable=await readReusablePackage(owner,values['reuse-package-from'],root,dependencies,toolchain);
    id=reusable.batchId;short=id.slice(0,8);install=reusable.plan.install;
    await write(resolve(directory,'reuse-provenance.json'),{artifactSource:reusable.directory,artifactBatchId:id,runId,controllerRoot,
      dependencyInventoryMigration:'Declared Vite cacheDir outputs are excluded from production build inputs; all installed package bytes and links match',oldResultsReplayed:false});
  }
  const resources=resolve(root,'.artifacts/tests/native-input-p2/resources/native-input'),catalogue=await read(resolve(resources,'editors-windows-x64.json'));
  const catalogueHosts = catalogue.profiles.map(({ profile }) => ({ shell: profile.shell, expectedVersion: profile.shellVersion }));
  assert.deepEqual(catalogueHosts, selectWindowsProfiles(), 'Windows native catalogue differs from the supported hosts');
  for(const [path,sha]of Object.entries(catalogue.sources))assert.equal(await hashFile(resolve(root,path)),sha,'Native source changed');
  for(const profile of catalogue.profiles)assert.equal(await hashFile(inside(resources,resolve(resources,profile.module))),profile.moduleSha256,'Native artifact changed');
  const coreSha=catalogue.profiles[0].moduleSha256;assert(catalogue.profiles.every(item=>item.moduleSha256===coreSha));
  const binaryName=reusable?.plan.binaryName??`ShellSpanBatch${short}`,productName=reusable?.plan.productName??`ShellSpan Package Batch ${short}`,application=resolve(install,binaryName+'.exe');
  let active,app,appDone,observer,observerDone,releaseGui,server,proof,manifestSha,assetHashes,resourceHashes,inputRecords,artifactRecords=[],outcome;
  async function phase(name,work){const startedAt=new Date().toISOString(),start=performance.now();let failure;
    try{return await work();}catch(error){failure=String(error);throw error;}finally{phases.push({name,startedAt,finishedAt:new Date().toISOString(),durationMs:performance.now()-start,...(failure?{failure}:{})});await writeFile(resolve(directory,'phases.json'),JSON.stringify(phases,null,2));}}
  async function run(name,command,args,cwd=root,appEnv=env){
    return phase(name,async()=>{
      const fd=fs.openSync(resolve(active?.directory??directory,name+'.log'),'wx');let child;
      try{
        child=spawn(command,args,{cwd,env:appEnv,windowsHide:true,stdio:['ignore',fd,fd]});
        const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);});
        assert.equal(code,0,`${name} failed; no automatic retry`);
      }finally{fs.closeSync(fd);}
    });
  }
  const frontendDirectory=resolve(reusable?.directory??directory,'frontend');
  const fixed={root,controllerRoot,runId,artifactBatchId:id,install,binaryName,productName,coreSha,toolchain,cargoTarget,target:'x86_64-pc-windows-msvc'};
  const lifecycle=[
    {id:'package/build',requirements:['A01','A06'],phase:reusable?'reuse-bundle':'bundle',expected:reusable?'Reference the exact completed retained NSIS build; no new compilation claim':'New NSIS package and retained compiled image from the frozen source; source rebuild qualification remains separate',evidence:['installer.json','build-inputs.json','frontend-assets.json','resource-inputs.json',reusable?'reuse-provenance.json':'bundle.log']},
    {id:'package/install',requirements:['A03','A06'],phase:'install-and-verify',expected:'Fresh owned installation with exact resource tree and verified NSIS image transformation',evidence:['install.log','installed-image.json']},
    {id:'package/uninstall',requirements:['E07'],phase:'uninstall-and-verify',expected:'Owned application stopped and installed executable absent after successful uninstaller',evidence:['uninstall.log','result.json']},
  ];
  const planned=packageCases({hosts,selected,artifact:{batch:id,coreSha256:coreSha},inputs:{sourceManifestSha256:await hashFile(resolve(stage.directory,'sources.json')),controllerManifestSha256:await hashFile(resolve(controllerStage.directory,'sources.json')),toolchain}});
  await write(resolve(directory,'plan.json'),{...fixed,planned,lifecycle,checklist:checklistObligations(await readFile(resolve(root,'docs/design/agent-terminal-input-acceptance-checklist.md'),'utf8')),fullAcceptancePassed:false});
  if(!values['frontend-only']&&selected.some(value=>value!=='ordinary'))assert(values['route-database'],'Model cases require an explicit route metadata database; credential values are never copied');
  async function verify(checkpoint='input-check'){
    const signal=checkpoint==='after-cleanup'?undefined:abort.signal;
    return phase('verify-inputs/'+checkpoint,async()=>{
    signal?.throwIfAborted();
    assert.deepEqual(captureValidationSources(root),sources,'Full source/index freeze drift');
    assert.deepEqual(captureValidationSources(controllerRoot),controllerSources,'Controller source/index freeze drift');
    if(assetHashes)assert.deepEqual(captureValidationAssets(frontendDirectory),assetHashes,'Built frontend drift');
    if(resourceHashes)assert.deepEqual(captureValidationAssets(nativeInputReleaseDirectory(root)),resourceHashes,'Frozen package resource drift');
    if(inputRecords)assert.equal((await dependencyInventory(resolve(root,'node_modules'),{signal})).sha256,dependencies.sha256,'Installed dependency bytes or links changed');
    if(artifactRecords.length)await verifyRetainedArtifacts(artifactRecords);
    if(inputRecords){
      const captured=await fingerprints(root,Object.values(inputRecords),{signal});
      for(const input of Object.values(inputRecords)){
      // Also detects additions and removals under the explicit build roots.
      const current=captured[input.stage];
      assert.equal(current.sha256,input.sha256,`Actual ${input.stage} build inputs changed`);
      }
    }
    });
  }
  async function verifyInstalled(){
    assert.equal(await hashFile(application),proof.installedSha256,'Installed image changed');
    const actual=captureValidationAssets(resolve(install,'native-input/generated'));
    assert.deepEqual(actual,resourceHashes,'Installed resource tree changed');
  }
  async function stopApp(){
    if(app){
      await execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',resolve(root,'scripts/native-input-p3/windows-image.ps1'),'-Action','Stop','-ApplicationPid',String(app.pid),'-RunnerPid',String(process.pid),'-Executable',application],{env:active.env,windowsHide:true,timeout:20000});
      await appDone;app=undefined;
    }
  }
  async function stop(){
    await stopApp();
    if(observer){await writeFile(resolve(active.directory,'foreground.jsonl.stop'),'stop',{flag:'wx'});const code=await observerDone;assert.equal(code,0,'Passive observer failed');observer=undefined;}
  }
  const adapter={verify,verifyInstalled,stop,
    async build(){
      if(reusable){
        await phase('reuse-bundle',async()=>{
          const readOriginal=name=>read(resolve(reusable.directory,name));
          assetHashes=await readOriginal('frontend-assets.json');resourceHashes=await readOriginal('resource-inputs.json');inputRecords=reusable.inputs;
          manifestSha=await hashFile(resolve(nativeInputReleaseDirectory(root),'resource-manifest.json'));
          await mkdir(resolve(directory,'retained-binaries'));
          for(const item of reusable.artifacts){const path=resolve(directory,'retained-binaries',item.role+'.exe');await copyFile(item.path,path,fs.constants.COPYFILE_EXCL);assert.equal(await hashFile(path),item.sha256);artifactRecords.push({...item,original:item.path,path});}
          await write(resolve(directory,'installer.json'),{artifacts:artifactRecords,configFile:reusable.configFile,configSha256:reusable.configSha256,qualification:'Exact independently hashed retained package reused; no recompilation'});
          await write(resolve(directory,'build-inputs.json'),inputRecords);await write(resolve(directory,'resource-inputs.json'),resourceHashes);await write(resolve(directory,'frontend-assets.json'),assetHashes);
        });
      }else{
      await phase('prepare-resources',async()=>{
        await run('prepare',process.execPath,[resolve(root,'scripts/prepare-native-input-resources.mjs'),'--no-build','--target',fixed.target,'--validation-editor','windows-x64']);
        const prepared=JSON.parse((await readFile(resolve(directory,'prepare.log'),'utf8')).trim());assert(prepared.validationOnly);
        fs.cpSync(prepared.directory,nativeInputReleaseDirectory(root),{recursive:true});
        await writeFile(resolve(nativeInputReleaseDirectory(root),'editor-validation.json'),JSON.stringify(validationPackageMarker(root,resolve(install,'native-input/generated'),await hashFile(resolve(stage.directory,'sources.json'))),null,2));
        manifestSha=await hashFile(resolve(nativeInputReleaseDirectory(root),'resource-manifest.json'));
        resourceHashes=captureValidationAssets(nativeInputReleaseDirectory(root));assertPackageResourcePaths(root,install,Object.keys(resourceHashes));
        await write(resolve(directory,'resource-inputs.json'),resourceHashes);
      });
      }
      server=createServer(async(request,response)=>{
        response.setHeader('Cache-Control','no-store');response.setHeader('Access-Control-Allow-Origin','http://tauri.localhost');response.setHeader('Access-Control-Allow-Headers','Content-Type');
        try{
          if(request.method==='OPTIONS'){response.writeHead(204).end();return;}
          assert(active&&app,'No owned application launch is active');
          const launch=active,launchToken=active.launchToken,launchStage=active.stage,settle=active.settle;
          if(request.method==='GET'&&request.url===`/${id}/bootstrap`){
            assert(!active.bootstrapped,'Launch configuration is single use');active.bootstrapped=true;
            response.setHeader('Content-Type','application/json');response.end(JSON.stringify(active.bootstrap));return;
          }
          if(request.method==='GET'&&request.url===`/__native-file-witness/${launchToken}`){response.setHeader('Content-Type','application/json');response.end(JSON.stringify(await windowsPackageFileWitness(resolve(launch.directory,'data'),resolve(launch.directory,'home'),launchToken,launch.item.stage==='semantics')));return;}
          assert(request.method==='POST');
          if([`/${launchToken}/capture`,`/__package-capture/${launchToken}`].includes(request.url)){
            const output=resolve(launch.directory,launchStage==='ordinary'?'native-window.png':'model-native-window.png');
            const capture=await execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',resolve(root,'scripts/fixtures/windows-desktop-capture.ps1'),'-Executable',application,'-Output',output],{env:launch.env,windowsHide:true,timeout:15000,encoding:'utf8'});
            response.setHeader('Content-Type','application/json');response.end(capture.stdout);return;
          }
          assert([`/${launchToken}`,`/__agent-stream-result/${launchToken}`].includes(request.url),'Unknown report identity');
          assert(!launch.reported,'Duplicate or stale outcome');let body='';for await(const chunk of request){body+=chunk.toString();assert(Buffer.byteLength(body)<=1048576,'Evidence exceeds bound');}
          assert(active===launch&&active.launchToken===launchToken&&app,'Report arrived after its launch ended');
          const value=JSON.parse(body);assert(typeof value.ok==='boolean','Final outcome required');assert(!launch.reported,'Concurrent duplicate outcome');launch.reported=true;
          await write(resolve(launch.directory,launchStage==='ordinary'?'webview-evidence.json':launchStage+'-outcome.json'),value);
          if(launchStage!=='ordinary'&&value.evidence)await write(resolve(launch.directory,launchStage+'-webview-evidence.json'),value.evidence);
          response.end('ok');settle(value);
        }catch(error){response.writeHead(409).end('Owned batch request rejected');if(active)active.controlFailure??=String(error);}
      });
      await new Promise((done,reject)=>{server.once('error',reject);server.listen(reusable?Number(new URL(reusable.origin).port):0,'127.0.0.1',done);});const origin=`http://127.0.0.1:${server.address().port}`;
      if(reusable){assert.equal(origin,reusable.origin);return;}
      // Only the test artifact contains this loader. No production startup hook,
      // env-eval, executable input, external script or expanded CSP is added.
      const {entry,loader,define,assets}=await phase('frontend',()=>buildPackageFrontend(root,directory,origin,id));
      assetHashes=assets;await write(resolve(directory,'frontend-assets.json'),assetHashes);
      const config={productName,mainBinaryName:binaryName,identifier:`com.shellspan.validation.batch.${id}`,build:{beforeBuildCommand:'',frontendDist:packageFrontendDirectory(root,resolve(directory,'frontend'))},
        app:{appDirectoriesOverride:resolve(directory,'tauri'),windows:[{label:'main',title:productName,url:relative(root,entry).replaceAll('\\','/'),width:1480,height:920,visible:true,focus:true,alwaysOnTop:false}],
          security:{csp:`default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ipc: http://ipc.localhost ${origin}; font-src 'self' data:`}},
        bundle:{createUpdaterArtifacts:false,resources:packageResourceMapping(root),windows:{webviewInstallMode:{type:'skip'},nsis:{installMode:'currentUser',startMenuFolder:productName,displayLanguageSelector:false}}}};
      const configFile=resolve(root,'.artifacts/config',`native-batch-${id}.json`);await mkdir(resolve(configFile,'..'),{recursive:true});await write(configFile,config);
      inputRecords=Object.fromEntries(await Promise.all(['native','frontend','package'].map(async kind=>[kind,await fingerprint(root,kind,{toolchain:toolchains[kind],target:fixed.target,
        extraPaths:kind==='package'?['.artifacts/releases/native-input/generated']:kind==='frontend'?['scripts/native-input-p3/package-frontend.mjs','scripts/native-input-p3/package-launch.mjs']:[],
        configuration:kind==='package'?config:kind==='native'?{catalogueSha256:await hashFile(resolve(resources,'editors-windows-x64.json')),producer:'build-windows.mjs'}:{entrySha256:await hashFile(entry),loaderSha256:await hashFile(loader),define}})])));
      await write(resolve(directory,'build-inputs.json'),inputRecords);
      if(values['frontend-only'])return;
      const cli=createRequire(import.meta.url).resolve('@tauri-apps/cli/tauri.js');
      await withLease(resolve(directory,'cargo-lane'),()=>run('bundle',process.execPath,[cli,'build','--target',fixed.target,'--bundles','nsis','--config',configFile]),{signal:abort.signal});
      const release=resolve(cargoTarget,fixed.target,'release'),bundles=resolve(release,'bundle/nsis'),matches=(await readdir(bundles)).filter(name=>name.includes(short)&&name.endsWith('.exe'));assert.equal(matches.length,1);
      const binary=fs.existsSync(resolve(release,binaryName+'.exe'))?resolve(release,binaryName+'.exe'):resolve(release,'ShellSpan.exe');
      const originals=[{role:'installer',path:resolve(bundles,matches[0])},{role:'compiled-unbundled',path:binary}];await mkdir(resolve(directory,'retained-binaries'));
      for(const item of originals){const sha256=await hashFile(item.path),path=resolve(directory,'retained-binaries',item.role+'.exe');await copyFile(item.path,path,fs.constants.COPYFILE_EXCL);assert.equal(await hashFile(path),sha256);artifactRecords.push({...item,original:item.path,path,sha256});}
      await write(resolve(directory,'installer.json'),{artifacts:artifactRecords,configFile,configSha256:await hashFile(configFile)});
    },
    async install(){
      await phase('install-and-verify',async()=>{
        await assertNativeGuiIdle(owner,process.pid);
        releaseGui=await acquireNativeGui();abort.signal.throwIfAborted();assert(!fs.existsSync(install),'Installation must be fresh');
        await run('install',artifactRecords.find(item=>item.role==='installer').path,['/S',`/D=${install}`]);
        proof=verifyNsisInstalledImage(await readFile(artifactRecords.find(item=>item.role==='compiled-unbundled').path),await readFile(application));
        await write(resolve(directory,'installed-image.json'),{application,...proof});await verifyInstalled();
      });
    },
    async run(item){
      const {token,directory:caseDirectory}=await allocateCase(casesRoot);
      active={item,token,directory:caseDirectory,env:{...env,HOME:resolve(caseDirectory,'home'),USERPROFILE:resolve(caseDirectory,'home'),
        SHELLSPAN_DATA_DIR:resolve(caseDirectory,'data'),SHELLSPAN_LOCAL_HOME:resolve(caseDirectory,'home'),SHELLSPAN_LOCAL_SHELL:item.host.executable,
        WEBVIEW2_USER_DATA_FOLDER:resolve(caseDirectory,'webview'),PSModuleAnalysisCachePath:resolve(caseDirectory,'module.cache'),
        SHELLSPAN_NATIVE_EDITOR_VALIDATION_ROOT:resolve(install,'native-input/generated')}};
      await write(resolve(caseDirectory,'plan.json'),{contract:item,token,paths:{home:active.env.HOME,data:active.env.SHELLSPAN_DATA_DIR,webview:active.env.WEBVIEW2_USER_DATA_FOLDER}});
      await write(resolve(caseDirectory,'active.json'),{pid:process.pid});const pids=[];let failure,cleanupFailure,modelStarted=false,metrics={modelDrivenToolCalls:0,llmHttpRequests:item.scenario==='ordinary'?0:null,approvals:0,commandExecutions:0,ordinaryTests:0};
      observer=spawn('D:/Programs/PowerShell/7/pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',resolve(root,'scripts/fixtures/windows-foreground-observe.ps1'),'-Output',resolve(caseDirectory,'foreground.jsonl')],{cwd:root,env:active.env,windowsHide:true,stdio:'ignore'});
      observerDone=new Promise((done,reject)=>{observer.once('error',reject);observer.once('close',done);});pids.push(observer.pid);
      async function launch(label,timeout){
        await assertNativeGuiIdle(owner,process.pid);
        abort.signal.throwIfAborted();active.stage=label;active.launchToken=randomUUID();active.bootstrapped=false;active.reported=false;
        const launchToken=active.launchToken;
        const origin=`http://127.0.0.1:${server.address().port}`;
        active.bootstrap={stage:label,report:origin+'/'+launchToken,install,manifestSha,coreSha,validationOnly:true,shell:item.host.shell,version:item.host.expectedVersion,
          query:{token:launchToken,nativeP3:item.host.shell,reportOrigin:origin,packageModel:'true',semanticVariant:item.scenario==='model-validation'?'validation':'headers'}};
        await write(resolve(caseDirectory,`launch-${label}.json`),{launchToken,stage:label,report:active.bootstrap.report});
        let timer;const reported=new Promise(done=>{active.settle=done;timer=setTimeout(()=>done({ok:false,error:`Installed ${label} timed out`}),timeout);});
        const cancelled=()=>active.settle({ok:false,error:'Batch cancelled; operation not replayed'});abort.signal.addEventListener('abort',cancelled,{once:true});
        try{
          await phase(item.id+'/'+label,async()=>{
            app=spawn(application,[],{cwd:install,env:active.env,windowsHide:true,stdio:'ignore'});if(Number.isInteger(app.pid))pids.push(app.pid);
            app.once('error',error=>active.settle({ok:false,error:String(error)}));
            appDone=new Promise(done=>app.once('close',(code,signal)=>{done(code);if(!active.reported)active.settle({ok:false,error:`Owned application exited before ${label} evidence: ${code??signal}`});}));
            const inspected=await execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',resolve(root,'scripts/native-input-p3/windows-image.ps1'),'-Action','Inspect','-ApplicationPid',String(app.pid),'-RunnerPid',String(process.pid),'-Executable',application],{env:active.env,windowsHide:true,timeout:20000,encoding:'utf8'});
            assert.equal(JSON.parse(inspected.stdout).sha256,proof.installedSha256,'Running image changed');await writeFile(resolve(caseDirectory,`application-${label}.json`),inspected.stdout,{flag:'wx'});
            const result=await reported;assert.equal(result.ok,true,result.error);
          });
        }finally{clearTimeout(timer);abort.signal.removeEventListener('abort',cancelled);}
      }
      try{
        await launch('ordinary',90000);await stopApp();
        const ordinary=(await read(resolve(caseDirectory,'webview-evidence.json'))).evidence;assert.equal(ordinary.loadedCore.sha256,coreSha);
        assert.equal(ordinary.session.ptyInfo.inputMode,'native-inline');assert.equal(ordinary.validationOnly,true);
        requireVisiblePackageViewport(ordinary.viewport);
        metrics.ordinaryTests=1;metrics.commandExecutions=1;
        if(item.scenario!=='ordinary'){
          await run('route-metadata',process.execPath,[resolve(root,'scripts/fixtures/windows-desktop-data.mjs'),values['route-database'],resolve(caseDirectory,'data')]);
          await launch('preflight',60000);await stopApp();modelStarted=true;await launch(item.stage,210000);await stopApp();
          const evidence=await read(resolve(caseDirectory,item.stage+'-webview-evidence.json'));
          assert(!evidence.failed);assert.equal(evidence.loadedCore.sha256,coreSha);assert.equal(evidence.before.session.nativePeerProfile.shell,item.host.shell);
          assert.equal(evidence.before.session.nativePeerProfile.shellVersion,item.host.expectedVersion);
          const calls=evidence.events.filter(event=>event.type==='tool/call'),results=evidence.events.filter(event=>event.type==='tool/result');
          assert.equal(calls.length,4);assert.equal(evidence.approved.length,4);assert.equal(results.length,4);assert(results.every(event=>event.data.status==='completed'));
          if(item.stage==='semantics'){
            assert.equal(evidence.kind,'actual-native-parent-semantics');assert.equal(evidence.variant,item.expected.variant);
            assert.deepEqual(results.map(event=>event.data.data.exitCode),[0,0,1,0]);assert.deepEqual(evidence.state.effectEntries,['ONCE']);assert.equal(evidence.state.unexpectedBodyExists,false);
          }else assert.equal(evidence.kind,'actual-native-file-chain');
          assert.equal(evidence.before.session.currentDirectory,evidence.after.session.currentDirectory);assert.equal(evidence.after.session.promptReady,true);
          assert.deepEqual(evidence.afterCloseState.nativeBootstrap.bootstraps,[]);
        }
      }catch(error){failure=String(error);}
      if(modelStarted){let evidence;try{evidence=await read(resolve(caseDirectory,item.stage+'-webview-evidence.json'));}catch(error){if(error.code!=='ENOENT')failure??=String(error);}metrics=modelEvidenceMetrics(evidence,metrics.ordinaryTests);}
      try{await stop();assert.deepEqual(windowsBootstrapWitness(resolve(caseDirectory,'data')).bootstraps,[],'Native bootstrap remains after case');}catch(error){cleanupFailure=String(error);}
      failure??=active.controlFailure;
      const record={id:item.id,contract:item,status:failure||cleanupFailure?'fail':'pass',executed:true,metrics,...(failure?{reason:failure}:{}),...(cleanupFailure?{cleanupFailure}:{}),
        artifactProof:{installedImageSha256:proof.installedSha256,resources:resourceHashes,retainedArtifacts:artifactRecords},fullAcceptancePassed:false};
      await write(resolve(caseDirectory,'result.json'),record);
      if(cleanupFailure)return record; // Keep active.json; never archive uncertain producers.
      await unlink(resolve(caseDirectory,'active.json'));
      const files=[...(await readdir(caseDirectory,{withFileTypes:true})).filter(entry=>entry.isFile()).map(entry=>entry.name),'data','home'];
      await sealCase(caseDirectory,{status:record.status,producerPids:pids,files,terminationConfirmed:true});
      audits.enqueue(()=>retainSealedCase(caseDirectory,resolve(retained,token.slice(0,8))));active=undefined;return record;
    },
    async uninstall(){
      if(!fs.existsSync(install))return; // Cancellation before installation.
      await phase('uninstall-and-verify',async()=>{
        await run('uninstall',resolve(install,'uninstall.exe'),['/S',`_?=${install}`],root,env);assert(!fs.existsSync(application),'Installed image remains');
        const residue=await retainUninstallResidue(owner,install,resolve(directory,'uninstalled-installation'));
        await write(resolve(directory,'uninstall-cleanup.json'),residue);
      });
    }
  };
  try{
    if(values['frontend-only']){
      try{await verify();await adapter.build();await verify();outcome={ok:true,records:[],frontendOnly:true,appLaunched:false,installed:false};}
      catch(error){outcome={ok:false,records:[],frontendOnly:true,primaryError:String(error),appLaunched:false,installed:false};}
    }else outcome=await runInstalledCases(planned,adapter,{signal:abort.signal});
  }finally{
    releaseGui?.();if(server?.listening)await new Promise(done=>server.close(done));
    process.removeListener('SIGINT',onCancel);process.removeListener('SIGTERM',onCancel);
    stopPolling();process.removeListener('exit',stopPolling);
    const retention=await audits.drain();
    const summary=summarize(planned,outcome?.records??[]);
    const lifecycleResults=lifecycle.map(item=>{const phase=phases.find(phase=>phase.name===item.phase);return {id:item.id,status:phase?(phase.failure?'fail':'pass'):'pending',executed:Boolean(phase)&&!(reusable&&item.id==='package/build'),reused:Boolean(reusable&&item.id==='package/build'&&phase&&!phase.failure)};});
    await write(resolve(directory,'result.json'),{...outcome,summary,lifecycle:lifecycleResults,retention,phases,productionAdmissionChanged:false,fullAcceptancePassed:false});
    console.log(JSON.stringify({directory,ok:outcome?.ok===true,summary,primaryError:outcome?.primaryError,cleanupError:outcome?.cleanupError}));
    process.exitCode=outcome?.ok&&retention.every(item=>item.status==='fulfilled')?0:1;
  }
}
