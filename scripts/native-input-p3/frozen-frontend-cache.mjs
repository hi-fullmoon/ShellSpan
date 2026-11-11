import assert from 'node:assert/strict';
import fs from 'node:fs';
import p from 'node:path';
import {createHash} from 'node:crypto';
import {loadEnv} from 'vite';
import {captureValidationAssets,captureValidationSources} from '../native-input-p2/frozen-validation.mjs';
import {dependencyInventory,dependencyInputProjection} from './acceptance-inputs.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
const digest=value=>hash(JSON.stringify(ordered(value)));
function owned(root,target){
  const relative=p.relative(p.resolve(root),p.resolve(target));
  assert(relative&&!relative.startsWith('..')&&!p.isAbsolute(relative),'Frontend cache must stay inside owned test artifacts');
}
function realDirectory(directory){
  assert(fs.lstatSync(directory).isDirectory()&&!fs.lstatSync(directory).isSymbolicLink(),'Frontend cache directory must not be a link');
  assert.equal(p.resolve(fs.realpathSync(directory)),p.resolve(directory),'Frontend cache path traverses a link');
}
function createRealDirectory(directory){
  let ancestor=p.resolve(directory);
  for(;;){
    try{fs.lstatSync(ancestor);break;}
    catch(error){if(error.code!=='ENOENT')throw error;const parent=p.dirname(ancestor);assert.notEqual(parent,ancestor);ancestor=parent;}
  }
  // Validate before mkdir: a missing child below a junction must not create
  // anything at that junction's target outside the owned artifacts scope.
  realDirectory(ancestor);
  fs.mkdirSync(directory,{recursive:true});realDirectory(directory);
}
function environmentInputs(root){
  // Match Vite's production-mode env loading before comparing effective
  // inputs. Vite initializes an absent NODE_ENV during the real compilation.
  loadEnv('production',root,'VITE_');
  const files={};
  for(const name of ['.env','.env.local','.env.production','.env.production.local']){
    const file=p.join(root,name);
    files[name]=fs.existsSync(file)?hash(fs.readFileSync(file)):null;
  }
  const values=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith('VITE_')||['NODE_ENV','BROWSERSLIST_ENV','BROWSERSLIST','BROWSERSLIST_CONFIG'].includes(key)));
  values.NODE_ENV??=process.env.VITE_USER_NODE_ENV==='development'?'development':'production';
  return digest({files,values});
}

// Opt-in, static-build reuse only. Current per-case manifests, single-use URL,
// resource checks, App identity, approvals and actual execution stay separate.
export async function buildFrozenFrontend({root,output,entry,sources,cacheRoot,build}){
  if(!cacheRoot){await build();return{enabled:false,reused:false};}
  assert(p.isAbsolute(cacheRoot),'Absolute frontend cache directory required');
  owned(p.join(root,'.artifacts/tests'),cacheRoot);
  owned(p.join(root,'.artifacts/tests/native-input-p2'),output);
  assert(!fs.existsSync(output),'Never overwrite a previous case frontend');
  assert(typeof entry==='string'&&Object.hasOwn(sources,entry),'Frozen source entry required');
  realDirectory(p.dirname(output));
  assert(!p.resolve(output).startsWith(p.resolve(cacheRoot)+p.sep)&&!p.resolve(cacheRoot).startsWith(p.resolve(output)+p.sep)&&p.resolve(output)!==p.resolve(cacheRoot),'Frontend output and cache must be disjoint');
  assert.deepEqual(captureValidationSources(root),sources,'Frontend source inputs changed before reuse');
  createRealDirectory(cacheRoot);
  const dependencies=await dependencyInventory(p.join(root,'node_modules'));
  const inputs={version:1,root:p.resolve(root),entry,sourceSha256:digest(sources),
    dependenciesSha256:digest(dependencyInputProjection(dependencies)),environmentSha256:environmentInputs(root),
    node:{version:process.version,platform:process.platform,arch:process.arch,executableSha256:hash(fs.readFileSync(process.execPath))},
    pipeline:'vite-configFile-false-react-tailwind-no-baseline-single-entry-v1'};
  const key=digest(inputs),directory=p.join(cacheRoot,key),manifest=p.join(directory,'manifest.json');
  if(fs.existsSync(directory)){
    realDirectory(directory);
    assert(fs.lstatSync(manifest).isFile()&&!fs.lstatSync(manifest).isSymbolicLink(),'Invalid frontend cache manifest');
    const record=JSON.parse(fs.readFileSync(manifest,'utf8'));
    assert.deepEqual(record.inputs,inputs,'Frontend cache input provenance changed');
    realDirectory(p.join(directory,'assets'));
    assert.deepEqual(captureValidationAssets(p.join(directory,'assets')),record.assets,'Frontend cache asset integrity changed');
    fs.cpSync(p.join(directory,'assets'),output,{recursive:true,errorOnExist:true,force:false});
    assert.deepEqual(captureValidationAssets(output),record.assets,'Per-case frontend copy differs');
    assert.deepEqual(captureValidationSources(root),sources,'Frontend source inputs changed while copying');
    assert.deepEqual(dependencyInputProjection(await dependencyInventory(p.join(root,'node_modules'))),dependencyInputProjection(dependencies),'Installed frontend inputs changed while copying');
    assert.equal(environmentInputs(root),inputs.environmentSha256,'Frontend build environment changed');
    return{enabled:true,reused:true,key,manifest,manifestSha256:hash(fs.readFileSync(manifest)),assetsSha256:digest(record.assets)};
  }
  await build();
  assert.deepEqual(captureValidationSources(root),sources,'Frontend source inputs changed during build');
  assert.deepEqual(dependencyInputProjection(await dependencyInventory(p.join(root,'node_modules'))),dependencyInputProjection(dependencies),'Installed frontend inputs changed during build');
  assert.equal(environmentInputs(root),inputs.environmentSha256,'Frontend build environment changed');
  const assets=captureValidationAssets(output);
  // Publish the exclusive completion manifest last. An interrupted copy has no
  // valid manifest and is refused; Windows need not rename a scanned directory.
  fs.mkdirSync(directory);fs.cpSync(output,p.join(directory,'assets'),{recursive:true,errorOnExist:true,force:false});
  assert.deepEqual(captureValidationAssets(p.join(directory,'assets')),assets);
  fs.writeFileSync(manifest,JSON.stringify({inputs,assets,buildCompletedAt:new Date().toISOString(),originOutput:output},null,2),{flag:'wx'});
  return{enabled:true,reused:false,key,manifest,manifestSha256:hash(fs.readFileSync(manifest)),assetsSha256:digest(assets)};
}
