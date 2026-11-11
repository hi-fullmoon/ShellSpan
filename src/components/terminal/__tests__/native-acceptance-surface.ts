export interface NativeAcceptanceBounds {
 top:number;bottom:number;left:number;right:number;width:number;height:number;
}
export async function createNativeAcceptanceSurface(parent:HTMLElement):Promise<{host:HTMLDivElement;bounds:NativeAcceptanceBounds}>{
 if(!parent.isConnected)throw Error('Native acceptance root is not connected');
 await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
 const host=document.createElement('div');host.style.cssText='width:100%;height:100%;min-height:0';parent.append(host);
 const rect=host.getBoundingClientRect(),root=parent.getBoundingClientRect();
 const bounds:NativeAcceptanceBounds={top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right,width:rect.width,height:rect.height};
 if(root.width<=0||root.height<=0||bounds.width<=0||bounds.height<=0||bounds.top< -1||bounds.left< -1||bounds.bottom>innerHeight+1||bounds.right>innerWidth+1||bounds.top<root.top-1||bounds.bottom>root.bottom+1){
  host.remove();throw Error('Native acceptance surface is outside the visible root viewport');
 }
 return {host,bounds};
}
