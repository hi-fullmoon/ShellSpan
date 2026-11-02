// Actual PTY fixture + real xterm; selection restoration uses coordinates only.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {chromium,webkit} from 'playwright';
import {displayModuleJavaScript,installedRuntimeManifest} from '../../../../scripts/native-input-p0/formal-runtime.mjs';
const fixture=JSON.parse(await readFile(new URL('./fixtures/native-selection-reflow.json',import.meta.url),'utf8'));
const viewportFixture=JSON.parse(await readFile(new URL('./fixtures/native-viewport-reflow.json',import.meta.url),'utf8'));
const viewportBytes=Buffer.from(viewportFixture.packet.base64,'base64');
const bytes=Buffer.from(fixture.packet.base64,'base64'),sha=data=>createHash('sha256').update(data).digest('hex');
assert.equal(bytes.length,fixture.packet.length);assert.equal(sha(bytes),fixture.packet.sha256);
assert.equal(viewportBytes.length,viewportFixture.packet.length);assert.equal(sha(viewportBytes),viewportFixture.packet.sha256);
const installed=await installedRuntimeManifest(),experimentPath=process.env.SHELLSPAN_P0_EXPERIMENT_MANIFEST;
const experiment=experimentPath?JSON.parse(await readFile(experimentPath,'utf8')):undefined;
const runtime=experiment?resolve(experiment.source,'lib/xterm.js'):'node_modules/@xterm/xterm/lib/xterm.js';
if(experiment){assert.equal(experiment.nativeAcceptance,false);assert.equal(experiment.formalPatchChanged,false);assert.equal(sha(await readFile(runtime)),experiment.artifacts['lib/xterm.js']);}
const directory=resolve('.artifacts/tests/native-input-p0/formal-validation/native-selection',randomUUID());await mkdir(directory,{recursive:true});
const assets={'/xterm.js':runtime,'/xterm.css':'node_modules/@xterm/xterm/css/xterm.css','/search.js':'node_modules/@xterm/addon-search/lib/addon-search.js','/unicode.js':'node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js','/webgl.js':'node_modules/@xterm/addon-webgl/lib/addon-webgl.js'};
const server=createServer(async(request,response)=>{try{if(request.url==='/display.js'){response.setHeader('Content-Type','application/javascript');response.end(await displayModuleJavaScript());return;}const path=assets[request.url];response.setHeader('Content-Type',path?(request.url.endsWith('.css')?'text/css':'application/javascript'):'text/html');response.end(path?await readFile(path):'<!doctype html><link rel="stylesheet" href="/xterm.css"><div id="surface"></div><script src="/xterm.js"></script><script src="/search.js"></script><script src="/unicode.js"></script><script src="/webgl.js"></script>');}catch(error){response.writeHead(500).end(String(error));}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const results=[];
try{for(const[engine,launcher]of[['chromium',chromium],['webkit',webkit]]){
 const browser=await launcher.launch({headless:true});try{for(const renderer of['dom','webgl']){
  const page=await browser.newPage({viewport:{width:1600,height:900}});try{
   await page.goto(`http://127.0.0.1:${server.address().port}`);const cases=[];
   for(const reflow of[false,true])for(const kind of['word','wrapped-source','unicode','drag','reverse-drag','invalid-row','vertical-resize']){
    const prepared=await page.evaluate(async({bytes,fixture,reflow,renderer,kind})=>{
     window.selectionTerminal?.dispose();document.querySelector('#surface').replaceChildren();
     const terminal=window.selectionTerminal=new Terminal({cols:fixture.columns,rows:fixture.rows,scrollback:20000,reflowCursorLine:false,allowProposedApi:true});terminal.open(document.querySelector('#surface'));
     if(renderer==='webgl')terminal.loadAddon(new WebglAddon.WebglAddon());terminal.loadAddon(new Unicode11Addon.Unicode11Addon());const search=new SearchAddon.SearchAddon();terminal.loadAddon(search);
     const module=await import('/display.js'),display=module.attachNativeInputDisplay(terminal,fixture.binding,{unicodeVersion:fixture.binding.unicodeVersion});
     await new Promise(resolve=>terminal.write(Uint8Array.from(bytes),resolve));await display.closeAfterPendingOutput();terminal.options.reflowCursorLine=reflow;
     const needle=kind==='wrapped-source'?fixture.source:kind==='unicode'?'父Shell-é-👩🏽‍💻':'P3_HISTORY_45';
     if(!search.findNext(needle)||terminal.getSelection()!==needle)throw Error(`Actual PTY text missing for ${kind}`);
     const position=terminal.getSelectionPosition();terminal.clearSelection();
     const snapshot={needle,position,selection:terminal.getSelection,select:terminal.select,line:terminal.buffer.normal.getLine};window.selectionCase=snapshot;
     if(kind==='drag'||kind==='reverse-drag'){
      terminal.scrollToLine(Math.max(0,position.start.y-3));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const rect=terminal.element.querySelector('.xterm-screen').getBoundingClientRect(),cellWidth=rect.width/terminal.cols,cellHeight=rect.height/terminal.rows;
      const start={x:rect.left+(position.start.x+0.1)*cellWidth,y:rect.top+(position.start.y-terminal.buffer.normal.viewportY+0.5)*cellHeight};
      const end={x:rect.left+(position.end.x+0.1)*cellWidth,y:start.y};return{needle,start,end};
     }
     if(kind==='invalid-row')terminal.select(0,terminal.buffer.normal.length+2,3);
     else terminal.select(position.start.x,position.start.y,(position.end.y-position.start.y)*terminal.cols+position.end.x-position.start.x);
     return{needle};
    },{bytes:[...bytes],fixture,reflow,renderer,kind});
    if(kind==='drag'||kind==='reverse-drag'){
     const start=kind==='drag'?prepared.start:prepared.end,end=kind==='drag'?prepared.end:prepared.start;
     await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:4});await page.mouse.up();
    }
    const observed=await page.evaluate(({fixture,kind})=>{
     const terminal=window.selectionTerminal,original=window.selectionCase,states=[];
     if(kind!=='invalid-row'&&terminal.getSelection()!==original.needle)throw Error(`Actual selection setup failed for ${kind}: ${JSON.stringify(terminal.getSelection())}`);
     const columns=kind==='vertical-resize'?[fixture.columns]:fixture.resizeColumns;
     for(const cols of columns){terminal.resize(cols,kind==='vertical-resize'?fixture.rows-1:fixture.rows);states.push({cols,text:terminal.getSelection(),position:terminal.getSelectionPosition()});}
     return{states,unchangedApis:terminal.getSelection===original.selection&&terminal.select===original.select&&terminal.buffer.normal.getLine===original.line};
    },{fixture,kind});
    assert(observed.unchangedApis);const expected=['invalid-row','vertical-resize'].includes(kind)?'':prepared.needle;
    assert(observed.states.every(state=>state.text===expected),`${engine}/${renderer}/${reflow}/${kind}: selection did not follow actual content`);
    cases.push({reflow,kind,resizes:observed.states.length,expected,states:observed.states});
   }
   const viewports=[];
   for(const parked of[true,false]){
   const viewport=await page.evaluate(async({fixture,bytes,renderer,parked})=>{
    window.selectionTerminal?.dispose();document.querySelector('#surface').replaceChildren();
    const terminal=window.selectionTerminal=new Terminal({cols:fixture.columns,rows:fixture.rows,scrollback:20000,reflowCursorLine:false,allowProposedApi:true});terminal.open(document.querySelector('#surface'));
    if(renderer==='webgl')terminal.loadAddon(new WebglAddon.WebglAddon());terminal.loadAddon(new Unicode11Addon.Unicode11Addon());
    const {attachNativeInputDisplay}=await import('/display.js');
    const display=attachNativeInputDisplay(terminal,fixture.binding,{unicodeVersion:fixture.binding.unicodeVersion});
    const write=async(start,end)=>new Promise(resolve=>terminal.write(Uint8Array.from(bytes.slice(start,end)),resolve));
    await write(0,fixture.park.offset);if(parked)terminal.scrollToLine(fixture.park.viewportY);
    const top=terminal.buffer.normal.getLine(terminal.buffer.normal.viewportY).translateToString(true);
    let offset=fixture.park.offset;const states=[];
    for(const event of fixture.events){
     await write(offset,event.offset);offset=event.offset;terminal.resize(event.columns,fixture.rows);
     const b=terminal.buffer.normal;states.push({cols:event.columns,viewportY:b.viewportY,baseY:b.baseY,top:b.getLine(b.viewportY).translateToString(true)});
    }
    await display.closeAfterPendingOutput();return{top,states};
   },{fixture:viewportFixture,bytes:[...viewportBytes],renderer,parked});
   assert(viewport.states.every(state=>parked?state.viewportY<state.baseY&&state.top===viewport.top:state.viewportY===state.baseY),`${engine}/${renderer}/${parked?'parked':'following'}: viewport changed during real PTY reflow: ${JSON.stringify(viewport)}`);
   viewports.push({parked,...viewport});
   }
   results.push({engine,renderer,cases,viewports});
  }finally{await page.close();}
 }}finally{await browser.close();}
}}finally{await new Promise(resolve=>server.close(resolve));assert.deepEqual(await installedRuntimeManifest(),installed);await writeFile(resolve(directory,'result.json'),JSON.stringify({scope:'real stored PTY bytes; public API, actual mouse selection and parked/following viewport across library reflow; no native/App execution or mock',fixtureSha256:fixture.packet.sha256,viewportFixtureSha256:viewportFixture.packet.sha256,runtime:experiment?{kind:'isolated experiment',path:runtime,sha256:experiment.artifacts['lib/xterm.js']}:installed,results},null,2));}
process.stdout.write(JSON.stringify({directory,renderers:results.length,selectionCases:results.reduce((sum,row)=>sum+row.cases.length,0),viewportCases:results.reduce((sum,row)=>sum+row.viewports.length,0)})+'\n');
