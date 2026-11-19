import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,isAbsolute} from 'node:path';
import {captureValidationSources} from '../integration/frozen-validation.mjs';
const [phase,directory]=process.argv.slice(2);
assert(['before','after'].includes(phase)&&isAbsolute(directory));
const root=resolve(import.meta.dirname,'../../..');
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const sources=captureValidationSources(root);
const archive=resolve(directory,'source-before.tar.gz');
if(phase==='before'){
  const files=resolve(directory,'source-files.list');writeFileSync(files,Object.keys(sources).join('\0')+'\0',{flag:'wx'});
  execFileSync('tar.exe',['-czf',archive,'--null','-T',files],{cwd:root,stdio:'pipe'});
  assert.deepEqual(captureValidationSources(root),sources,'Source changed while its complete archive was created');
}
const document={at:new Date().toISOString(),phase,sources,
  archiveSha256:hash(archive),importedArchiveSha256:hash(resolve(root,'artifacts/tests/native-input/acceptance/source.tar.gz')),
  indexSha256:hash(resolve(root,'artifacts/tests/native-input/acceptance/frozen-git-index'))};
writeFileSync(resolve(directory,`source-${phase}.json`),JSON.stringify(document,null,2),{flag:'wx'});
if(phase==='after'){
  const before=JSON.parse(readFileSync(resolve(directory,'source-before.json'),'utf8'));
  assert.deepEqual(document.sources,before.sources,'The complete source set changed during desktop acceptance');
  assert.equal(document.archiveSha256,before.archiveSha256);assert.equal(document.indexSha256,before.indexSha256);
}
