// Freeze existing real PTY bytes; no synthesized terminal output or control.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const input=resolve(process.argv[2]),output=resolve(process.argv[3]??'src/lib/terminal/__tests__/fixtures/native-selection-reflow.json');
const raw=await readFile(resolve(input,'raw.bin')),geometry=JSON.parse(await readFile(resolve(input,'geometry.json'),'utf8'));
const binding=JSON.parse(await readFile(resolve(input,'verified-display-binding.json'),'utf8'));
const corpus=JSON.parse(await readFile(resolve(input,'source-corpus.json'),'utf8'));
const endMarker=Buffer.from('P3_HISTORY_60\r\n'),end=raw.indexOf(endMarker)+endMarker.length;assert(end>=endMarker.length);
const bytes=raw.subarray(0,end),sha=data=>createHash('sha256').update(data).digest('hex');
const fixture={version:1,scope:'Actual controlled ZLE prefix through sixty genuine output lines; dependency coordinate regression only, not P3 acceptance',
 provenance:{capture:input.slice(input.indexOf('.native-input-p3/')),rawSha256:sha(raw),byteRange:[0,end]},
 columns:geometry.columns,rows:geometry.rows,resizeColumns:geometry.resizeEvents.map(event=>event.columns),binding,
 source:corpus[0].source,packet:{base64:bytes.toString('base64'),length:bytes.length,sha256:sha(bytes)}};
assert.equal(fixture.columns,100);assert.equal(fixture.resizeColumns.length,7);
await writeFile(output,JSON.stringify(fixture,null,2)+'\n');process.stdout.write(JSON.stringify({output,bytes:bytes.length,sha256:sha(bytes)})+'\n');
