// Library-only transport repartitioning of actual native PTY bytes. Resizes here
// deliberately occur inside a captured OSC packet; this is not a new shell run.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {formalRuntime,candidateRuntime,displayModuleJavaScript,installedRuntimeManifest} from './formal-runtime.mjs';
const installed=formalRuntime?await installedRuntimeManifest():undefined;
const captures=path.resolve(process.argv[2]);
const output=path.resolve(process.env.SHELLSPAN_P0_OUTPUT_ROOT??path.join(captures,formalRuntime?'parser-boundaries-formal':'parser-boundaries-cursor-selection'));await mkdir(output,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(captures,'manifest.json'),'utf8'));
const name=manifest.cases.find(name=>name.startsWith('commit-'));assert(name);
const raw=await readFile(path.join(captures,name,'pty.bin'));
const packets=[false,true].map(off=>({off,bytes:Buffer.from(`\x1b]1337;SetUserVar=ShellSpanP0ReflowCursorLine=${off?'MA==':'MQ=='}\x07`)}));
const trials=packets.flatMap(({off,bytes})=>{
  const start=raw.indexOf(bytes);assert(start>=0,'Actual native mode packet missing');
  return Array.from({length:bytes.length},(_,split)=>({off,split,
    prefix:raw.subarray(0,start+split).toString('base64'),suffix:bytes.subarray(split).toString('base64')}));
});
const assets={
  '/xterm.js':[candidateRuntime('.artifacts/tests/native-input-p0/xterm-reflow-lab/xterm.js'),'application/javascript'],
  '/webgl.js':['node_modules/@xterm/addon-webgl/lib/addon-webgl.js','application/javascript'],
  '/xterm.css':['node_modules/@xterm/xterm/css/xterm.css','text/css']
};
const server=createServer(async(req,res)=>{
  if(req.url==='/display-module.js'){res.setHeader('Content-Type','application/javascript');res.end(await displayModuleJavaScript());return;}
  try{const asset=assets[req.url];res.setHeader('Content-Type',asset?asset[1]:'text/html');
    res.end(asset?await readFile(asset[0]):'<!doctype html><link rel="stylesheet" href="/xterm.css"><div id="a"></div><div id="b"></div><script src="/xterm.js"></script><script src="/webgl.js"></script>');}
  catch(error){res.writeHead(500).end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const results=[];
try{
  for(const [engine,type]of [['chromium',chromium],['webkit',webkit]]){
    const browser=await type.launch({headless:true});
    try{for(const renderer of ['dom','webgl']){
      const page=await browser.newPage();
      try{
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        for(const trial of trials){
          const state=await page.evaluate(async({trial,renderer,formalRuntime})=>{
            const displayModule=formalRuntime?await import('/display-module.js'):undefined,controllers=[];
            function create(id){
              const target=document.querySelector(id);target.replaceChildren();
              const term=new Terminal({cols:100,rows:24,scrollback:1000,reflowCursorLine:false,allowProposedApi:true});
              term.open(target);if(renderer==='webgl')term.loadAddon(new WebglAddon.WebglAddon());
              if(displayModule)controllers.push(displayModule.attachNativeInputDisplay(term,{inputMode:'native-inline',oscIdentifier:1337,
                enterPayload:'SetUserVar=ShellSpanP0ReflowCursorLine=MQ==',exitPayload:'SetUserVar=ShellSpanP0ReflowCursorLine=MA=='}));
              else term.parser.registerOscHandler(1337,data=>{
                if(data==='SetUserVar=ShellSpanP0ReflowCursorLine=MQ=='){term.options.reflowCursorLine=true;return true;}
                if(data==='SetUserVar=ShellSpanP0ReflowCursorLine=MA=='){term.options.reflowCursorLine=false;return true;}
                return false;
              });return term;
            }
            const term=create('#a'),reference=create('#b');
            const write=(target,b64)=>new Promise(resolve=>target.write(Uint8Array.from(atob(b64),c=>c.charCodeAt(0)),resolve));
            for(const target of [term,reference])await write(target,trial.prefix);
            const before=term.options.reflowCursorLine;
            term.resize(32,24);term.resize(40,24);
            const during=term.options.reflowCursorLine;
            for(const target of [term,reference])await write(target,trial.suffix);
            const after=term.options.reflowCursorLine;
            // Select through the actual cursor, excluding untouched viewport
            // padding. No content, internal space, or emitted LF is normalized.
            const copy=target=>{
              const buffer=target.buffer.active;
              target.select(0,0,(buffer.baseY+buffer.cursorY)*target.cols+buffer.cursorX);
              return target.getSelection();
            };
            const equalCopy=copy(term)===copy(reference);
            controllers.forEach(controller=>controller.dispose());term.dispose();reference.dispose();return {before,during,after,equalCopy};
          },{trial,renderer,formalRuntime});
          const pass=state.before===trial.off&&state.during===trial.off&&state.after===!trial.off&&state.equalCopy;
          results.push({engine,renderer,signal:trial.off?'off':'on',split:trial.split,...state,result:pass?'PASS':'FAIL'});
        }
      }finally{await page.close();}
    }}finally{await browser.close();}
  }
}finally{server.close();}
await writeFile(path.join(output,'summary.json'),JSON.stringify({kind:'library-only resize inside actual captured native OSC packets',installedRuntime:installed,results},null,2));
const failures=results.filter(item=>item.result==='FAIL');
console.log(JSON.stringify({trials:results.length,failed:failures.length}));
if(failures.length)process.exitCode=1;
