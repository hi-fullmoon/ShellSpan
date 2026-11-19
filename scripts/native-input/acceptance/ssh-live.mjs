import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,readdir,mkdir,copyFile,chmod,open,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {displayModuleJavaScript,installedRuntimeManifest} from '../prototype/formal-runtime.mjs';
import {captureValidationSources} from '../integration/frozen-validation.mjs';
import {editorValidationEnvironment} from './editor-validation.mjs';
import {auditEditorResources} from './editor-resources.mjs';
const owner=resolve(import.meta.dirname,'../../..'),root=resolve(process.argv[2]);assert.equal(resolve(process.cwd()),root);assert(process.env.CARGO_TARGET_DIR);
const stage=JSON.parse(await readFile(resolve(root,'artifacts/tests/native-input/acceptance/candidate-stage.json'),'utf8'));assert(stage.sealed&&stage.root===root);
const validation=await editorValidationEnvironment(root,resolve(root,'artifacts/tests/native-input/integration/resources/native-input'),['linux-aarch64-glibc-2.36']);
const resourceAudit=auditEditorResources(root,'linux-aarch64-glibc-2.36');assert(resourceAudit.selectedValid);
const directory=resolve(root,'artifacts/tests/native-input/acceptance/ssh-live',randomUUID());await mkdir(directory,{recursive:true});
const sources=captureValidationSources(root);const runtime=await installedRuntimeManifest();
const experiment=process.env.SHELLSPAN_P3_XTERM_EXPERIMENT?JSON.parse(await readFile(process.env.SHELLSPAN_P3_XTERM_EXPERIMENT,'utf8')):undefined;
const unicode11=process.env.SHELLSPAN_P3_UNICODE11_ASSET;
if(experiment){assert(experiment.nativeAcceptance===false&&experiment.formalPatchChanged===false);assert.equal(createHash('sha256').update(await readFile(resolve(experiment.source,'lib/xterm.js'))).digest('hex'),experiment.artifacts['lib/xterm.js']);}
let binary,binarySha256;
const build=spawn('cargo',['test','--locked','--manifest-path','src-tauri/Cargo.toml','--lib','--no-run','--message-format=json-render-diagnostics'],{cwd:root,stdio:['ignore','pipe','pipe']});
const diagnostics=[];build.stderr.on('data',bytes=>diagnostics.push(bytes));let executable;
const built=new Promise((resolve,reject)=>{build.once('error',reject);build.once('exit',resolve);});
for await(const line of createInterface({input:build.stdout})){if(!line.trim())continue;const event=JSON.parse(line);if(event.reason==='compiler-message'&&event.message.rendered)diagnostics.push(Buffer.from(event.message.rendered));if(event.reason==='compiler-artifact'&&event.profile.test&&event.executable){assert(!executable||executable===event.executable);executable=event.executable;}}
const buildCode=await built;await writeFile(resolve(directory,'build.log'),Buffer.concat(diagnostics));assert.equal(buildCode,0);assert(executable);
binary=resolve(directory,'native-zle-tests');binarySha256=createHash('sha256').update(await readFile(executable)).digest('hex');await copyFile(executable,binary);await chmod(binary,0o700);assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'),binarySha256);
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
let active;
const assets={'/xterm.js':['node_modules/@xterm/xterm/lib/xterm.js','application/javascript'],'/xterm.css':['node_modules/@xterm/xterm/css/xterm.css','text/css'],'/search.js':['node_modules/@xterm/addon-search/lib/addon-search.js','application/javascript']};
if(experiment)assets['/xterm.js']=[resolve(experiment.source,'lib/xterm.js'),'application/javascript'];
if(unicode11){assert(experiment,'A different provider is limited to an explicit isolated experiment');assets['/unicode11.js']=[resolve(unicode11),'application/javascript'];}
const server=createServer(async(request,response)=>{
  try{
    const requestUrl=new URL(request.url,'http://127.0.0.1');
    if(requestUrl.pathname==='/stream'){
      if(!active){response.writeHead(204).end();return;}
      // Read bytes first: every resize is atomically published while the PTY
      // collector is locked, before any bytes following its offset are added.
      let bytes;try{bytes=await readFile(resolve(active,'raw-live.bin'));}catch(error){if(error.code==='ENOENT'){response.writeHead(204).end();return;}throw error;}
      let entry,events=[];try{entry=JSON.parse(await readFile(resolve(active,'geometry-live.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
      try{events=JSON.parse(await readFile(resolve(active,'geometry-events.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
      const offset=Number(requestUrl.searchParams.get('offset')??0);assert(Number.isSafeInteger(offset)&&offset>=0&&offset<=bytes.length);
      response.setHeader('Content-Type','application/json');response.setHeader('Cache-Control','no-store');response.end(JSON.stringify({offset,total:bytes.length,bytes:bytes.subarray(offset).toString('base64'),entry,events}));return;
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
  const actual=resolve(root,'artifacts/tests/native-input/acceptance/production-ssh-zle');await mkdir(actual,{recursive:true});
  for(const columns of[32,40,100,180]){
    active=undefined;const page=await browser.newPage({viewport:{width:1500,height:640}});let child,ended,fixturePath,runDirectory;
    try{
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.evaluate(async({columns,unicode11})=>{
        const {attachNativeInputDisplay,NATIVE_INPUT_DISPLAY}=await import('/display.js');
        const terminal=new Terminal({cols:columns,rows:30,scrollback:20000,reflowCursorLine:false,allowProposedApi:unicode11});terminal.open(document.querySelector('#surface'));
        if(unicode11)terminal.loadAddon(new Unicode11Addon.Unicode11Addon());
        const ordinaryUnicodeVersion=unicode11?terminal.unicode.activeVersion:undefined;
        if(unicode11&&ordinaryUnicodeVersion!=='6')throw new Error('Ordinary provider default changed before owned input');
        const search=new SearchAddon.SearchAddon();terminal.loadAddon(search);const display=attachNativeInputDisplay(terminal,NATIVE_INPUT_DISPLAY,unicode11?{unicodeVersion:'11'}:{});
        const original={selection:terminal.getSelection,line:terminal.buffer.normal.getLine,open:terminal.open};const decoder=new TextDecoder('utf-8',{fatal:true});
        window.p3={terminal,search,display,original,ordinaryUnicodeVersion,decoder,offset:0,eventIndex:0,wrapped:false,stopped:false,failure:undefined};
        const state=window.p3;const write=bytes=>new Promise(resolve=>terminal.write(decoder.decode(bytes,{stream:true}),resolve));
        state.done=(async()=>{
          while(!state.stopped){
            const response=await fetch(`/stream?offset=${state.offset}`,{cache:'no-store'});if(response.status===204){await new Promise(resolve=>setTimeout(resolve,5));continue;}
            if(!response.ok)throw new Error(await response.text());const packet=await response.json();const bytes=Uint8Array.from(atob(packet.bytes),char=>char.charCodeAt(0));
            for(const event of packet.events.slice(state.eventIndex)){
              if(event.offset>packet.total)break;if(event.offset<state.offset)throw new Error('Live geometry was observed after its following PTY bytes');
              await write(bytes.slice(state.offset-packet.offset,event.offset-packet.offset));state.offset=event.offset;terminal.resize(event.columns,30);state.eventIndex++;
            }
            await write(bytes.slice(state.offset-packet.offset));state.offset=packet.total;
            if(packet.entry)state.entry=packet.entry;
            if(packet.entry&&!state.wrapped){
              // Read-only public cells, independent of SearchAddon's line
              // cache. Require the same complete ASCII prefix and a genuine
              // isWrapped boundary; no text or API is replaced in the renderer.
              const prefix=packet.entry.prefixBeforeFirstResize;if(!/^[\x20-\x7e]+$/.test(prefix)||prefix.length<=terminal.cols)throw new Error('Wrap observer requires the declared full ASCII prefix longer than a row');
              const buffer=terminal.buffer.normal;let position;
              for(let row=0;row<buffer.length&&!position;row++)for(let column=0;column<terminal.cols&&!position;column++){
                const first=buffer.getLine(row)?.getCell(column);if(first?.getWidth()!==1||(first.getChars()||' ')!==prefix[0])continue;
                let y=row,x=column,index=0,crossed=false;
                while(index<prefix.length){
                  if(x===terminal.cols){y++;x=0;if(!buffer.getLine(y)?.isWrapped)break;crossed=true;}
                  const cell=buffer.getLine(y)?.getCell(x);if(cell?.getWidth()!==1||(cell.getChars()||' ')!==prefix[index])break;
                  x++;index++;
                }
                if(index===prefix.length&&crossed)position={start:{x:column,y:row},end:{x,y}};
              }
              if(position){
                if(unicode11&&terminal.unicode.activeVersion!=='11')throw new Error('Owned wrapped input did not use the selected actual provider');
                const proof={sourceSha256:packet.entry.sourceSha256,columns:terminal.cols,wrapped:true,position,fullAsciiPrefix:prefix,observation:'public-cells-with-real-isWrapped',observedBytes:state.offset,cursorX:terminal.buffer.normal.cursorX,cursorY:terminal.buffer.normal.cursorY,providerVersion:unicode11?terminal.unicode.activeVersion:undefined};
                const acknowledged=await fetch('/wrapped',{method:'POST',body:JSON.stringify(proof)});if(!acknowledged.ok)throw new Error(await acknowledged.text());state.wrapped=proof;
              }
            }
            await new Promise(resolve=>setTimeout(resolve,5));
          }
        })().catch(error=>{state.failure=String(error);});
      },{columns,unicode11:Boolean(unicode11)});
      const before=new Set(await readdir(actual));const log=await open(resolve(directory,`${columns}.log`),'wx');
      fixturePath=execFileSync(process.execPath,[resolve(owner,'scripts/native-input/acceptance/linux-peer.mjs'),root],{cwd:owner,encoding:'utf8'}).trim();
      runDirectory=resolve(root,'artifacts/tests/native-input/acceptance/scoped-ssh-runs',randomUUID());await mkdir(runDirectory,{recursive:true});const image=resolve(runDirectory,'actual-scoped-ssh-tests');await copyFile(binary,image);await chmod(image,0o700);assert.equal(await hash(image),binarySha256);
      child=spawn(resolve(owner,'artifacts/tests/native-input/acceptance/venv/bin/python'),['-B',resolve(owner,'scripts/native-input/acceptance/linux-run.py'),fixturePath],{cwd:owner,stdio:['ignore',log.fd,log.fd],env:{...process.env,...validation,SHELLSPAN_P3_SSH_TEST_IMAGE:image,SHELLSPAN_P3_SSH_PLANNED_OPERATIONS:'10',SHELLSPAN_P3_TEST_COLUMNS:String(columns),SHELLSPAN_P3_LIVE_GEOMETRY:'1'}});
      ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
      const deadline=Date.now()+5000;while(!active){const created=(await readdir(actual)).filter(name=>!before.has(name));assert(created.length<=1);if(created.length)active=resolve(actual,created[0]);else{assert(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,5));}}
      const exitCode=await ended;await log.close();
      await page.waitForFunction(()=>window.p3.failure||window.p3.offset>0);const raw=await readFile(resolve(active,'raw.bin'));
      await page.waitForFunction(length=>window.p3.failure||window.p3.offset===length,raw.length);
      const observed=await page.evaluate(async()=>{const s=window.p3;s.stopped=true;await s.done;s.terminal.selectAll();const all=s.terminal.getSelection();s.terminal.clearSelection();const found=s.entry?s.search.findNext(s.entry.source):false;const selected=s.terminal.getSelection();s.terminal.clearSelection();const providerBeforeClose=s.ordinaryUnicodeVersion===undefined?undefined:s.terminal.unicode.activeVersion;await s.display.closeAfterPendingOutput();return{failure:s.failure,wrapped:s.wrapped,geometryEvents:s.eventIndex,all,exactSourceCopy:!!s.entry&&all.includes(s.entry.source),exactSourceSearch:found&&selected===s.entry.source,selected,publicApisUnmodified:s.terminal.getSelection===s.original.selection&&s.terminal.buffer.normal.getLine===s.original.line&&s.terminal.open===s.original.open,displayRestored:s.terminal.options.reflowCursorLine===false,providerBeforeClose,providerRestored:s.ordinaryUnicodeVersion===undefined||(providerBeforeClose===s.ordinaryUnicodeVersion&&s.terminal.unicode.activeVersion===s.ordinaryUnicodeVersion)};});
      await page.screenshot({path:resolve(directory,`${columns}.png`)});if(binary)assert.equal(await hash(binary),binarySha256);
      const entry=JSON.parse(await readFile(resolve(active,'geometry.json'),'utf8'));const wire=(await readFile(resolve(active,'control.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);const length=Buffer.byteLength(entry.source);
      const fullProof=wire.some(message=>message.requestId==='prepare-3'&&message.payload.kind==='inputConfirmed'&&message.payload.sourceDigest===entry.sourceSha256&&message.payload.utf8Bytes===length&&message.payload.cursorUtf8Bytes===length&&message.payload.endUtf8Bytes===length);assert(fullProof);
      const tabSource="typeset P3_SSH_TABS=$'A\tB'; [[ $P3_SSH_TABS == $'A\tB' ]] && printf '%s%s\\n' P3-SSH- TABS",tabLength=Buffer.byteLength(tabSource),tabDigest=createHash('sha256').update(tabSource).digest('hex');
      const tabFullProof=wire.some(message=>message.requestId==='prepare-8'&&message.payload.kind==='inputConfirmed'&&message.payload.sourceDigest===tabDigest&&message.payload.utf8Bytes===tabLength&&message.payload.cursorUtf8Bytes===tabLength&&message.payload.endUtf8Bytes===tabLength);assert(tabFullProof);
      const cleanup=JSON.parse(await readFile(resolve(runDirectory,'run-result.json'),'utf8'));assert(cleanup.credentialDeleted&&cleanup.accountLocked&&!cleanup.cleanupErrors.length);
      results.push({columns,exitCode,evidence:active,fixturePath,runDirectory,actual:JSON.parse(await readFile(resolve(active,'result.json'),'utf8')),fullProof,tabFullProof,cleanup,observed});
    }finally{if(child?.exitCode===null)await ended;if(fixturePath)execFileSync(process.execPath,[resolve(owner,'scripts/native-input/acceptance/scoped-fixture-stop.mjs'),resolve(fixturePath,'../owner.json')],{cwd:owner,stdio:'pipe'});await page.close();active=undefined;}
  }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));assert.deepEqual(captureValidationSources(root),sources);assert.deepEqual(await installedRuntimeManifest(),runtime);assert.deepEqual(auditEditorResources(root,'linux-aarch64-glibc-2.36'),resourceAudit);await writeFile(resolve(directory,'result.json'),JSON.stringify({binarySha256,sourceCount:Object.keys(sources).length,runtime,results,...(experiment?{nativeAcceptance:false,formalPatchChanged:false,experimentDirectory:experiment.directory,candidateRuntimeSha256:experiment.artifacts['lib/xterm.js'],unicode11Asset:unicode11}:{} )},null,2));}
console.log(JSON.stringify({directory,cases:results.length}));
assert(results.length===4&&results.every(value=>value.exitCode===0&&value.actual.ok&&value.observed.wrapped&&!value.observed.failure&&value.observed.geometryEvents===7&&value.observed.exactSourceCopy&&value.observed.exactSourceSearch&&value.observed.publicApisUnmodified&&value.observed.displayRestored&&value.observed.providerRestored),'Actual live geometry, exact source copy/search or component/provider lifecycle failed; all original observations retained');
