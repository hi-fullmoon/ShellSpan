import type {TerminalController} from '../registry/terminal-registry';
const property=(value:unknown,key:string):unknown=>value!==null&&(typeof value==='object'||typeof value==='function')?Reflect.get(value,key):undefined;
/** Read-only renderer observation. No parser, buffer, input or API replacement. */
export function macRenderObserver(controller:TerminalController){
 const terminal=controller.terminal;let renders=0,paint:Record<string,unknown>|null=null,readError:string|null=null;
 const context=()=>{
  const value=property(property(property(controller,'webglAddon'),'_renderer'),'_gl');
  if(typeof WebGL2RenderingContext!=='undefined'&&value instanceof WebGL2RenderingContext)return value;
  if(typeof WebGLRenderingContext!=='undefined'&&value instanceof WebGLRenderingContext)return value;
  return undefined;
 };
 const listener=terminal.onRender(()=>{
  renders++;const gl=context();if(!gl||gl.isContextLost()||gl.getParameter(gl.FRAMEBUFFER_BINDING)!==null)return;
  const width=Math.min(128,gl.drawingBufferWidth),height=Math.min(64,gl.drawingBufferHeight);if(!width||!height)return;
  try{
   const pixels=new Uint8Array(width*height*4);gl.readPixels(0,gl.drawingBufferHeight-height,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
   let painted=0;const colors=new Set<string>();for(let index=0;index<pixels.length;index+=4)if(pixels[index+3]){painted++;colors.add(pixels[index]+','+pixels[index+1]+','+pixels[index+2]+','+pixels[index+3]);}
   if(painted&&colors.size>1)paint={at:Date.now(),width,height,paintedPixels:painted,colors:colors.size,defaultFramebuffer:true};
  }catch(error){readError=String(error);}
 });
 return{
  snapshot(){
   const gl=context(),row=terminal.element?.querySelector('.xterm-rows'),renderService=property(property(terminal,'_core'),'_renderService'),renderer=property(property(renderService,'_renderer'),'value');
   const constructor=property(renderer,'constructor'),implementation=typeof constructor==='function'?constructor.name:null;
   const rows=row?{display:getComputedStyle(row).display,visibility:getComputedStyle(row).visibility,rows:row.childElementCount}:null;
   return{at:Date.now(),implementation,kind:gl?'webgl':rows&&rows.display!=='none'&&rows.visibility!=='hidden'?'dom':'unknown',renders,contextLost:gl?.isContextLost()??null,contextVersion:gl?.getParameter(gl.VERSION)??null,paint,readError,dom:rows,canvasCount:terminal.element?.querySelectorAll('canvas').length??0,userAgent:navigator.userAgent,scope:'Actual renderer/context/readback observations only; no parser access or execution authority'};
  },
  stop(){listener.dispose();},
 };
}
