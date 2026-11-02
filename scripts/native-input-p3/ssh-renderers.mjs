// Replay the four real SSH/resize captures on browser/rendering engines. This
// adds display coverage without claiming four more native executions.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
import {chromium,webkit} from 'playwright';
import {captureValidationSources} from '../native-input-p2/frozen-validation.mjs';
import {installedRuntimeManifest} from '../native-input-p0/formal-runtime.mjs';
const owner=resolve(import.meta.dirname,'../..'),input=resolve(process.argv[2]),native=JSON.parse(await readFile(input,'utf8'));
assert.equal(native.results.length,4);assert(native.results.every(x=>x.actual.ok&&x.fullProof&&x.tabFullProof));
const root=resolve(input,'../../../..'),stage=JSON.parse(await readFile(resolve(root,'.native-input-p3/candidate-stage.json'),'utf8'));assert(stage.sealed&&stage.root===root);
const sources=captureValidationSources(root);assert.deepEqual(sources,JSON.parse(await readFile(resolve(stage.directory,'sources.json'),'utf8')));
const displayPath=resolve(root,'src/lib/terminal/native-input-display.ts'),displayBytes=await readFile(displayPath),displayHash=createHash('sha256').update(displayBytes).digest('hex');
const display=ts.transpileModule(displayBytes.toString('utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const formal=await installedRuntimeManifest(),experiment=JSON.parse(await readFile(resolve(owner,'.native-input-p3/xterm-el-experiment/8479c9d8-b3fd-400d-ac10-83b375ec8168/result.json'),'utf8'));
const xterm=resolve(experiment.source,'lib/xterm.js'),unicode=resolve(owner,'.native-input-p3/root-unicode11/node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js');
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');assert.equal(await hash(xterm),native.candidateRuntimeSha256);const unicodeHash=await hash(unicode);
const tabSource="typeset P3_SSH_TABS=$'A\tB'; [[ $P3_SSH_TABS == $'A\tB' ]] && printf '%s%s\\n' P3-SSH- TABS";
const tabDisplay=execFileSync('/Library/Frameworks/Python.framework/Versions/3.14/bin/python3',['-c','import sys; sys.stdout.write(("P3-SSH> "+sys.stdin.read()).expandtabs(8)[8:])'],{input:tabSource,encoding:'utf8'});
const directory=resolve(owner,'.native-input-p3/ssh-renderers',randomUUID());await mkdir(directory,{recursive:true});
const assets={'/xterm.js':[xterm,'application/javascript'],'/xterm.css':[resolve(owner,'node_modules/@xterm/xterm/css/xterm.css'),'text/css'],'/search.js':[resolve(owner,'node_modules/@xterm/addon-search/lib/addon-search.js'),'application/javascript'],'/webgl.js':[resolve(owner,'node_modules/@xterm/addon-webgl/lib/addon-webgl.js'),'application/javascript'],'/unicode.js':[unicode,'application/javascript']};
const server=createServer(async(req,res)=>{try{if(req.url==='/display.js'){res.setHeader('Content-Type','application/javascript');res.end(display);return;}const asset=assets[req.url];res.setHeader('Content-Type',asset?asset[1]:'text/html');res.end(asset?await readFile(asset[0]):'<!doctype html><link rel="stylesheet" href="/xterm.css"><div id="surface"></div><script src="/xterm.js"></script><script src="/search.js"></script><script src="/webgl.js"></script><script src="/unicode.js"></script>');}catch{res.writeHead(500).end();}});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const results=[];
try{for(const[engine,type]of[['chromium',chromium],['webkit',webkit]]){
 const browser=await type.launch({headless:true});
 try{for(const renderer of['dom','webgl'])for(const row of native.results){
  const entry=JSON.parse(await readFile(resolve(row.evidence,'geometry.json'),'utf8')),bytes=await readFile(resolve(row.evidence,'raw.bin'));assert.equal(entry.resizeEvents.length,7);
  const wire=(await readFile(resolve(row.evidence,'control.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),digest=createHash('sha256').update(entry.source).digest('hex');assert.equal(digest,entry.sourceSha256);
  assert(wire.some(x=>x.requestId==='prepare-3'&&x.payload.kind==='inputConfirmed'&&x.payload.sourceDigest===digest&&x.payload.utf8Bytes===Buffer.byteLength(entry.source)&&x.payload.cursorUtf8Bytes===x.payload.utf8Bytes&&x.payload.endUtf8Bytes===x.payload.utf8Bytes));
  const page=await browser.newPage({viewport:{width:1500,height:700}});
  try{await page.goto(`http://127.0.0.1:${server.address().port}`);
   const observed=await page.evaluate(async({entry,bytes,renderer,tabDisplay})=>{
    const{attachNativeInputDisplay,NATIVE_INPUT_DISPLAY}=await import('/display.js');const term=new Terminal({cols:entry.columns,rows:entry.rows,scrollback:20000,reflowCursorLine:false,allowProposedApi:true});term.loadAddon(new Unicode11Addon.Unicode11Addon());term.open(document.querySelector('#surface'));if(renderer==='webgl')term.loadAddon(new WebglAddon.WebglAddon());const search=new SearchAddon.SearchAddon();term.loadAddon(search);
    const original={selection:term.getSelection,line:term.buffer.normal.getLine,open:term.open},responses=[];term.onData(x=>responses.push(x));const ordinary=term.unicode.activeVersion,display=attachNativeInputDisplay(term,NATIVE_INPUT_DISPLAY,{unicodeVersion:'11'}),decoder=new TextDecoder('utf-8',{fatal:true});let offset=0,ownedAtResize;
    for(const event of[...entry.resizeEvents,{offset:bytes.length}]){while(offset<event.offset){const end=Math.min(event.offset,offset+97);await new Promise(done=>term.write(decoder.decode(Uint8Array.from(bytes.slice(offset,end)),{stream:true}),done));offset=end;}if(event.columns){if(ownedAtResize===undefined)ownedAtResize=term.unicode.activeVersion;term.resize(event.columns,entry.rows);}}
    term.selectAll();const copied=term.getSelection();term.clearSelection();const found=search.findNext(entry.source),selected=term.getSelection();term.clearSelection();const before=term.unicode.activeVersion,reflowBefore=term.options.reflowCursorLine;await display.closeAfterPendingOutput();
    return{ordinary,ownedAtResize,providerBeforeDispose:before,providerAfterDispose:term.unicode.activeVersion,reflowBeforeDispose:reflowBefore,reflowAfterDispose:term.options.reflowCursorLine,exactCopy:copied.includes(entry.source),exactSearch:found&&selected===entry.source,legalTabCopy:copied.includes(tabDisplay),publicApisUnmodified:term.getSelection===original.selection&&term.buffer.normal.getLine===original.line&&term.open===original.open,noInput:responses.length===0};
   },{entry,bytes:[...bytes],renderer,tabDisplay});
   results.push({engine,renderer,columns:entry.columns,evidence:row.evidence,rawSha256:createHash('sha256').update(bytes).digest('hex'),...observed});
   if(!observed.exactCopy||!observed.exactSearch||!observed.legalTabCopy)await page.screenshot({path:resolve(directory,`${engine}-${renderer}-${entry.columns}-failure.png`)});
  }finally{await page.close();}
 }}finally{await browser.close();}
}}finally{await new Promise(done=>server.close(done));assert.deepEqual(captureValidationSources(root),sources);assert.equal(await hash(displayPath),displayHash);assert.equal(await hash(xterm),native.candidateRuntimeSha256);assert.equal(await hash(unicode),unicodeHash);assert.deepEqual(await installedRuntimeManifest(),formal);await writeFile(resolve(directory,'result.json'),JSON.stringify({input,root,displayHash,xtermHash:native.candidateRuntimeSha256,unicodeHash,sourceCount:Object.keys(sources).length,scope:'same real SSH PTY/geometry/full-proof captures; replay only, no new native/App executions',results},null,2));}
console.log(JSON.stringify({directory,cases:results.length,passed:results.filter(x=>x.exactCopy&&x.exactSearch&&x.legalTabCopy&&x.providerBeforeDispose==='6'&&x.providerAfterDispose==='6'&&x.publicApisUnmodified&&x.noInput).length}));assert.equal(results.length,16);assert(results.every(x=>x.ordinary==='6'&&x.ownedAtResize==='11'&&x.providerBeforeDispose==='6'&&x.providerAfterDispose==='6'&&!x.reflowBeforeDispose&&!x.reflowAfterDispose&&x.exactCopy&&x.exactSearch&&x.legalTabCopy&&x.publicApisUnmodified&&x.noInput));
