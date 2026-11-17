// Explicit validation admission for a complete frozen source copy. The normal
// app resource path never obtains this process-only selection implicitly.
import assert from 'node:assert/strict';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {captureValidationSources} from '../native-input-p2/frozen-validation.mjs';
export async function editorValidationEnvironment(root,resources,targets){
 root=await realpath(root);resources=await realpath(resources);
 const child=relative(root,resources);assert(child!==''&&child!=='..'&&!child.startsWith(`..${sep}`)&&!isAbsolute(child),'Editor validation resources must be a strict descendant of the snapshot');
 const index=JSON.parse(await readFile(resolve(root,'artifacts/tests/native-input-p3/snapshot-index.json'),'utf8'));assert.equal(await realpath(index.root),root);
 const sha=bytes=>createHash('sha256').update(bytes).digest('hex');assert.equal(sha(await readFile(index.index)),index.indexSha256);
 const stage=JSON.parse(await readFile(resolve(root,'artifacts/tests/native-input-p3/candidate-stage.json'),'utf8'));assert(stage.sealed&&stage.root===root);
 const bytes=await readFile(resolve(stage.directory,'sources.json')),sources=JSON.parse(bytes.toString('utf8'));assert.deepEqual(captureValidationSources(root),sources);
 assert(targets.length&&targets.every(value=>['macos-arm64','linux-aarch64-glibc-2.36','windows-x64'].includes(value)));
 await writeFile(resolve(root,'artifacts/tests/native-input-p3/editor-validation-sources.json'),bytes);
 let packaged=false;
 try{const manifest=JSON.parse(await readFile(resolve(resources,'resource-manifest.json'),'utf8'));assert(manifest.validationOnly,'A normal app output cannot be relabeled as a validation package');packaged=true;}catch(error){if(error.code!=='ENOENT')throw error;}
 if(packaged){const marker=JSON.parse(await readFile(resolve(resources,'editor-validation.json'),'utf8'));assert.equal(marker.resourceRoot,resources);assert.equal(marker.sourceManifestSha256,sha(bytes));assert(targets.every(target=>marker.editorTargets.includes(target)));}
 else await writeFile(resolve(resources,'editor-validation.json'),JSON.stringify({protocol:'shellspan.native-editor-validation',resourceRoot:resources,sourceManifestSha256:sha(bytes),editorTargets:targets},null,2));
 return{SHELLSPAN_NATIVE_EDITOR_VALIDATION_ROOT:resources};
}
