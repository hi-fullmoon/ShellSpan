import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {chromium,webkit} from 'playwright';
import {displayModuleJavaScript,installedRuntimeManifest} from '../native-input-p0/formal-runtime.mjs';
import {captureValidationSources} from '../native-input-p2/frozen-validation.mjs';
const root=resolve(import.meta.dirname,'../..');
const inputs=process.argv.slice(2).map(path=>resolve(path));assert(inputs.length>0);
const sources=captureValidationSources(root);const installed=await installedRuntimeManifest();
const directory=resolve(root,'artifacts/tests/native-input-p3/browser',randomUUID());await mkdir(directory,{recursive:true});
const assets={'/xterm.js':['node_modules/@xterm/xterm/lib/xterm.js','application/javascript'],
  '/xterm.css':['node_modules/@xterm/xterm/css/xterm.css','text/css'],
  '/webgl.js':['node_modules/@xterm/addon-webgl/lib/addon-webgl.js','application/javascript'],
  '/unicode11.js':['node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js','application/javascript'],
  '/search.js':['node_modules/@xterm/addon-search/lib/addon-search.js','application/javascript']};
const server=createServer(async(request,response)=>{
  try{
    if(request.url==='/display.js'){response.setHeader('Content-Type','application/javascript');response.end(await displayModuleJavaScript());return;}
    const asset=assets[request.url];response.setHeader('Content-Type',asset?asset[1]:'text/html');
    response.end(asset?await readFile(resolve(root,asset[0])):'<!doctype html><link rel="stylesheet" href="/xterm.css"><div id="surface"></div><script src="/xterm.js"></script><script src="/webgl.js"></script><script src="/search.js"></script><script src="/unicode11.js"></script>');
  }catch{response.writeHead(500).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const results=[];
try{
  for(const [engine,type]of[['chromium',chromium],['webkit',webkit]]){
    const browser=await type.launch({headless:true});
    try{for(const renderer of['dom','webgl'])for(const input of inputs){
      const entry=JSON.parse(await readFile(resolve(input,'geometry.json'),'utf8'));
      const outcome=JSON.parse(await readFile(resolve(input,'result.json'),'utf8'));assert(outcome.ok);
      const bytes=await readFile(resolve(input,'raw.bin'));
      const bindingBytes=await readFile(resolve(input,'verified-display-binding.json'));
      const binding=JSON.parse(bindingBytes.toString('utf8'));
      assert(binding.protocol==='shellspan.native-input'&&binding.inputMode==='native-inline'&&binding.unicodeVersion==='11','Actual captured ZLE display binding is required');
      const wire=(await readFile(resolve(input,'control.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
      const digest=createHash('sha256').update(entry.source).digest('hex');assert.equal(digest,entry.sourceSha256);
      assert(wire.some(message=>message.payload.kind==='inputConfirmed'&&message.payload.sourceDigest===digest&&
        message.payload.utf8Bytes===Buffer.byteLength(entry.source)&&message.payload.cursorUtf8Bytes===Buffer.byteLength(entry.source)&&message.payload.endUtf8Bytes===Buffer.byteLength(entry.source)));
      const page=await browser.newPage({viewport:{width:1500,height:640}});
      try{
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        const actual=await page.evaluate(async({entry,bytes,renderer,binding})=>{
          const {attachNativeInputDisplay}=await import('/display.js');
          const term=new Terminal({cols:entry.columns,rows:entry.rows,scrollback:20000,reflowCursorLine:false,allowProposedApi:true});term.open(document.querySelector('#surface'));
          if(renderer==='webgl')term.loadAddon(new WebglAddon.WebglAddon());
          term.loadAddon(new Unicode11Addon.Unicode11Addon());
          const search=new SearchAddon.SearchAddon();term.loadAddon(search);
          const originals={selection:term.getSelection,line:term.buffer.normal.getLine,open:term.open};const input=[];term.onData(value=>input.push(value));
          const display=attachNativeInputDisplay(term,binding,{unicodeVersion:binding.unicodeVersion,unicodeScope:binding.unicodeScope});const decoder=new TextDecoder('utf-8',{fatal:true});
          const write=chunk=>new Promise(resolve=>term.write(decoder.decode(Uint8Array.from(chunk),{stream:true}),resolve));
          let offset=0,wrappedBeforeResize;const geometry=[];
          for(const event of[...entry.resizeEvents,{offset:bytes.length}]){
            while(offset<event.offset){const end=Math.min(event.offset,offset+97);await write(bytes.slice(offset,end));offset=end;}
            if(event===entry.resizeEvents[0]){
              const found=search.findNext(entry.prefixBeforeFirstResize);const selected=term.getSelection();const position=term.getSelectionPosition();term.clearSelection();
              const wrapped=position?Array.from({length:position.end.y-position.start.y},(_,index)=>term.buffer.normal.getLine(position.start.y+index+1)?.isWrapped):[];
              if(!found||selected!==entry.prefixBeforeFirstResize||!position||!wrapped.some(Boolean))return{failure:'Actual pre-resize source was not observed across wrapped rows',found,selected,position,wrapped,
                lines:Array.from({length:term.buffer.normal.length},(_,index)=>({text:term.buffer.normal.getLine(index).translateToString(true),wrapped:term.buffer.normal.getLine(index).isWrapped}))};
              wrappedBeforeResize={position,wrapped,columns:term.cols};
            }
            if(event.columns){term.resize(event.columns,entry.rows);geometry.push({columns:term.cols,rows:term.rows,cursorX:term.buffer.normal.cursorX,cursorY:term.buffer.normal.cursorY,baseY:term.buffer.normal.baseY});}
          }
          term.selectAll();const all=term.getSelection();term.clearSelection();
          const found=search.findNext(entry.prefixBeforeFirstResize);const selected=term.getSelection();term.clearSelection();
          const exactSourceFound=search.findNext(entry.source);const exactSourceSelection=term.getSelection();term.clearSelection();
          if(!found||selected!==entry.prefixBeforeFirstResize)return{failure:'Actual ASCII source prefix was lost or corrupted after native resize',found,selected,all,geometry};
          if(!all.includes('P3-LONG-COMPLETE')||!all.includes('P3-AFTER-INTERRUPT'))return{failure:'Actual execution/recovery output is missing',all,geometry};
          if(term.getSelection!==originals.selection||term.buffer.normal.getLine!==originals.line||term.open!==originals.open||input.length)throw new Error('Display modified a public xterm API or produced input');
          await display.closeAfterPendingOutput();if(term.options.reflowCursorLine!==false)throw new Error('Actual native display interval remained enabled');
          return{wrappedBeforeResize,geometry,asciiPrefixCopy:true,asciiPrefixSearch:true,exactSourceFound,exactSourceSelection,
            exactUnicodeSourceCopy:exactSourceFound&&exactSourceSelection===entry.source,publicApisUnmodified:true,noInput:true,all};
        },{entry,bytes:[...bytes],renderer,binding});
        if(actual.failure){await writeFile(resolve(directory,'failure.json'),JSON.stringify({engine,renderer,input,entry,actual},null,2));await page.screenshot({path:resolve(directory,'failure.png')});assert.fail(`${actual.failure}; ${directory}`);}
        await page.screenshot({path:resolve(directory,`${engine}-${renderer}-${entry.columns}.png`)});
        results.push({engine,renderer,input,columns:entry.columns,sourceSha256:digest,ptySha256:createHash('sha256').update(bytes).digest('hex'),displayBindingSha256:createHash('sha256').update(bindingBytes).digest('hex'),displayBinding:binding,...actual});
      }finally{await page.close();}
    }}finally{await browser.close();}
  }
}finally{
  await new Promise(resolve=>server.close(resolve));
  assert.deepEqual(captureValidationSources(root),sources,'Browser verification source set changed');
  assert.deepEqual(await installedRuntimeManifest(),installed,'Installed renderer or formal patch changed');
  await writeFile(resolve(directory,'summary.json'),JSON.stringify({installed,sourceCount:Object.keys(sources).length,expected:inputs.length*4,completed:results.length,
    scope:'actual-PTY/native-proof/observed-softwrap/resize/ASCII-selection-and-search; full Unicode and native-App acceptance remain separate',results},null,2));
}
console.log(JSON.stringify({directory,cases:results.length}));
