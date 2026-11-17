// Compare genuine literal-control-character PTY rendering with ordinary ZLE.
// Expected requests never enter the renderer; only captured PTY bytes do.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium,webkit} from 'playwright';
import ts from 'typescript';
import {installedRuntimeManifest} from '../native-input-p0/formal-runtime.mjs';
import {captureValidationSources} from '../native-input-p2/frozen-validation.mjs';
import {artifactWorkspace} from '../artifact-paths.mjs';
const owner=resolve(import.meta.dirname,'../..'),input=resolve(process.argv[2]);
const root=artifactWorkspace(input);
const stage=JSON.parse(await readFile(resolve(root,'artifacts/tests/native-input-p3/candidate-stage.json'),'utf8'));
assert(stage.sealed&&stage.root===root);
const sourceMap=JSON.parse(await readFile(resolve(stage.directory,'sources.json'),'utf8'));
assert.deepEqual(captureValidationSources(root),sourceMap);
const scopedProvider=true;
const displayBinding=JSON.parse(await readFile(resolve(input,'verified-display-binding.json'),'utf8'));
assert.equal(displayBinding.unicodeVersion,'11');assert.equal(typeof displayBinding.ownedReflowCursorLine,'boolean');
const displaySource=await readFile(resolve(root,'src/lib/terminal/native-input-display.ts'),'utf8');
const displayJavaScript=ts.transpileModule(displaySource,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const geometry=JSON.parse(await readFile(resolve(input,'geometry.json'),'utf8'));
const corpus=JSON.parse(await readFile(resolve(input,'source-corpus.json'),'utf8')).filter(x=>x.literalLf||x.literalTab||x.literalCr);
assert.equal(corpus.length,3);assert(corpus.every(x=>x.actualFullInputProof));
const wire=(await readFile(resolve(input,'control.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
for(const entry of corpus)assert(wire.some(x=>x.requestId===`prepare-${entry.index}`&&x.payload.kind==='inputConfirmed'&&x.payload.sourceDigest===entry.sourceDigest&&x.payload.utf8Bytes===entry.utf8Bytes));
const directory=resolve(owner,'artifacts/tests/native-input-p3/scoped-character-browser',randomUUID());await mkdir(directory,{recursive:true});
const python=process.env.SHELLSPAN_P3_PEXPECT_PYTHON??'/Library/Frameworks/Python.framework/Versions/3.14/bin/python3';
const ordinaryCore=process.env.SHELLSPAN_P3_ORDINARY_CORE_PRODUCER;
const baselines=[];
for(const entry of corpus){
 const fixture=resolve(directory,`literal-${entry.index}`);await mkdir(fixture);
 await writeFile(resolve(fixture,'geometry.json'),JSON.stringify({source:entry.source,sourceSha256:entry.sourceDigest,columns:40,rows:30}));
 const log=execFileSync(python,['-B','scripts/native-input-p3/zle-baseline.py',fixture,...(ordinaryCore?['--reviewed-core-producer',ordinaryCore]:[])],{cwd:owner,encoding:'utf8',timeout:30000});
 await writeFile(resolve(fixture,'capture.log'),log);
 const children=await readdir(resolve(fixture,'ordinary-zle-baseline'));assert.equal(children.length,1);
 const actual=resolve(fixture,'ordinary-zle-baseline',children[0]);
 const result=JSON.parse(await readFile(resolve(actual,'result.json'),'utf8'));assert(result.ok&&result.actualBufferSha256===entry.sourceDigest&&result.sourceExecuted===false);
 // Python's standard expandtabs supplies the legal textual tab expansion at
 // the actual eleven-column prompt. CR follows ZLE's visible ^M convention.
 entry.expectedDisplayCopy=execFileSync(python,['-c','import sys; s=sys.stdin.read().replace(chr(13),"^M"); sys.stdout.write(("P3-NATIVE> "+s).expandtabs(8)[11:])'],{input:entry.source,encoding:'utf8'});
 baselines.push({entry,actual});
}
const runtime=await installedRuntimeManifest();
const candidatePath=process.env.SHELLSPAN_P3_CHARACTER_XTERM??resolve(runtime.directory,'lib/xterm.js');
const candidateBytes=await readFile(candidatePath);
assert.equal(createHash('sha256').update(candidateBytes).digest('hex'),runtime.artifacts['lib/xterm.js']);
const unicodePath=resolve(owner,'node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js');
const assets={'/xterm.js':[candidatePath,'application/javascript'],'/xterm.css':[resolve(owner,'node_modules/@xterm/xterm/css/xterm.css'),'text/css'],'/search.js':[resolve(owner,'node_modules/@xterm/addon-search/lib/addon-search.js'),'application/javascript'],'/webgl.js':[resolve(owner,'node_modules/@xterm/addon-webgl/lib/addon-webgl.js'),'application/javascript'],'/unicode.js':[unicodePath,'application/javascript']};
const server=createServer(async(req,res)=>{try{if(req.url==='/display.js'){res.setHeader('Content-Type','application/javascript');res.end(displayJavaScript);return;}const asset=assets[req.url];res.setHeader('Content-Type',asset?asset[1]:'text/html');res.end(asset?await readFile(asset[0]):'<!doctype html><link rel="stylesheet" href="/xterm.css"><div id="surface"></div><script src="/xterm.js"></script><script src="/search.js"></script><script src="/webgl.js"></script><script src="/unicode.js"></script>');}catch{res.writeHead(500).end();}});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const results=[];
try{
 for(const [engine,type]of[['chromium',chromium],['webkit',webkit]]){
  const browser=await type.launch({headless:true});
  try{for(const renderer of['dom','webgl'])for(const {entry,actual}of baselines){
   const observations=[];
   for(const mode of['ordinary','native']){
    const bytes=await readFile(resolve(mode==='ordinary'?actual:input,'raw.bin'));
    const page=await browser.newPage({viewport:{width:1000,height:700}});
    try{
     await page.goto(`http://127.0.0.1:${server.address().port}`);
     const observed=await page.evaluate(async({bytes,entry,geometry,mode,renderer,displayBinding})=>{
      const {attachNativeInputDisplay}=await import('/display.js');
      const term=new Terminal({cols:mode==='ordinary'?40:geometry.columns,rows:30,scrollback:20000,reflowCursorLine:false,allowProposedApi:true});if(mode==='native')term.loadAddon(new Unicode11Addon.Unicode11Addon());term.open(document.querySelector('#surface'));
      if(renderer==='webgl')term.loadAddon(new WebglAddon.WebglAddon());const search=new SearchAddon.SearchAddon();term.loadAddon(search);
      const original={selection:term.getSelection,line:term.buffer.normal.getLine,open:term.open},responses=[];term.onData(x=>responses.push(x));
      const originalProvider=term.unicode.activeVersion;
      const display=mode==='native'?attachNativeInputDisplay(term,displayBinding,{unicodeVersion:displayBinding.unicodeVersion}):undefined;const decoder=new TextDecoder('utf-8',{fatal:true});let offset=0;
      for(const event of[...(mode==='native'?geometry.resizeEvents:[]),{offset:bytes.length}]){await new Promise(done=>term.write(decoder.decode(Uint8Array.from(bytes.slice(offset,event.offset)),{stream:true}),done));offset=event.offset;if(event.columns)term.resize(event.columns,30);}
      // Each boundary token fits on its observed physical row in both cases;
      // ordinary ZLE's hard wrap does not prevent finding the same cell range.
      const prefix=entry.index===10?'[[ $? == 1 ]]':entry.index===11?'typeset -g P3_TABS=':'typeset -g P3_CR=';
      const tail=entry.index===10?' STATUS':entry.index===11?' TABS':' CR';
      const startFound=search.findPrevious(prefix),start=term.getSelectionPosition()?.start;
      const endFound=search.findNext(tail),end=term.getSelectionPosition()?.end;
      let copied,cells;
      if(start&&end){term.select(start.x,start.y,(end.y-start.y)*term.cols+end.x-start.x);copied=term.getSelection();cells=[];for(let row=start.y;row<=end.y;row++){const line=term.buffer.normal.getLine(row),from=row===start.y?start.x:0,to=row===end.y?end.x:term.cols;cells.push({wrapped:line.isWrapped,cells:Array.from({length:to-from},(_,i)=>{const cell=line.getCell(from+i);return{chars:cell.getChars(),width:cell.getWidth()};})});}}
      const apis=term.getSelection===original.selection&&term.buffer.normal.getLine===original.line&&term.open===original.open;
      const providerBeforeClose=term.unicode.activeVersion;if(display)await display.closeAfterPendingOutput();return{mode,startFound,endFound,start,end,copied,cells,publicApisUnmodified:apis,noInput:responses.length===0,displayRestored:term.options.reflowCursorLine===false,providerBeforeClose,providerRestored:providerBeforeClose===originalProvider&&term.unicode.activeVersion===originalProvider};
     },{bytes:[...bytes],entry,geometry,mode,renderer,displayBinding});
     await page.screenshot({path:resolve(directory,`${engine}-${renderer}-${entry.index}-${mode}.png`)});observations.push({rawSha256:createHash('sha256').update(bytes).digest('hex'),...observed});
    }finally{await page.close();}
   }
   const [ordinary,native]=observations;
   // A width-one empty terminal cell and a width-one real space have the
   // same visible character. Keep raw cells and their equality separately:
   // emitting real tab spaces is the behavior this acceptance must observe.
   const visible=rows=>rows?.map(row=>row.cells.map(cell=>({chars:cell.chars===''&&cell.width===1?' ':cell.chars,width:cell.width})));
   results.push({engine,renderer,index:entry.index,sourceDigest:entry.sourceDigest,expectedDisplayCopy:entry.expectedDisplayCopy,observations,sameCopy:ordinary.copied!==undefined&&ordinary.copied===native.copied,nativeLegalCopy:native.copied===entry.expectedDisplayCopy,sameCells:ordinary.cells!==undefined&&JSON.stringify(ordinary.cells.map(x=>x.cells))===JSON.stringify(native.cells?.map(x=>x.cells)),sameVisibleCells:ordinary.cells!==undefined&&JSON.stringify(visible(ordinary.cells))===JSON.stringify(visible(native.cells))});
  }}finally{await browser.close();}
 }
}finally{
 await new Promise(done=>server.close(done));assert.deepEqual(captureValidationSources(root),sourceMap);assert.deepEqual(await installedRuntimeManifest(),runtime);
 await writeFile(resolve(directory,'result.json'),JSON.stringify({input,scopedProvider,displayBinding,runtime,ordinaryCoreProducer:ordinaryCore,sourceCount:Object.keys(sourceMap).length,scope:'actual ordinary quoted-input vs actual NIP literal LF/Tab/CR PTY public cells and selection; no native-App claim',results},null,2));
}
console.log(JSON.stringify({directory,cases:results.length,legalCopy:results.filter(x=>x.nativeLegalCopy).length,rawCells:results.filter(x=>x.sameCells).length,visibleCells:results.filter(x=>x.sameVisibleCells).length}));
assert(results.length===12&&results.every(x=>x.nativeLegalCopy&&x.sameVisibleCells&&x.observations.every(y=>y.startFound&&y.endFound&&y.publicApisUnmodified&&y.noInput&&y.displayRestored&&y.providerRestored)),'Literal-control-character visible cells, legal copy or provider restoration requirement failed; actual observations retained');
