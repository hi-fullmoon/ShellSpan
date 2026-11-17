// Genuine headless DOM/xterm focus and filesystem/HTTP checks. No native/model receipts.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'vite';
import {chromium,webkit} from 'playwright';
import ts from 'typescript';
import {attachFocusTraceChannel} from '../../../../scripts/native-input-p3/focus-trace-channel.mjs';
const directory=resolve('artifacts/tests/native-input-p3/focus-trace-checks',randomUUID());await mkdir(directory,{recursive:true,mode:0o700});
const source=await readFile(new URL('./native-focus-trace.ts',import.meta.url),'utf8');
const channelSource=await readFile('scripts/native-input-p3/focus-trace-channel.mjs');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const module=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const tokens={chromium:randomUUID(),webkit:randomUUID()},results=[];
for(const name of Object.keys(tokens))await mkdir(resolve(directory,name),{mode:0o700});
const server=await createServer({configFile:false,root:directory,logLevel:'silent',server:{host:'127.0.0.1',port:0},plugins:[{
 name:'actual-passive-focus-checks',configureServer(server){
  for(const[name,token]of Object.entries(tokens))attachFocusTraceChannel(server,token,resolve(directory,name));
  server.middlewares.use((request,response,next)=>{void(async()=>{
   if(request.url==='/probe.js'){response.setHeader('Content-Type','application/javascript');response.end(module);}
   else if(request.url==='/xterm.js'){response.setHeader('Content-Type','application/javascript');response.end(await readFile('node_modules/@xterm/xterm/lib/xterm.js'));}
   else if(request.url==='/xterm.css'){response.setHeader('Content-Type','text/css');response.end(await readFile('node_modules/@xterm/xterm/css/xterm.css'));}
   else if(request.url==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><link rel="stylesheet" href="/xterm.css"><div data-composer-editor contenteditable="true" id="editor" style="width:500px;height:80px"></div><div id="terminal"></div><input id="other"><script src="/xterm.js"></script>');}
   else next();
  })().catch(error=>{response.writeHead(500).end(error.message);});});
 }
}]});
await server.listen();const url=`http://127.0.0.1:${server.httpServer.address().port}`;
try{for(const[name,launcher]of[['chromium',chromium],['webkit',webkit]]){
 const browser=await launcher.launch({headless:true});try{
  const page=await browser.newPage({viewport:{width:1000,height:700}});await page.goto(url);
  const privateText=`never-record-${randomUUID()}`;await page.locator('#editor').click();await page.keyboard.type(privateText);
  await page.evaluate(async privateText=>{
   const editor=document.querySelector('#editor');editor.setAttribute('aria-label',privateText);editor.setAttribute('role','textbox');
   document.querySelector('#other').setAttribute('role',privateText);
   const {createNativeFocusTrace}=await import('/probe.js');
   const terminal=new Terminal({cols:60,rows:8});terminal.open(document.querySelector('#terminal'));
   const original={focus:HTMLElement.prototype.focus,blur:HTMLElement.prototype.blur,terminalFocus:terminal.focus};
   const context=()=>({monitoring:true,stage:'actual-dom-check',section:'workbench',activeSessionId:null,expectedSessionId:null,
    focusEnabled:false,focusTarget:null,draftLength:editor.innerText.length,draftMatches:editor.innerText===privateText});
   window.probe={editor,terminal,original,limits:0,context};
   window.probe.trace=createNativeFocusTrace({editor:()=>editor,context,onLimit:()=>window.probe.limits++});
   window.probe.trace.arm();
  },privateText);
  await page.locator('#other').click();
  await page.evaluate(()=>{
   const s=window.probe;if(document.activeElement===s.editor)throw Error('Actual focus did not leave the editor');
   s.trace.check('store-app',new Error('Observed store transition').stack);
   s.trace.violate('focusin');
  });
  await page.locator('#editor').click();
  await page.evaluate(async()=>{
   const s=window.probe;s.editor.contentEditable='false';s.editor.contentEditable='true';
   const parent=s.editor.parentNode;parent.removeChild(s.editor);parent.insertBefore(s.editor,parent.firstChild);
   await new Promise(resolve=>requestAnimationFrame(resolve));s.terminal.focus();
   if(document.activeElement!==s.terminal.textarea)throw Error('Actual xterm input did not receive focus');
   s.trace.violate('focusin');await new Promise(resolve=>requestAnimationFrame(resolve));
  });
  const report=await page.evaluate(()=>{
   const s=window.probe,report=s.trace.finish('failure-before-cleanup');
   if(HTMLElement.prototype.focus!==s.original.focus||HTMLElement.prototype.blur!==s.original.blur||s.terminal.focus!==s.original.terminalFocus)throw Error('Public focus methods were replaced');
   return report;
  });
  assert(!report.overflow&&report.firstViolation.trigger==='focusin');
  assert(report.firstViolation.snapshot.active.tag==='INPUT'&&!report.firstViolation.snapshot.active.composer);
  assert.equal(report.firstViolation.snapshot.active.role,'other');
  assert(report.states.some(s=>s.editor?.role==='textbox'));
  assert(report.entries.some(e=>e.kind==='dom:focusout'));
  assert(report.entries.some(e=>e.kind==='check'&&e.data?.trigger==='store-app'
    &&typeof e.data.stack==='string'&&e.data.stack.length>0&&e.data.stack.length<=4096));
  assert(report.entries.some(e=>e.kind==='mutation:childList'&&e.data.removedEditor));
  assert(report.entries.some(e=>e.kind==='mutation:attributes'&&e.data.attribute==='contenteditable'));
  assert(report.states.some(s=>s.active?.terminal));
  const encoded=JSON.stringify(report);assert(!encoded.includes(privateText),'Passive diagnostic retained text or an aria-label');
  const endpoint=`${url}/__native-p3-focus-trace/${tokens[name]}`;
  assert.equal((await fetch(endpoint)).status,500);
  const saved=await fetch(endpoint,{method:'POST',body:encoded});assert(saved.ok);const receipt=await saved.json();
  const file=resolve(directory,name,receipt.file),stored=await readFile(file);
  assert.equal(receipt.sha256,createHash('sha256').update(stored).digest('hex'));assert.equal(stored.toString(),encoded);
  if(process.platform!=='win32')assert.equal((await stat(file)).mode&0o077,0);
  assert.equal((await fetch(endpoint,{method:'POST',body:encoded})).status,500);
  assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),receipt.sha256);
  const limited=await page.evaluate(async()=>{
   const s=window.probe;let count=0;
   const t=(await import('/probe.js')).createNativeFocusTrace({editor:()=>s.editor,context:s.context,maxEntries:3,onLimit:()=>count++});
   s.editor.focus();s.terminal.focus();s.editor.focus();await new Promise(resolve=>requestAnimationFrame(resolve));
   return{report:t.finish('failure-before-cleanup'),count};
  });
  assert(limited.report.overflow&&limited.count===1&&limited.report.entries.length<=3);
  results.push({engine:name,entries:report.entries.length,states:report.states.length,firstViolationFrozen:true,contentAbsent:true,
   actualMutationObserved:true,safeRoleFacts:true,publicMethodsUnmodified:true,oneShotPrivateFile:true,limitFailsExplicitly:true});
  await page.close();
 }finally{await browser.close();}
}}finally{await server.close();assert.equal(await readFile(new URL('./native-focus-trace.ts',import.meta.url),'utf8'),source);assert.equal(sha(await readFile('scripts/native-input-p3/focus-trace-channel.mjs')),sha(channelSource));await writeFile(resolve(directory,'result.json'),JSON.stringify({scope:'Actual headless DOM/xterm and HTTP/file observer checks only; no Tauri window/model/native acceptance',sourceSha256:sha(source),channelSha256:sha(channelSource),results},null,2));}
assert.equal(results.length,2);process.stdout.write(JSON.stringify({directory,engines:results.length})+'\n');
