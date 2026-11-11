import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {Terminal} from '@xterm/xterm';
import fixture from './fixtures/mac-lifecycle-startup.json';
import {macLifecyclePromptResidues} from './mac-lifecycle-prompt';

it.each(fixture.samples)('observes the actual captured $name prefix without editing bytes, buffer or public methods',async sample=>{
 const bytes=Buffer.from(sample.base64,'base64');expect(bytes.length).toBe(sample.bytes);expect(createHash('sha256').update(bytes).digest('hex')).toBe(sample.sha256);
 const terminal=new Terminal({cols:fixture.columns,rows:fixture.rows,allowProposedApi:true}),input:string[]=[];
 const originals={write:terminal.write,selection:terminal.getSelection,line:terminal.buffer.normal.getLine};terminal.onData(value=>input.push(value));
 try{
  // Public parser/buffer only; no fake renderer, canvas, IPC or native receipt.
  // This unattached unit terminal is not an App or browser acceptance result.
  await new Promise<void>(done=>terminal.write(bytes,done));
  const state=()=>Array.from({length:terminal.buffer.normal.length},(_,row)=>terminal.buffer.normal.getLine(row)?.translateToString(false));
  const before=state(),diagnostic={columns:terminal.cols,rows:terminal.rows,nonempty:before.flatMap((line,row)=>line?.trim()?[{row,text:line,translatedRight:terminal.buffer.normal.getLine(row)?.translateToString(true),firstCellInverse:terminal.buffer.normal.getLine(row)?.getCell(0)?.isInverse()}]:[])};
  expect(macLifecyclePromptResidues(terminal),JSON.stringify(diagnostic)).toEqual(sample.expectedResidualRows);expect(state()).toEqual(before);
  expect(terminal.write).toBe(originals.write);expect(terminal.getSelection).toBe(originals.selection);expect(terminal.buffer.normal.getLine).toBe(originals.line);expect(input).toEqual([]);
 }finally{terminal.dispose();}
});
