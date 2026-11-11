import {expect,it} from 'vitest';
import {verifyMacLateOutputFrames,type MacLifecycleFrame} from './mac-late-lifecycle-frames';

const marker='OLD_LATE_OUTPUT';
const frame=(payload:string,capturedAtUnixMs=100,sessionId='old'):MacLifecycleFrame=>({sessionId,capturedAtUnixMs,payload});
const verify=(frames:readonly MacLifecycleFrame[])=>verifyMacLateOutputFrames(frames,'old',100);

it('keeps the original frame and metadata for an unsplit marker',()=>{
 const output=frame('prefix\r\n'+marker+'\r\nsuffix',101);
 expect(verify([output])).toEqual([output]);
 expect(verify([output])[0]).toBe(output);
});

it.each(Array.from({length:marker.length-1},(_,index)=>index+1))(
 'accepts the late marker split at character %i',split=>{
  const first=frame('prefix'+marker.slice(0,split)),second=frame(marker.slice(split)+'\r\n',101);
  const frames=[frame('earlier output',99),first,frame(marker,1,'new'),second,frame('later output',102)];
  expect(verify(frames)).toEqual([first,second]);
  expect(verify(frames)[0]).toBe(first);
  expect(verify(frames)[1]).toBe(second);
 });

it('accepts a marker delivered one character per frame with empty chunks interleaved',()=>{
 const output=Array.from(marker,character=>frame(character));
 const frames=output.flatMap(value=>[frame(''),value]);
 expect(verify(frames)).toEqual(output);
});

it.each([0,1,2])('rejects a pre-release frame at marker fragment %i',early=>{
 const frames=['OLD_','LATE_','OUTPUT'].map((part,index)=>frame(part,index===early?99:101));
 expect(()=>verify(frames)).toThrow('Late bytes lack actual old-transport/time provenance');
});

it('does not let a later valid occurrence hide an earlier pre-release marker',()=>{
 expect(()=>verify([frame('OLD_LATE_',99),frame('OUTPUT',100),frame(marker,101)]))
  .toThrow('Late bytes lack actual old-transport/time provenance');
});

it('retains the frames covering every late occurrence without duplicates',()=>{
 const first=frame('OLD_LATE_'),second=frame('OUTPUT\r\n'+marker,101);
 expect(verify([first,second])).toEqual([first,second]);
});

it.each([
 {frames:[]},
 {frames:[frame('OLD_LATE_')]},
 {frames:[frame(marker,101,'new')]},
 {frames:[frame('OLD_LATE_'),frame('OUTPUT',101,'new')]},
])('rejects absent, incomplete or foreign-transport markers: $frames',({frames})=>{
 expect(()=>verify(frames)).toThrow('Late bytes lack actual old-transport/time provenance');
});
