import assert from 'node:assert/strict';
import {readFileSync,realpathSync,readdirSync,cpSync,constants} from 'node:fs';
import {resolve} from 'node:path';
import {captureValidationSources} from '../native-input-p2/frozen-validation.mjs';
import {auditEditorResources} from './editor-resources.mjs';
import {inside,inventory,hashFile,digest} from './acceptance-inputs.mjs';

export function copySnapshotResources(source,destination){
  // A filesystem clone has independent contents on first write. Where clones
  // are unsupported Node falls back to a regular copy, never a hard link.
  cpSync(source,destination,{recursive:true,mode:constants.COPYFILE_FICLONE});
}

export async function selectSnapshotResources(owner,value){
  const root=realpathSync(value);inside(resolve(owner,'.artifacts/tests/p3'),root);
  const stage=JSON.parse(readFileSync(resolve(root,'.artifacts/tests/native-input-p3/candidate-stage.json'),'utf8'));
  assert(stage.sealed&&stage.root===root,'Resource reuse requires a sealed source snapshot');
  inside(resolve(owner,'.artifacts/tests/p3'),stage.directory);
  const manifest=resolve(stage.directory,'sources.json'),sources=JSON.parse(readFileSync(manifest,'utf8'));
  assert.deepEqual(captureValidationSources(root),sources,'Resource source snapshot changed');
  assert(auditEditorResources(root,'windows-x64').selectedValid,'Resource source does not match its frozen native inputs');
  const directory=realpathSync(resolve(root,'.artifacts/tests/native-input-p2/resources'));inside(root,directory);
  const paths=readdirSync(directory),files=await inventory(directory,paths);
  return {root,directory,paths,files,sourceManifestSha256:await hashFile(manifest),resourcesSha256:digest(files)};
}
export async function verifySnapshotResourceCopy(selection,destination){
  assert.deepEqual(await inventory(selection.directory,selection.paths),selection.files,'Resource source changed during copying');
  assert.deepEqual(await inventory(destination,readdirSync(destination)),selection.files,'Copied resources differ from the retained original');
}
