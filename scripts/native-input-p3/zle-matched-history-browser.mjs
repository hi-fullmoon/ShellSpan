// Read-only comparison of real matched ordinary/native captures, not live input.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {chromium,webkit} from 'playwright';
import {displayModuleJavaScript,installedRuntimeManifest} from '../native-input-p0/formal-runtime.mjs';
const root=resolve(import.meta.dirname,'../..'),native=resolve(process.argv[2]),ordinary=resolve(process.argv[3]),bindingPath=resolve(process.argv[4]);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),files={};
async function input(path){const bytes=await readFile(path);files[path]=hash(bytes);return bytes;}
const binding=JSON.parse(await input(bindingPath));assert(binding.unicodeVersion==='11'&&binding.ownedReflowCursorLine===false);
const cases=[];
for(const [kind,directory]of[['native',native],['ordinary',ordinary]]){
 const result=JSON.parse(await input(resolve(directory,'result.json'))),geometry=JSON.parse(await input(resolve(directory,'geometry.json'))),raw=await input(resolve(directory,'raw.bin'));
 assert(result.ok);assert.equal(result.coreSha256,'204b5d23a4ac312283650b1d20a57f380557206a0928a6d9b37347d477ac0e84');assert.equal(hash(Buffer.from(geometry.source)),geometry.sourceSha256);
 cases.push({kind,directory,result,geometry,raw:[...raw]});
}
assert.equal(cases[0].geometry.sourceSha256,cases[1].geometry.sourceSha256);assert.equal(cases[1].result.actualBudget,0);assert.equal(cases[1].result.explicitCtrlL,false);
const runtime=await installedRuntimeManifest(),display=await displayModuleJavaScript();files.displayJavaScript=hash(Buffer.from(display));
const directory=resolve(root,'artifacts/tests/native-input-p3/matched-history-browser',randomUUID());await mkdir(directory,{recursive:true});
const assets={'/xterm.js':'node_modules/@xterm/xterm/lib/xterm.js','/xterm.css':'node_modules/@xterm/xterm/css/xterm.css','/search.js':'node_modules/@xterm/addon-search/lib/addon-search.js','/unicode.js':'node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js','/webgl.js':'node_modules/@xterm/addon-webgl/lib/addon-webgl.js'};
const server=createServer(async(request,response)=>{try{if(request.url==='/display.js'){response.setHeader('Content-Type','application/javascript');response.end(display);return;}const asset=assets[request.url];response.setHeader('Content-Type',asset?(request.url.endsWith('.css')?'text/css':'application/javascript'):'text/html');response.end(asset?await readFile(resolve(root,asset)):'<!doctype html><link rel="stylesheet" href="/xterm.css"><div id="surface"></div><script src="/xterm.js"></script><script src="/search.js"></script><script src="/unicode.js"></script><script src="/webgl.js"></script>');}catch(error){response.writeHead(500).end(String(error));}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const results=[];
try{for(const[engine,launcher]of[['chromium',chromium],['webkit',webkit]]){
 const browser=await launcher.launch({headless:true});try{for(const renderer of['dom','webgl'])for(const capture of cases){
  const page=await browser.newPage({viewport:{width:2200,height:900}});try{
   await page.goto(`http://127.0.0.1:${server.address().port}`);
   const observed=await page.evaluate(async({capture,binding,renderer})=>{
    const terminal=new Terminal({cols:capture.geometry.columns,rows:capture.geometry.rows,scrollback:20000,reflowCursorLine:false,allowProposedApi:true});terminal.open(document.querySelector('#surface'));
    if(renderer==='webgl')terminal.loadAddon(new WebglAddon.WebglAddon());
    const search=new SearchAddon.SearchAddon();terminal.loadAddon(search);let display;
    if(capture.kind==='native'){terminal.loadAddon(new Unicode11Addon.Unicode11Addon());const module=await import('/display.js');display=module.attachNativeInputDisplay(terminal,binding,{unicodeVersion:binding.unicodeVersion});}
    const original={selection:terminal.getSelection,line:terminal.buffer.normal.getLine,open:terminal.open},responses=[];terminal.onData(value=>responses.push(value));
    const decoder=new TextDecoder('utf-8',{fatal:true}),bytes=Uint8Array.from(capture.raw);let offset=0,eventIndex=0,found=false;
    const write=part=>new Promise(resolve=>terminal.write(decoder.decode(part,{stream:true}),resolve));
    while(offset<bytes.length){
     while(capture.geometry.resizeEvents[eventIndex]?.offset===offset){terminal.resize(capture.geometry.resizeEvents[eventIndex].columns,capture.geometry.rows);eventIndex++;}
     const end=Math.min(offset+128,capture.geometry.resizeEvents[eventIndex]?.offset??bytes.length,bytes.length);if(end===offset)throw Error('Invalid actual resize ordering');await write(bytes.slice(offset,end));offset=end;
     if(search.findNext(capture.geometry.source)&&terminal.getSelection()===capture.geometry.source){found=true;break;}terminal.clearSelection();
    }
    const position=terminal.getSelectionPosition();terminal.clearSelection();terminal.selectAll();const copied=terminal.getSelection();terminal.clearSelection();
    const b=terminal.buffer.normal,rows=Array.from({length:b.length},(_,y)=>({y,text:b.getLine(y)?.translateToString(true)??'',wrapped:b.getLine(y)?.isWrapped??false}));
    const markers={startup:copied.includes('P3-STARTUP:env:profile:rc:login'),parent:copied.includes('P3-PARENT:父Shell'),background:[...new Set(copied.match(/P3-BACKGROUND-\d+:/g)??[])],prefill:[...new Set(copied.match(/P3_HISTORY_\d{2}/g)??[])]};
    const result={found,offset,offsetResolutionBytes:128,position,cursor:{x:b.cursorX,y:b.baseY+b.cursorY},markers,copied,rows,provider:terminal.unicode.activeVersion,publicApisUnmodified:terminal.getSelection===original.selection&&terminal.buffer.normal.getLine===original.line&&terminal.open===original.open,responses};
    if(display)await display.closeAfterPendingOutput();return result;
   },{capture,binding,renderer});
   await page.screenshot({path:resolve(directory,`${engine}-${renderer}-${capture.kind}.png`)});assert(observed.publicApisUnmodified&&observed.responses.length===0);results.push({engine,renderer,kind:capture.kind,input:capture.directory,...observed});
  }finally{await page.close();}
 }}finally{await browser.close();}
}}finally{await new Promise(resolve=>server.close(resolve));assert.deepEqual(await installedRuntimeManifest(),runtime);for(const[path,digest]of Object.entries(files))if(path!=='displayJavaScript')assert.equal(hash(await readFile(path)),digest);await writeFile(resolve(directory,'result.json'),JSON.stringify({scope:'read-only matched ordinary/native real captures at first observed full source, up to128 bytes resolution; not live/frame/flicker or production acceptance',bindingPath,files,runtime,results},null,2));}
process.stdout.write(JSON.stringify({directory,cases:results.length,observations:results.map(value=>({engine:value.engine,renderer:value.renderer,kind:value.kind,fullSource:value.found,markers:value.markers}))})+'\n');
