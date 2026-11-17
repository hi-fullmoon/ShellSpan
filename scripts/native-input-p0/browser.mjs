// Real PTY recordings -> unmodified xterm public API. No registry/projection,
// source replacement, synthetic output or internal renderer access.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { spawnSync } from 'node:child_process';
import {formalRuntime,candidateRuntime,installedRuntimeManifest} from './formal-runtime.mjs';
const installed=formalRuntime?await installedRuntimeManifest():undefined;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const unicode11 = process.env.SHELLSPAN_P0_UNICODE === '11';
const input = process.env.SHELLSPAN_P0_CAPTURE_ROOT ?? 'artifacts/tests/native-input-p0/darwin-installed';
const backgroundOnly=process.env.SHELLSPAN_P0_BACKGROUND_ONLY==='1';
const reflowCursorLine=process.env.SHELLSPAN_P0_REFLOW_CURSOR==='1';
const xtermLab=process.env.SHELLSPAN_P0_XTERM_LAB==='1';
const xtermBaseline=process.env.SHELLSPAN_P0_XTERM_LAB==='baseline';
const output = path.resolve(process.env.SHELLSPAN_P0_OUTPUT_ROOT??path.resolve(root,input,'browser',`unicode${unicode11?'11':'6'}`,`${backgroundOnly?'background-only':'full'}${formalRuntime?'-formal':''}${reflowCursorLine?'-cursor-reflow':''}${xtermLab?'-dependency-lab':xtermBaseline?'-dependency-baseline':''}`));
await mkdir(output, { recursive: true });
if (unicode11) {
  const dependencies = path.join(root,'artifacts/tests/native-input-p0/browser-deps');
  await mkdir(dependencies,{recursive:true});
  await writeFile(path.join(dependencies,'package.json'),await readFile(path.join(root,'scripts/native-input-p0/browser-dependencies.json')));
  const installed=spawnSync('pnpm',['install','--dir',dependencies,'--ignore-workspace','--ignore-scripts'],{cwd:root,encoding:'utf8'});
  assert.equal(installed.status,0,installed.stderr);
}
const captureRoot = path.resolve(root, input);
const captures = (await readdir(captureRoot, { withFileTypes: true })).filter(item => item.isDirectory());
let causalSource;
let causalMode;
try { const metadata=JSON.parse(await readFile(path.join(captureRoot,'inputs.json'),'utf8')); causalSource=metadata.schedule?.source;causalMode=metadata.mode; } catch {}
const sourceCapture = captures.find(item => item.name.startsWith('source-binding-native-submit-'));
const backgroundCapture = captures.find(item => item.name.startsWith('background-resize-unicode-'));
const geometries = captures.filter(item => item.name.startsWith('geometry-'));
if(!backgroundOnly) assert(sourceCapture, `Missing native source capture: ${captureRoot}`);
assert(backgroundCapture, `Missing native background/resize capture: ${captureRoot}`);
if(!backgroundOnly) assert.equal(geometries.length, 16, 'Need real user/bridge normal and oversized geometry pairs for all four widths');
const assets = new Map([
  ['/xterm.js', [candidateRuntime(xtermLab?'artifacts/tests/native-input-p0/xterm-reflow-lab/xterm.js':xtermBaseline?'artifacts/tests/native-input-p0/xterm-reflow-lab/xterm-baseline.js':'node_modules/@xterm/xterm/lib/xterm.js'),'application/javascript']],
  ['/search.js', ['node_modules/@xterm/addon-search/lib/addon-search.js','application/javascript']],
  ['/webgl.js', ['node_modules/@xterm/addon-webgl/lib/addon-webgl.js','application/javascript']],
  ['/xterm.css', ['node_modules/@xterm/xterm/css/xterm.css','text/css']],
  ['/unicode11.js', ['artifacts/tests/native-input-p0/browser-deps/node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js','application/javascript']],
]);
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/xterm.css">
<style>body { margin: 12px; background: #151515; } #surface { width: 1800px; height: 640px; }</style>
<div id="surface"></div><script src="/xterm.js"></script><script src="/search.js"></script><script src="/webgl.js"></script>${unicode11?'<script src="/unicode11.js"></script>':''}`;
const server = createServer(async (request, response) => {
  try {
    const asset = assets.get(request.url);
    response.setHeader('Content-Type', asset ? asset[1] : 'text/html');
    response.end(asset ? await readFile(path.join(root, asset[0])) : html);
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const results = [];
const environment={node:process.version,platform:process.platform,arch:process.arch,
  installedRuntime:installed,
  playwright:JSON.parse(await readFile(path.join(root,'node_modules/playwright/package.json'),'utf8')).version,
  xterm:JSON.parse(await readFile(path.join(root,'node_modules/@xterm/xterm/package.json'),'utf8')).version,
  captureRoot,unicode:unicode11?'11':'6',reflowCursorLine,xtermLab,
  xtermLabManifest:xtermLab||xtermBaseline?JSON.parse(await readFile(path.join(root,`artifacts/tests/native-input-p0/xterm-reflow-lab/${xtermBaseline?'baseline-':''}manifest.json`),'utf8')):null,browsers:{}};
try {
  for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await type.launch({ headless: true });
    environment.browsers[engine]=browser.version();
    try {
      for (const renderer of ['dom', 'webgl']) {
        for (const theme of ['dark','light']) {
          const page = await browser.newPage({ viewport: { width: 1900, height: 760 } });
          const errors=[];
          try {
          await page.goto(url);
          async function initialize() {
            return page.evaluate(async ({renderer,theme,unicode11,reflowCursorLine,reference}) => {
              window.term?.dispose();
              document.querySelector('#surface').replaceChildren();
              window.term = new Terminal({ cols:100, rows:24, scrollback:10000,allowProposedApi:true,reflowCursorLine,
                fontFamily:'monospace',fontSize:14,
                theme:theme==='dark'?{background:'#151515',foreground:'#eeeeee'}:{background:'#ffffff',foreground:'#111111'} });
              window.search = new SearchAddon.SearchAddon();
              term.loadAddon(search);
              term.open(document.querySelector('#surface'));
              window.editingTrace=[];
              window.tracingEditing=false;
              for(const final of ['A','B','C','D','E','F','G','H','J','K','L','M','P','S','T','X','@'])
                term.parser.registerCsiHandler({final},parameters=>{
                  if(window.tracingEditing) editingTrace.push({final,parameters});
                  return false;
                });
              window.referenceTerm?.dispose();
              document.querySelector('#reference')?.remove();
              window.referenceTerm=null;
              if(reference) {
                const container=document.createElement('div');
                container.id='reference';container.style.cssText='position:fixed;left:-10000px;width:1800px;height:640px';
                document.body.appendChild(container);
                window.referenceTerm=new Terminal({cols:100,rows:24,scrollback:10000,fontFamily:'monospace',fontSize:14,reflowCursorLine:true});
                referenceTerm.open(container);
              }
              if(unicode11) { term.loadAddon(new Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion='11'; }
              term.focus();
              if(renderer==='webgl') term.loadAddon(new WebglAddon.WebglAddon());
              await document.fonts.ready;
              await new Promise(resolve=>{
                const subscription=term.onRender(()=>{subscription.dispose();resolve();});
                term.refresh(0,term.rows-1);
              });
              await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
            }, {renderer,theme,unicode11,reflowCursorLine,reference:causalMode==='append-display'});
          }
          async function write(frame) {
            await page.evaluate(async frame => {
              if(frame.resize) term.resize(...frame.resize);
              if(frame.bytes) {
                const bytes=Uint8Array.from(atob(frame.bytes),c=>c.charCodeAt(0));
                await new Promise(resolve => term.write(bytes,resolve));
                if(window.referenceTerm) await new Promise(resolve=>referenceTerm.write(bytes,resolve));
              }
            }, frame);
          }
          async function state() {
            return page.evaluate(() => {
              const buffer=term.buffer.active;
              return { x:buffer.cursorX,y:buffer.cursorY,base:buffer.baseY,
                lines:Array.from({length:buffer.length},(_,i)=>buffer.getLine(i)?.translateToString(true)) };
            });
          }
          async function capture(filename) {
            await page.evaluate(async () => {
              await document.fonts.ready;
              await new Promise(resolve=>{
                const subscription=term.onRender(()=>{subscription.dispose();resolve();});
                term.refresh(0,term.rows-1);
              });
              await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
            });
            const dom=await page.evaluate(()=>({
              rows:document.querySelector('.xterm-rows')?.textContent,
              width:document.querySelector('.xterm-screen').getBoundingClientRect().width,
              height:document.querySelector('.xterm-screen').getBoundingClientRect().height,
              viewportY:term.buffer.active.viewportY,
            }));
            await writeFile(path.join(output,`${filename}.json`),JSON.stringify(dom,null,2));
            await page.screenshot({path:path.join(output,filename)});
          }
          if(!backgroundOnly) {
          const geometryStates = new Map();
          const appendColumns=new Set();
          for (const entry of geometries) {
            await initialize();
            const directory=path.join(captureRoot,entry.name);
            const metadata=JSON.parse(await readFile(path.join(directory,'geometry.json'),'utf8'));
            const timeline=JSON.parse(await readFile(path.join(directory,'timeline.json'),'utf8'));
            for(const frame of timeline) { if(frame.checkpoint==='geometry') break; await write(frame); }
            const observed=await state();
            if(metadata.display_profile==='append' && metadata.mode==='bridge') {
              appendColumns.add(metadata.columns);
              const visible=await page.evaluate(source=>{
                const found=search.findNext(source),selected=term.getSelection();
                const b=term.buffer.active;
                term.select(0,0,(b.baseY+b.cursorY)*term.cols+b.cursorX);
                const all=term.getSelection();term.clearSelection();
                return {found,selected,all};
              },metadata.source);
              assert(visible.found && visible.selected===metadata.source,'Actual native command is not fully searchable/copyable');
              assert.equal(visible.all,`USER_PROMPT\nP0> ${metadata.source}`,'Unexpected blank lines, replay or lost input in the native display');
            }
            if(metadata.display_profile==='preserve') {
              observed.input=await page.evaluate(()=>{
                const b=term.buffer.active,end=b.baseY+b.cursorY;
                let start=end;
                while(start>=0 && !b.getLine(start)?.translateToString(true).startsWith("P0> printf")) start--;
                if(start<0) return null;
                term.select(0,start,(end-start)*term.cols+b.cursorX);
                const copied=term.getSelection();
                term.clearSelection();
                return {cursorX:b.cursorX,cursorRow:end-start,
                  lines:Array.from({length:end-start+1},(_,i)=>b.getLine(start+i)?.translateToString(true)),copied};
              });
              assert(observed.input,'Native input span not found in the known display-only fixture');
            }
            assert(!observed.lines.join('\n').includes('builtin eval --'));
            geometryStates.set(`${metadata.columns}-${metadata.size}-${metadata.mode}`,observed);
            await writeFile(path.join(output,`${engine}-${renderer}-${theme}-${metadata.columns}-${metadata.size}-${metadata.mode}.json`),JSON.stringify(observed,null,2));
            if(metadata.mode==='bridge' && theme==='dark')
              await capture(`${engine}-${renderer}-${metadata.columns}-${metadata.size}.png`);
          }
          for(const columns of [32,40,100,180]) {
            for(const size of ['normal','oversize']) {
            try {
              const actual=geometryStates.get(`${columns}-${size}-bridge`),expected=geometryStates.get(`${columns}-${size}-user`);
              if(!appendColumns.has(columns)) assert.deepEqual(actual,expected,
                `${engine}/${renderer}/${theme}: native user vs bridge ${size} geometry at ${columns}`);
            } catch(error) { errors.push({columns,size,error:error.message}); }
            }
          }
          await initialize();
          const timeline=JSON.parse(await readFile(path.join(captureRoot,sourceCapture.name,'timeline.json'),'utf8'));
          let committed=false;
          for(const frame of timeline) {
            if(frame.event?.event==='InputConfirmed' && !committed) {
              await capture(`${engine}-${renderer}-${theme}-before.png`);
            }
            await write(frame);
            if(frame.event?.event==='Settled' && !committed) {
              committed=true;
              await capture(`${engine}-${renderer}-${theme}-after.png`);
              const observed=await state();
              assert(!observed.lines.join('\n').includes('builtin eval --'));
              assert(observed.lines.join('\n').includes('SHORT_OK'));
              const selection=await page.evaluate(()=>{
                const found=search.findNext('SHORT_OK');
                const selection=term.getSelection();
                term.selectAll();
                return {found,selection,all:term.getSelection(), focused:document.activeElement===document.querySelector('.xterm-helper-textarea')};
              });
              assert(selection.found && selection.selection==='SHORT_OK' && selection.focused);
              assert(selection.all.includes('SHORT_OK'));
            }
          }
          assert(committed);
          }
          await initialize();
          const backgroundTimeline=JSON.parse(await readFile(path.join(captureRoot,backgroundCapture.name,'timeline.json'),'utf8'));
          let backgroundWasVisible=false;
          for(const frame of backgroundTimeline) {
            if(frame.checkpoint==='editing-start') await page.evaluate(()=>{window.tracingEditing=true;});
            if(frame.checkpoint==='observed-end') break;
            if(frame.checkpoint==='before-submit') {
              const pending=await state();
              pending.editingCsiTrace=await page.evaluate(()=>{window.tracingEditing=false;return window.editingTrace;});
              if(causalSource) pending.sourceSearch=await page.evaluate(source=>{
                const found=search.findNext(source);
                const selected=term.getSelection();
                term.clearSelection();
                return {found,selected};
              },causalSource);
              await writeFile(path.join(output,`${engine}-${renderer}-${theme}-background-before-submit.json`),JSON.stringify(pending,null,2));
              await capture(`${engine}-${renderer}-${theme}-background-before-submit.png`);
            }
            await write(frame);
            if(frame.bytes && !backgroundWasVisible && (await state()).lines.some(line=>line.includes('BG_1'))) {
              backgroundWasVisible=true;
              await capture(`${engine}-${renderer}-${theme}-background-before.png`);
            }
          }
          const backgroundState=await state();
          backgroundState.backgroundWasVisible=backgroundWasVisible;
          if(causalMode==='append-display') {
            backgroundState.nativeStreamComparison=await page.evaluate(()=>{
              term.selectAll();referenceTerm.selectAll();
              const result={resized:term.getSelection(),unresized:referenceTerm.getSelection()};
              term.clearSelection();referenceTerm.clearSelection();return result;
            });
          }
          await writeFile(path.join(output,`${engine}-${renderer}-${theme}-background.json`),JSON.stringify(backgroundState,null,2));
          await capture(`${engine}-${renderer}-${theme}-background.png`);
          for(let number=1;number<=5;number++) {
            assert(backgroundState.lines.some(line=>line.includes(`BG_${number}`)),`Rendered background output BG_${number} was lost`);
          }
          if(causalMode==='append-display') assert.equal(backgroundState.nativeStreamComparison.resized,
            backgroundState.nativeStreamComparison.unresized,'Resize changed the actual copied native stream');
          } catch(error) { errors.push({error:error.stack}); }
          finally { await page.close(); }
          results.push({engine,renderer,theme,result:errors.length?'FAIL':'PASS',scope:backgroundOnly?'background':'full',geometryColumns:backgroundOnly?[]:[32,40,100,180],errors});
        }
      }
    } finally { await browser.close(); }
  }
  await writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2));
  await writeFile(path.join(output,'environment.json'),JSON.stringify(environment,null,2));
  console.log(`P0 browser: ${results.filter(item=>item.result==='PASS').length}/8 lanes passed; source=${input}; ${output}`);
  process.exitCode=results.some(item=>item.result!=='PASS')?1:0;
} finally { server.close(); }
