import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {captureValidationAssets} from '../native-input-p2/frozen-validation.mjs';
import {packageLoader,packageDefines} from './package-launch.mjs';

export function scopePackageStyles(code){
  const source="@import 'tailwindcss';";if(!code.includes(source))throw Error('Reviewed Tailwind import changed');
  // This CSS belongs to the acceptance artifact only. Every frozen src file
  // remains a class source; generated resources and Cargo output are not UI.
  return code.replace(source,"@import 'tailwindcss' source(none);\n@source '../';");
}
export function assertPackageModuleInput(id){
  if(/\/node_modules\/\.vite(?:\/|$)/i.test(('/'+id.replaceAll('\\','/')).split('?')[0]))throw Error('Generated Vite cache cannot be a package build input');
}

export function guardPackageWatchInputs(plugin){
  if(Array.isArray(plugin))return plugin.map(guardPackageWatchInputs);
  const guarded={...plugin};
  // Rolldown exposes addWatchFile, but not Rollup's getWatchFiles. Check each
  // dependency when the owned framework plugin registers it, including CSS
  // files that never become module-graph entries.
  for(const name of ['buildStart','resolveId','load','transform','buildEnd','generateBundle']){
    const hook=plugin[name],handler=typeof hook==='function'?hook:hook?.handler;
    if(!handler)continue;
    const wrapped=function(...args){
      const context=new Proxy(this,{get(target,key){
        if(key==='addWatchFile')return id=>{assertPackageModuleInput(id);return target.addWatchFile(id);};
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }});
      return Reflect.apply(handler,context,args);
    };
    guarded[name]=typeof hook==='function'?wrapped:{...hook,handler:wrapped};
  }
  return guarded;
}

export function packageInputGuard(root){
  const styles=resolve(root,'src/styles/base.css').replaceAll('\\','/');
  return {
    name:'acceptance-frozen-style-sources',enforce:'pre',
    transform(code,id){assertPackageModuleInput(id);if(id.split('?')[0].replaceAll('\\','/')===styles)return scopePackageStyles(code);},
    generateBundle(){for(const id of this.getModuleIds())assertPackageModuleInput(id);},
  };
}

export function packageCssInputGuard(){
  return {postcssPlugin:'acceptance-css-inputs',OnceExit(_root,{result}){
    for(const message of result.messages){
      if(message.type==='dependency'&&message.file)assertPackageModuleInput(message.file);
      if(message.type==='dir-dependency'&&message.dir)assertPackageModuleInput(message.dir+'/');
    }
  }};
}

export async function buildPackageFrontend(root,directory,origin,id){
  const entry=resolve(directory,'batch.html'),loader=resolve(directory,'batch-loader.ts');
  await writeFile(entry,'<!doctype html><html><body><div id="root"></div><div id="status"></div><script type="module" src="./batch-loader.ts"></script></body></html>',{flag:'wx'});
  await writeFile(loader,packageLoader(origin,id),{flag:'wx'});
  const started=performance.now();
  await build({configFile:false,root,mode:'production',cacheDir:resolve(directory,'vite-cache'),base:'/',logLevel:'error',resolve:{alias:{'@':resolve(root,'src')}},plugins:[packageInputGuard(root),guardPackageWatchInputs(react()),guardPackageWatchInputs(tailwindcss())],define:packageDefines,
    css:{postcss:{plugins:[packageCssInputGuard()]}},
    build:{target:'esnext',outDir:resolve(directory,'frontend'),emptyOutDir:true,rolldownOptions:{input:entry}}});
  return {entry,loader,define:packageDefines,assets:captureValidationAssets(resolve(directory,'frontend')),durationMs:performance.now()-started};
}
