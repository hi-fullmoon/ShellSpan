// Preserve a real live observer failure as a dependency regression fixture.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const input=resolve(process.argv[2]),report=JSON.parse(await readFile(input,'utf8'));
const item=report.results.find(item=>item.theme==='adam1'&&item.columns===32);
assert(item?.exitCode===0);
const parked=item.observations.find(item=>item.role==='parked');
const frames=parked.frames.filter(frame=>frame.at>=parked.parkedAt),first=frames[0];
assert(frames.some(frame=>frame.viewportY===frame.baseY));
const raw=await readFile(resolve(item.evidence,'raw.bin'));
const events=JSON.parse(await readFile(resolve(item.evidence,'geometry-events.json'),'utf8'));
const bytes=raw.subarray(0,events.at(-1).offset),sha=data=>createHash('sha256').update(data).digest('hex');
const fixture={version:1,scope:'Real live PTY failure; viewport coordinate regression only, not new native acceptance',
 provenance:{report:input.slice(input.indexOf('artifacts/tests/native-input-p3/')),rawSha256:sha(raw),byteRange:[0,bytes.length]},
 columns:item.columns,rows:30,binding:parked.binding,park:{offset:first.offset,viewportY:first.viewportY},events,
 packet:{base64:bytes.toString('base64'),length:bytes.length,sha256:sha(bytes)}};
assert(first.offset<events[0].offset);
const output=resolve('src/lib/terminal/__tests__/fixtures/native-viewport-reflow.json');
await writeFile(output,JSON.stringify(fixture,null,2)+'\n');
process.stdout.write(JSON.stringify({output,bytes:bytes.length,sha256:sha(bytes)})+'\n');
