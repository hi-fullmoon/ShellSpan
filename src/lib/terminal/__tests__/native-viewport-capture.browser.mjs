// Reproduce a real parked-viewport failure from its complete observed prefix.
// No Shell execution, manufactured output, private parser or coordinate repair.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {chromium,webkit} from 'playwright';
import {displayModuleJavaScript,installedRuntimeManifest} from '../../../../scripts/native-input/prototype/formal-runtime.mjs';

const root=resolve(import.meta.dirname,'../../../..'),capture=resolve(process.argv[2]??''),mode=process.argv[3]??'resize';
assert(process.argv.length>=3&&process.argv.length<=4&&['resize','fit'].includes(mode)&&capture.includes('/artifacts/tests/native-input/integration/phase2/'),'Supply one actual owned App capture and optional fit mode');
const read=p=>JSON.parse(readFileSync(p,'utf8')),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const evidence=read(resolve(capture,'native-webview-evidence.json'));
const traceBytes=readFileSync(resolve(capture,'native-display-trace.json')),visibleBytes=readFileSync(resolve(capture,'native-display-visible-output.utf8'));
assert.equal(sha(traceBytes),evidence.uploads.trace.sha256);assert.equal(sha(visibleBytes),evidence.uploads['visible-output'].sha256);
const trace=JSON.parse(traceBytes),visible=new TextDecoder('utf8',{fatal:true}).decode(visibleBytes);
assert(trace.version===2&&trace.replayable);assert.equal(trace.outputCharacters,visible.length);
const parked=evidence.records.find(r=>r.label==='parked-initial')?.originalParked;
assert(parked&&parked.anchorOffset===0&&parked.selection);
const last=trace.events.filter(e=>e.type==='checkpoint').at(-1);
assert.equal(last.label,'failure');assert.equal(evidence.records.at(-1).reason,'Error: Horizontal reflow lost original selection/relative viewport anchor');
const original=JSON.parse(last.stateJson);assert.equal(original.columns,127);
const runtime=await installedRuntimeManifest(),display=await displayModuleJavaScript();
const assets={'/xterm.js':'node_modules/@xterm/xterm/lib/xterm.js','/xterm.css':'node_modules/@xterm/xterm/css/xterm.css','/fit.js':'node_modules/@xterm/addon-fit/lib/addon-fit.js','/unicode.js':'node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js','/webgl.js':'node_modules/@xterm/addon-webgl/lib/addon-webgl.js','/search.js':'node_modules/@xterm/addon-search/lib/addon-search.js'};
const output=resolve(root,'artifacts/tests/native-viewport-capture',randomUUID());mkdirSync(output,{recursive:true,mode:0o700});
const server=createServer((request,response)=>{
 if(request.url==='/display.js'){response.setHeader('Content-Type','application/javascript');response.end(display);return;}
 const file=assets[request.url];response.setHeader('Content-Type',file?(file.endsWith('.css')?'text/css':'application/javascript'):'text/html');
 response.end(file?readFileSync(resolve(root,file)):'<!doctype html><link rel="stylesheet" href="/xterm.css"><style>*{box-sizing:border-box}body{margin:0}#surface{width:1100px;height:650px;margin-top:32px}.terminal.xterm{height:100%;padding:4px 0 4px 4px}</style><div id="surface"></div><script src="/xterm.js"></script><script src="/fit.js"></script><script src="/unicode.js"></script><script src="/webgl.js"></script><script src="/search.js"></script>');
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const results=[];
try{for(const[engine,launcher]of [['chromium',chromium],['webkit',webkit]]){
 const browser=await launcher.launch({headless:true});
 try{for(const renderer of ['default','webgl']){
  const page=await browser.newPage({viewport:{width:1480,height:920},deviceScaleFactor:mode==='fit'?2:1}),result={engine,renderer,mode,status:'running',checkpoints:[],resizes:[]};results.push(result);
  try{
   await page.goto('http://127.0.0.1:'+server.address().port);
   await page.evaluate(async({initial,renderer})=>{
    const t=new Terminal({...initial.options,cols:initial.columns,rows:initial.rows,allowProposedApi:true});t.open(document.querySelector('#surface'));
    if(renderer==='webgl')t.loadAddon(new WebglAddon.WebglAddon());
    if(initial.nativeDisplayBinding?.unicodeVersion==='11')t.loadAddon(new Unicode11Addon.Unicode11Addon());
    const {attachNativeInputDisplay}=await import('/display.js'),binding=initial.nativeDisplayBinding;
    if(binding)attachNativeInputDisplay(t,binding,{unicodeVersion:binding.unicodeVersion,unicodeScope:binding.unicodeScope});
    const search=new SearchAddon.SearchAddon(),fit=new FitAddon.FitAddon();t.loadAddon(search);t.loadAddon(fit);
    const state=()=>{const b=t.buffer.normal;return{cols:t.cols,rows:t.rows,viewportY:b.viewportY,baseY:b.baseY,selection:t.getSelection(),position:t.getSelectionPosition()??null};};
    const drain=async()=>{await new Promise(done=>t.write('',done));await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));await new Promise(done=>t.write('',done));};
    const original={write:t.write,resize:t.resize,select:t.select,selection:t.getSelection,line:t.buffer.normal.getLine};
    window.viewportCase={t,search,fit,state,drain,original};await drain();
   },{initial:trace.initial,renderer});
   for(const[index,event]of trace.events.entries()){
    if(event.type==='output')await page.evaluate(async data=>{await new Promise(done=>window.viewportCase.t.write(data,done));},visible.slice(event.offset,event.offset+event.characters));
    else if(event.type==='resize'){
     assert.equal(event.outputSequence,event.parsedThrough);
     const states=await page.evaluate(async({event,mode})=>{
      const r=window.viewportCase;await r.drain();const before=r.state();
      if(mode==='fit'){
       const widths={127:1100,50:440,40:360},heights={37:650,18:320,33:580},host=document.querySelector('#surface');
       if(!widths[event.columns]||!heights[event.rows])throw Error('Unknown original fixture host size');
       host.style.width=widths[event.columns]+'px';host.style.height=heights[event.rows]+'px';r.fit.fit();r.t.refresh(0,r.t.rows-1);
       if(r.t.cols!==event.columns||r.t.rows!==event.rows)throw Error('Actual FitAddon geometry differs from original grid: '+JSON.stringify(r.state()));
      }else r.t.resize(event.columns,event.rows);
      const synchronous=r.state();await r.drain();return{before,synchronous,drained:r.state(),devicePixelRatio};
     },{event,mode});result.resizes.push({index,...states});
    }else if(event.type==='action'){
     await page.evaluate(async a=>{const r=window.viewportCase,t=r.t;await r.drain();switch(a.kind){case'select':t.select(a.column,a.row,a.length);break;case'scrollToLine':t.scrollToLine(a.row);break;case'clearSelection':t.clearSelection();break;case'scrollToBottom':t.scrollToBottom();break;case'searchNext':if(!r.search.findNext(a.term))throw Error('Original search failed');break;default:throw Error('Unexpected original action');}await r.drain();},event.action);
    }else if(event.type==='checkpoint'){
     const state=await page.evaluate(async()=>{const r=window.viewportCase;await r.drain();return r.state();});result.checkpoints.push({index,label:event.label,state});
     if(event.label.startsWith('parked-')||event===last){
      assert.equal(state.selection,parked.selection,'Original selection bytes changed');assert(state.position,'Public selection coordinates missing');
      assert(state.position.start.y>=0&&state.position.start.x>=0&&state.position.start.x<state.cols,'Invalid original anchor');
      assert.equal(state.position.start.y-state.viewportY,parked.anchorOffset,'Original anchor drifted relative to viewport');
      assert(state.viewportY<state.baseY,'Parked viewport followed the bottom');
     }
    }else throw Error('Unknown original trace event');
   }
   result.publicApisUnmodified=await page.evaluate(()=>{const{t,original:o}=window.viewportCase;return t.write===o.write&&t.resize===o.resize&&t.select===o.select&&t.getSelection===o.selection&&t.buffer.normal.getLine===o.line;});assert(result.publicApisUnmodified);result.status='passed';
  }catch(error){result.status='failed';result.error=String(error);}
  finally{await page.close();}
 }}finally{await browser.close();}
}}finally{await new Promise(done=>server.close(done));}
assert.equal(results.length,4);assert.deepEqual(await installedRuntimeManifest(),runtime);assert.equal(sha(readFileSync(resolve(capture,'native-display-trace.json'))),sha(traceBytes));assert.equal(sha(readFileSync(resolve(capture,'native-display-visible-output.utf8'))),sha(visibleBytes));
writeFileSync(resolve(output,'result.json'),JSON.stringify({at:new Date().toISOString(),capture,mode,traceSha256:sha(traceBytes),visibleSha256:sha(visibleBytes),runtime,results,scope:'Exact observed real-App prefix through its known failure; fit mode applies the frozen fixture host sizes and actual FitAddon, never supplied result coordinates. No transport EOF, new Shell execution or native App pass claimed'},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,results:results.map(({engine,renderer,status,error})=>({engine,renderer,status,error}))}));process.exitCode=results.every(r=>r.status==='passed')?0:1;
