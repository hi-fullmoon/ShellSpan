// No private xterm state or application selection override. All buffers come
// from actual PTY bytes; fixed selection expectations describe native cells.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {formalRuntime,candidateRuntime,originalRuntime,displayModuleJavaScript,installedRuntimeManifest} from './formal-runtime.mjs';
const installed=formalRuntime?await installedRuntimeManifest():undefined;
const experimentPath=process.env.SHELLSPAN_P0_EXPERIMENT_MANIFEST;
const experiment=experimentPath?JSON.parse(await readFile(experimentPath,'utf8')):undefined;
let experimentalRuntime;
if(experiment){
  assert.equal(experiment.nativeAcceptance,false);assert.equal(experiment.formalPatchChanged,false);
  experimentalRuntime=path.resolve(experiment.source,'lib/xterm.js');
  assert.equal(createHash('sha256').update(await readFile(experimentalRuntime)).digest('hex'),experiment.artifacts['lib/xterm.js']);
}
const searchCases=JSON.parse(await readFile('scripts/native-input/prototype/copy-search-cases.json','utf8'));
const stockOrdinary=process.argv.includes('--ordinary-stock-only');
const input=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]??path.join(input,'browser'));await mkdir(output,{recursive:true});
const corpora=[{root:input,primary:true},{root:path.resolve(process.env.SHELLSPAN_P0_COPY_LEGACY_ROOT??'artifacts/tests/native-input-p0/dependency-compat-pty-v4'),primary:false}];
const captures=[];
for(const corpus of corpora){
  const manifest=JSON.parse(await readFile(path.join(corpus.root,'manifest.json'),'utf8'));
  for(const name of manifest.cases)captures.push({...corpus,name,
    scenario:JSON.parse(await readFile(path.join(corpus.root,name,'scenario.json'),'utf8')),
    frames:JSON.parse(await readFile(path.join(corpus.root,name,'timeline.json'),'utf8'))});
}
if(stockOrdinary)for(let i=captures.length-1;i>=0;i--)if(!captures[i].scenario.name.startsWith('native-edit'))captures.splice(i,1);
const caseFilters=process.argv.filter(arg=>arg.startsWith('--case=')).map(arg=>arg.slice(7));
if(caseFilters.length)for(let i=captures.length-1;i>=0;i--)if(!caseFilters.includes(captures[i].scenario.name))captures.splice(i,1);
const assets={
  '/baseline.js':[stockOrdinary?(formalRuntime?originalRuntime:'node_modules/@xterm/xterm/lib/xterm.js'):'artifacts/tests/native-input-p0/xterm-copy-lab/xterm-baseline.js','application/javascript'],
  '/candidate.js':[experimentalRuntime??candidateRuntime('artifacts/tests/native-input-p0/xterm-copy-lab/xterm.js'),'application/javascript'],
  '/webgl.js':['node_modules/@xterm/addon-webgl/lib/addon-webgl.js','application/javascript'],
  '/search.js':['node_modules/@xterm/addon-search/lib/addon-search.js','application/javascript'],
  '/xterm.css':['node_modules/@xterm/xterm/css/xterm.css','text/css']
};
const server=createServer(async(req,res)=>{
  if(req.url==='/display-module.js'){res.setHeader('Content-Type','application/javascript');res.end(await displayModuleJavaScript());return;}
  try{const asset=assets[req.url];res.setHeader('Content-Type',asset?asset[1]:'text/html');
    res.end(asset?await readFile(asset[0]):`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/xterm.css"><div id="surface"></div><script src="/${req.url.includes('candidate')?'candidate':'baseline'}.js"></script><script src="/webgl.js"></script><script src="/search.js"></script>`);}
  catch(error){res.writeHead(500).end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const results=[];
try{
  for(const[engine,type]of [['chromium',chromium],['webkit',webkit]]){
    const browser=await type.launch({headless:true});
    try{for(const renderer of ['dom','webgl']){
      const baselines=new Map();
      for(const bundle of ['baseline','candidate']){
        const page=await browser.newPage({viewport:{width:1400,height:900}});
        try{
          await page.goto(`http://127.0.0.1:${server.address().port}/${bundle}`);
          for(const enabled of stockOrdinary?[false]:[false,true])for(const capture of captures){
            const ordinary=capture.scenario.name.startsWith('native-edit');
            const applicable=ordinary?!enabled:(!capture.scenario.inbandDisplay||enabled);
            const role=ordinary?(enabled?'ordinary-global-true-negative-control':'ordinary-native-default'):
              capture.scenario.inbandDisplay?(enabled?'owned-inband':'owned-unpaired-negative-control'):'library';
            const snapshots=await page.evaluate(async({capture,renderer,enabled,searchCase,formalRuntime})=>{
              window.copyControllers?.forEach(controller=>controller.dispose());window.copyControllers=[];
              const displayModule=formalRuntime?await import('/display-module.js'):undefined;
              window.copyTerm?.dispose();window.copyReference?.dispose();document.querySelector('#reference')?.remove();
              const{scenario,frames}=capture;
              const term=window.copyTerm=new Terminal({cols:scenario.cols,rows:scenario.rows,scrollback:scenario.scrollback,
                reflowCursorLine:enabled&&scenario.initialReflow!==false,allowProposedApi:true,fontSize:14,fontFamily:'monospace'});
              document.querySelector('#surface').replaceChildren();term.open(document.querySelector('#surface'));
              if(renderer==='webgl')term.loadAddon(new WebglAddon.WebglAddon());
              const search=new SearchAddon.SearchAddon();term.loadAddon(search);
              let reference;
              if(scenario.referenceCopy){
                const div=document.createElement('div');div.id='reference';div.style.cssText='position:fixed;left:-10000px';document.body.appendChild(div);
                reference=window.copyReference=new Terminal({cols:scenario.cols,rows:scenario.rows,scrollback:scenario.scrollback,
                  reflowCursorLine:false,allowProposedApi:true});reference.open(div);
              }
              if(scenario.inbandDisplay&&enabled)for(const target of[term,reference].filter(Boolean)){
                if(displayModule){window.copyControllers.push(displayModule.attachNativeInputDisplay(target,{inputMode:'native-inline',oscIdentifier:1337,
                  enterPayload:'SetUserVar=ShellSpanP0ReflowCursorLine=MQ==',exitPayload:'SetUserVar=ShellSpanP0ReflowCursorLine=MA=='}));continue;}
                target.parser.registerOscHandler(1337,data=>{
                if(data==='SetUserVar=ShellSpanP0ReflowCursorLine=MQ=='){target.options.reflowCursorLine=true;return true;}
                if(data==='SetUserVar=ShellSpanP0ReflowCursorLine=MA=='){target.options.reflowCursorLine=false;return true;}
                return false;
              });}
              const snapshots={};
              for(const frame of frames){
                if(frame.bytes){const bytes=Uint8Array.from(atob(frame.bytes),c=>c.charCodeAt(0));
                  await Promise.all([term,reference].filter(Boolean).map(target=>new Promise(resolve=>target.write(bytes,resolve))));}
                if(frame.resize)term.resize(...frame.resize);
                if(frame.checkpoint){
                  const buffer=term.buffer.active;
                  const lines=Array.from({length:buffer.length},(_,i)=>{const line=buffer.getLine(i);return {
                    wrapped:line.isWrapped,length:line.length,text:line.translateToString(true),cells:Array.from({length:line.length},(_,col)=>{
                      const c=line.getCell(col);return [c.getChars(),c.getWidth()];})};});
                  const copyAll=target=>{target.selectAll();const result=target.getSelection().replace(/\n+$/,'');target.clearSelection();return result;};
                  const selections=(frame.oracle?.selections??[]).map(selection=>{
                    term.select(selection.col,selection.row,selection.length);const text=term.getSelection();const position=term.getSelectionPosition();
                    term.clearSelection();return {text,position};});
                  const cell=buffer.getLine(buffer.baseY+buffer.cursorY)?.getCell(buffer.cursorX);
                  const searches=[];
                  if(searchCase&&(!searchCase.checkpoints||searchCase.checkpoints.includes(frame.checkpoint))){
                    const viewport=buffer.viewportY;
                    for(const query of searchCase.terms){
                      term.clearSelection();const found=search.findNext(query,{caseSensitive:true});
                      searches.push({query,found,text:term.getSelection()});
                    }
                    term.clearSelection();term.scrollToLine(viewport);
                  }
                  snapshots[frame.checkpoint]={state:{cols:term.cols,rows:term.rows,type:buffer.type,baseY:buffer.baseY,viewportY:buffer.viewportY,
                    cursor:[buffer.cursorX,buffer.cursorY],cell:cell?[cell.getChars(),cell.getWidth()]:null,lines,markers:term.markers.length},
                    copy:copyAll(term),referenceCopy:reference?copyAll(reference):undefined,selections,searches};
                }
              }
              return snapshots;
            },{capture,renderer,enabled,searchCase:searchCases[capture.scenario.name],formalRuntime});
            const errors=[],diagnostics=[];
            const check=(ok,message)=>{if(!ok)errors.push(message);};
            for(const frame of capture.frames.filter(f=>f.checkpoint)){
              const snapshot=snapshots[frame.checkpoint],oracle=frame.oracle??{};
              check(snapshot.state.markers===0,`${frame.checkpoint}: leaked marker`);
              for(const [i,expected]of(oracle.selections??[]).entries())if(expected.text!==undefined)check(snapshot.selections[i].text===expected.text,
                `${frame.checkpoint}: selection ${i}: ${JSON.stringify(snapshot.selections[i].text)} != ${JSON.stringify(expected.text)}`);
              for(const search of snapshot.searches)check(search.found&&search.text===search.query,
                `${frame.checkpoint}: native search/selection mismatch: ${JSON.stringify(search)}`);
              if(oracle.referenceCopy)check(snapshot.copy===snapshot.referenceCopy,`${frame.checkpoint}: full owned copy differs from actual no-resize stream`);
              if(ordinary&&oracle.copy!==undefined){
                // Strong historical diagnostic, not a newly frozen requirement
                // for native Readline hard-line redraw without owned append.
                diagnostics.push({checkpoint:frame.checkpoint,kind:'strong-source-copy-diagnostic',matches:snapshot.copy===oracle.copy,
                  expected:oracle.copy,actual:snapshot.copy});
              }else if(enabled&&oracle.copy!==undefined)check(snapshot.copy===oracle.copy,`${frame.checkpoint}: copy differs: ${JSON.stringify(snapshot.copy)}`);
              if(enabled&&oracle.sameCell)check(JSON.stringify(snapshot.state.cell)===JSON.stringify(snapshots[oracle.sameCell].state.cell),`${frame.checkpoint}: cursor cell changed`);
              if(enabled&&oracle.cursor)check(JSON.stringify(snapshot.state.cursor)===JSON.stringify(oracle.cursor),`${frame.checkpoint}: cursor differs`);
            }
            const finalFrame=capture.frames.filter(frame=>frame.checkpoint).at(-1);
            const interactive=[];
            if((finalFrame.oracle?.drags?.length??0)||(finalFrame.oracle?.clicks?.length??0)){
              await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
              const metrics=await page.evaluate(()=>{const r=document.querySelector('.xterm-screen').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width/copyTerm.cols,h:r.height/copyTerm.rows};});
              const point=coords=>({x:metrics.x+(coords[0]+0.1)*metrics.w,y:metrics.y+(coords[1]+0.5)*metrics.h});
              for(const drag of finalFrame.oracle.drags??[]){
                await page.evaluate(()=>copyTerm.clearSelection());if(drag.column)await page.keyboard.down('Alt');
                const start=point(drag.start),end=point(drag.end);
                await page.mouse.move(start.x,start.y);await page.mouse.down({clickCount:1});await page.mouse.move(end.x,end.y,{steps:3});await page.mouse.up();
                if(drag.column)await page.keyboard.up('Alt');
                const text=await page.evaluate(()=>copyTerm.getSelection());interactive.push({kind:'drag',...drag,actual:text});
                check(text===drag.text,`actual ${drag.column?'column ':''}drag ${JSON.stringify(drag.start)}→${JSON.stringify(drag.end)}: ${JSON.stringify(text)}`);
              }
              for(const click of finalFrame.oracle.clicks??[]){
                await page.evaluate(()=>copyTerm.clearSelection());const at=point(click.at);await page.mouse.click(at.x,at.y,{clickCount:click.count});
                const text=await page.evaluate(()=>copyTerm.getSelection());interactive.push({kind:'click',...click,actual:text});
                check(text===click.text,`actual ${click.count}-click: ${JSON.stringify(text)}`);
              }
            }
            const key=`${capture.primary}:${capture.name}:${enabled}`;
            if(bundle==='baseline')baselines.set(key,snapshots);
            else{
              const original=baselines.get(key);
              for(const label of Object.keys(snapshots)){
                try{assert.deepEqual(snapshots[label].state,original[label].state);}catch{errors.push(`${label}: canonical native cell/cursor state changed`);}
                const frame=capture.frames.find(frame=>frame.checkpoint===label);
                for(const [i,selection]of(frame.oracle?.selections??[]).entries())if(selection.sameAsBaseline)
                  check(JSON.stringify(snapshots[label].selections[i])===JSON.stringify(original[label].selections[i]),`${label}: existing public selection compatibility changed`);
                if(ordinary&&!enabled)check(snapshots[label].copy===original[label].copy,`${label}: ordinary default-false native copy compatibility changed`);
                if(['alternate-screen','vim-tui'].includes(capture.scenario.name))check(snapshots[label].copy===original[label].copy,`${label}: alternate/TUI copy compatibility changed`);
              }
            }
            const result={engine,renderer,bundle,enabled,case:capture.name,role,applicable,result:errors.length?'FAIL':'PASS',errors,diagnostics};
            results.push(result);
            await writeFile(path.join(output,`${engine}-${renderer}-${bundle}-${enabled}-${capture.primary?'focused':'compatibility'}-${capture.name}.json`),JSON.stringify({result,snapshots,interactive},null,2));
          }
        }finally{await page.close();}
      }
    }}finally{await browser.close();}
  }
}finally{server.close();}
const failures=results.filter(r=>r.bundle==='candidate'&&r.applicable&&r.result==='FAIL');
const summary={kind:'actual PTY/public API copy compatibility; stronger ordinary source equality remains diagnostic',
  installedRuntime:experiment?undefined:installed,
  ...(experiment?{experimentalRuntime:{manifest:experimentPath,path:experimentalRuntime,sha256:experiment.artifacts['lib/xterm.js']},referenceInstalledRuntime:installed}:{}),
  directUnmodifiedStockComparison:stockOrdinary,
  candidateManifest:experiment??installed??JSON.parse(await readFile('artifacts/tests/native-input-p0/xterm-copy-lab/manifest.json','utf8')),
  baselineManifest:stockOrdinary?{kind:'unmodified original xterm 6.0.0',bundleSha256:createHash('sha256').update(await readFile(formalRuntime?originalRuntime:'node_modules/@xterm/xterm/lib/xterm.js')).digest('hex')}:
    JSON.parse(await readFile('artifacts/tests/native-input-p0/xterm-copy-lab/baseline-manifest.json','utf8')),
  captures:await Promise.all(captures.map(async c=>({root:c.root,name:c.name,sha256:createHash('sha256').update(await readFile(path.join(c.root,c.name,'pty.bin'))).digest('hex')}))),results};
await writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({caseLanes:results.length,applicableCandidate:results.filter(r=>r.bundle==='candidate'&&r.applicable).length,
  failures:failures.map(({case:name,engine,renderer,enabled,errors})=>({name,engine,renderer,enabled,errors}))}));
if(failures.length)process.exitCode=1;
