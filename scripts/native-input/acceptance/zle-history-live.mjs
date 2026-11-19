// Live real PTY observers: one follows input, another reads selected old output.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,readdir,mkdir,copyFile,chmod,open,rename} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {chromium,webkit} from 'playwright';
import {captureValidationSources} from '../integration/frozen-validation.mjs';
import {displayModuleJavaScript,installedRuntimeManifest} from '../prototype/formal-runtime.mjs';
import {editorValidationEnvironment} from './editor-validation.mjs';
import {auditEditorResources} from './editor-resources.mjs';
const root=resolve(import.meta.dirname,'../../..');assert(process.platform==='darwin'&&process.env.CARGO_TARGET_DIR);
const {values}=parseArgs({options:{theme:{type:'string'},columns:{type:'string'},engine:{type:'string'},renderer:{type:'string'},scenario:{type:'string'},transport:{type:'string'}}});
const transport=values.transport??'local';assert(['local','ssh'].includes(transport));
const scenario=values.scenario??'input';assert(['input','background','background-resize'].includes(scenario));
assert(scenario!=='background-resize'||transport==='local');
const themes=values.theme?[values.theme]:(transport==='ssh'?['plain']:['walters','adam1']);assert(themes.every(x=>(transport==='ssh'?['plain']:['walters','adam1']).includes(x)));
const widths=values.columns?values.columns.split(',').map(Number):[32,40,100,180];assert(widths.length&&widths.every(x=>[32,40,100,180].includes(x)));
const engine=values.engine??'chromium',renderer=values.renderer??'dom';assert(['chromium','webkit'].includes(engine)&&['dom','webgl'].includes(renderer));
const target=transport==='ssh'?'linux-aarch64-glibc-2.36':'macos-arm64';
const infrastructureOwner=JSON.parse(await readFile(resolve(root,'artifacts/tests/native-input/acceptance/candidate-stage.json'),'utf8')).owner;
const marker={startup:transport==='ssh'?'P3-SSH-INITIALIZED':'P3-STARTUP:env:profile:rc:login',parent:transport==='ssh'?'P3-SSH-PERSISTED':'P3-PARENT:父Shell',background:transport==='ssh'?'P3-SSH-BG-':'P3-BACKGROUND-'};
const validation=await editorValidationEnvironment(root,resolve(root,'artifacts/tests/native-input/integration/resources/native-input'),[target]);
const resourceAudit=auditEditorResources(root,target);assert(resourceAudit.selectedValid);
const sources=captureValidationSources(root),runtime=await installedRuntimeManifest();
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const directory=resolve(root,'artifacts/tests/native-input/acceptance/history-live',randomUUID());await mkdir(directory,{recursive:true});
const buildLog=await open(resolve(directory,'build.log'),'wx');
const build=spawn('cargo',['test','--locked','--manifest-path','src-tauri/Cargo.toml','--lib','--no-run','--message-format=json-render-diagnostics'],{cwd:root,stdio:['ignore','pipe',buildLog.fd]});
const built=new Promise((resolve,reject)=>{build.once('error',reject);build.once('exit',resolve);});let executable;
for await(const line of createInterface({input:build.stdout})){if(!line.trim())continue;const value=JSON.parse(line);if(value.reason==='compiler-message'&&value.message.rendered)await buildLog.writeFile(value.message.rendered);if(value.reason==='compiler-artifact'&&value.profile.test&&value.executable){assert(!executable||executable===value.executable);executable=value.executable;}}
assert.equal(await built,0);await buildLog.close();assert(executable);
const binary=resolve(directory,'actual-zle-history-tests'),binarySha256=await hash(executable);await copyFile(executable,binary);await chmod(binary,0o700);
const assets={'/xterm.js':'node_modules/@xterm/xterm/lib/xterm.js','/xterm.css':'node_modules/@xterm/xterm/css/xterm.css','/search.js':'node_modules/@xterm/addon-search/lib/addon-search.js','/unicode.js':'node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js','/webgl.js':'node_modules/@xterm/addon-webgl/lib/addon-webgl.js'};
let active;
const optional=async path=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return undefined;throw error;}};
const server=createServer(async(request,response)=>{try{
 if(request.url==='/hold'){
  const held=active&&!!await optional(resolve(active,'full-input-observation.json'))&&!await optional(resolve(active,'full-input-observation-finished.json'));
  response.setHeader('Content-Type','application/json');response.end(JSON.stringify({active:!!held}));return;
 }
 if(request.url==='/stream'){
  if(!active){response.writeHead(204).end();return;}
  const binding=await optional(resolve(active,'verified-display-binding.json'));if(!binding){response.writeHead(204).end();return;}
  let bytes;try{bytes=await readFile(resolve(active,'raw-live.bin'));}catch(error){if(error.code==='ENOENT'){response.writeHead(204).end();return;}throw error;}
  const entry=await optional(resolve(active,'geometry-live.json')),events=await optional(resolve(active,'geometry-events.json'))??[];
  const hold=!!await optional(resolve(active,'full-input-observation.json'))&&!await optional(resolve(active,'full-input-observation-finished.json'));
  response.setHeader('Content-Type','application/json');response.setHeader('Cache-Control','no-store');response.end(JSON.stringify({binding,bytes:bytes.toString('base64'),entry,events,hold}));return;
 }
 if(request.url==='/wrapped'&&request.method==='POST'){
  assert(active);const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;assert(size<=4096);chunks.push(chunk);}const value=JSON.parse(Buffer.concat(chunks));
  const entry=await optional(resolve(active,'geometry-live.json'));assert(value.wrapped&&value.sourceSha256===entry.sourceSha256&&value.columns===entry.columns);
  const pending=resolve(active,'wrapped-ready.pending');await writeFile(pending,JSON.stringify(value),{flag:'wx'});await rename(pending,resolve(active,'wrapped-ready.json'));response.end('ok');return;
 }
 if(request.url==='/display.js'){response.setHeader('Content-Type','application/javascript');response.end(await displayModuleJavaScript());return;}
 const asset=assets[request.url];response.setHeader('Content-Type',asset?(request.url.endsWith('.css')?'text/css':'application/javascript'):'text/html');
 response.end(asset?await readFile(resolve(root,asset)):'<!doctype html><link rel="stylesheet" href="/xterm.css"><div id="surface"></div><script src="/xterm.js"></script><script src="/search.js"></script><script src="/unicode.js"></script><script src="/webgl.js"></script>');
}catch(error){response.writeHead(500).end(String(error));}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await({chromium,webkit}[engine]).launch({headless:true}),results=[];
try{for(const theme of themes)for(const columns of widths){
 active=undefined;const pages=[];let child,ended,fixturePath,runDirectory;
 try{
  for(const role of ['follow','parked']){
   const page=await browser.newPage({viewport:{width:2200,height:900}});pages.push(page);await page.goto(`http://127.0.0.1:${server.address().port}`);
   await page.evaluate(async({columns,renderer,role,scenario,marker})=>{
    const {attachNativeInputDisplay}=await import('/display.js');
    const terminal=new Terminal({cols:columns,rows:30,scrollback:20000,reflowCursorLine:false,allowProposedApi:true});terminal.open(document.querySelector('#surface'));
    if(renderer==='webgl')terminal.loadAddon(new WebglAddon.WebglAddon());
    terminal.loadAddon(new Unicode11Addon.Unicode11Addon());const search=new SearchAddon.SearchAddon();terminal.loadAddon(search);
    const s=window.live={terminal,search,role,offset:0,eventIndex:0,frames:[],failure:undefined,stopped:false,allowResize:false,completedDecodedUtf8Bytes:0,offeredRawThrough:0};
    s.original={selection:terminal.getSelection,line:terminal.buffer.normal.getLine,open:terminal.open};
     if(role==='follow'&&scenario!=='input'){
     const host=document.createElement('div');host.style.cssText='position:fixed;left:-10000px';document.body.append(host);
     s.reference=new Terminal({cols:columns,rows:30,scrollback:20000,reflowCursorLine:false,allowProposedApi:true});s.reference.open(host);s.reference.loadAddon(new Unicode11Addon.Unicode11Addon());
    }
    const decoder=new TextDecoder('utf-8',{fatal:true});
    const snapshot=()=>{
     const b=terminal.buffer.normal,rows=[];let joined='';
     for(let y=0;y<b.length;y++){const line=b.getLine(y),text=line?.translateToString(true)??'';rows.push({y,text,wrapped:line?.isWrapped??false});joined+=(line?.isWrapped?'':'\n')+text;}
     const markers={startup:joined.includes(marker.startup),parent:joined.includes(marker.parent),background:[...new Set(joined.match(new RegExp(marker.background+'\\d+:','g'))??[])],prefill:[...new Set(joined.match(/P3_HISTORY_\d{2}/g)??[])]};
     return{at:performance.now(),offset:s.offset,parsedUtf8LowerBound:s.completedDecodedUtf8Bytes,offeredRawUpperBound:s.offeredRawThrough,eventIndex:s.eventIndex,baseY:b.baseY,viewportY:b.viewportY,cursor:{x:b.cursorX,y:b.baseY+b.cursorY},selection:terminal.getSelection(),markers,rows};
    };
    s.snapshot=snapshot;
    terminal.onRender(()=>{const frame=snapshot();s.frames.push({...frame,rows:undefined});if(s.frames.length>10000)s.failure='Real frame audit exceeded its declared bound';});
    const write=async bytes=>{s.offeredRawThrough+=bytes.length;const text=decoder.decode(bytes,{stream:true}),decodedLength=new TextEncoder().encode(text).length;await Promise.all([new Promise(resolve=>terminal.write(text,()=>{s.completedDecodedUtf8Bytes+=decodedLength;resolve();})),...(s.reference?[new Promise(resolve=>s.reference.write(text,resolve))]:[])]);};
    s.done=(async()=>{while(!s.stopped){
     const response=await fetch('/stream',{cache:'no-store'});if(response.status===204){await new Promise(resolve=>setTimeout(resolve,5));continue;}if(!response.ok)throw Error(await response.text());const packet=await response.json();
     if(!s.binding){if(packet.binding.ownedReflowCursorLine!==true||packet.binding.unicodeVersion!=='11')throw Error('Actual verified native-append binding was not received before PTY output');s.binding=packet.binding;s.display=attachNativeInputDisplay(terminal,packet.binding,{unicodeVersion:packet.binding.unicodeVersion,unicodeScope:packet.binding.unicodeScope});if(s.reference)s.referenceDisplay=attachNativeInputDisplay(s.reference,packet.binding,{unicodeVersion:packet.binding.unicodeVersion,unicodeScope:packet.binding.unicodeScope});}
     const bytes=Uint8Array.from(atob(packet.bytes),x=>x.charCodeAt(0));
     for(const event of packet.events.slice(s.eventIndex)){
      if(event.offset>bytes.length)break;
      if(event.offset<s.offset)throw Error('Actual resize arrived after its following PTY bytes');
      await write(bytes.slice(s.offset,event.offset));s.offset=event.offset;
      terminal.resize(event.columns,event.rows??30);
      if(s.reference&&scenario==='background-resize')s.reference.resize(event.columns,event.rows);
      s.eventIndex++;
     }
     await write(bytes.slice(s.offset));s.offset=bytes.length;if(packet.entry)s.entry=packet.entry;
     if(scenario==='input'&&role==='follow'&&packet.entry&&!s.wrapped&&search.findNext(packet.entry.prefixBeforeFirstResize)){
      const selected=terminal.getSelection(),position=terminal.getSelectionPosition();terminal.clearSelection();
      if(selected===packet.entry.prefixBeforeFirstResize&&position&&Array.from({length:position.end.y-position.start.y},(_,i)=>terminal.buffer.normal.getLine(position.start.y+i+1)?.isWrapped).some(Boolean))s.wrapped={sourceSha256:packet.entry.sourceSha256,columns,wrapped:true,position,actualOffset:s.offset};
     }
     if(role==='follow'&&s.wrapped&&s.allowResize&&!s.acknowledged){const result=await fetch('/wrapped',{method:'POST',body:JSON.stringify(s.wrapped)});if(!result.ok)throw Error(await result.text());s.acknowledged=true;}
     if(scenario==='input'&&role==='follow'&&packet.hold&&!s.fullSource&&search.findNext(s.entry.source)){
      const selected=terminal.getSelection(),position=terminal.getSelectionPosition();
      if(selected===s.entry.source&&position){
       await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
       const held=await(await fetch('/hold',{cache:'no-store'})).json();
       if(held.active)s.fullSource={...snapshot(),position,exactSource:true,inActualUnsubmittedHold:true};
      }
      terminal.clearSelection();
     }
     if(scenario!=='input'&&role==='follow'&&packet.hold&&!s.fullSource){
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const held=await(await fetch('/hold',{cache:'no-store'})).json();
      if(held.active){
       const copyToCursor=target=>{const b=target.buffer.normal;target.select(0,0,(b.baseY+b.cursorY)*target.cols+b.cursorX);const value=target.getSelection();target.clearSelection();return value;};
       s.fullSource={...snapshot(),combinedCopy:copyToCursor(terminal),referenceCopy:copyToCursor(s.reference),inActualUnsubmittedHold:true};
      }
     }
     await new Promise(resolve=>setTimeout(resolve,5));
    }})().catch(error=>{s.failure=String(error);});
   },{columns,renderer,role,scenario,marker});
  }
  const production=resolve(root,transport==='ssh'?'artifacts/tests/native-input/acceptance/production-ssh-zle':'artifacts/tests/native-input/acceptance/production-zle');await mkdir(production,{recursive:true});const before=new Set(await readdir(production));const log=await open(resolve(directory,`${theme}-${columns}.log`),'wx');
  const environment={...process.env,...validation,SHELLSPAN_P3_TEST_PROMPT_THEME:theme,SHELLSPAN_P3_TEST_COLUMNS:String(columns),SHELLSPAN_P3_TRACE_SCHEDULE:'1',SHELLSPAN_P3_GEOMETRY_BACKGROUND_OUTPUT:scenario==='input'?'0':'1',SHELLSPAN_P3_HISTORY_PREFILL:'1',SHELLSPAN_P3_OBSERVE_FULL_INPUT:'1',SHELLSPAN_P3_INTERRUPT_STAGE:'running'};
  if(scenario==='background-resize')environment.SHELLSPAN_P3_GEOMETRY_DYNAMIC_ROWS='1';else delete environment.SHELLSPAN_P3_GEOMETRY_DYNAMIC_ROWS;
  if(scenario==='input'||transport==='ssh')environment.SHELLSPAN_P3_LIVE_GEOMETRY='1';else delete environment.SHELLSPAN_P3_LIVE_GEOMETRY;
  if(transport==='ssh'){
   fixturePath=execFileSync(process.execPath,[resolve(root,'scripts/native-input/acceptance/linux-peer.mjs'),root],{cwd:root,encoding:'utf8'}).trim();
   runDirectory=resolve(root,'artifacts/tests/native-input/acceptance/scoped-ssh-runs',randomUUID());await mkdir(runDirectory,{recursive:true});const image=resolve(runDirectory,'actual-scoped-ssh-tests');await copyFile(binary,image);await chmod(image,0o700);assert.equal(await hash(image),binarySha256);
   child=spawn(resolve(infrastructureOwner,'artifacts/tests/native-input/acceptance/venv/bin/python'),['-B',resolve(root,'scripts/native-input/acceptance/linux-run.py'),fixturePath],{cwd:root,env:{...environment,SHELLSPAN_P3_SSH_TEST_IMAGE:image,SHELLSPAN_P3_SSH_PLANNED_OPERATIONS:'10'},stdio:['ignore',log.fd,log.fd]});
  }else child=spawn(binary,['terminal_command::zle_tests::native_zle_production_startup_parent_parser_and_jobs','--ignored','--exact'],{cwd:root,env:environment,stdio:['ignore',log.fd,log.fd]});
  ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  const deadline=Date.now()+30000;while(!active){const created=(await readdir(production)).filter(name=>!before.has(name));assert(created.length<=1);if(created.length)active=resolve(production,created[0]);else{assert(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,5));}}
  await pages[1].waitForFunction(()=>window.live.failure||window.live.snapshot().markers.prefill.length===60,{},{timeout:10000});
  await pages[1].locator('.xterm-screen').hover();
  await pages[1].mouse.wheel(0,-100000);
  await pages[1].waitForFunction(()=>window.live.terminal.buffer.normal.viewportY<window.live.terminal.buffer.normal.baseY,{},{timeout:500});
  const parked=await pages[1].evaluate(async()=>{
   const s=window.live;let previous=-1,stable=0;
   for(let frame=0;frame<20&&stable<2;frame++){await new Promise(resolve=>requestAnimationFrame(resolve));const y=s.terminal.buffer.normal.viewportY;stable=y===previous?stable+1:0;previous=y;}
   const current=s.snapshot(),row=current.rows.find(row=>row.y>=current.viewportY&&row.y<current.viewportY+s.terminal.rows&&/P3_HISTORY_\d{2}/.test(row.text));
   if(!row)throw Error('The actual wheel viewport did not contain old output');
   const marker=row.text.match(/P3_HISTORY_\d{2}/)[0],x=row.text.indexOf(marker);if(!/^[\x20-\x7e]*$/.test(row.text.slice(0,x)))throw Error('Selected ASCII marker has a non-ASCII column prefix');
   s.terminal.select(x,row.y,marker.length);s.selectionExpected=marker;s.parkedAt=performance.now();return{...s.snapshot(),expected:marker};
  });
  assert.equal(parked.selection,parked.expected);
  if(scenario==='input'){await pages[0].waitForFunction(()=>window.live.failure||window.live.wrapped,{},{timeout:10000});assert.equal(await pages[0].evaluate(()=>window.live.failure),undefined);await pages[0].evaluate(()=>{window.live.allowResize=true;});}
  const exitCode=await ended;await log.close();const rawLength=(await readFile(resolve(active,'raw.bin'))).length;
  const observations=[];
  for(let index=0;index<pages.length;index++){
   const page=pages[index];await page.waitForFunction(length=>window.live.failure||window.live.offset===length,rawLength);
   const value=await page.evaluate(async()=>{const s=window.live;s.stopped=true;await s.done;if(s.failure)throw Error(s.failure);if(!s.display)throw Error('The actual live observer never received its verified binding');await new Promise(resolve=>requestAnimationFrame(resolve));const final=s.snapshot();let copied;if(s.role==='follow'){s.terminal.selectAll();copied=s.terminal.getSelection();s.terminal.clearSelection();}const publicApisUnmodified=s.terminal.getSelection===s.original.selection&&s.terminal.buffer.normal.getLine===s.original.line&&s.terminal.open===s.original.open;await s.display.closeAfterPendingOutput();if(s.referenceDisplay)await s.referenceDisplay.closeAfterPendingOutput();return{role:s.role,binding:s.binding,failure:s.failure,wrapped:s.wrapped,fullSource:s.fullSource,final,copied,frames:s.frames,parkedAt:s.parkedAt,selectionExpected:s.selectionExpected,publicApisUnmodified,providerAfter:s.terminal.unicode.activeVersion,reflowAfter:s.terminal.options.reflowCursorLine};});
   observations.push(value);await page.screenshot({path:resolve(directory,`${theme}-${columns}-${value.role}.png`)});
  }
  const actual=JSON.parse(await readFile(resolve(active,'result.json'),'utf8'));results.push({scenario,theme,columns,exitCode,evidence:active,actual,observations});
  const geometry=JSON.parse(await readFile(resolve(active,'geometry.json'),'utf8'));
  const control=[];for await(const line of createInterface({input:createReadStream(resolve(active,transport==='ssh'?'control.jsonl':'control-live.jsonl')),crlfDelay:Infinity}))if(line)control.push(JSON.parse(line));
  if(transport==='local'){
   const confirmed=control.find(value=>value.message.requestId==='prepare-3'&&value.message.payload.kind==='inputConfirmed');
   assert(confirmed&&geometry.resizeEvents.length===7&&geometry.resizeEvents.every(value=>value.elapsedMicros<confirmed.elapsedMicros),'The seven actual resizes did not precede native full-input confirmation');
   if(scenario==='background-resize')assert(new Set(geometry.resizeEvents.map(value=>value.rows)).size>2,'The real PTY did not change height');
  }else{
   assert.equal(geometry.resizeEvents.length,7);
   assert(control.some(value=>value.requestId==='wrap-query-3'&&value.payload.kind==='snapshot'&&value.payload.phase==='typing'&&value.payload.mayHaveSubmitted===false),'Actual SSH typing query proof missing');
   const cleanup=JSON.parse(await readFile(resolve(runDirectory,'run-result.json'),'utf8'));assert(cleanup.ok&&cleanup.credentialDeleted&&cleanup.accountLocked&&cleanup.cleanupErrors.length===0);results[results.length-1].cleanup=cleanup;
  }
  const follow=observations[0],history=observations[1];
  const actualPrintedIds=[...new Set([...((await readFile(resolve(active,'raw.bin'))).toString('utf8')).matchAll(new RegExp(marker.background+'(\\d+):','g'))].map(value=>Number(value[1])))];
  const missingBackground=actualPrintedIds.filter(id=>!follow.copied.includes(`${marker.background}${id}:父Shell-é-👩🏽‍💻`));
  results[results.length-1].background={actualPrintedIds,missingBackground};
  assert.equal(exitCode,0);assert(actual.ok);assert(observations.every(value=>!value.failure&&value.publicApisUnmodified&&value.providerAfter==='6'&&value.reflowAfter===false));
  assert(follow.fullSource?.inActualUnsubmittedHold&&follow.fullSource.markers.startup&&follow.fullSource.markers.parent&&follow.fullSource.markers.prefill.length===60,'The live input frame did not retain actual prior output');
  if(scenario==='input'){assert(follow.fullSource.exactSource);assert.deepEqual(follow.fullSource.cursor,follow.fullSource.position.end,'Actual native input cursor did not match full source end');}
  else{
   assert.equal(follow.fullSource.combinedCopy,follow.fullSource.referenceCopy,'Owned combined output differs from the real reference stream');
   const prefix=(await readFile(resolve(active,'raw.bin'))).subarray(0,follow.fullSource.offeredRawUpperBound).toString('utf8');
   const completed=actualPrintedIds.filter(id=>prefix.includes(`${marker.background}${id}:父Shell-é-👩🏽‍💻`));
   assert(completed.length>0);assert(completed.every(id=>follow.fullSource.combinedCopy.includes(`${marker.background}${id}:父Shell-é-👩🏽‍💻`)),'A complete real background payload disappeared before arm');
  }
  assert.equal(history.final.markers.prefill.length,60);assert(history.final.markers.startup&&history.final.markers.parent);
  assert.equal(history.final.selection,history.selectionExpected,'Real user history selection changed during native input/resize');
  assert.equal(missingBackground.length,0,'Actually printed background payloads disappeared from original public copy');
 }catch(error){
  const observations=[];for(const page of pages){try{observations.push(await page.evaluate(()=>{const s=window.live;s.stopped=true;return{failure:s.failure,binding:s.binding,wrapped:s.wrapped,fullSource:s.fullSource,final:s.snapshot(),frames:s.frames};}));}catch(failure){observations.push({error:String(failure)});}}
  results.push({theme,columns,evidence:active,error:String(error),observations});throw error;
 }finally{if(child?.exitCode===null)await ended;if(fixturePath)execFileSync(process.execPath,[resolve(infrastructureOwner,'scripts/native-input/acceptance/scoped-fixture-stop.mjs'),resolve(fixturePath,'../owner.json')],{cwd:infrastructureOwner,stdio:'pipe'});for(const page of pages)await page.close();active=undefined;}
}}finally{
 await browser.close();await new Promise(resolve=>server.close(resolve));assert.equal(await hash(binary),binarySha256);assert.deepEqual(captureValidationSources(root),sources);assert.deepEqual(await installedRuntimeManifest(),runtime);assert.deepEqual(auditEditorResources(root,target),resourceAudit);
 await writeFile(resolve(directory,'result.json'),JSON.stringify({scope:'live real local/SSH ZLE; input-only source/caret or background combined-copy; actual native proof, resize, readonly frames and physical wheel; 250ms observation before arm/accept',transport,scenario,engine,renderer,themes,widths,binarySha256,sourceCount:Object.keys(sources).length,runtime,results},null,2));
}
process.stdout.write(JSON.stringify({directory,cases:results.length,engine,renderer})+'\n');
