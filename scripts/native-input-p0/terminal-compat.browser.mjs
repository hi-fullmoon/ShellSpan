// Real PTY bytes, public xterm APIs, and explicitly separate library oracles.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {createHash} from 'node:crypto';
import {formalRuntime,candidateRuntime,displayModuleJavaScript,installedRuntimeManifest} from './formal-runtime.mjs';
const installed=formalRuntime?await installedRuntimeManifest():undefined;
const input=path.resolve(process.argv[2]);
const queued=process.env.SHELLSPAN_P0_QUEUE_RESIZE==='1';
const fragmented=process.env.SHELLSPAN_P0_FRAGMENT_BYTES==='1';
const output=path.resolve(process.env.SHELLSPAN_P0_OUTPUT_ROOT??path.join(input,`browser${formalRuntime?'-formal':''}${queued?'-queued':''}${fragmented?'-fragmented':''}`));
await mkdir(output,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(input,'manifest.json'),'utf8'));
const captures=await Promise.all(manifest.cases.map(async name=>({
  name,scenario:JSON.parse(await readFile(path.join(input,name,'scenario.json'),'utf8')),
  frames:JSON.parse(await readFile(path.join(input,name,'timeline.json'),'utf8'))
})));
const assets={
  '/baseline.js':['.artifacts/tests/native-input-p0/xterm-reflow-lab/xterm-baseline.js','application/javascript'],
  '/candidate.js':[candidateRuntime('.artifacts/tests/native-input-p0/xterm-reflow-lab/xterm.js'),'application/javascript'],
  '/webgl.js':['node_modules/@xterm/addon-webgl/lib/addon-webgl.js','application/javascript'],
  '/xterm.css':['node_modules/@xterm/xterm/css/xterm.css','text/css']
};
const server=createServer(async(req,res)=>{
  try {
    if(req.url==='/display-module.js'){res.setHeader('Content-Type','application/javascript');res.end(await displayModuleJavaScript());return;}
    const asset=assets[req.url];
    res.setHeader('Content-Type',asset?asset[1]:'text/html');
    res.end(asset?await readFile(asset[0]):`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/xterm.css"><div id="surface"></div><script src="/${req.url.includes('candidate')?'candidate':'baseline'}.js"></script><script src="/webgl.js"></script>`);
  } catch(error){res.writeHead(500).end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const results=[];
try {
  for(const[engine,type]of [['chromium',chromium],['webkit',webkit]]) {
    const browser=await type.launch({headless:true});
    try {
      for(const renderer of ['dom','webgl']) {
        const states={};
        for(const bundle of ['baseline','candidate']) {
          const page=await browser.newPage({viewport:{width:900,height:700}});
          try {
            await page.exposeFunction('snapshotImage',label=>page.screenshot({path:path.join(output,`${engine}-${renderer}-${label}.png`)}));
            await page.goto(`http://127.0.0.1:${server.address().port}/${bundle}`);
            for(const enabled of [false,true]) {
              for(const capture of captures) {
                const snapshots=await page.evaluate(async({capture,renderer,enabled,bundle,queued,fragmented,formalRuntime})=>{
                  const displayModule=formalRuntime?await import('/display-module.js'):undefined;
                  const controllers=[];
                  const {scenario,frames}=capture;
                  const term=new Terminal({cols:scenario.cols,rows:scenario.rows,scrollback:scenario.scrollback,
                    reflowCursorLine:enabled&&scenario.initialReflow!==false,allowProposedApi:true,fontSize:14,fontFamily:'monospace'});
                  document.querySelector('#surface').replaceChildren();
                  term.open(document.querySelector('#surface'));
                  let reference;
                  if(scenario.referenceCopy) {
                    const container=document.createElement('div');container.style.display='none';
                    document.body.appendChild(container);
                    reference=new Terminal({cols:scenario.cols,rows:scenario.rows,scrollback:scenario.scrollback,
                      reflowCursorLine:false,allowProposedApi:true});reference.open(container);
                  }
                  if(renderer==='webgl')term.loadAddon(new WebglAddon.WebglAddon());
                  const replies=[];term.onData(data=>replies.push(data));
                  const snapshots={};
                  const modeEvents=[];
                  if(enabled&&scenario.inbandDisplay)for(const target of [term,reference].filter(Boolean)){
                    if(displayModule)controllers.push(displayModule.attachNativeInputDisplay(target,{inputMode:'native-inline',oscIdentifier:1337,
                      enterPayload:'SetUserVar=ShellSpanP0ReflowCursorLine=MQ==',exitPayload:'SetUserVar=ShellSpanP0ReflowCursorLine=MA=='}));
                    target.parser.registerOscHandler(1337,data=>{
                    if(data==='SetUserVar=ShellSpanP0ReflowCursorLine=MQ==') {
                      if(target===term)modeEvents.push('on');if(displayModule)return false;target.options.reflowCursorLine=true;return true;
                    }
                    if(data==='SetUserVar=ShellSpanP0ReflowCursorLine=MA==') {
                      if(target===term)modeEvents.push('off');if(displayModule)return false;target.options.reflowCursorLine=false;return true;
                    }
                    return false;
                  });}
                  let displayOwned=false;
                  let ignoredDelayedReceipts=0;
                  let pending=[];
                  for(const frame of frames) {
                    if(enabled&&frame.displayPolicy&&!scenario.inbandDisplay) {
                      displayOwned=frame.displayPolicy.startsWith('open-');
                      term.options.reflowCursorLine=displayOwned;
                    }
                    if(frame.deliverReceipt&&!displayOwned)ignoredDelayedReceipts++;
                    if(frame.bytes) {
                      const bytes=Uint8Array.from(atob(frame.bytes),c=>c.charCodeAt(0));
                      const chunks=fragmented?Array.from(bytes,byte=>Uint8Array.of(byte)):[bytes];
                      for(const chunk of chunks) {
                        const written=Promise.all([term,reference].filter(Boolean).map(target=>new Promise(resolve=>target.write(chunk,resolve))));
                        if(queued)pending.push(written);else await written;
                      }
                    }
                    if(frame.resize)term.resize(...frame.resize);
                    if(frame.ptyEOF) {
                      await Promise.all(pending);pending=[];
                      if(enabled&&scenario.inbandDisplay){if(displayModule)controllers.forEach(controller=>controller.resetAfterTransportClosed());else term.options.reflowCursorLine=false;}
                    }
                    if(frame.checkpoint) {
                      await Promise.all(pending);pending=[];
                      const buffer=term.buffer.active;
                      const lines=Array.from({length:buffer.length},(_,i)=>{
                        const line=buffer.getLine(i);
                        return {wrapped:line.isWrapped,text:line.translateToString(true),cells:Array.from({length:term.cols},(_,x)=>{
                          const cell=line.getCell(x);return [cell.getChars(),cell.getWidth()];
                        })};
                      });
                      term.selectAll();const copy=term.getSelection();term.clearSelection();
                      let referenceCopy;
                      if(reference){reference.selectAll();referenceCopy=reference.getSelection().replace(/\n+$/,'');reference.clearSelection();}
                      const line=buffer.getLine(buffer.baseY+buffer.cursorY);
                      const cell=line?.getCell(buffer.cursorX);
                      snapshots[frame.checkpoint]={cols:term.cols,rows:term.rows,baseY:buffer.baseY,viewportY:buffer.viewportY,
                        option:term.options.reflowCursorLine,ignoredDelayedReceipts,
                        modeEvents:[...modeEvents],
                        referenceCopy,
                        cursor:[buffer.cursorX,buffer.cursorY],cell:cell?[cell.getChars(),cell.getWidth()]:null,
                        type:buffer.type,lines,copy:copy.replace(/\n+$/,''),replies:[...replies],markers:term.markers.length};
                      if(bundle==='candidate'&&enabled&&renderer==='dom'&&
                          ((scenario.name==='native-edit'&&frame.checkpoint==='narrow')||
                           (scenario.name==='vim-tui'&&frame.checkpoint==='32x10'))) {
                        await window.snapshotImage(`${scenario.name}-${frame.checkpoint}`);
                      }
                    }
                  }
                  controllers.forEach(controller=>controller.dispose());term.dispose();reference?.dispose();return snapshots;
                },{capture,renderer,enabled,bundle,queued,fragmented,formalRuntime});
                const key=`${capture.name}:${enabled}`;states[`${bundle}:${key}`]=snapshots;
                await writeFile(path.join(output,`${engine}-${renderer}-${bundle}-${enabled}-${capture.name}.json`),JSON.stringify(snapshots,null,2));
                const errors=[];
                const observations=[];
                const ordinary=capture.scenario.name.startsWith('native-edit');
                const applicable=!ordinary||!enabled;
                for(const frame of capture.frames.filter(f=>f.checkpoint)) {
                  const state=snapshots[frame.checkpoint],oracle=frame.oracle??{};
                  const check=(ok,message)=>{if(!ok)errors.push(`${frame.checkpoint}: ${message}`);};
                  check(state.markers===0,'temporary marker leaked');
                  check(state.cursor[0]>=0&&state.cursor[0]<=state.cols&&state.cursor[1]>=0&&state.cursor[1]<state.rows,'cursor outside terminal');
                  check(state.lines.length<=state.rows+capture.scenario.scrollback,'buffer exceeds scrollback');
                  check(state.viewportY>=0&&state.viewportY<=state.baseY,'viewport outside buffer');
                  if(oracle.buffer)check(state.type===oracle.buffer,`buffer ${state.type} != ${oracle.buffer}`);
                  if(oracle.reply)check(state.replies.at(-1)===oracle.reply,'scroll-region response differs');
                  if(oracle.firstCells) {
                    const first=state.lines.flatMap((line,index)=>index===0||line.wrapped?line.cells:[])
                      .slice(0,oracle.firstCells.length).map(cell=>cell[0]);
                    check(JSON.stringify(first)===JSON.stringify(oracle.firstCells),'existing logical cell positions changed');
                    observations.push({checkpoint:frame.checkpoint,existingCellInvariant:JSON.stringify(first)===JSON.stringify(oracle.firstCells)});
                  }
                  if(oracle.visualRows) {
                    const matches=JSON.stringify(state.lines.map(line=>line.text).filter(Boolean))===JSON.stringify(oracle.visualRows);
                    check(matches,'native ASCII visible rows differ');
                    observations.push({checkpoint:frame.checkpoint,visualRowsMatch:matches});
                  }
                  if(enabled||oracle.checkFalse) {
                    if(oracle.referenceCopy)check(state.copy===state.referenceCopy,'full actual copied stream differs from no-resize reference');
                    if(oracle.labels)for(const label of oracle.labels)check(state.copy.includes(label),`missing actual output ${label}`);
                    if(oracle.copy!==undefined) {
                      if(ordinary)observations.push({checkpoint:frame.checkpoint,kind:'strong-source-copy-diagnostic',
                        matches:state.copy===oracle.copy,expected:oracle.copy,actual:state.copy});
                      else check(state.copy===oracle.copy,`copy mismatch: ${JSON.stringify(state.copy)}`);
                    }
                    if(oracle.contains!==undefined)check(state.copy.includes(oracle.contains),'native user draft missing or duplicated');
                    if(oracle.copyPrefix!==undefined)check(state.copy.startsWith(oracle.copyPrefix),'native earlier observed prefix was lost');
                    if(oracle.option!==undefined)check(state.option===oracle.option,`option ${state.option} != ${oracle.option}`);
                    if(oracle.cursor)check(JSON.stringify(state.cursor)===JSON.stringify(oracle.cursor),`cursor ${state.cursor} != ${oracle.cursor}`);
                    if(oracle.sameCell)check(JSON.stringify(state.cell)===JSON.stringify(snapshots[oracle.sameCell].cell),`cell ${JSON.stringify(state.cell)} != ${JSON.stringify(snapshots[oracle.sameCell].cell)}`);
                  }
                }
                let stockComparison;
                if(bundle==='candidate') {
                  if(!enabled||capture.scenario.name==='alternate-screen'||capture.scenario.name==='vim-tui') {
                    const comparable=values=>Object.fromEntries(Object.entries(values).map(([name,value])=>[name,
                      formalRuntime&&!ordinary?{...value,copy:undefined,referenceCopy:undefined}:value]));
                    try {assert.deepEqual(comparable(snapshots),comparable(states[`baseline:${key}`]));stockComparison='PASS';}
                    catch{errors.push('stock compatibility state differs');stockComparison='FAIL';}
                  }
                }
                results.push({engine,renderer,bundle,reflowCursorLine:enabled,case:capture.name,applicable,
                  scope:ordinary?(enabled?'ordinary-global-true-negative-control':'ordinary-native-default'):'library-or-owned',
                  result:errors.length?'FAIL':'PASS',stockComparison,observations,errors});
              }
            }
          } finally{await page.close();}
        }
      }
    } finally{await browser.close();}
  }
} finally{server.close();}
const summary={kind:'real PTY terminal-program bytes + browser public API library assertions; not native shell acceptance',
  installedRuntime:installed,
  queuedResizeBeforeWriteParsing:queued,fragmentedByteWrites:fragmented,
  captureHashes:await Promise.all(captures.map(async capture=>({name:capture.name,
    files:Object.fromEntries(await Promise.all(['pty.bin','timeline.json','scenario.json'].map(async name=>
      [name,createHash('sha256').update(await readFile(path.join(input,capture.name,name))).digest('hex')])))}))),
  candidateManifest:JSON.parse(await readFile('.artifacts/tests/native-input-p0/xterm-reflow-lab/manifest.json','utf8')),
  baselineManifest:JSON.parse(await readFile('.artifacts/tests/native-input-p0/xterm-reflow-lab/baseline-manifest.json','utf8')),
  results};
await writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2));
const failures=results.filter(r=>r.result==='FAIL');
console.log(JSON.stringify({caseLanes:results.length,failed:failures.length,
  defaultOffCompared:results.filter(r=>r.bundle==='candidate'&&!r.reflowCursorLine).length,
  defaultOffStockMatches:results.filter(r=>r.bundle==='candidate'&&!r.reflowCursorLine&&r.stockComparison==='PASS').length,
  candidateOptInPassed:results.filter(r=>r.bundle==='candidate'&&r.reflowCursorLine&&r.result==='PASS').length,
  candidateOptInFailures:failures.filter(r=>r.bundle==='candidate'&&r.reflowCursorLine)}));
if(failures.some(r=>r.bundle==='candidate'&&r.applicable))process.exitCode=1;
