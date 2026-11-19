import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {chromium,webkit} from 'playwright';
import {displayModuleJavaScript,installedRuntimeManifest} from '../prototype/formal-runtime.mjs';

const root=resolve(import.meta.dirname,'../../..');
const linux=process.argv.includes('--linux');
const pointer=JSON.parse(await readFile(resolve(root,linux?'artifacts/tests/native-input-p2/latest-linux-geometry.json':'artifacts/tests/native-input-p2/latest-geometry.json'),'utf8'));
const target=linux?'linux-aarch64-glibc-2.36':'macos-arm64';
const catalogue=JSON.parse(await readFile(resolve(root,`artifacts/tests/native-input-p2/resources/native-input/catalogue-${target}.json`),'utf8'));
const entries=JSON.parse(await readFile(pointer.summary,'utf8'));
assert(catalogue.profiles.length>0,'No native Bash profiles in the geometry catalogue');
const sizes=linux?['oversize']:['normal','oversize'];
const expectedGeometry=catalogue.profiles.flatMap(({bashVersion})=>[32,40,100,180].flatMap(columns=>sizes.map(size=>`${bashVersion}/${columns}/${size}`)));
assert.deepEqual(entries.map(({version,columns,size})=>`${version}/${columns}/${size}`).sort(),expectedGeometry.sort(),'Geometry evidence must cover the built profiles');
const expectedCases=entries.length*4;
const installed=await installedRuntimeManifest();
const directory=resolve(root,'artifacts/tests/native-input-p2/browser',randomUUID());await mkdir(directory,{recursive:true,mode:0o700});
const assets={'/xterm.js':['node_modules/@xterm/xterm/lib/xterm.js','application/javascript'],'/xterm.css':['node_modules/@xterm/xterm/css/xterm.css','text/css'],'/webgl.js':['node_modules/@xterm/addon-webgl/lib/addon-webgl.js','application/javascript'],'/search.js':['node_modules/@xterm/addon-search/lib/addon-search.js','application/javascript']};
const server=createServer(async(request,response)=>{
  try{if(request.url==='/display.js'){response.setHeader('Content-Type','application/javascript');response.end(await displayModuleJavaScript());return;}
    const asset=assets[request.url];response.setHeader('Content-Type',asset?asset[1]:'text/html');response.end(asset?await readFile(resolve(root,asset[0])):'<!doctype html><style>body{background:#18181b;color:#fafafa}</style><link rel="stylesheet" href="/xterm.css"><div id="surface"></div><script src="/xterm.js"></script><script src="/webgl.js"></script><script src="/search.js"></script>');
  }catch{response.writeHead(500).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const results=[];
try{
  for(const[engine,type]of[['chromium',chromium],['webkit',webkit]]){
    const browser=await type.launch({headless:true});
    try{for(const renderer of['dom','webgl'])for(const entry of entries){
      const page=await browser.newPage({viewport:{width:1500,height:520}});
      try{
        const bytes=await readFile(resolve(entry.directory,'typed-pty.bin'));
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        const actual=await page.evaluate(async({entry,bytes,renderer})=>{
          const {attachNativeInputDisplay,NATIVE_INPUT_DISPLAY}=await import('/display.js');
          const term=new Terminal({cols:entry.columns,rows:entry.rows,scrollback:10000,allowProposedApi:true,reflowCursorLine:false});term.open(document.querySelector('#surface'));
          if(renderer==='webgl')term.loadAddon(new WebglAddon.WebglAddon());
          const search=new SearchAddon.SearchAddon();term.loadAddon(search);
          const originals={selection:term.getSelection,line:term.buffer.normal.getLine,open:term.open};const input=[];term.onData(value=>input.push(value));
          const display=attachNativeInputDisplay(term,NATIVE_INPUT_DISPLAY);
          const decoder=new TextDecoder('utf-8',{fatal:true});
          // Production ssh-data carries the backend's incrementally decoded
          // UTF-8 string. Reproduce that actual public transport type.
          const write=chunk=>new Promise(resolve=>term.write(decoder.decode(Uint8Array.from(chunk),{stream:true}),resolve));
          // Every byte comes from the real target stream, including fragments
          // within UTF-8/OSC; no terminal output or editor receipt is invented.
          let offset=0;
          if(!Array.isArray(entry.readEvents)||entry.readEvents.length<=3)throw new Error('Fresh native capture must include actual PTY read timing');
          let nextOffset=0;
          for(const read of entry.readEvents){if(read.offset!==nextOffset||!Number.isSafeInteger(read.length)||read.length<=0||!Number.isSafeInteger(read.atMs))throw new Error('Invalid actual PTY read boundary');nextOffset+=read.length;}
          if(nextOffset!==bytes.length)throw new Error('Read timing does not cover exactly the actual PTY bytes');
          const progress=[];
          let seenInput=false;
          let wrappedBeforeResize;
          const events=[...entry.readEvents.map(read=>({offset:read.offset+read.length,atMs:read.atMs})),...entry.resizeEvents,{offset:bytes.length}].sort((a,b)=>a.offset-b.offset);
          for(const event of events){
            while(offset<event.offset){const end=Math.min(event.offset,offset+97);await write(bytes.slice(offset,end));offset=end;}
            if(event.atMs!==undefined){
              await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
              term.selectAll();const text=term.getSelection();term.clearSelection();
              const prefix=entry.source.slice(0,24);
              seenInput||=text.includes(prefix);
              if(seenInput){if(!text.includes(prefix))throw new Error('Previously painted native input disappeared during a real read');progress.push({atMs:event.atMs,text});}
            }
            if(event===entry.resizeEvents[0]&&entry.size==='oversize'){
              if(!search.findNext(entry.prefixBeforeFirstResize)||term.getSelection()!==entry.prefixBeforeFirstResize)throw new Error('Real pre-resize prefix was not retained');
              const position=term.getSelectionPosition();term.clearSelection();
              if(!position||position.end.y<=position.start.y||!Array.from({length:position.end.y-position.start.y},(_,index)=>term.buffer.normal.getLine(position.start.y+index+1)?.isWrapped).some(Boolean))throw new Error('Oversize resize preceded actual wrapped source rows');
              wrappedBeforeResize=position;
            }
            if(event.columns)term.resize(event.columns,event.rows??entry.rows);
          }
          if(new Set(progress.map(frame=>frame.text)).size<=3)throw new Error('The real xterm buffer must visibly advance before submission');
          if(progress.at(-1).atMs-progress[0].atMs<=500)throw new Error('Native typing must remain visible over time');
          if(term.options.reflowCursorLine!==true)throw new Error('Actual producer did not enter the formal display mode');
          const inspect=()=>{
            const {cursorX,cursorY,baseY}=term.buffer.normal;
            term.selectAll();const all=term.getSelection();term.clearSelection();
            if(entry.background){
              term.select(0,0,(baseY+cursorY)*term.cols+cursorX);
              const throughCursor=term.getSelection();const end=term.getSelectionPosition()?.end;term.clearSelection();
              const start=throughCursor.lastIndexOf(entry.source.slice(0,24));
              const interleaved=start<0?[]:throughCursor.slice(start).split(entry.background.line+'\n');
              return{all,found:interleaved.length===2,selected:interleaved.join(''),end,cursorX,cursorY,baseY,throughCursor};
            }
            const found=search.findNext(entry.source);const selected=term.getSelection();const end=term.getSelectionPosition()?.end;term.clearSelection();
            return{all,found,selected,end,cursorX,cursorY,baseY};
          };
          const before=inspect();
          if(!before.found||before.selected!==entry.source||!entry.background&&!before.all.includes(entry.source))return {failure:'Actual Unicode source is not exactly copyable through the expected PTY output',before,expected:entry.source,lines:Array.from({length:term.buffer.normal.length},(_,index)=>({text:term.buffer.normal.getLine(index).translateToString(true),wrapped:term.buffer.normal.getLine(index).isWrapped}))};
          const heightChanged=entry.resizeEvents.some(event=>event.rows!==undefined&&event.rows!==entry.rows);
          term.resize(entry.columns===32?40:32,heightChanged?Math.max(8,entry.rows-4):entry.rows);term.resize(entry.columns,entry.rows);
          const after=inspect();
          if(!after.found||after.selected!==entry.source||after.all!==before.all)throw new Error('Resize changed real source/history selection');
          if(heightChanged)for(const state of [before,after]){
            if(state.end?.x!==state.cursorX||state.end?.y!==state.baseY+state.cursorY)throw new Error('The native cursor moved away from the end of the actual source');
          }
          if(term.getSelection!==originals.selection||term.buffer.normal.getLine!==originals.line||term.open!==originals.open)throw new Error('Public xterm API was overridden');
          if(input.length||after.all.includes('ss_native_input_begin'))throw new Error('Display created input or exposed the execution plan');
          await display.closeAfterPendingOutput();if(term.options.reflowCursorLine!==false)throw new Error('Display cleanup did not restore the option');
          return {before,after,wrappedBeforeResize,visibleFrames:progress.length,visibleDurationMs:progress.at(-1).atMs-progress[0].atMs,noInput:true,publicApisUnmodified:true};
        },{entry,bytes:[...bytes],renderer});
        if(actual.failure){await writeFile(resolve(directory,'failure.json'),JSON.stringify({engine,renderer,entry,actual},null,2));await page.screenshot({path:resolve(directory,'failure.png')});assert.fail(`${actual.failure}; ${directory}`);}
        if(entry.version==='5.3')await page.screenshot({path:resolve(directory,`${engine}-${renderer}-${entry.columns}-${entry.size}.png`)});
        results.push({engine,renderer,version:entry.version,columns:entry.columns,size:entry.size,sourceSha256:createHash('sha256').update(entry.source).digest('hex'),ptySha256:createHash('sha256').update(bytes).digest('hex'),...actual});
      }finally{await page.close();}
    }}finally{await browser.close();}
  }
}finally{await new Promise(resolve=>server.close(resolve));await writeFile(resolve(directory,'summary.json'),JSON.stringify({installed,target:linux?'linux-aarch64-glibc-2.36':'macos-arm64',sourceCaptures:pointer.summary,expectedCases,completed:results.length,result:results.length===expectedCases?'PASS':'INCOMPLETE',results},null,2));}
console.log(JSON.stringify({directory,result:'PASS',cases:results.length}));
