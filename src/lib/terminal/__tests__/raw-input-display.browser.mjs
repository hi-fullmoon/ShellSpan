// Explicit real-browser regression using supplied actual macOS App captures.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {chromium,webkit} from 'playwright';
import ts from 'typescript';

assert.equal(process.platform,'darwin','This explicit regression requires actual macOS browser/platform behavior');
const root=resolve(import.meta.dirname,'../../../..'),paths=process.argv.slice(2);assert.equal(paths.length,3,'Supply actual raw Bash, raw Zsh and native capture directories');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),read=p=>JSON.parse(readFileSync(p,'utf8'));
const captures=paths.map(path=>{
 const directory=resolve(path);assert(directory.includes('/artifacts/'));
 const evidence=read(resolve(directory,'native-webview-evidence.json'));
 const traceBytes=readFileSync(resolve(directory,'native-display-trace.json')),visibleBytes=readFileSync(resolve(directory,'native-display-visible-output.utf8'));
 assert.equal(sha(traceBytes),evidence.uploads.trace.sha256);assert.equal(sha(visibleBytes),evidence.uploads['visible-output'].sha256);
 const trace=JSON.parse(traceBytes);assert(trace.replayable);assert.equal(evidence.modelCalls,0);
 return{directory,evidence,trace,traceSha256:sha(traceBytes),visible:new TextDecoder('utf8',{fatal:true}).decode(visibleBytes),visibleSha256:sha(visibleBytes)};
});
const raws=captures.filter(item=>item.evidence.initial.session.inputMode==='raw'),native=captures.find(item=>item.evidence.initial.session.inputMode==='native-inline');assert.equal(raws.length,2);assert(native);
const source=readFileSync(resolve(root,'src/lib/terminal/raw-input-display.ts'),'utf8'),platform=readFileSync(resolve(root,'src/lib/platform.ts'),'utf8');
const transpile=text=>ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const assets={'/xterm.js':resolve(root,'node_modules/@xterm/xterm/lib/xterm.js'),'/xterm.css':resolve(root,'node_modules/@xterm/xterm/css/xterm.css'),'/webgl.js':resolve(root,'node_modules/@xterm/addon-webgl/lib/addon-webgl.js'),'/unicode.mjs':resolve(root,'node_modules/@xterm/addon-unicode11/lib/addon-unicode11.mjs')};
const imports={'@xterm/addon-unicode11':'/unicode.mjs','@/lib/platform':'/platform.js'};
const server=createServer((request,response)=>{
 if(request.url==='/raw.js'||request.url==='/platform.js'){response.setHeader('Content-Type','application/javascript');response.end(transpile(request.url==='/raw.js'?source:platform));return;}
 const file=assets[request.url];response.setHeader('Content-Type',file?(file.endsWith('.css')?'text/css':'application/javascript'):'text/html');response.end(file?readFileSync(file):'<!doctype html><link rel="stylesheet" href="/xterm.css"><div id="surface"></div><script type="importmap">'+JSON.stringify({imports})+'</script><script src="/xterm.js"></script><script src="/webgl.js"></script>');
});
const output=resolve(root,'artifacts/tests/raw-input-display',randomUUID());mkdirSync(output,{recursive:true,mode:0o700});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const results=[];
try{for(const [engine,launcher]of [['chromium',chromium],['webkit',webkit]]){
 const browser=await launcher.launch({headless:true});
 try{for(const renderer of ['default','webgl'])for(const item of raws){
  const page=await browser.newPage({viewport:{width:1480,height:920}});
  try{
   await page.goto('http://127.0.0.1:'+server.address().port);
   const result=await page.evaluate(async({initial,ptyInfo,nativeInfo,trace,visible,firstInput,renderer})=>{
    const {attachRawInputDisplay}=await import('/raw.js');let assertions=0;const check=(value,message)=>{assertions++;if(!value)throw Error(message);};
    const t=new Terminal({...initial.options,cols:initial.columns,rows:initial.rows,allowProposedApi:true});t.open(document.querySelector('#surface'));if(renderer==='webgl')t.loadAddon(new WebglAddon.WebglAddon());
    const original={write:t.write,resize:t.resize,select:t.select,getSelection:t.getSelection,line:t.buffer.normal.getLine},baseline=t.unicode.activeVersion;
    check(attachRawInputDisplay(t,nativeInfo)===undefined&&t.unicode.activeVersion===baseline,'Native metadata acquired a raw scope');
    check(attachRawInputDisplay(t,undefined)===undefined,'Absent transport acquired a display scope');
    const before=JSON.stringify(ptyInfo),scope=attachRawInputDisplay(t,ptyInfo);check(scope&&t.unicode.activeVersion==='11','Actual local macOS raw transport did not select Unicode 11');
    check(ptyInfo.inputMode==='raw'&&!ptyInfo.nativeDisplayBinding,'Scope acquired a native binding');
    const outputs=trace.events.filter(event=>event.type==='output');let outputCount=0,pendingParsed=false,parsedWithOwnedVersion=false;
    for(const event of trace.events){
     if(event.type==='output'){
      const data=visible.slice(event.offset,event.offset+event.characters);outputCount++;
      if(outputCount===outputs.length)t.write(data,()=>{pendingParsed=true;parsedWithOwnedVersion=t.unicode.activeVersion==='11';});
      else await new Promise(done=>t.write(data,done));
     }else if(event.type==='resize'){await new Promise(done=>t.write('',done));t.resize(event.columns,event.rows);}
     else check(event.type==='checkpoint','Unexpected raw capture action');
    }
    await new Promise(done=>t.write('',done));check(pendingParsed&&parsedWithOwnedVersion,'Original output was not drained with its owned width provider');
    await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
    t.selectAll();const copied=t.getSelection();t.clearSelection();
    const prefix=firstInput.slice(0,firstInput.indexOf('RAW_'));check(copied.includes(prefix),'Actual original ordinary source prefix was erased');
    scope.dispose();check(t.unicode.activeVersion===baseline,'Ordered close did not restore original provider');
    t.selectAll();check(t.getSelection()===copied,'Provider restoration rewrote source/history output');t.clearSelection();
    const successor=attachRawInputDisplay(t,ptyInfo);scope.dispose();check(t.unicode.activeVersion==='11','Retired scope changed the successor');
    t.unicode.activeVersion=baseline;successor.dispose();check(t.unicode.activeVersion===baseline,'Explicit external provider change was overwritten');
    check(JSON.stringify(ptyInfo)===before,'Display scope mutated capability metadata');
    check(t.write===original.write&&t.resize===original.resize&&t.select===original.select&&t.getSelection===original.getSelection&&t.buffer.normal.getLine===original.line,'Display installed a public API override');
    const result={assertions,baseline,after:t.unicode.activeVersion,sourcePrefixPresent:true,metadataUnchanged:true,publicApisUnmodified:true,renderer,scope:'Actual captured bytes only; system ZLE hard-wrap/compound-emoji semantics are not declared passed'};t.dispose();return result;
   },{initial:item.trace.initial,ptyInfo:item.evidence.session.ptyInfo,nativeInfo:native.evidence.session.ptyInfo,trace:item.trace,visible:item.visible,firstInput:item.evidence.input[0].data,renderer});
   assert(result.assertions>=12);results.push({engine,version:browser.version(),renderer,directory:item.directory,...result});
  }finally{await page.close();}
 }}finally{await browser.close();}
}}finally{await new Promise(done=>server.close(done));}
assert.equal(results.length,8);for(const item of captures){assert.equal(sha(readFileSync(resolve(item.directory,'native-display-trace.json'))),item.traceSha256);assert.equal(sha(readFileSync(resolve(item.directory,'native-display-visible-output.utf8'))),item.visibleSha256);}
writeFileSync(resolve(output,'result.json'),JSON.stringify({at:new Date().toISOString(),sourceSha256:sha(Buffer.from(source)),captures:captures.map(item=>({directory:item.directory,traceSha256:item.traceSha256,visibleSha256:item.visibleSha256})),results,scope:'Real browser/terminal scoped-width regression with actual prior App bytes. No Shell source execution, parser changes, synthesized output, source normalization, Windows execution or native App acceptance credit.'},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,combinations:results.length,assertions:results.reduce((sum,row)=>sum+row.assertions,0)}));
