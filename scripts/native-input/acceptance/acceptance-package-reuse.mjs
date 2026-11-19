import assert from 'node:assert/strict';
import fs from 'node:fs';
import {resolve} from 'node:path';
import {captureValidationSources} from '../integration/frozen-validation.mjs';
import {nativeInputReleaseDirectory} from '../integration/resource-paths.mjs';
import {inside,hashFile,inventory,fingerprints,reuseDecision,verifyRetainedArtifacts,dependencyInputProjection} from './acceptance-inputs.mjs';

const normalized=files=>Object.fromEntries(Object.entries(files).map(([path,sha256])=>[path.replaceAll('\\','/'),sha256]));
async function requireTree(directory,expected){
  assert.deepEqual(await inventory(directory,fs.readdirSync(directory)),normalized(expected),'Retained resource or frontend drift');
}

export function productionDependencyInputs(value){
  // Explicit migration of the old inventory using the production build's
  // declared Vite cacheDir boundary. Installed package bytes are all retained.
  return dependencyInputProjection(value);
}
export function assertReusableBuild(plan,result){
  assert.equal(plan.target,'x86_64-pc-windows-msvc','Retained package target changed');
  assert(result.phases.some(phase=>phase.name==='bundle'&&!phase.failure),'No completed build to reuse');
  assert(result.ok===true||result.summary.executed===0&&result.lifecycle.every(item=>item.id==='package/build'||!item.executed),
    'An uncertain or partially executed acceptance batch cannot supply a reusable package');
}
export function assertArtifactSourceContext(stage){
  assert(stage.sealed&&stage.contextKind!=='controller-only','A controller-only snapshot cannot supply application artifacts');
}
export async function readReusablePackage(owner,directory,root,dependencies,toolchain){
  const read=path=>JSON.parse(fs.readFileSync(path,'utf8'));
  root=fs.realpathSync(root);inside(resolve(owner,'artifacts/tests/p3'),root);
  directory=fs.realpathSync(directory);inside(resolve(owner,'artifacts/tests/p3'),directory);
  const plan=read(resolve(directory,'plan.json')),result=read(resolve(directory,'result.json'));
  assert.equal(plan.root,root,'Artifact source context must be exactly the retained frozen root');
  assertReusableBuild(plan,result);
  const batchId=plan.planned[0].artifact.batch;assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(batchId));
  assert.equal(directory,resolve(root,'artifacts/tests/pk',batchId.slice(0,8)),'Producer directory does not match its artifact identity');
  assert.equal(plan.install,resolve(directory,'i'),'Retained installation binding changed');
  assert.equal(plan.binaryName,`ShellSpanBatch${batchId.slice(0,8)}`);assert.equal(plan.productName,`ShellSpan Package Batch ${batchId.slice(0,8)}`);
  assert.deepEqual(captureValidationSources(root),read(resolve(root,'../sources.json')),'Artifact source snapshot drift');
  const stage=read(resolve(root,'artifacts/tests/native-input/acceptance/candidate-stage.json'));assertArtifactSourceContext(stage);assert.equal(stage.root,root);
  const expected=productionDependencyInputs(read(resolve(directory,'installed-dependencies.json'))),actual=productionDependencyInputs(dependencies);
  const changed=Object.keys({...expected.files,...actual.files}).filter(path=>expected.files[path]!==actual.files[path]);
  const links=Object.keys({...expected.links,...actual.links}).filter(path=>JSON.stringify(expected.links[path])!==JSON.stringify(actual.links[path]));
  assert.equal(changed.length+links.length,0,`Actual dependency drift: ${JSON.stringify({changedFiles:changed.slice(0,20),changedLinks:links.slice(0,20),total:changed.length+links.length})}`);
  for(const key of ['node','rustc','cargo','lockSha256','cargoLockSha256'])assert.equal(toolchain[key],plan.toolchain[key],`Toolchain changed: ${key}`);
  const installer=read(resolve(directory,'installer.json'));
  // Retained batches bind their paths and bytes to the original frozen source.
  const legacyConfig=resolve(root,'.artifacts/config',`native-batch-${batchId}.json`);
  const legacy=installer.configFile===legacyConfig;
  assert(legacy||installer.configFile===resolve(directory,'tauri-config.json'),'Retained package configuration path changed');
  const packageResources=legacy?resolve(root,'.artifacts/releases/native-input/generated'):nativeInputReleaseDirectory(root);
  assert.deepEqual(installer.artifacts.map(item=>item.role).sort(),['compiled-unbundled','installer']);
  for(const artifact of installer.artifacts){inside(directory,artifact.path);assert.equal(fs.realpathSync(artifact.path).toLowerCase(),resolve(artifact.path).toLowerCase(),'Linked artifact input rejected');}
  assert.equal(await hashFile(installer.configFile),installer.configSha256,'Retained package configuration drift');
  await verifyRetainedArtifacts(installer.artifacts);
  await requireTree(resolve(directory,'frontend'),read(resolve(directory,'frontend-assets.json')));
  await requireTree(packageResources,read(resolve(directory,'resource-inputs.json')));
  const inputs=read(resolve(directory,'build-inputs.json'));
  const captured=await fingerprints(root,Object.values(inputs));
  for(const input of Object.values(inputs)){
    assert.equal(input.target,plan.target,'Retained stage target changed');const actual=captured[input.stage];
    const decision=reuseDecision(input,actual);assert(decision.reuse,`Retained ${input.stage} inputs changed: ${JSON.stringify(decision)}`);
  }
  const resources=resolve(root,'artifacts/tests/native-input/integration/resources/native-input');
  const catalogue=read(resolve(resources,'editors-windows-x64.json'));
  for(const profile of catalogue.profiles){
    inside(resources,resolve(resources,profile.module));assert.equal(await hashFile(resolve(resources,profile.module)),profile.moduleSha256,'Retained Core drift');
  }
  const config=read(installer.configFile),origin=config.app.security.csp.match(/connect-src[^;]* (http:\/\/127\.0\.0\.1:\d+);/)?.[1];assert(origin,'Exact original report origin missing');
  assert.equal(config.identifier,`com.shellspan.validation.batch.${batchId}`);assert.equal(config.mainBinaryName,plan.binaryName);
  assert(!fs.existsSync(plan.install),'Retained installation must be absent; never overwrite or adopt it');
  return {directory,plan,config,configFile:installer.configFile,configSha256:installer.configSha256,origin,batchId,artifacts:installer.artifacts,inputs,packageResources};
}
