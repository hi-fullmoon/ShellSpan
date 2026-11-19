import assert from 'node:assert/strict';import {resolve} from 'node:path';
import {readOwnedHistoryJson} from './windows-history-witness.mjs';
async function stable(root,name){try{return await readOwnedHistoryJson(root,name);}catch(error){if(error instanceof SyntaxError||error.code==='ERR_ASSERTION'&&error.message.includes('changed while reading'))return null;throw error;}}
export async function readNativeJobGroup(evidence,token,marker){
 assert(/^[a-f0-9-]{36}$/.test(token));assert(/^native-jobs-[a-f0-9-]{36}$/.test(marker),'Exact independently generated native output marker required');
 const record=await stable(evidence,'home/native-group-'+marker+'.json'),observer=await stable(evidence,'native-job-observer.json'),tree=await stable(evidence,'os-identity-run.json');
 if(!record||!observer||!tree)return{ready:false};
 assert.equal(record.marker,marker);assert.equal(observer.token,token);assert(observer.handleHeld&&observer.inputInjected===false&&observer.terminationRequested===false);
 assert(tree.readOnly&&tree.inputInjected===false&&tree.terminationRequested===false&&tree.failures.length===0);
 const app=tree.applications.find(value=>value.pid===observer.appPid),shell=tree.shells.find(value=>value.pid===observer.shellPid&&value.handleCreated===observer.handleCreated);if(!app||!shell)return{ready:false};
 assert(app.handleHeld&&shell.handleHeld);assert.equal(shell.parentPid,app.pid);
 const worker=tree.ownedDescendants.find(value=>value.pid===record.workerPid&&value.handleCreated===record.workerCreated),child=tree.ownedDescendants.find(value=>value.pid===record.childPid&&value.handleCreated===record.childCreated);if(!worker||!child)return{ready:false};
 assert(worker.handleHeld&&child.handleHeld);assert.notEqual(worker.pid,child.pid);assert.equal(worker.parentPid,shell.pid);assert.equal(child.parentPid,worker.pid);
 for(const value of [worker,child]){assert.equal(resolve(value.exe).toLowerCase(),resolve(observer.executable).toLowerCase());assert.equal(value.exeSha256,observer.sha256);assert.equal(resolve(value.exe).toLowerCase(),resolve(record.executable).toLowerCase());}
 return{ready:true,token,marker,appPid:app.pid,shellPid:shell.pid,parentAlive:app.ended!==true&&shell.ended!==true,worker,child,groupEnded:worker.ended===true&&child.ended===true,jobMembershipClaimedByObserver:false,inputInjected:false,terminationRequested:false,scope:'Independent held OS parent/worker/descendant identities; Windows Job empty accounting remains the actual native management result obligation'};
}
