import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {readOwnedHistoryJson} from './windows-history-witness.mjs';

async function stable(root,name){
  try{return await readOwnedHistoryJson(root,name);}
  catch(error){
    if(error instanceof SyntaxError||error.code==='ERR_ASSERTION'&&error.message.includes('changed while reading'))return null;
    throw error;
  }
}
export async function readInitializationObserver(evidence,token,manifest){
  assert(/^[a-f0-9-]{36}$/.test(token));
  assert(resolve(manifest).startsWith(resolve(evidence)+sep));
  const matches=[];
  for(const name of await readdir(evidence)){
    if(!/^native-image-\d+-[a-f0-9-]{36}-process\.json$/.test(name))continue;
    const record=await stable(evidence,name);
    if(record?.frozenManifest===manifest)matches.push({name,record});
  }
  if(!matches.length)return{ready:false};
  assert.equal(matches.length,1,'Initializer belongs to more than one actual App');
  const {name,record}=matches[0];
  const image=await stable(evidence,name.replace('-process.json','.json'));
  const tree=await stable(evidence,'os-identity-initialize.json'),fast=await stable(evidence,'os-modules-initialize.json');
  if(!image||!tree||!fast)return{ready:false};
  assert.equal(image.frozenManifest,manifest);
  assert(resolve(record.executable).startsWith(resolve(evidence)+sep));
  const observations=[];
  for(const value of [tree,fast]){
    assert(value.readOnly===true&&value.inputInjected===false&&value.terminationRequested===false);
    assert(Array.isArray(value.failures)&&value.failures.length===0,'Initializer OS observer failed');
    const app=value.applications.filter(row=>row.pid===record.appPid);
    if(!app.length)return{ready:false};
    assert.equal(app.length,1);
    assert(app[0].handleHeld===true&&app[0].ended===false,'Initializer App is not held alive');
    assert.equal(app[0].runnerPid,record.runnerPid);
    assert.equal(resolve(app[0].path).toLowerCase(),resolve(record.executable).toLowerCase());
    assert.equal(app[0].sha256,image.binarySha256);
    observations.push(app[0]);
  }
  assert.equal(observations[0].handleCreated,observations[1].handleCreated,'Initializer observers hold different App identities');
  return{ready:true,token,appPid:record.appPid,handleCreated:observations[0].handleCreated,executable:record.executable,sha256:image.binarySha256,observerKinds:['identity','modules'],readOnly:true,inputInjected:false,terminationRequested:false};
}
