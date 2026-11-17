import {afterEach,expect,it} from 'vitest';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {build} from 'vite';
import tailwindcss from '@tailwindcss/vite';
import {packageInputGuard,guardPackageWatchInputs,packageCssInputGuard} from '../native-input-p3/package-frontend.mjs';
import {inside} from '../native-input-p3/acceptance-inputs.mjs';

const base=resolve(import.meta.dirname,'../../artifacts/tests/package-frontend-guard'),roots=[];
async function fixture(files){
  await mkdir(base,{recursive:true});const root=await mkdtemp(resolve(base,'case-'));roots.push(root);
  for(const [name,content]of Object.entries(files)){const path=resolve(root,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,content);}
  return root;
}
afterEach(async()=>{for(const root of roots.splice(0)){inside(base,root);await rm(root,{recursive:true,force:true});}});

it('validates the module graph using only the supported Rolldown context API',()=>{
  const guard=packageInputGuard(base);
  const context={getModuleIds:()=>['/repo/src/main.ts'][Symbol.iterator]()};
  expect(()=>guard.generateBundle.call(context)).not.toThrow();
  expect(()=>guard.generateBundle.call({getModuleIds:()=>['/repo/node_modules/.vite/deps/react.js'][Symbol.iterator]()})).toThrow('Generated Vite cache');
  expect(()=>guard.generateBundle.call({getModuleIds:()=>['D:\\repo\\NODE_MODULES\\.VITE\\deps\\react.js'][Symbol.iterator]()})).toThrow('Generated Vite cache');
});

it('checks framework watch dependencies while preserving hook filters and context receivers',()=>{
  class Context{
    #files=[];
    addWatchFile(id){this.#files.push(id);}
    get files(){return this.#files;}
    isContext(){return this.#files.length;}
  }
  const plugin={name:'framework',transform:{filter:{id:/\.css$/},handler(id){this.addWatchFile(id);return this.isContext();}}};
  const guarded=guardPackageWatchInputs([plugin])[0],context=new Context();
  expect(guarded.transform.filter).toBe(plugin.transform.filter);
  expect(guarded.transform.handler.call(context,'/repo/src/part.css')).toBe(1);
  expect(()=>guarded.transform.handler.call(context,'/repo/node_modules/.vite/cached.css')).toThrow('Generated Vite cache');
  expect(context.files).toEqual(['/repo/src/part.css']);expect(plugin.transform.handler).not.toBe(guarded.transform.handler);
});

async function compile(root,{tailwind=false}={}){
  return build({configFile:false,root,logLevel:'silent',mode:'production',cacheDir:resolve(root,'vite-cache'),
    plugins:[packageInputGuard(root),...(tailwind?[guardPackageWatchInputs(tailwindcss())]:[])],
    css:{postcss:{plugins:[packageCssInputGuard()]}},
    build:{write:false,rolldownOptions:{input:resolve(root,'main.js')}}});
}

it('builds ordinary CSS dependencies with the actual Vite/Rolldown adapter',async()=>{
  const root=await fixture({'main.js':"import './plain.css';",'plain.css':"@import './part.css'; .allowed { color: red; }",'part.css':'.part { display: block; }'});
  const result=await compile(root);expect(result.output.some(item=>item.type==='asset'&&item.fileName.endsWith('.css'))).toBe(true);
});

it('rejects an actual generated-cache JavaScript import',async()=>{
  const root=await fixture({'main.js':"export {payload} from './generated/node_modules/.vite/cache.js';",'generated/node_modules/.vite/cache.js':'export const payload="untrusted cache";'});
  await expect(compile(root)).rejects.toThrow('Generated Vite cache');
});

it('rejects a CSS-only cache dependency that is not a JavaScript module',async()=>{
  const root=await fixture({'main.js':"import './plain.css';",'plain.css':"@import './generated/node_modules/.vite/cache.css';",'generated/node_modules/.vite/cache.css':'.cache { color: red; }'});
  await expect(compile(root)).rejects.toThrow('Generated Vite cache');
});

it('rejects a Tailwind stylesheet cache dependency when the framework registers its watch input',async()=>{
  const root=await fixture({'main.js':"import './src/styles/base.css';",'src/styles/base.css':"@import 'tailwindcss';\n@import '../../generated/node_modules/.vite/cache.css';",'generated/node_modules/.vite/cache.css':'.cache { color: red; }'});
  await expect(compile(root,{tailwind:true})).rejects.toThrow('Generated Vite cache');
});
