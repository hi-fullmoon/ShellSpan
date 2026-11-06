import {cp,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function copyNativeRebuildSources(root,tree){
  for(const name of ['src-tauri/native-input-editors','src-tauri/native-input-adapter','src-tauri/vendor/portable-pty']){
    await cp(resolve(root,name),resolve(tree,name),{recursive:true,filter:path=>!path.split(/[\\/]/).some(part=>['target','__pycache__'].includes(part))});
  }
  // The shipped Windows example compiles this real result-capture module.
  for(const name of ['protocol.rs','capture.rs']){
    const relative=`src-tauri/src/terminal_command/${name}`;
    await mkdir(resolve(tree,relative,'..'),{recursive:true});
    await cp(resolve(root,relative),resolve(tree,relative));
  }
}
