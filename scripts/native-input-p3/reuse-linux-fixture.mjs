// Reuse a live owned peer only after all actual native compile inputs/artifacts
// match. A host-only profile binding change does not imply a target rebuild.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {requireEditorResources} from './editor-resources.mjs';
import {captureValidationSources} from '../native-input-p2/frozen-validation.mjs';
const fixturePath=resolve(process.argv[2]),root=resolve(process.argv[3]),fixture=JSON.parse(readFileSync(fixturePath,'utf8'));
const stage=JSON.parse(readFileSync(resolve(root,'artifacts/tests/native-input-p3/candidate-stage.json'),'utf8'));assert(stage.sealed&&stage.root===root);
const sources=captureValidationSources(root);assert.deepEqual(sources,JSON.parse(readFileSync(resolve(stage.directory,'sources.json'),'utf8')));
assert.equal(fixture.container,`shellspan-nip-p3-${fixture.id}`);
assert.equal(execFileSync('docker',['inspect','--format','{{index .Config.Labels "shellspan.native-input-p3"}}',fixture.container],{encoding:'utf8'}).trim(),fixture.id);
assert.equal(execFileSync('docker',['inspect','--format','{{.State.Running}}',fixture.container],{encoding:'utf8'}).trim(),'true');
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex'),target='linux-aarch64-glibc-2.36';
requireEditorResources(root,target);requireEditorResources(fixture.root,target);
const cataloguePath='artifacts/tests/native-input-p2/resources/native-input/editors-linux-aarch64-glibc-2.36.json';assert.equal(hash(resolve(root,cataloguePath)),hash(resolve(fixture.root,cataloguePath)));
const catalogue=JSON.parse(readFileSync(resolve(root,cataloguePath),'utf8'));for(const[path,digest]of Object.entries(catalogue.sources))assert.equal(hash(resolve(root,path)),digest);
const directory=resolve(root,'artifacts/tests/native-input-p3/ssh-fixture');mkdirSync(directory,{recursive:true});
const reused={...fixture,root};writeFileSync(resolve(directory,'fixture.json'),JSON.stringify(reused,null,2),{flag:'wx'});
writeFileSync(resolve(directory,'reuse.json'),JSON.stringify({fixturePath,actualProducerSourceRoot:fixture.root,actualRebuild:false,sourceMatchingInputs:catalogue.sources,fixture:reused},null,2),{flag:'wx'});
writeFileSync(resolve(directory,'owner.json'),JSON.stringify({id:fixture.id,container:fixture.container,root,image:fixture.image,imageId:fixture.imageId},null,2),{flag:'wx'});
assert.deepEqual(captureValidationSources(root),sources);console.log(resolve(directory,'fixture.json'));
