export type MacLifecycleFrame = {sessionId:string;capturedAtUnixMs:number;payload:string};

export function verifyMacLateOutputFrames(
 frames:readonly MacLifecycleFrame[],sessionId:string,releasedAtUnixMs:number,
):MacLifecycleFrame[] {
 const marker='OLD_LATE_OUTPUT';
 const ownedFrames=frames.filter(frame=>frame.sessionId===sessionId);
 const output=ownedFrames.map(frame=>frame.payload).join('');
 const lateFrames:MacLifecycleFrame[]=[];
 let markerStart=output.indexOf(marker),offset=0;
 // PTY chunks can split any part of a marker. Keep the original frames covering
 // every complete occurrence so a late suffix cannot hide a pre-release prefix.
 for(const frame of ownedFrames) {
  const end=offset+frame.payload.length;
  while(markerStart!==-1&&markerStart+marker.length<=offset) {
   markerStart=output.indexOf(marker,markerStart+marker.length);
  }
  if(end>offset&&markerStart!==-1&&markerStart<end)lateFrames.push(frame);
  offset=end;
 }
 if(!lateFrames.length||!lateFrames.every(frame=>frame.capturedAtUnixMs>=releasedAtUnixMs)) {
  throw Error('Late bytes lack actual old-transport/time provenance');
 }
 return lateFrames;
}
