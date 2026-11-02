// Verify cumulative evidence without retrying a command or rewriting any run.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {parseArgs} from 'node:util';
import {captureValidationAssets} from './frozen-validation.mjs';

const root=resolve(import.meta.dirname,'../..');
const owned=resolve(root,'.native-input-p2');
const {values}=parseArgs({options:{matrix:{type:'string',multiple:true},run:{type:'string',multiple:true},'require-frozen':{type:'boolean'},'require-auxiliary':{type:'boolean'},'source-root':{type:'string',multiple:true}}});
const validationRoots=values['source-root']?.map(path=>resolve(path))??[root];
const sourceSnapshots=new Map();
for(const validationRoot of validationRoots)if(validationRoot!==root){
  assert(validationRoot.startsWith(resolve(owned,'acceptance-source')+'/'));
  const sourceSnapshot=JSON.parse(readFileSync(resolve(validationRoot,'.native-input-p2/source-snapshot.json'),'utf8'));
  assert(sourceSnapshot.ownerRoot===root&&sourceSnapshot.sourceRoot===validationRoot&&sourceSnapshot.sharedDriftReviewed===true,'Isolated source must have its exact P2/shared-source correspondence reviewed');
  sourceSnapshots.set(validationRoot,sourceSnapshot);
}
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const own=path=>{const absolute=resolve(path);assert([owned,...validationRoots.map(path=>resolve(path,'.native-input-p2'))].some(base=>absolute.startsWith(base+'/')),'Evidence must belong to the isolated P2 directory');return absolute;};
const candidates=[];const matrices=[];
for(const input of values.matrix??[]){
  const path=own(input);const summary=json(path);
  matrices.push({path:relative(root,path),sha256:sha(path),result:summary.result,
    failures:summary.steps.filter(step=>step.exitCode!==0).map(({version,transport,scenario,exitCode})=>({version,transport,scenario,exitCode}))});
  for(const step of summary.steps){
    if(step.exitCode!==0)continue;
    const outcome=JSON.parse(step.output.trim());
    assert.equal(outcome.exitCode,0);
    candidates.push({directory:own(outcome.destination),expected:{version:step.version,transport:step.transport,scenario:step.scenario}});
  }
}
for(const path of values.run??[])candidates.push({directory:own(path)});
assert(candidates.length,'At least one actual matrix or isolated run is required');
const production=path=>path.startsWith('src-tauri/')&&!path.includes('/tests/')
  ||path.startsWith('node_modules/@xterm/')
  ||['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','src/components/terminal/registry/terminal-registry.ts',
    'src/components/terminal/terminal-controller-layer.tsx','src/lib/ipc/tauri.ts','src/types/index.ts',
    'src/lib/terminal/native-input-display.ts','scripts/dependency-builds/xterm/artifacts.json'].includes(path);
const cases=new Map();const rejected=[];
for(const {directory,expected} of candidates){
  try{
    const inputs=json(resolve(directory,'acceptance-inputs.json'));
    const invocation=json(resolve(directory,'invocation.json'));
    const transport=invocation.arguments.includes('--native-input-p2-ssh-fixture')?'ssh':'local';
    const identity={version:inputs.version,transport,scenario:inputs.scenario};
    if(expected)assert.deepEqual(identity,expected,'Actual invocation differs from its matrix case');
    for(const name of['initialize-result.json','native-result.json','result.json',...(transport==='ssh'?['credential-cleanup-result.json']:[])])assert.equal(json(resolve(directory,name)).exitCode,0,`Unsuccessful actual phase: ${name}`);
    const sourceHashes=Object.fromEntries(Object.entries(inputs.sources).filter(([path])=>production(path)));
    assert(Object.keys(sourceHashes).length>=25,'Production provenance is incomplete');
    const validationRoot=validationRoots.find(base=>Object.entries(sourceHashes).every(([path,digest])=>{try{return sha(resolve(base,path))===digest;}catch{return false;}})
      &&(!inputs.sourceSnapshot||sha(resolve(base,inputs.sourceSnapshot.path))===inputs.sourceSnapshot.sha256));
    assert(validationRoot,'No recorded immutable source version matches every production hash of this actual run');
    const validationOwned=resolve(validationRoot,'.native-input-p2');
    for(const [path,digest] of Object.entries(sourceHashes))assert.equal(sha(resolve(validationRoot,path)),digest,`Production source drift: ${path}`);
    const target=transport==='ssh'?'linux-aarch64-glibc-2.36':'macos-arm64';
    const producer=inputs.producers.find(value=>value.profile.includes(`-${target}-`));assert(producer,'Actual target producer missing');
    assert.equal(sha(resolve(validationRoot,producer.manifest)),producer.manifestSha256,'Producer manifest drift');
    for(const [path,digest] of Object.entries(producer.sources))assert.equal(sha(resolve(validationRoot,path)),digest,`Producer source drift: ${path}`);
    const catalogue=resolve(validationOwned,`resources/native-input/catalogue-${target}.json`);
    assert.equal(sha(catalogue),producer.catalogueSha256,'Distributed catalogue drift');
    const artifact=json(catalogue).profiles.find(value=>value.id===producer.profile);
    assert.deepEqual(artifact,producer.distributedArtifact,'Distributed profile differs from the run');
    for(const [path,digest] of[[artifact.module,artifact.moduleSha256],[artifact.relay,artifact.relaySha256]])assert.equal(sha(resolve(validationOwned,'resources/native-input',path)),digest,'Distributed artifact drift');
    if(inputs.modelRoutesSha256)assert.equal(sha(resolve(directory,'model-routes.json')),inputs.modelRoutesSha256,'Actual isolated model configuration drifted');
    if(inputs.sourceSnapshot)assert.equal(sha(resolve(validationRoot,inputs.sourceSnapshot.path)),inputs.sourceSnapshot.sha256,'Actual source snapshot provenance drifted');
    const evidencePath=resolve(directory,'native-webview-evidence.json');const evidence=json(evidencePath);assert(!evidence.failed,'Actual WebView reported failure');
    const role=evidence.events?.find(value=>value.toolChain)?.toolChain??evidence.events?.find(value=>value.terminalDelegation)?.terminalDelegation;
    const initial=evidence.identity??evidence.nativeLayout?.nativeInitial??evidence.initial??role?.identity??role?.nativeInitial;
    if(evidence.result)assert.equal(evidence.result.ok,true,'Actual role fixture reported failure');
    if(!['lifecycle','close'].includes(inputs.scenario)){
      assert(initial,'Actual initial Broker identity is absent');
      assert.equal(initial.inputMode,'native-inline');
      {
        assert.equal(initial.nativePeerProfile?.verifiedProfileId,producer.profile,'Actual accepted peer differs from the verified artifact');
        assert.equal(initial.nativeDisplayBinding?.protocol,'shellspan.native-input');
      }
    }
    if(['contention','delegation'].includes(inputs.scenario))assert(role?.nativeProofs?.some(view=>view.sessionId===initial.transportSessionId&&view.terminalSessionId===initial.terminalSessionId&&view.terminalGeneration===initial.terminalGeneration&&view.inputObservation?.activeCommand?.fullInputConfirmed&&view.inputObservation.activeCommand.submissionIntentDurable),'Actual role full/durable proof missing');
    if(['interactive','interactive-fresh'].includes(inputs.scenario))assert(evidence.credentialInputBlocked===true&&evidence.publicApisUnmodified===true&&evidence.observations.some(event=>event.inputObservation?.activeCommand?.fullInputConfirmed&&event.inputObservation.activeCommand.submissionIntentDurable),'Actual interactive proof/gate/API evidence missing');
    if(inputs.scenario==='ssh-fault'){assert.equal(readFileSync(resolve(directory,'effect-once.bin'),'utf8'),'ONCE\n');assert(evidence.rejected&&evidence.staleRejected,'Actual recovery/stale transport rejection missing');}
    if(inputs.scenario==='jobs'){
      const views=evidence.nativeLayout.nativeObservations.flatMap(event=>event.inputObservation?.activeCommand?[event.inputObservation.activeCommand]:[]);
      assert(views.some(view=>view.fullInputConfirmed&&view.submissionIntentDurable),'Actual full/durable proof missing');
      assert.equal(evidence.results.length,7,'Actual job sequence is incomplete');
    }
    if(inputs.scenario.startsWith('history-'))assert.equal(json(resolve(directory,'history-verification.json')).privateControlsAbsent,true);
    const initialized=Date.parse(json(resolve(directory,'initialize-result.json')).completedAt);
    const finished=Date.parse(json(resolve(directory,'native-result.json')).completedAt);
    const images=readdirSync(directory).filter(name=>/^native-image-\d+\.json$/.test(name)).map(name=>({name,...json(resolve(directory,name))}))
      .filter(value=>Date.parse(value.capturedAt)>=initialized&&Date.parse(value.capturedAt)<=finished);
    assert.equal(images.length,1,'Could not identify the actual native phase signed image');
    const image=images[0];assert.equal(image.identifier,'com.shellspan.validation.native-input-p2');
    assert(/^[0-9a-f]{64}$/.test(image.binarySha256)&&image.signing.some(value=>/^CDHash=[0-9a-f]{40}$/.test(value))&&image.signing.some(value=>/^TeamIdentifier=\S+$/.test(value)),'Signed image provenance is incomplete');
    let frontend={frozen:false,kind:'Recorded source and actual signed image; development-server assets were not separately archived'};
    if(image.frozenManifest){
      const manifestPath=own(image.frozenManifest);assert(manifestPath.startsWith(directory+'/'));
      const manifest=json(manifestPath);const manifestSha256=sha(manifestPath);
      assert.equal(image.frozenInputs?.manifestSha256,manifestSha256);
      assert.equal(manifest.hmr,false);assert.equal(manifest.tauriWatch,false);
      assert(resolve(manifest.assetsDirectory).startsWith(directory+'/'));
      assert.deepEqual(captureValidationAssets(manifest.assetsDirectory),manifest.assets,'Frozen frontend assets drifted after the run');
      const token=manifestPath.match(/\/frozen-manifest-([a-f0-9-]{36})\.json$/)?.[1];assert(token);
      for(const stage of['after-frontend-build','before-native-compile','after-webview-result','finished']){
        const check=json(resolve(directory,`frozen-${token}-${stage}.json`));assert.equal(check.manifestSha256,manifestSha256);assert.equal(check.stage,stage);
      }
      const runner=image.name.match(/^native-image-(\d+)\.json$/)[1];
      for(const stage of['before-native-build','after-native-build','before-native-launch','after-native-exit']){
        const check=json(resolve(directory,`frozen-runner-${runner}-${stage}.json`));assert.equal(check.manifestSha256,manifestSha256);assert.equal(check.stage,stage);
      }
      const end=json(resolve(directory,`native-image-${runner}-end.json`));assert.equal(end.verified,true);assert.equal(end.binarySha256,image.binarySha256);assert.equal(end.frozenManifest,manifestPath);
      frontend={frozen:true,kind:'Static Vite build/preview; single-use page; source/assets/image checked through exit',manifest:relative(root,manifestPath),manifestSha256,assetsDirectory:relative(root,manifest.assetsDirectory),assets:manifest.assets};
    }
    cases.set(`${identity.version}/${transport}/${identity.scenario}`,{...identity,directory:relative(root,directory),sourceValidationRoot:validationRoot,
      inputsSha256:sha(resolve(directory,'acceptance-inputs.json')),evidenceSha256:sha(evidencePath),sourceHashes,
      producer,actualPeerProfile:initial?.nativePeerProfile??null,nativeDisplayBinding:initial?.nativeDisplayBinding??null,
      frontend,image:{...image,evidenceSha256:sha(resolve(directory,image.name))}});
  }catch(error){rejected.push({directory:relative(root,directory),reason:String(error)});}
}
const required=[];const lifecycle=[];
for(const version of['4.1','4.4','5.3']){
  for(const transport of['local','ssh'])for(const scenario of['history-small','history-default','history-custom','history-empty','history-unset','jobs'])required.push(`${version}/${transport}/${scenario}`);
  lifecycle.push(`${version}/ssh/lifecycle`);
}
const missing=required.filter(key=>!cases.has(key));const missingLifecycle=lifecycle.filter(key=>!cases.has(key));
const frozenCases=required.filter(key=>cases.get(key)?.frontend.frozen).length;
const frozenLifecycleCases=lifecycle.filter(key=>cases.get(key)?.frontend.frozen).length;
const requiredAuxiliary=['ssh-fault','interactive','close','contention','delegation'];
const auxiliary=Object.fromEntries(requiredAuxiliary.map(name=>[name,[...cases.values()].filter(value=>value.scenario===name||name==='interactive'&&value.scenario==='interactive-fresh').at(-1)]));
const missingAuxiliary=requiredAuxiliary.filter(name=>!auxiliary[name]);
const directory=resolve(owned,'evidence-summary',randomUUID());mkdirSync(directory,{recursive:true,mode:0o700});
const summary={capturedAt:new Date().toISOString(),scope:'Cumulative verified actual application evidence; original matrix failures remain failures',
  sourceValidationRoots:validationRoots,sourceSnapshots:[...sourceSnapshots].map(([path,snapshot])=>({path:relative(root,resolve(path,'.native-input-p2/source-snapshot.json')),sha256:sha(resolve(path,'.native-input-p2/source-snapshot.json')),scope:snapshot.scope,sharedDrift:snapshot.sharedDrift})),
  requiredCases:required.length,coveredCases:required.length-missing.length,requiredLifecycleCases:lifecycle.length,
  coveredLifecycleCases:lifecycle.length-missingLifecycle.length,coverageComplete:missing.length===0&&missingLifecycle.length===0,
  frozenCases,frozenLifecycleCases,frozenCoverageComplete:frozenCases===required.length&&frozenLifecycleCases===lifecycle.length,
  auxiliary,missingAuxiliary,auxiliaryComplete:missingAuxiliary.length===0,
  matrices,missing,missingLifecycle,rejected,cases:Object.fromEntries([...cases].sort(([left],[right])=>left.localeCompare(right)))};
writeFileSync(resolve(directory,'summary.json'),JSON.stringify(summary,null,2),{mode:0o600});
console.log(JSON.stringify({directory,coverageComplete:summary.coverageComplete,coveredCases:summary.coveredCases,coveredLifecycleCases:summary.coveredLifecycleCases,missing,missingLifecycle,rejected}));
assert(summary.coverageComplete,'Actual P2 matrix evidence coverage is incomplete');
if(values['require-frozen'])assert(summary.frozenCoverageComplete,'Frozen static-asset evidence coverage is incomplete; earlier source/image evidence was not backfilled');
if(values['require-auxiliary'])assert(summary.auxiliaryComplete,'Current auxiliary application evidence is incomplete');
