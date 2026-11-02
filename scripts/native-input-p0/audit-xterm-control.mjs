// Compare previously captured real terminal states; no generated screen data.
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const base=path.join(root,'.native-input-p0/final-record/macos-5.3/browser/unicode6');
const files=(await readdir(path.join(base,'full'))).filter(name=>
  /^(chromium|webkit)-(dom|webgl)-(dark|light)-(32|40|100|180)-(normal|oversize)-(user|bridge)\.json$/.test(name));
assert.equal(files.length,128);
for(const file of files) {
  const original=JSON.parse(await readFile(path.join(base,'full',file),'utf8'));
  const candidate=JSON.parse(await readFile(path.join(base,'full-dependency-lab',file),'utf8'));
  assert.deepEqual(candidate,original,`Default-off generic dependency behavior changed: ${file}`);
}
const summary={comparedRealStates:files.length,result:'PASS',option:'reflowCursorLine=false'};
await writeFile(path.join(root,'.native-input-p0/xterm-default-control.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary));
