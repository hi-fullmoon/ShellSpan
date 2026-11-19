import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rmdir,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {lstatSync,realpathSync,openSync,readSync,closeSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';

export function watchBatchCancellation(path,runId,controller,{intervalMs=100}={}){
  assert(Number.isInteger(intervalMs)&&intervalMs>=10&&intervalMs<=1000);
  const poll=()=>{
    if(controller.signal.aborted)return;
    let fd;
    try{
      const info=lstatSync(path);
      assert(info.isFile()&&!info.isSymbolicLink()&&info.size<=4096);
      assert.equal(realpathSync.native(path).toLowerCase(),resolve(path).toLowerCase());
      fd=openSync(path,'r');const buffer=Buffer.alloc(4097),length=readSync(fd,buffer,0,buffer.length,0);assert(length<=4096);
      const request=JSON.parse(buffer.subarray(0,length).toString('utf8'));
      assert(request.version===1&&request.runId===runId);
      controller.abort(new Error('Explicit batch cancellation requested'));
    }catch(error){if(error.code!=='ENOENT')controller.abort(new Error('Invalid batch cancellation request'));}
    finally{if(fd!==undefined)closeSync(fd);}
  };
  const timer=setInterval(poll,intervalMs);timer.unref?.();return ()=>clearInterval(timer);
}

// No stale-lock stealing: an interrupted batch requires ownership review.
// This is additional to the existing global native GUI lock.
export async function withLease(directory,work,{signal,timeoutMs=900000}={}){
  await mkdir(resolve(directory,'..'),{recursive:true});const token=randomUUID(),deadline=Date.now()+timeoutMs;
  while(true){
    signal?.throwIfAborted();
    try{await mkdir(directory);break;}catch(error){if(error.code!=='EEXIST')throw error;}
    assert(Date.now()<deadline,'Owned execution lane is busy; no stale lock was removed');
    await delay(40,undefined,{signal});
  }
  try{
    await writeFile(resolve(directory,'owner.json'),JSON.stringify({pid:process.pid,token}),{flag:'wx'});
    signal?.throwIfAborted();return await work();
  }finally{
    const owner=JSON.parse(await readFile(resolve(directory,'owner.json'),'utf8'));
    assert.equal(owner.token,token,'Execution lease identity changed');
    await unlink(resolve(directory,'owner.json'));await rmdir(directory);
  }
}

export async function boundedQueue(items,limit,worker,{signal}={}){
  assert(Number.isInteger(limit)&&limit>0&&limit<=8,'Queue concurrency must be between one and eight');
  let next=0;const results=items.map(()=>({status:'pending'}));
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(next<items.length&&!signal?.aborted){
      const index=next++;try{results[index]={status:'fulfilled',value:await worker(items[index],index)};}
      catch(error){results[index]={status:'rejected',reason:String(error)};}
    }
  }));return results;
}

export function backgroundQueue(limit){
  assert(Number.isInteger(limit)&&limit>0&&limit<=8);const waiting=[],results=[],active=new Set();
  function pump(){while(waiting.length&&active.size<limit){
    const {work,index}=waiting.shift();const task=Promise.resolve().then(work)
      .then(value=>{results[index]={status:'fulfilled',value};},error=>{results[index]={status:'rejected',reason:String(error)};})
      .finally(()=>{active.delete(task);pump();});active.add(task);
  }}
  return {enqueue(work){const index=results.length;results.push({status:'pending'});waiting.push({work,index});pump();},
    async drain(){while(active.size||waiting.length){pump();await Promise.all([...active]);}return results;}};
}

export async function runInstalledCases(cases,adapter,{signal}={}){
  for(const method of ['verify','build','install','verifyInstalled','run','stop','uninstall'])
    assert.equal(typeof adapter[method],'function',`Installed case adapter is missing ${method}; no side effects started`);
  const records=cases.map(item=>({id:item.id,status:'pending',executed:false}));
  let installed=false,primaryError,cleanupError;
  try{
    signal?.throwIfAborted();await adapter.verify('before-build');await adapter.build();await adapter.verify('after-build');signal?.throwIfAborted();
    // Installation may partially succeed before returning an error.
    installed=true;await adapter.install();await adapter.verifyInstalled();signal?.throwIfAborted();
    for(const [index,item]of cases.entries()){
      if(signal?.aborted){records[index]={...records[index],status:'blocked',reason:'cancelled-before-execution'};continue;}
      try{
        await adapter.verify('before-case/'+item.id);await adapter.verifyInstalled();signal?.throwIfAborted();
        records[index].executed=true;const result=await adapter.run(item);
        assert(result&&['pass','fail','blocked'].includes(result.status),'Run must return an explicit outcome');
        records[index]={...records[index],...result};
        // A failure/unknown operation never permits an automatic next launch.
        if(result.status!=='pass')throw new Error('Case did not pass; subsequent cases remain unexecuted');
      }catch(error){
        if(records[index].status==='pending')records[index]={...records[index],status:signal?.aborted&&!records[index].executed?'blocked':'fail',reason:String(error)};
        throw error;
      }
    }
  }catch(error){primaryError=String(error);}
  finally{
    try{await adapter.stop();}catch(error){cleanupError=String(error);}
    // Stop failure means ownership/termination is uncertain; keep installation.
    if(installed&&!cleanupError)try{await adapter.uninstall();}catch(error){cleanupError=String(error);}
    try{await adapter.verify('after-cleanup');}catch(error){cleanupError??=String(error);}
  }
  for(const record of records)if(record.status==='pending')Object.assign(record,{status:'blocked',reason:primaryError??'not-executed'});
  return {records,primaryError,cleanupError,ok:!primaryError&&!cleanupError&&records.every(item=>item.status==='pass')};
}
