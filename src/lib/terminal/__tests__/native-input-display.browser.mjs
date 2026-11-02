// Real installed xterm + actual native PTY mode packets; no mock terminal.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {createHash} from 'node:crypto';
import {displayModuleJavaScript,installedRuntimeManifest} from '../../../../scripts/native-input-p0/formal-runtime.mjs';
const installed=await installedRuntimeManifest();
const fixture=JSON.parse(await readFile(new URL('./fixtures/native-input-display.json',import.meta.url),'utf8'));
const decode=name=>{const packet=fixture.packets[name],bytes=Buffer.from(packet.base64,'base64');
  assert.equal(bytes.length,packet.length);assert.equal(createHash('sha256').update(bytes).digest('hex'),packet.sha256);return bytes;};
const on=decode('enter'),off=decode('exit');
const output=path.resolve(process.env.SHELLSPAN_P0_OUTPUT_ROOT??'.artifacts/tests/native-input-p0/formal-validation/display-controller');await mkdir(output,{recursive:true});
const assets={'/xterm.js':['node_modules/@xterm/xterm/lib/xterm.js','application/javascript'],
  '/webgl.js':['node_modules/@xterm/addon-webgl/lib/addon-webgl.js','application/javascript'],
  '/xterm.css':['node_modules/@xterm/xterm/css/xterm.css','text/css']};
const server=createServer(async(req,res)=>{
  if(req.url==='/display.js'){res.setHeader('Content-Type','application/javascript');res.end(await displayModuleJavaScript());return;}
  const asset=assets[req.url];res.setHeader('Content-Type',asset?asset[1]:'text/html');
  res.end(asset?await readFile(asset[0]):'<!doctype html><link rel="stylesheet" href="/xterm.css"><div id="surface"></div><script src="/xterm.js"></script><script src="/webgl.js"></script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const results=[];
try{
  for(const[engine,type]of[['chromium',chromium],['webkit',webkit]]){
    const browser=await type.launch({headless:true});
    try{for(const renderer of['dom','webgl']){
      const page=await browser.newPage();try{
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        const result=await page.evaluate(async({on,off,renderer})=>{
          const{attachNativeInputDisplay}=await import('/display.js');
          const binding={inputMode:'native-inline',oscIdentifier:1337,
            enterPayload:'SetUserVar=ShellSpanP0ReflowCursorLine=MQ==',exitPayload:'SetUserVar=ShellSpanP0ReflowCursorLine=MA=='};
          let assertions=0;const check=(condition,message)=>{assertions++;if(!condition)throw Error(message);};
          const term=new Terminal({cols:80,rows:24,allowProposedApi:true,reflowCursorLine:false});term.open(document.querySelector('#surface'));
          if(renderer==='webgl')term.loadAddon(new WebglAddon.WebglAddon());
          const inputs=[];term.onData(data=>inputs.push(data));
          const write=data=>new Promise(resolve=>term.write(Uint8Array.from(data),resolve));
          await write(on);check(term.options.reflowCursorLine===false,'Import installed a handler on raw terminal');
          for(const mode of['raw']){
            let rejected=false;try{attachNativeInputDisplay(term,{...binding,inputMode:mode});}catch{rejected=true;}
            check(rejected,`Installed native handler for ${mode}`);
          }
          const controller=attachNativeInputDisplay(term,binding);
          let duplicate=false;try{attachNativeInputDisplay(term,binding);}catch{duplicate=true;}
          check(duplicate,'Duplicate attachment accepted');
          await write(on.slice(0,-1));check(term.options.reflowCursorLine===false,'Partial OSC changed display');
          await write(on.slice(-1));check(term.options.reflowCursorLine===true,'Complete native OSC did not enter');
          await write(off);check(term.options.reflowCursorLine===false,'Native exit did not restore default');
          await write(on);controller.resetAfterTransportClosed();check(term.options.reflowCursorLine===false,'Transport end did not reset');
          await write(on);check(term.options.reflowCursorLine===false,'Late bytes reopened a closed controller');
          controller.dispose();controller.dispose();check(term.options.reflowCursorLine===false,'Dispose is not idempotent');
          const next=attachNativeInputDisplay(term,binding);await write(on);next.dispose();
          check(term.options.reflowCursorLine===false,'Explicit next attachment did not clean up');
          const nativeRedraw=attachNativeInputDisplay(term,{...binding,ownedReflowCursorLine:false});
          await write(on);check(term.options.reflowCursorLine===false,'Verified native redraw enabled cursor-line reflow');
          await write(off);check(term.options.reflowCursorLine===false,'Native redraw exit changed the ordinary baseline');
          nativeRedraw.dispose();
          let invalidReflow=false;try{attachNativeInputDisplay(term,{...binding,ownedReflowCursorLine:1});}catch{invalidReflow=true;}
          check(invalidReflow,'Invalid reflow capability was accepted');
          term.options.reflowCursorLine=true;let custom=false;try{attachNativeInputDisplay(term,binding);}catch{custom=true;}
          check(custom&&term.options.reflowCursorLine===true,'Attachment overwrote preexisting user option');
          check(inputs.length===0,'Display OSC emitted executable terminal input');
          term.dispose();return assertions;
        },{on:[...on],off:[...off],renderer});
        results.push({engine,renderer,assertions:result,result:'PASS'});
      }finally{await page.close();}
    }}finally{await browser.close();}
  }
}finally{server.close();}
await writeFile(path.join(output,'summary.json'),JSON.stringify({installed,results},null,2));
console.log(`native display public-API checks: ${results.length}/4; ${results.reduce((n,r)=>n+r.assertions,0)} assertions`);
