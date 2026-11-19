// Actual native App capture: preserve its original bytes and reproduce the
// ordinary-keyboard echo before comparing the corrected display configuration.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {chromium,webkit} from 'playwright';
import {displayModuleJavaScript,installedRuntimeManifest} from '../../../../scripts/native-input/prototype/formal-runtime.mjs';
import {captureValidationSources} from '../../../../scripts/native-input/integration/frozen-validation.mjs';

const root=resolve(import.meta.dirname,'../../../..'),fixture=JSON.parse(await readFile(resolve(import.meta.dirname,'fixtures/native-zle-ordinary-keyboard.json'),'utf8'));
assert.equal(createHash('sha256').update(fixture.raw).digest('hex'),fixture.rawSha256);
assert.equal(fixture.kind,'actual-macos-zle-ordinary-keyboard-capture');assert.equal(fixture.originalBinding.unicodeVersion,'11');assert.equal(fixture.originalBinding.unicodeScope,undefined);
const sources=captureValidationSources(root),runtime=await installedRuntimeManifest(),display=await displayModuleJavaScript();
const directory=resolve(root,'artifacts/tests/native-input/acceptance/ordinary-unicode-browser',randomUUID());await mkdir(directory,{recursive:true});
const assets={'/xterm.js':'node_modules/@xterm/xterm/lib/xterm.js','/xterm.css':'node_modules/@xterm/xterm/css/xterm.css','/unicode.js':'node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js','/webgl.js':'node_modules/@xterm/addon-webgl/lib/addon-webgl.js'};
const server=createServer(async(request,response)=>{try{
 if(request.url==='/display.js'){response.setHeader('Content-Type','application/javascript');response.end(display);return;}
 const file=assets[request.url];response.setHeader('Content-Type',file?(request.url.endsWith('.css')?'text/css':'application/javascript'):'text/html');response.end(file?await readFile(resolve(root,file)):'<!doctype html><link rel="stylesheet" href="/xterm.css"><div id="surface"></div><script src="/xterm.js"></script><script src="/unicode.js"></script><script src="/webgl.js"></script>');
}catch(error){response.writeHead(500).end(String(error));}});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const results=[];let failure;
try{
 for(const [engine,type]of [['chromium',chromium],['webkit',webkit]]){
  const browser=await type.launch({headless:true});try{
   for(const renderer of ['dom','webgl'])for(const configuration of ['original-input-only','corrected-session']){
    const page=await browser.newPage({viewport:{width:2200,height:1000}});try{
     await page.goto(`http://127.0.0.1:${server.address().port}`);
     const actual=await page.evaluate(async({fixture,renderer,configuration})=>{
      const module=await import('/display.js'),term=new Terminal({cols:fixture.geometry.columns,rows:fixture.geometry.rows,scrollback:10000,reflowCursorLine:false,allowProposedApi:true});term.open(document.querySelector('#surface'));if(renderer==='webgl')term.loadAddon(new WebglAddon.WebglAddon());term.loadAddon(new Unicode11Addon.Unicode11Addon());
      const before={unicode:term.unicode.activeVersion,selection:term.getSelection,line:term.buffer.normal.getLine,open:term.open},responses=[];term.onData(value=>responses.push(value));
      const binding={...fixture.originalBinding,...(configuration==='corrected-session'?{unicodeScope:'session'}:{})};
      const mode=module.attachNativeInputDisplay(term,binding,{unicodeVersion:binding.unicodeVersion,unicodeScope:binding.unicodeScope});
      await new Promise(done=>term.write(fixture.raw,done));const rows=Array.from({length:term.buffer.normal.length},(_,index)=>term.buffer.normal.getLine(index)?.translateToString(true)??'');
      const echo=rows.find(line=>line.includes(fixture.marker)&&line.includes('printf'))??null,output=rows.find(line=>line.startsWith(fixture.marker+' '))??null,activeVersion=term.unicode.activeVersion,reflow=term.options.reflowCursorLine;
      await mode.closeAfterPendingOutput();return{echo,output,rows,activeVersion,reflow,restoredVersion:term.unicode.activeVersion,originalVersion:before.unicode,restoredReflow:term.options.reflowCursorLine,publicApisUnmodified:before.selection===term.getSelection&&before.line===term.buffer.normal.getLine&&before.open===term.open,responses};
     },{fixture,renderer,configuration});
     await page.screenshot({path:resolve(directory,`${engine}-${renderer}-${configuration}.png`)});results.push({engine,renderer,configuration,...actual});
     assert.equal(actual.output,fixture.expectedOutput);assert(actual.publicApisUnmodified);assert.deepEqual(actual.responses,[]);assert.equal(actual.reflow,false);assert.equal(actual.restoredReflow,false);assert.equal(actual.restoredVersion,actual.originalVersion);
     if(configuration==='original-input-only'){assert.equal(actual.echo,fixture.originalCorruptEcho);assert.equal(actual.activeVersion,'6');}
     else{assert.equal(actual.echo,fixture.expectedCorrectedEcho);assert.equal(actual.activeVersion,'11');assert(actual.echo.startsWith('MANUAL-CHECK> printf '));assert(actual.echo.endsWith(" edit=BAD'"));}
    }finally{await page.close();}
   }
  }finally{await browser.close();}
 }
}catch(error){failure=String(error);throw error;}
finally{
 await new Promise(done=>server.close(done));assert.deepEqual(captureValidationSources(root),sources);assert.deepEqual(await installedRuntimeManifest(),runtime);
 await writeFile(resolve(directory,'result.json'),JSON.stringify({status:failure?'failed':'passed',failure,sourceFixtureSha256:fixture.rawSha256,sourceCount:Object.keys(sources).length,runtime,expected:8,completed:results.length,results,scope:'Actual captured ordinary ZLE input stream under original and corrected Unicode scopes. Does not generate keyboard/PTY input, host negotiation, execution receipts or native App acceptance.'},null,2));
}
assert.equal(results.length,8);console.log(JSON.stringify({directory,cases:8,passed:true}));
