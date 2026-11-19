import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {build} from 'vite';
import {chromium} from 'playwright';
import {inside} from '../../../../scripts/native-input/acceptance/acceptance-inputs.mjs';

const root=resolve(import.meta.dirname,'../../../..'),directory=resolve(root,'artifacts/tests/native-package-viewport',randomUUID());await mkdir(directory,{recursive:true});
assert(process.argv[2],'Explicit retained package directory required');
const artifact=fs.realpathSync(process.argv[2]);inside(resolve(root,'artifacts/tests'),artifact);
const assets=JSON.parse(fs.readFileSync(resolve(artifact,'frontend-assets.json'),'utf8'));
const cssName=Object.keys(assets).find(name=>name.endsWith('.css'));assert(cssName,'Retained package CSS missing');
const cssPath=resolve(artifact,'frontend',cssName),css=fs.readFileSync(cssPath,'utf8');assert.equal(createHash('sha256').update(css).digest('hex'),assets[cssName]);
const bundle=await build({configFile:false,root,logLevel:'error',build:{write:false,minify:false,lib:{entry:resolve(import.meta.dirname,'native-package-viewport.ts'),name:'PackageViewport',formats:['iife']}}});
const code=(Array.isArray(bundle)?bundle:[bundle]).flatMap(item=>item.output).find(item=>item.type==='chunk').code;
let browser,failure;const records=[];
try{
 browser=await chromium.launch({headless:true});
 for(const viewport of [{width:1480,height:920},{width:960,height:600}]){
  const page=await browser.newPage({viewport});await page.setContent('<!doctype html><html><body><div id="root"></div><div id="status"></div></body></html>');
  await page.addStyleTag({content:css});await page.addScriptTag({content:code});
  const result=await page.evaluate(async()=>{
   const fixture=window.PackageViewport,old=document.createElement('div');old.style.cssText='width:100vw;height:100vh';document.body.append(old);
   let oldLayoutRejected=false;try{fixture.nativePackageViewport(old);}catch{oldLayoutRejected=true;}old.remove();
   const host=fixture.createNativePackageHost();host.textContent='PACKAGE_LAYOUT_VISIBLE';await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
   return {oldLayoutRejected,parent:host.parentElement.id,viewport:fixture.nativePackageViewport(host)};
  });
  assert(result.oldLayoutRejected,'Old offscreen layout was not reproduced');assert.equal(result.parent,'root');
  await page.screenshot({path:resolve(directory,`layout-${viewport.width}.png`)});records.push(result);await page.close();
 }
}catch(error){failure=String(error);}finally{await browser?.close();}
await writeFile(resolve(directory,'result.json'),JSON.stringify({ok:!failure,failure,records,cssPath,cssSha256:assets[cssName],validation:'browser-layout-only',nativeAcceptance:false,fullAcceptancePassed:false},null,2),{flag:'wx'});
console.log(JSON.stringify({directory,ok:!failure,windows:records.length,failure}));process.exitCode=failure?1:0;
