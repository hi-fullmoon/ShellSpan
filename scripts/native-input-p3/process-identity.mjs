import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {win32} from 'node:path';
import {promisify} from 'node:util';

const validPid=pid=>Number.isInteger(pid)&&pid>1&&pid<=0xffffffff;
function timestamp(value){
  assert(typeof value==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(value),'Process time needs an explicit timezone');
  const time=Date.parse(value);assert(Number.isFinite(time),'Invalid process time');return time;
}
function executable(value){
  assert(typeof value==='string'&&!value.includes('\0')&&win32.isAbsolute(value),'Absolute process executable required');
  return win32.normalize(value).replace(/^\\\\\?\\/,'').toLowerCase();
}
function validateIdentity(value){
  assert(value&&validPid(value.pid),'Invalid producer process identity');executable(value.exe);
  if(value.created!==undefined)timestamp(value.created);
  else assert(timestamp(value.start)<=timestamp(value.end),'Invalid producer phase bounds');
}
export function producerIdentityMatches(expected,observed){
  validateIdentity(expected);if(!observed)return false;
  assert(validPid(observed.pid),'Invalid observed process identity');
  const path=executable(observed.exe),created=timestamp(observed.created);
  if(expected.pid!==observed.pid||executable(expected.exe)!==path)return false;
  // Same conservative margins as the existing owned-process cleanup audit.
  if(expected.created!==undefined)return Math.abs(created-timestamp(expected.created))<1000;
  return created>=timestamp(expected.start)-2000&&created<=timestamp(expected.end)+2000;
}
export async function observeProducerProcesses(pids){
  assert(process.platform==='win32','Identity-based producer checks require Windows process metadata');
  assert(Array.isArray(pids)&&pids.length&&pids.every(validPid),'Explicit valid producer PIDs required');
  const filter=[...new Set(pids)].map(pid=>'ProcessId = '+pid).join(' OR ');
  const command="$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules/CimCmdlets/CimCmdlets.psd1') -ErrorAction Stop; "+
    "$rows=@(Get-CimInstance Win32_Process -Filter '"+filter+"' | ForEach-Object { if(-not $_.ExecutablePath -or $null -eq $_.CreationDate){throw 'Process identity metadata unavailable'}; @{pid=[int64]$_.ProcessId;exe=$_.ExecutablePath;created=$_.CreationDate.ToUniversalTime().ToString('o')} }); ConvertTo-Json -InputObject $rows -Depth 3 -Compress";
  const shell=win32.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  assert(win32.isAbsolute(shell),'Absolute Windows process inspector required');
  const result=await promisify(execFile)(shell,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:20000,encoding:'utf8'});
  const rows=JSON.parse(result.stdout.replace(/^\uFEFF/,''));assert(Array.isArray(rows),'Expected a process identity inventory');
  assert.equal(new Set(rows.map(row=>row.pid)).size,rows.length,'Duplicate observed process identity');return rows;
}
export async function assertProducerIdentitiesExited(pids,identities){
  assert(Array.isArray(pids)&&pids.every(validPid),'Explicit valid producer PIDs required');
  assert(Array.isArray(identities),'Explicit producer identities required');identities.forEach(validateIdentity);
  assert.deepEqual([...new Set(identities.map(row=>row.pid))].sort((a,b)=>a-b),[...new Set(pids)].sort((a,b)=>a-b),'Producer identities must cover every original PID');
  if(!pids.length)return;
  const rows=await observeProducerProcesses(pids);
  for(const identity of identities)assert(!producerIdentityMatches(identity,rows.find(row=>row.pid===identity.pid)),`Producer still running with original identity: ${identity.pid}`);
}
