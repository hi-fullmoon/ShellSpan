import type {Terminal} from '@xterm/xterm';

/** Observation for these owned printf-only lifecycle cases. Their programs do
 * not print a standalone inverse percent. Never erase or move such a cell. */
export function macLifecyclePromptResidues(terminal:Terminal):number[]{
 const buffer=terminal.buffer.normal,result:number[]=[];
 for(let row=0;row<buffer.length;row++){
  const line=buffer.getLine(row);
  if(line&&line.translateToString(false)==='%'+(' '.repeat(line.length-1))&&line.getCell(0)?.isInverse())result.push(row);
 }
 return result;
}
