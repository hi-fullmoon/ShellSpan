import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {dirname,isAbsolute,join,resolve,sep} from 'node:path';

// Test infrastructure only. Persist the actual child exit before callers inspect
// metadata or propagate a capture failure. No environment or model input is saved.
export function runOwnedCaptureCommand({program,args,evidence,timeoutMs}) {
  const allowed=resolve(import.meta.dirname,'../../../artifacts/tests');
  assert(isAbsolute(evidence)&&resolve(evidence).startsWith(allowed+sep));
  let cursor=resolve(evidence);
  for(;;){const info=fs.lstatSync(cursor);assert(info.isDirectory()&&!info.isSymbolicLink()&&resolve(fs.realpathSync(cursor))===cursor);if(cursor===allowed)break;cursor=dirname(cursor);}
  assert(typeof program==='string'&&Array.isArray(args)&&args.every(value=>typeof value==='string')&&Number.isSafeInteger(timeoutMs)&&timeoutMs>0);
  const recordPath=join(evidence,'native-capture-command-'+randomUUID()+'.json'),start=new Date().toISOString();
  return new Promise((complete,reject)=>{
    let actualExitCode=null,actualSignal=null,actualExitSeen=false;
    const child=execFile(program,args,{timeout:timeoutMs,maxBuffer:65536,windowsHide:true},(error,stdout,stderr)=>{
      const record={pid:child.pid??null,program,args,start,end:new Date().toISOString(),actualExitSeen,exitCode:actualExitCode,signal:actualSignal,timeoutMs,
        callbackCode:error?.code??null,callbackKilled:error?.killed??false,stderr:stderr.slice(0,4096),scope:'Owned capture command only; no native execution or screenshot success inferred from this record'};
      try{fs.writeFileSync(recordPath,JSON.stringify(record,null,2),{flag:'wx',mode:0o600});}catch(writeError){reject(writeError);return;}
      if(error){reject(new Error(stderr||error.message));return;}
      if(!actualExitSeen||actualExitCode!==0){reject(new Error('Capture process has no confirmed zero exit'));return;}
      complete({stdout,recordPath,record});
    });
    child.once('exit',(code,signal)=>{actualExitSeen=true;actualExitCode=code;actualSignal=signal;});
  });
}
