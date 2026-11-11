export function nativeCaptureError(status:number,detail:string):string {
  return `Owned actual window capture refused (HTTP ${status}): ${detail.slice(0,4096)}`;
}
