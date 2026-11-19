import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {displayModuleJavaScript,installedRuntimeManifest} from '../prototype/formal-runtime.mjs';
const root=resolve(import.meta.dirname,'../../..'),input=resolve(process.argv[2]);
const entry=JSON.parse(await readFile(resolve(input,'geometry.json'),'utf8'));
const baselineDirectory=resolve(process.argv[3]);
const baseline=JSON.parse(await readFile(resolve(baselineDirectory,'result.json'),'utf8'));
assert.equal(baseline.sourceSha256,entry.sourceSha256);assert.equal(baseline.actualBufferSha256,entry.sourceSha256);
const runtime=await installedRuntimeManifest();const directory=resolve(root,'artifacts/tests/native-input-p3/source-copy-comparison',randomUUID());await mkdir(directory,{recursive:true});
const assets={'/xterm.js':['node_modules/@xterm/xterm/lib/xterm.js','application/javascript'],'/xterm.css':['node_modules/@xterm/xterm/css/xterm.css','text/css'],'/search.js':['node_modules/@xterm/addon-search/lib/addon-search.js','application/javascript']};
const server=createServer(async(request,response)=>{try{if(request.url==='/display.js'){response.setHeader('Content-Type','application/javascript');response.end(await displayModuleJavaScript());return;}const asset=assets[request.url];response.setHeader('Content-Type',asset?asset[1]:'text/html');response.end(asset?await readFile(resolve(root,asset[0])):'<!doctype html><link rel="stylesheet" href="/xterm.css"><div id="surface"></div><script src="/xterm.js"></script><script src="/search.js"></script>');}catch{response.writeHead(500).end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true});const results=[];
try{
  for(const mode of['ordinary-no-adapter','native']){
    const bytes=await readFile(mode==='native'?resolve(input,'raw.bin'):resolve(baselineDirectory,'raw.bin'));
    const checkpoints=[];
    if(mode==='ordinary-no-adapter'){
      let offset=bytes.indexOf(Buffer.from('👩'));
      if(offset>=0){checkpoints.push({offset,label:'before-woman'});for(const token of['👩','🏽','🏽','‍','💻']){const found=bytes.indexOf(Buffer.from(token),offset);if(found<0)break;offset=found+Buffer.byteLength(token);checkpoints.push({offset,label:`after-${token}`});}}
    }
    const page=await browser.newPage({viewport:{width:1500,height:640}});
    try{
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const actual=await page.evaluate(async({entry,bytes,mode,checkpoints})=>{
        const {attachNativeInputDisplay,NATIVE_INPUT_DISPLAY}=await import('/display.js');
        const term=new Terminal({cols:entry.columns,rows:entry.rows,scrollback:20000,reflowCursorLine:false,allowProposedApi:true});term.open(document.querySelector('#surface'));
        const original={selection:term.getSelection,line:term.buffer.normal.getLine,open:term.open};const search=new SearchAddon.SearchAddon();term.loadAddon(search);const display=attachNativeInputDisplay(term,NATIVE_INPUT_DISPLAY);
        const decoder=new TextDecoder('utf-8',{fatal:true});const write=data=>new Promise(resolve=>term.write(decoder.decode(Uint8Array.from(data),{stream:true}),resolve));let offset=0;const glyphCheckpoints=[],terminalResponses=[];term.onData(value=>terminalResponses.push(value));
        for(const event of[...(mode==='native'?entry.resizeEvents:checkpoints),{offset:bytes.length}]){
          await write(bytes.slice(offset,event.offset));offset=event.offset;if(event.columns)term.resize(event.columns,entry.rows);
          if(event.label){const buffer=term.buffer.normal,row=buffer.baseY+buffer.cursorY,line=buffer.getLine(row);glyphCheckpoints.push({label:event.label,offset,cursorX:buffer.cursorX,row,columns:term.cols,cells:Array.from({length:Math.min(term.cols,buffer.cursorX+4)-Math.max(0,buffer.cursorX-10)},(_,index)=>{const column=Math.max(0,buffer.cursorX-10)+index,cell=line.getCell(column);return{column,chars:cell.getChars(),width:cell.getWidth()};})});}
        }
        term.selectAll();const copied=term.getSelection();term.clearSelection();const found=search.findNext(entry.source);const selected=term.getSelection();term.clearSelection();
        const rows=Array.from({length:term.buffer.normal.length},(_,row)=>({row,wrapped:term.buffer.normal.getLine(row).isWrapped,text:term.buffer.normal.getLine(row).translateToString(true)}));
        await display.closeAfterPendingOutput();return{found,selected,copied,exactSourceCopy:copied.includes(entry.source),exactSourceSearch:found&&selected===entry.source,
          literalZwjEscape:copied.includes('<200d>'),rows,glyphCheckpoints,terminalResponses,unicodeVersion:term.unicode.activeVersion,publicApisUnmodified:term.getSelection===original.selection&&term.buffer.normal.getLine===original.line&&term.open===original.open};
      },{entry,bytes:[...bytes],mode,checkpoints});
      await page.screenshot({path:resolve(directory,`${mode}.png`)});results.push({mode,rawSha256:createHash('sha256').update(bytes).digest('hex'),...actual});
    }finally{await page.close();}
  }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await writeFile(resolve(directory,'result.json'),JSON.stringify({scope:'real ordinary/native ZLE buffer and public xterm copy/search comparison; not native-App acceptance',input,sourceSha256:entry.sourceSha256,baseline,runtime,results},null,2));}
console.log(JSON.stringify({directory,results:results.map(({mode,exactSourceCopy,exactSourceSearch,literalZwjEscape,publicApisUnmodified})=>({mode,exactSourceCopy,exactSourceSearch,literalZwjEscape,publicApisUnmodified}))}));
assert(results.every(value=>value.exactSourceCopy&&value.exactSourceSearch&&value.publicApisUnmodified),'Actual source copy/search requirement is not satisfied; exact original observations retained');
