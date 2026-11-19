import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,readdir,mkdir,copyFile,chmod,open,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {displayModuleJavaScript,installedRuntimeManifest} from '../prototype/formal-runtime.mjs';
import {captureValidationSources} from '../integration/frozen-validation.mjs';
const root=resolve(import.meta.dirname,'../../..');assert.equal(process.platform,'darwin');
const ordinaryInput=process.env.SHELLSPAN_P3_ORDINARY_ZLE_EVIDENCE;
assert(ordinaryInput||process.env.CARGO_TARGET_DIR);
const directory=resolve(root,'artifacts/tests/native-input-p3/live-geometry',randomUUID());await mkdir(directory,{recursive:true});
const sources=captureValidationSources(root);const runtime=await installedRuntimeManifest();
const experiment=process.env.SHELLSPAN_P3_XTERM_EXPERIMENT?JSON.parse(await readFile(process.env.SHELLSPAN_P3_XTERM_EXPERIMENT,'utf8')):undefined;
const unicode11=process.env.SHELLSPAN_P3_UNICODE11_ASSET;
if(experiment){assert(experiment.nativeAcceptance===false&&experiment.formalPatchChanged===false);assert.equal(createHash('sha256').update(await readFile(resolve(experiment.source,'lib/xterm.js'))).digest('hex'),experiment.artifacts['lib/xterm.js']);}
let binary,binarySha256;
if(!ordinaryInput){
const build=spawn('cargo',['test','--locked','--manifest-path','src-tauri/Cargo.toml','--lib','--no-run','--message-format=json-render-diagnostics'],{cwd:root,stdio:['ignore','pipe','pipe']});
const diagnostics=[];build.stderr.on('data',bytes=>diagnostics.push(bytes));let executable;
const built=new Promise((resolve,reject)=>{build.once('error',reject);build.once('exit',resolve);});
for await(const line of createInterface({input:build.stdout})){if(!line.trim())continue;const event=JSON.parse(line);if(event.reason==='compiler-message'&&event.message.rendered)diagnostics.push(Buffer.from(event.message.rendered));if(event.reason==='compiler-artifact'&&event.profile.test&&event.executable){assert(!executable||executable===event.executable);executable=event.executable;}}
const buildCode=await built;await writeFile(resolve(directory,'build.log'),Buffer.concat(diagnostics));assert.equal(buildCode,0);assert(executable);
binary=resolve(directory,'native-zle-tests');binarySha256=createHash('sha256').update(await readFile(executable)).digest('hex');await copyFile(executable,binary);await chmod(binary,0o700);assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'),binarySha256);
}
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
let active;
const assets={'/xterm.js':['node_modules/@xterm/xterm/lib/xterm.js','application/javascript'],'/xterm.css':['node_modules/@xterm/xterm/css/xterm.css','text/css'],'/search.js':['node_modules/@xterm/addon-search/lib/addon-search.js','application/javascript']};
if(experiment)assets['/xterm.js']=[resolve(experiment.source,'lib/xterm.js'),'application/javascript'];
if(unicode11){assert(experiment,'A different provider is limited to an explicit isolated experiment');assets['/unicode11.js']=[resolve(unicode11),'application/javascript'];}
const server=createServer(async(request,response)=>{
  try{
    if(request.url==='/stream'){
      if(!active){response.writeHead(204).end();return;}
      // Read bytes first: every resize is atomically published while the PTY
      // collector is locked, before any bytes following its offset are added.
      let bytes;try{bytes=await readFile(resolve(active,'raw-live.bin'));}catch(error){if(error.code==='ENOENT'){response.writeHead(204).end();return;}throw error;}
      let entry,events=[];try{entry=JSON.parse(await readFile(resolve(active,'geometry-live.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
      try{events=JSON.parse(await readFile(resolve(active,'geometry-events.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
      response.setHeader('Content-Type','application/json');response.setHeader('Cache-Control','no-store');response.end(JSON.stringify({bytes:bytes.toString('base64'),entry,events}));return;
    }
    if(request.url==='/wrapped'&&request.method==='POST'){
      assert(active);const chunks=[];let size=0;for await(const bytes of request){size+=bytes.length;assert(size<=4096);chunks.push(bytes);}
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));assert(value.wrapped&&value.position.end.y>value.position.start.y);
      const entry=JSON.parse(await readFile(resolve(active,'geometry-live.json'),'utf8'));assert.equal(value.sourceSha256,entry.sourceSha256);assert.equal(value.columns,entry.columns);
      const pending=resolve(active,'wrapped-ready.pending');await writeFile(pending,JSON.stringify({...value,observedAt:new Date().toISOString(),kind:'live-public-xterm-buffer-before-real-PTY-resize'}),{flag:'wx'});await rename(pending,resolve(active,'wrapped-ready.json'));
      response.end('ok');return;
    }
    if(request.url==='/display.js'){response.setHeader('Content-Type','application/javascript');response.end(await displayModuleJavaScript());return;}
    const asset=assets[request.url];response.setHeader('Content-Type',asset?asset[1]:'text/html');response.end(asset?await readFile(resolve(root,asset[0])):'<!doctype html><link rel="stylesheet" href="/xterm.css"><div id="surface"></div><script src="/xterm.js"></script><script src="/search.js"></script>'+(unicode11?'<script src="/unicode11.js"></script>':''));
  }catch(error){response.writeHead(500).end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});const results=[];
try{
  const actual=ordinaryInput?resolve(ordinaryInput,'ordinary-zle-baseline'):resolve(root,'artifacts/tests/native-input-p3/production-zle');await mkdir(actual,{recursive:true});
  for(const columns of[32,40,100,180]){
    active=undefined;const page=await browser.newPage({viewport:{width:1500,height:640}});let child;
    try{
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const ordinaryReflow=ordinaryInput&&process.env.SHELLSPAN_P3_ORDINARY_REFLOW==='1';if(ordinaryReflow)assert(experiment,'Ordinary reflow changes require an explicit isolated experiment');
      await page.evaluate(async({columns,unicode11,ordinaryReflow})=>{
        const {attachNativeInputDisplay,NATIVE_INPUT_DISPLAY}=await import('/display.js');
        const terminal=new Terminal({cols:columns,rows:30,scrollback:20000,reflowCursorLine:false,allowProposedApi:unicode11});terminal.open(document.querySelector('#surface'));
        if(unicode11){terminal.loadAddon(new Unicode11Addon.Unicode11Addon());terminal.unicode.activeVersion='11';if(terminal.unicode.activeVersion!=='11')throw new Error('Actual candidate provider was not activated');}
        const search=new SearchAddon.SearchAddon();terminal.loadAddon(search);const display=attachNativeInputDisplay(terminal,NATIVE_INPUT_DISPLAY);
        if(ordinaryReflow)terminal.options.reflowCursorLine=true;
        const original={selection:terminal.getSelection,line:terminal.buffer.normal.getLine,open:terminal.open};const decoder=new TextDecoder('utf-8',{fatal:true});
        window.p3={terminal,search,display,original,decoder,offset:0,eventIndex:0,wrapped:false,stopped:false,failure:undefined};
        const state=window.p3;const write=bytes=>new Promise(resolve=>terminal.write(decoder.decode(bytes,{stream:true}),resolve));
        state.done=(async()=>{
          while(!state.stopped){
            const response=await fetch('/stream',{cache:'no-store'});if(response.status===204){await new Promise(resolve=>setTimeout(resolve,5));continue;}
            if(!response.ok)throw new Error(await response.text());const packet=await response.json();const bytes=Uint8Array.from(atob(packet.bytes),char=>char.charCodeAt(0));
            for(const event of packet.events.slice(state.eventIndex)){
              if(event.offset>bytes.length)break;if(event.offset<state.offset)throw new Error('Live geometry was observed after its following PTY bytes');
              await write(bytes.slice(state.offset,event.offset));state.offset=event.offset;terminal.resize(event.columns,30);state.eventIndex++;
            }
            await write(bytes.slice(state.offset));state.offset=bytes.length;
            if(packet.entry)state.entry=packet.entry;
            if(packet.entry&&!state.wrapped&&search.findNext(packet.entry.prefixBeforeFirstResize)){
              const selected=terminal.getSelection();const position=terminal.getSelectionPosition();terminal.clearSelection();
              const wrapped=position&&Array.from({length:position.end.y-position.start.y},(_,index)=>terminal.buffer.normal.getLine(position.start.y+index+1)?.isWrapped).some(Boolean);
              if(selected===packet.entry.prefixBeforeFirstResize&&wrapped){
                const proof={sourceSha256:packet.entry.sourceSha256,columns:terminal.cols,wrapped:true,position,observedBytes:state.offset,cursorX:terminal.buffer.normal.cursorX,cursorY:terminal.buffer.normal.cursorY};
                const acknowledged=await fetch('/wrapped',{method:'POST',body:JSON.stringify(proof)});if(!acknowledged.ok)throw new Error(await acknowledged.text());state.wrapped=proof;
              }
            }
            await new Promise(resolve=>setTimeout(resolve,5));
          }
        })().catch(error=>{state.failure=String(error);});
      },{columns,unicode11:Boolean(unicode11),ordinaryReflow:Boolean(ordinaryReflow)});
      const before=new Set(await readdir(actual));const log=await open(resolve(directory,`${columns}.log`),'wx');
      const ordinaryArgs=ordinaryInput?['-B','scripts/native-input/acceptance/zle-baseline.py',ordinaryInput,'--dynamic','--columns',String(columns),'--shell',process.env.SHELLSPAN_P3_TEST_ZSH??'/bin/zsh',...(process.env.SHELLSPAN_P3_TEST_COMBINING_CHARS?['--combining-chars']:[])]:undefined;
      child=spawn(ordinaryArgs?process.env.SHELLSPAN_P3_PYTHON:binary,ordinaryArgs??['terminal_command::zle_tests::native_zle_production_startup_parent_parser_and_jobs','--ignored','--exact'],{cwd:root,stdio:['ignore',log.fd,log.fd],env:{...process.env,SHELLSPAN_P3_TEST_COLUMNS:String(columns),SHELLSPAN_P3_LIVE_GEOMETRY:'1',SHELLSPAN_P3_INTERRUPT_STAGE:'running'}});
      const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
      const deadline=Date.now()+5000;while(!active){const created=(await readdir(actual)).filter(name=>!before.has(name));assert(created.length<=1);if(created.length)active=resolve(actual,created[0]);else{assert(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,5));}}
      const exitCode=await ended;await log.close();
      await page.waitForFunction(()=>window.p3.failure||window.p3.offset>0);const raw=await readFile(resolve(active,'raw.bin'));
      await page.waitForFunction(length=>window.p3.failure||window.p3.offset===length,raw.length);
      const observed=await page.evaluate(async()=>{const s=window.p3;s.stopped=true;await s.done;s.terminal.selectAll();const all=s.terminal.getSelection();s.terminal.clearSelection();const found=s.entry?s.search.findNext(s.entry.source):false;const selected=s.terminal.getSelection();s.terminal.clearSelection();await s.display.closeAfterPendingOutput();return{failure:s.failure,wrapped:s.wrapped,geometryEvents:s.eventIndex,all,exactSourceCopy:!!s.entry&&all.includes(s.entry.source),exactSourceSearch:found&&selected===s.entry.source,selected,publicApisUnmodified:s.terminal.getSelection===s.original.selection&&s.terminal.buffer.normal.getLine===s.original.line&&s.terminal.open===s.original.open,displayRestored:s.terminal.options.reflowCursorLine===false};});
      await page.screenshot({path:resolve(directory,`${columns}.png`)});if(binary)assert.equal(await hash(binary),binarySha256);
      results.push({columns,exitCode,evidence:active,actual:JSON.parse(await readFile(resolve(active,'result.json'),'utf8')),observed});
    }finally{if(child?.exitCode===null)child.kill();await page.close();active=undefined;}
  }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));assert.deepEqual(captureValidationSources(root),sources);assert.deepEqual(await installedRuntimeManifest(),runtime);await writeFile(resolve(directory,'result.json'),JSON.stringify({binarySha256,sourceCount:Object.keys(sources).length,runtime,results,ordinaryInput,ordinaryReflow:ordinaryInput&&process.env.SHELLSPAN_P3_ORDINARY_REFLOW==='1',...(experiment?{nativeAcceptance:false,formalPatchChanged:false,experimentDirectory:experiment.directory,candidateRuntimeSha256:experiment.artifacts['lib/xterm.js'],unicode11Asset:unicode11}:{} )},null,2));}
console.log(JSON.stringify({directory,cases:results.length}));
assert(results.length===4&&results.every(value=>value.exitCode===0&&value.actual.ok&&value.observed.wrapped&&!value.observed.failure&&value.observed.geometryEvents===7&&value.observed.exactSourceCopy&&value.observed.exactSourceSearch&&value.observed.publicApisUnmodified&&value.observed.displayRestored),'Actual live geometry, exact source copy/search or component lifecycle failed; all original observations retained');
