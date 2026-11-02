// New display code against exact real EOF receipts from the same native/Core
// sources. This replay does not claim a fresh App/Broker/native execution.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import ts from 'typescript';
import {chromium,webkit} from 'playwright';
import {installedRuntimeManifest} from '../native-input-p0/formal-runtime.mjs';
import {captureValidationSources} from '../native-input-p2/frozen-validation.mjs';
const owner=resolve(import.meta.dirname,'../..'),root=resolve(process.argv[2]),input=resolve(process.argv[3]),nativeRoot=resolve(input,'../..');
const stage=JSON.parse(await readFile(resolve(root,'.native-input-p3/candidate-stage.json'),'utf8')),nativeStage=JSON.parse(await readFile(resolve(nativeRoot,'.native-input-p3/candidate-stage.json'),'utf8'));
assert(stage.sealed&&nativeStage.sealed);assert.equal(stage.coreSha256,nativeStage.coreSha256);
const sources=captureValidationSources(root),nativeSources=captureValidationSources(nativeRoot);
assert.deepEqual(sources,JSON.parse(await readFile(resolve(stage.directory,'sources.json'),'utf8')));assert.deepEqual(nativeSources,JSON.parse(await readFile(resolve(nativeStage.directory,'sources.json'),'utf8')));
for(const path of ['src-tauri/native-input-editors/src/ffi.rs','src-tauri/native-input-editors/zle.c','src-tauri/native-input-editors/zle.zsh','src-tauri/src/terminal_command/local.rs','src-tauri/src/terminal_command/zle_tests.rs'])assert.equal(sources[path],nativeSources[path]);
const names=await readdir(input);assert.equal(names.length,14);
const displayPath=resolve(root,'src/lib/terminal/native-input-display.ts'),displayBytes=await readFile(displayPath),displaySha256=createHash('sha256').update(displayBytes).digest('hex');
const display=ts.transpileModule(displayBytes.toString('utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const runtime=await installedRuntimeManifest(),experiment=JSON.parse(await readFile(resolve(owner,'.native-input-p3/xterm-el-experiment/8479c9d8-b3fd-400d-ac10-83b375ec8168/result.json'),'utf8'));
const xterm=resolve(experiment.source,'lib/xterm.js'),unicode=resolve(owner,'.native-input-p3/root-unicode11/node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js');
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');assert.equal(await hash(xterm),experiment.artifacts['lib/xterm.js']);const unicodeSha256=await hash(unicode);
const directory=resolve(owner,'.native-input-p3/scoped-provider-eof',randomUUID());await mkdir(directory,{recursive:true});
const assets={'/xterm.js':[xterm,'application/javascript'],'/xterm.css':[resolve(owner,'node_modules/@xterm/xterm/css/xterm.css'),'text/css'],'/webgl.js':[resolve(owner,'node_modules/@xterm/addon-webgl/lib/addon-webgl.js'),'application/javascript'],'/unicode.js':[unicode,'application/javascript']};
const server=createServer(async(req,res)=>{try{if(req.url==='/display.js'){res.setHeader('Content-Type','application/javascript');res.end(display);return;}const asset=assets[req.url];res.setHeader('Content-Type',asset?asset[1]:'text/html');res.end(asset?await readFile(asset[0]):'<!doctype html><link rel="stylesheet" href="/xterm.css"><div id="surface"></div><script src="/xterm.js"></script><script src="/webgl.js"></script><script src="/unicode.js"></script>');}catch{res.writeHead(500).end();}});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const results=[];
try{for(const[engine,type]of[['chromium',chromium],['webkit',webkit]]){
 const browser=await type.launch({headless:true});
 try{for(const renderer of['dom','webgl'])for(const name of names){
  const evidence=resolve(input,name),native=JSON.parse(await readFile(resolve(evidence,'result.json'),'utf8'));assert(native.ok);
  const raw=await readFile(resolve(evidence,'raw.bin')),page=await browser.newPage({viewport:{width:1100,height:650}});
  try{await page.goto(`http://127.0.0.1:${server.address().port}`);
   const observed=await page.evaluate(async({bytes,renderer})=>{
    const{attachNativeInputDisplay,NATIVE_INPUT_DISPLAY}=await import('/display.js');
    const term=new Terminal({cols:100,rows:30,scrollback:10000,reflowCursorLine:false,allowProposedApi:true});term.loadAddon(new Unicode11Addon.Unicode11Addon());term.open(document.querySelector('#surface'));if(renderer==='webgl')term.loadAddon(new WebglAddon.WebglAddon());
    const original={selection:term.getSelection,line:term.buffer.normal.getLine,open:term.open},responses=[];term.onData(x=>responses.push(x));
    const before=term.unicode.activeVersion,display=attachNativeInputDisplay(term,NATIVE_INPUT_DISPLAY,{unicodeVersion:'11'});
    await new Promise(done=>term.write(Uint8Array.from(bytes),done));const providerBeforeDispose=term.unicode.activeVersion,reflowBeforeDispose=term.options.reflowCursorLine;
    await display.closeAfterPendingOutput();return{ordinaryProvider:before,providerBeforeDispose,reflowBeforeDispose,providerAfterDispose:term.unicode.activeVersion,reflowAfterDispose:term.options.reflowCursorLine,publicApisUnmodified:term.getSelection===original.selection&&term.buffer.normal.getLine===original.line&&term.open===original.open,responses};
   },{bytes:[...raw],renderer});
   results.push({engine,renderer,evidence,phase:native.phase,rawSha256:createHash('sha256').update(raw).digest('hex'),...observed});
  }finally{await page.close();}
 }}finally{await browser.close();}
}}finally{await new Promise(done=>server.close(done));assert.deepEqual(captureValidationSources(root),sources);assert.deepEqual(captureValidationSources(nativeRoot),nativeSources);assert.deepEqual(await installedRuntimeManifest(),runtime);assert.equal(await hash(displayPath),displaySha256);assert.equal(await hash(xterm),experiment.artifacts['lib/xterm.js']);assert.equal(await hash(unicode),unicodeSha256);
 await writeFile(resolve(directory,'result.json'),JSON.stringify({root,input,displaySha256,coreSha256:stage.coreSha256,xtermSha256:experiment.artifacts['lib/xterm.js'],unicodeSha256,scope:'real EOF PTY from identical native sources/Core; provider/reflow restored before disposal; replay only, no full same-source App/Broker acceptance',results},null,2));}
console.log(JSON.stringify({directory,cases:results.length,passed:results.filter(x=>x.providerBeforeDispose==='6'&&!x.reflowBeforeDispose&&x.providerAfterDispose==='6'&&!x.reflowAfterDispose&&x.publicApisUnmodified&&!x.responses.length).length}));
assert.equal(results.length,56);assert(results.every(x=>x.ordinaryProvider==='6'&&x.providerBeforeDispose==='6'&&!x.reflowBeforeDispose&&x.providerAfterDispose==='6'&&!x.reflowAfterDispose&&x.publicApisUnmodified&&!x.responses.length));
