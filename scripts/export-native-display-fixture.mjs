// Export display bytes only, never a synthetic lifecycle receipt.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const args=process.argv.slice(2),index=args.indexOf('--captures');
assert(index>=0&&args[index+1],'Provide --captures with an actual ownership-window manifest directory');
const root=path.resolve(args[index+1]);
const manifest=JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'));
assert.equal(manifest.nativeFailures.length,0,'Native capture contains failures');
const name=manifest.cases.find(name=>name.startsWith('commit-'));assert(name);
const raw=await readFile(path.join(root,name,'pty.bin'));
const packets={};
for(const[label,value]of[['enter','MQ=='],['exit','MA==']]){
  const expected=Buffer.from(`\x1b]1337;SetUserVar=ShellSpanP0ReflowCursorLine=${value}\x07`);
  const offset=raw.indexOf(expected);assert(offset>=0,`Missing actual native ${label} packet`);
  const bytes=raw.subarray(offset,offset+expected.length);
  packets[label]={offset,length:bytes.length,base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
}
const fixture={kind:'actual native PTY display-packet excerpt; untrusted presentation, not control acknowledgement',
  provenance:{captureCase:name,rawPtySha256:createHash('sha256').update(raw).digest('hex'),
    shellSha256:manifest.inputs.shell.sha256,bridgeSha256:manifest.inputs.bridge.sha256,
    platform:'macOS arm64',bash:'5.3',readline:'8.3.6',
    regenerate:'node scripts/export-native-display-fixture.mjs --captures <successful ownership-window capture directory>'},packets};
const output=path.resolve('src/lib/terminal/__tests__/fixtures/native-input-display.json');
await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(fixture,null,2)+'\n');
console.log(output);
