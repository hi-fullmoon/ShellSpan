import assert from 'node:assert/strict';
import fs from 'node:fs';
import p from 'node:path';
import { test } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
const root=p.resolve(import.meta.dirname,'../..');
const directory=p.join(root,'.artifacts/tests/windows-process-ownership',randomUUID());
fs.mkdirSync(directory,{recursive:true});
const helper=p.join(root,'scripts/fixtures/windows-process-ownership.ps1');
const script=p.join(root,'scripts/fixtures/windows-process-ownership-test.ps1');
const record=(id,parent,created,executable='node.exe')=>({ProcessId:id,ParentProcessId:parent,CreationDate:created===null?null:new Date(created*1000).toISOString(),ExecutablePath:executable});
function select(processes,overrides={}){
  const input=p.join(directory,randomUUID()+'.json');
  fs.writeFileSync(input,JSON.stringify({rootPid:20,ownerPid:10,rootExecutable:'node.exe',processes,...overrides}));
  return JSON.parse(execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',script,'-InputFile',input,'-Helper',helper],{cwd:root,windowsHide:true,encoding:'utf8',timeout:20000}).replace(/^\uFEFF/,''));
}
const windows={skip:process.platform!=='win32'};
test('selects only the time-consistent descendant tree',windows,()=>{
  const result=select([record(10,1,1),record(20,10,2),record(30,20,3),record(40,30,4),record(50,10,5)]);
  assert.equal(result.ok,true);assert.deepEqual(result.selected,[20,30,40]);
});
test('PID reuse cannot adopt an older unrelated subtree',windows,()=>{
  const result=select([record(10,1,1),record(20,10,2),record(30,20,20),record(40,30,10,'wps.exe'),record(50,40,11,'plugin.exe'),record(60,30,21)]);
  assert.equal(result.ok,true);assert.deepEqual(result.selected,[20,30,60]);assert.equal(result.rejected[0].pid,40);
});
test('rejects a root predating its current owner',windows,()=>{
  assert.equal(select([record(10,1,5),record(20,10,2)]).ok,false);
});
test('rejects a changed root image and an unproven missing root',windows,()=>{
  assert.equal(select([record(10,1,1),record(20,10,2,'other.exe')]).ok,false);
  assert.equal(select([record(10,1,1),record(30,20,3)]).ok,false);
});
test('unknown child creation time never grants ownership',windows,()=>{
  const result=select([record(10,1,1),record(20,10,2),record(30,20,null)]);
  assert.deepEqual(result.selected,[20]);assert.equal(result.rejected[0].pid,30);
});
test('handle cleanup stops the owned tree and preserves a sibling',windows,async()=>{
  const childScript=p.join(directory,'owned-root.mjs');
  fs.writeFileSync(childScript,"import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});process.stdout.write(JSON.stringify({childPid:child.pid})+'\\n');setInterval(()=>{},1000);");
  const owned=spawn(process.execPath,[childScript],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const sibling=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
  const ownedClosed=once(owned,'close'),siblingClosed=once(sibling,'close');
  try{
    const [ready]=await once(owned.stdout,'data');
    const {childPid}=JSON.parse(ready.toString());
    const output=p.join(directory,'cleanup.json');
    execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',p.join(root,'scripts/fixtures/windows-desktop-process-cleanup.ps1'),'-RootPid',String(owned.pid),'-OwnerPid',String(process.pid),'-RootExecutable',process.execPath,'-Output',output],{cwd:root,windowsHide:true,stdio:'pipe',timeout:20000});
    await ownedClosed;
    const result=JSON.parse(fs.readFileSync(output,'utf8').replace(/^\uFEFF/,''));
    assert.equal(result.ok,true);assert.equal(result.treeKillUsed,false);assert.equal(result.termination,'verified-process-handles');assert(result.before.some(entry=>entry.pid===owned.pid));assert(result.before.some(entry=>entry.pid===childPid));assert(!result.before.some(entry=>entry.pid===sibling.pid));assert.deepEqual(result.remaining,[]);
    assert.equal(sibling.exitCode,null);assert.doesNotThrow(()=>process.kill(sibling.pid,0));
  }finally{
    if(owned.exitCode===null)owned.kill();if(sibling.exitCode===null)sibling.kill();
    await Promise.allSettled([ownedClosed,siblingClosed]);
  }
});
