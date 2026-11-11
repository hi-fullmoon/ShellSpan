// Actual pinned xterm/public paste. Read-only cat output, no native/Agent receipt.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {chromium,webkit} from 'playwright';
import ts from 'typescript';
import {createServer as createViteServer} from 'vite';
import {attachDisplayTraceChannel} from '../../../../scripts/native-input-p3/display-trace-channel.mjs';
const directory=resolve('.artifacts/tests/native-input-p3/display-paste-checks',randomUUID());mkdirSync(directory,{recursive:true,mode:0o700});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const source=readFileSync(new URL('./native-display-trace.ts',import.meta.url),'utf8');
const module=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const stdout=execFileSync('/bin/cat',['AGENTS.md']);assert(stdout.equals(readFileSync('AGENTS.md')));
writeFileSync(resolve(directory,'actual-cat-stdout.bin'),stdout,{flag:'wx'});
const assets={'/xterm.js':readFileSync('node_modules/@xterm/xterm/lib/xterm.js'),'/xterm.css':readFileSync('node_modules/@xterm/xterm/css/xterm.css'),'/trace.js':Buffer.from(module)};
const tokens={chromium:randomUUID(),webkit:randomUUID()};for(const engine of Object.keys(tokens))mkdirSync(resolve(directory,engine));
const vite=await createViteServer({root:directory,configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true},plugins:[{name:'actual-browser-trace-upload',configureServer(server){for(const engine of Object.keys(tokens))attachDisplayTraceChannel(server,tokens[engine],resolve(directory,engine),{nativeDaily:'full-zsh'});}}]});
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
    const {NativeDisplayTrace,nativeDisplayTraceState,pasteWithNativeDisplayTrace}=await import('/trace.js');
    const options={cols:80,rows:12,scrollback:10000,allowProposedApi:true};
    const open=()=>{const host=document.createElement('div');host.style.cssText='width:800px;height:240px';document.querySelector('#surfaces').append(host);const t=new Terminal(options);t.open(host);return t;};
    const drain=async t=>{await new Promise(done=>t.write('',done));await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));await new Promise(done=>t.write('',done));};
    const observed=open(),original={paste:observed.paste,write:observed.write},data='printf 中文 e\u0301 👩🏽‍💻\nsecond\t  ';
    const trace=new NativeDisplayTrace({columns:80,rows:12,empty:true,unicodeVersion:observed.unicode.activeVersion,options:{scrollback:10000}}),inputs=[],order=[];
    observed.onData(value=>{inputs.push(value);order.push(trace.snapshot(output).events.filter(event=>event.type==='action').map(event=>event.action.kind));});
    const sequence=trace.output(output);await new Promise(done=>observed.write(output,done));trace.parsed(sequence);await drain(observed);
    trace.action({kind:'scrollToLine',row:0});observed.scrollToLine(0);await drain(observed);
    const before=JSON.parse(nativeDisplayTraceState(observed));if(before.baseY<=0||before.viewportY!==0)throw Error('Actual output did not create a parked historical viewport');
    pasteWithNativeDisplayTrace(observed,trace,data);await drain(observed);
    const after=JSON.parse(nativeDisplayTraceState(observed)),capture=trace.snapshot(output);
    const replay=open(),replayInputs=[];replay.onData(value=>replayInputs.push(value));
    const missing=open();
    for(const event of capture.events){
     if(event.type==='output'){const text=output.slice(event.offset,event.offset+event.characters);await new Promise(done=>replay.write(text,done));await new Promise(done=>missing.write(text,done));}
     else if(event.type==='action'){
      await drain(replay);await drain(missing);
      if(event.action.kind==='scrollToLine'){replay.scrollToLine(event.action.row);missing.scrollToLine(event.action.row);}
      else if(event.action.kind==='paste')replay.paste(event.action.data);
      else throw Error('Unexpected real observation action');
     }
    }
    await drain(replay);await drain(missing);
    const result={before,after,trace:capture,inputs,order,replayInputs,replay:JSON.parse(nativeDisplayTraceState(replay)),missingPaste:JSON.parse(nativeDisplayTraceState(missing)),publicApisUnmodified:observed.paste===original.paste&&observed.write===original.write};
    observed.dispose();replay.dispose();missing.dispose();return result;
   },new TextDecoder('utf-8',{fatal:true}).decode(stdout));
   assert.equal(result.after.viewportY,result.after.baseY);assert.deepEqual({...result.after,viewportY:result.before.viewportY},result.before);
   assert.deepEqual(result.replay,result.after);assert.deepEqual(result.missingPaste,result.before);assert.notDeepEqual(result.missingPaste,result.after);
   const data='printf 中文 e\u0301 👩🏽‍💻\nsecond\t  ';assert.deepEqual(result.inputs,[data.replace(/\n/g,'\r')]);assert.deepEqual(result.replayInputs,result.inputs);
   assert.deepEqual(result.order,[['scrollToLine','paste']]);assert.equal(result.trace.version,5);assert.equal(result.trace.replayable,true);assert.deepEqual(result.trace.issues,[]);
   assert.equal(result.trace.outputCharacters,new TextDecoder().decode(stdout).length);assert.equal(result.publicApisUnmodified,true);
   const traceBytes=Buffer.from(JSON.stringify(result.trace)),response=await fetch(`http://127.0.0.1:${server.address().port}/__native-display-trace/${tokens[engine]}`,{method:'POST',body:traceBytes});assert.equal(response.status,200);
   const retained=await response.json();assert.equal(retained.sha256,sha(traceBytes));assert(readFileSync(retained.file).equals(traceBytes));result.httpRetainedTrace=retained;
   const file=resolve(directory,engine+'.json');writeFileSync(file,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
   results.push({engine,version:browser.version(),status:'passed',file,sha256:sha(readFileSync(file)),newShellSourceExecutions:0,nativeAcceptancePasses:0});
  }finally{await browser.close();}
 }
}finally{await new Promise(done=>server.close(done));await vite.close();}
writeFileSync(resolve(directory,'result.json'),JSON.stringify({results,stdout:{file:resolve(directory,'actual-cat-stdout.bin'),sha256:sha(stdout)},sourceSha256:sha(Buffer.from(source)),assets:Object.fromEntries(Object.entries(assets).map(([url,bytes])=>[url,sha(bytes)])),physicalInputClaim:false,nativeAcceptancePasses:0,scope:'Real public paste UI scroll and byte-preserving display observation/replay only; no Shell/PTY backend receives onData.'},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({directory,results}));
