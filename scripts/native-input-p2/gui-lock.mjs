import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';

export function assertNativeGuiAllowed(){
  assert.equal(process.env.SHELLSPAN_ALLOW_FOREGROUND_TESTS,'1',
    'Native App acceptance is disabled by default because it can take desktop focus. Use SHELLSPAN_ALLOW_FOREGROUND_TESTS=1 only for an explicitly scheduled acceptance run; compilation, type and static checks do not need it.');
}

export async function acquireNativeGui(){
  assertNativeGuiAllowed();
  const root=resolve(import.meta.dirname,'../../.native-input-p2');mkdirSync(root,{recursive:true});
  const directory=resolve(root,'gui-lock');const deadline=Date.now()+900000;
  while(true){
    try{mkdirSync(directory,{mode:0o700});writeFileSync(resolve(directory,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});break;}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      try{const owner=JSON.parse(readFileSync(resolve(directory,'owner.json'),'utf8'));assert(Number.isSafeInteger(owner.pid)&&owner.pid>1);try{process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH'){rmSync(directory,{recursive:true});continue;}throw error;}}
      catch(error){if(error.code!=='ENOENT')throw error;}
      assert(Date.now()<deadline,'Another native GUI validation did not release the owned lock');
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  }
  const release=()=>{try{const owner=JSON.parse(readFileSync(resolve(directory,'owner.json'),'utf8'));if(owner.pid===process.pid)rmSync(directory,{recursive:true});}catch(error){if(error.code!=='ENOENT')throw error;}};
  process.once('exit',release);return release;
}
