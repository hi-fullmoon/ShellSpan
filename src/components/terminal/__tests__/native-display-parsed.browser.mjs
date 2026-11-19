// Real pinned browsers/xterm and actual cat stdout; no Shell source replay,
// controller mock, method replacement, native execution or human receipt.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {chromium,webkit} from 'playwright';
import ts from 'typescript';
import {createServer as createViteServer} from 'vite';
import {attachDisplayTraceChannel} from '../../../../scripts/native-input/acceptance/display-trace-channel.mjs';
const directory=resolve('artifacts/tests/native-input-p3/display-parsed-checks',randomUUID());mkdirSync(directory,{recursive:true,mode:0o700});mkdirSync(resolve(directory,'home'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),source=readFileSync(new URL('./native-display-trace.ts',import.meta.url),'utf8');
const module=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const stdout=execFileSync('/bin/cat',['AGENTS.md'],{env:{...process.env,HOME:resolve(directory,'home')}});assert(stdout.equals(readFileSync('AGENTS.md')));writeFileSync(resolve(directory,'actual-cat-stdout.bin'),stdout,{flag:'wx'});
const assets={'/xterm.js':readFileSync('node_modules/@xterm/xterm/lib/xterm.js'),'/xterm.css':readFileSync('node_modules/@xterm/xterm/css/xterm.css'),'/trace.js':Buffer.from(module)};
const kinds=['original','wrong-selection','missing-parsed','reordered-callback','missing-resize-state','changed-resize-state'],entries=[];
for(const engine of ['chromium','webkit'])for(const kind of kinds){const folder=resolve(directory,engine+'-'+kind);mkdirSync(folder);entries.push({engine,kind,folder,token:randomUUID()});}
const vite=await createViteServer({root:directory,configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true},plugins:[{name:'actual-parsed-trace-retention',configureServer(server){for(const entry of entries)attachDisplayTraceChannel(server,entry.token,entry.folder,{nativeDaily:entry.kind==='wrong-selection'?'full-bash':'eof-private-bash'});}}]});
const server=createServer((request,response)=>{
 if(request.url.startsWith('/__native-display-trace/')){vite.middlewares(request,response);return;}
 const asset=assets[request.url];response.setHeader('Content-Type',request.url.endsWith('.js')?'application/javascript':request.url.endsWith('.css')?'text/css':'text/html');
 response.end(asset??'<!doctype html><link rel="stylesheet" href="/xterm.css"><script src="/xterm.js"></script><div id="surfaces"></div>');
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const results=[];
try{
 for(const [engine,launcher]of [['chromium',chromium],['webkit',webkit]]){
  const browser=await launcher.launch({headless:true});
  try{
   const page=await browser.newPage({viewport:{width:1280,height:900}});await page.goto(`http://127.0.0.1:${server.address().port}`);
   const result=await page.evaluate(async output=>{
    const {NativeDisplayTrace,nativeDisplayTraceState}=await import('/trace.js');
    const open=()=>{const host=document.createElement('div');host.style.cssText='width:900px;height:240px';document.querySelector('#surfaces').append(host);const terminal=new Terminal({cols:80,rows:12,scrollback:10000,allowProposedApi:true});terminal.open(host);return terminal;};
    const drain=async terminal=>{await new Promise(done=>terminal.write('',done));await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));await new Promise(done=>terminal.write('',done));};
    const observed=open(),initial={columns:80,rows:12,empty:true,unicodeVersion:observed.unicode.activeVersion,options:{scrollback:10000}},trace=new NativeDisplayTrace(initial,true),legacy=new NativeDisplayTrace(initial);
    const original={write:observed.write,resize:observed.resize,selection:observed.getSelection,line:observed.buffer.normal.getLine};
    const resize=observed.onResize(({cols,rows})=>{trace.resize(cols,rows,nativeDisplayTraceState(observed));legacy.resize(cols,rows);});
    const sequence=trace.output(output,'local'),oldSequence=legacy.output(output,'local');let callbackObserved=false;
    const parsed=new Promise(done=>observed.write(output,()=>{callbackObserved=true;trace.parsed(sequence,{data:output,source:'local'});legacy.parsed(oldSequence);done();}));
    observed.resize(51,14);const resizeBeforeCallback=callbackObserved===false;
    await parsed;await drain(observed);await trace.checkpoint('queued-output-resize',nativeDisplayTraceState(observed));const captured=trace.snapshot(output),old=legacy.snapshot(output);
    const replay=open(),pending=[],resizeComparisons=[],checkpoints=[];let accepted=-1,parsedThrough=-1;
    for(const event of captured.events){
     if(event.type==='output'){if(event.sequence!==++accepted)throw Error('Actual accepted output order differs');pending.push({...event,data:output.slice(event.offset,event.offset+event.characters)});}
     else if(event.type==='parsed'){
      const next=pending.shift();if(!next||event.sequence!==parsedThrough+1||event.sequence!==next.sequence||event.outputSequence!==accepted)throw Error('Actual parse callback order differs');
      await new Promise(done=>replay.write(next.data,done));parsedThrough=event.sequence;
     }else if(event.type==='resize'){
      if(event.outputSequence!==accepted||event.parsedThrough!==parsedThrough)throw Error('Actual resize boundary differs');
      replay.resize(event.columns,event.rows);const actual=nativeDisplayTraceState(replay);resizeComparisons.push({expected:event.stateJson,actual,equal:actual===event.stateJson});if(actual!==event.stateJson)throw Error('Original complete resize state differs');
     }else if(event.type==='checkpoint'){
      if(parsedThrough!==accepted||pending.length)throw Error('Original checkpoint did not drain all parsed output');await drain(replay);const actual=nativeDisplayTraceState(replay);checkpoints.push({expected:event.stateJson,actual,equal:actual===event.stateJson});if(actual!==event.stateJson)throw Error('Original complete checkpoint differs');
     }else throw Error('Unexpected observed regression event');
    }
    const withoutResize=open();await new Promise(done=>withoutResize.write(output,done));await drain(withoutResize);
    const value={trace:captured,legacy:old,resizeBeforeCallback,resizeComparisons,checkpoints,pendingOutputs:pending.length,final:nativeDisplayTraceState(observed),missingResize:nativeDisplayTraceState(withoutResize),
     publicApisUnmodified:observed.write===original.write&&observed.resize===original.resize&&observed.getSelection===original.selection&&observed.buffer.normal.getLine===original.line};
    resize.dispose();observed.dispose();replay.dispose();withoutResize.dispose();return value;
   },new TextDecoder('utf-8',{fatal:true}).decode(stdout));
   assert(result.resizeBeforeCallback&&result.publicApisUnmodified);assert.equal(result.trace.version,6);assert.equal(result.trace.replayable,true);assert.deepEqual(result.trace.issues,[]);assert.equal(result.pendingOutputs,0);
   assert.deepEqual(result.trace.events.map(e=>e.type),['output','resize','parsed','checkpoint']);assert(result.resizeComparisons.length===1&&result.resizeComparisons.every(v=>v.equal));assert(result.checkpoints.length===1&&result.checkpoints.every(v=>v.equal));assert.notEqual(result.final,result.missingResize);
   assert.equal(result.legacy.version,2);assert.equal(result.legacy.replayable,false);assert.deepEqual(result.legacy.issues,['Resize occurred before previously observed output was parsed']);
   const http=[];
   for(const entry of entries.filter(e=>e.engine===engine)){
    const trace=structuredClone(result.trace);if(entry.kind==='missing-parsed')trace.events=trace.events.filter(e=>e.type!=='parsed');
    if(entry.kind==='reordered-callback')trace.events.find(e=>e.type==='parsed').sequence++;
    if(entry.kind==='missing-resize-state')delete trace.events.find(e=>e.type==='resize').stateJson;
    if(entry.kind==='changed-resize-state'){const resize=trace.events.find(e=>e.type==='resize'),state=JSON.parse(resize.stateJson);state.columns++;resize.stateJson=JSON.stringify(state);resize.stateCharacters=resize.stateJson.length;}
    const body=Buffer.from(JSON.stringify(trace)),url=`http://127.0.0.1:${server.address().port}/__native-display-trace/${entry.token}`,response=await fetch(url,{method:'POST',body});
    assert.equal(response.status,entry.kind==='original'?200:500,entry.kind);const expectedFile=resolve(entry.folder,'native-display-trace.json');
    if(entry.kind==='original'){const saved=await response.json();assert.equal(saved.sha256,sha(body));assert(readFileSync(saved.file).equals(body));assert.equal((await fetch(url,{method:'POST',body})).status,500);assert(readFileSync(saved.file).equals(body));}
    else{const {existsSync}=await import('node:fs');assert.equal(existsSync(expectedFile),false);}
    http.push({kind:entry.kind,status:response.status});
   }
   const file=resolve(directory,engine+'.json');writeFileSync(file,JSON.stringify({...result,http},null,2)+'\n',{flag:'wx',mode:0o600});results.push({engine,version:browser.version(),status:'passed',file,sha256:sha(readFileSync(file)),resizeStatesCompared:1,fullCheckpointsCompared:1,rejectedMutations:5});
  }finally{await browser.close();}
 }
}finally{await new Promise(done=>server.close(done));await vite.close();}
writeFileSync(resolve(directory,'result.json'),JSON.stringify({results,actualStdout:{file:resolve(directory,'actual-cat-stdout.bin'),sha256:sha(stdout)},traceSourceSha256:sha(Buffer.from(source)),assets:Object.fromEntries(Object.entries(assets).map(([name,bytes])=>[name,sha(bytes)])),nativeAcceptancePasses:0,physicalInputClaim:false,scope:'Actual public xterm queued write, resize event and callback ordering with exact full public-state replay and byte-preserving HTTP retention. Existing legacy rejection is unchanged. No native/App/profile acceptance is inferred.'},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({directory,results,nativeAcceptancePasses:0}));
