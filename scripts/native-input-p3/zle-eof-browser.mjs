// Replays real EOF PTY evidence and checks public display state before disposal.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {chromium,webkit} from 'playwright';
import {displayModuleJavaScript,installedRuntimeManifest} from '../native-input-p0/formal-runtime.mjs';
import {captureValidationSources} from '../native-input-p2/frozen-validation.mjs';
const root=resolve(import.meta.dirname,'../..'),input=resolve(process.argv[2]);
const sources=captureValidationSources(root),runtime=await installedRuntimeManifest();
const directory=resolve(root,'.native-input-p3/eof-browser',randomUUID());await mkdir(directory,{recursive:true});
const assets={'/xterm.js':['node_modules/@xterm/xterm/lib/xterm.js','application/javascript'],'/xterm.css':['node_modules/@xterm/xterm/css/xterm.css','text/css'],'/webgl.js':['node_modules/@xterm/addon-webgl/lib/addon-webgl.js','application/javascript']};
const server=createServer(async(request,response)=>{try{if(request.url==='/display.js'){response.setHeader('Content-Type','application/javascript');response.end(await displayModuleJavaScript());return;}const asset=assets[request.url];response.setHeader('Content-Type',asset?asset[1]:'text/html');response.end(asset?await readFile(resolve(root,asset[0])):'<!doctype html><link rel="stylesheet" href="/xterm.css"><div id="surface"></div><script src="/xterm.js"></script><script src="/webgl.js"></script>');}catch{response.writeHead(500).end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const results=[];
try{
 for(const [engine,type]of[['chromium',chromium],['webkit',webkit]]){
  const browser=await type.launch({headless:true});
  try{for(const renderer of['dom','webgl'])for(const name of await readdir(input)){
   const evidence=resolve(input,name),native=JSON.parse(await readFile(resolve(evidence,'result.json'),'utf8'));assert(native.ok);
   const bytes=await readFile(resolve(evidence,'raw.bin'));const page=await browser.newPage({viewport:{width:1100,height:650}});
   try{
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const observed=await page.evaluate(async({bytes,renderer})=>{
     const {attachNativeInputDisplay,NATIVE_INPUT_DISPLAY}=await import('/display.js');
     const terminal=new Terminal({cols:100,rows:30,scrollback:10000,reflowCursorLine:false});terminal.open(document.querySelector('#surface'));
     if(renderer==='webgl')terminal.loadAddon(new WebglAddon.WebglAddon());
     const original={selection:terminal.getSelection,line:terminal.buffer.normal.getLine,open:terminal.open};const responses=[];terminal.onData(value=>responses.push(value));
     const display=attachNativeInputDisplay(terminal,NATIVE_INPUT_DISPLAY);const decoder=new TextDecoder('utf-8',{fatal:true});
     await new Promise(resolve=>terminal.write(decoder.decode(Uint8Array.from(bytes)),resolve));
     const beforeDispose=terminal.options.reflowCursorLine;
     const publicApisUnmodified=terminal.getSelection===original.selection&&terminal.buffer.normal.getLine===original.line&&terminal.open===original.open;
     await display.closeAfterPendingOutput();return{beforeDispose,afterDispose:terminal.options.reflowCursorLine,publicApisUnmodified,responses};
    },{bytes:[...bytes],renderer});
    if(['typing','accepted-before-parent'].includes(native.phase))await page.screenshot({path:resolve(directory,`${engine}-${renderer}-${native.phase}.png`)});
    results.push({engine,renderer,phase:native.phase,evidence,ptySha256:createHash('sha256').update(bytes).digest('hex'),...observed});
   }finally{await page.close();}
  }}finally{await browser.close();}
 }
}finally{await new Promise(resolve=>server.close(resolve));assert.deepEqual(captureValidationSources(root),sources);assert.deepEqual(await installedRuntimeManifest(),runtime);await writeFile(resolve(directory,'result.json'),JSON.stringify({scope:'real-PTY EOF display-off before disposal; not full source-copy, live App or Broker recovery acceptance',runtime,sourceCount:Object.keys(sources).length,results},null,2));}
console.log(JSON.stringify({directory,cases:results.length}));
assert.equal(results.length,56);assert(results.every(value=>value.beforeDispose===false&&value.afterDispose===false&&value.publicApisUnmodified&&value.responses.length===0),'Actual EOF bytes did not restore the display before disposal; observations retained');
