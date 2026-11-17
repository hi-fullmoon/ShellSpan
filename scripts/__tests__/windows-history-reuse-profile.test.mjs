import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import p from 'node:path';
import {expect,it} from 'vitest';
import {prepareWindowsHistoryReuseProfile} from '../native-input-p3/windows-history-reuse-profile.mjs';
import {readWindowsHistoryReuseReceipt} from '../native-input-p3/windows-history-reuse-witness.mjs';

const project=p.resolve(import.meta.dirname,'../..'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
it('refuses invalid reuse identities before writing a profile',()=>{
 const evidence=p.join(project,'artifacts/tests/history-reuse-components',randomUUID());
 expect(()=>prepareWindowsHistoryReuseProfile({evidence,home:p.join(evidence,'home'),data:p.join(evidence,'data'),host:'powerShell7',mode:'history-default',reuseId:'bad'})).toThrow('reuse identity');
 expect(fs.existsSync(evidence)).toBe(false);
});
it.skipIf(process.platform!=='win32').each(['windowsPowerShell','powerShell7'])('preserves once-only seeds across separate private provider processes: %s',async host=>{
 for(const mode of ['history-default','history-save-at-exit','history-save-nothing']){
  const evidence=p.join(project,'artifacts/tests/history-reuse-components',randomUUID()),home=p.join(evidence,'home'),data=p.join(evidence,'data');fs.mkdirSync(home,{recursive:true});fs.mkdirSync(data);
  const plan=prepareWindowsHistoryReuseProfile({host,mode,maximumVariable:'int71',reuseId:randomUUID(),evidence,home,data});
  const shell=host==='powerShell7'?'D:/Programs/PowerShell/7/pwsh.exe':p.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),phases=[];
  function launch(index){
   const result=spawnSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-File',p.join(project,'scripts/fixtures/windows-history-profile-observe.ps1'),'-OwnedProfile',plan.profile,'-Module',p.join(project,'src-tauri/resources/powershell/PSReadLine/2.4.5/PSReadLine.psd1'),'-VariableKind','none','-Observation',p.join(evidence,'provider-'+index+'.json')],{env:{...process.env,HOME:home,USERPROFILE:home,APPDATA:p.join(home,'AppData/Roaming'),LOCALAPPDATA:p.join(home,'AppData/Local')},windowsHide:true,encoding:'utf8',timeout:20000});
   phases.push({index,exitCode:result.status,error:result.stderr});fs.writeFileSync(p.join(evidence,'component-process-exits.json'),JSON.stringify(phases,null,2));expect(result.status,result.stderr).toBe(0);
  }
  launch(0);const marker=p.join(plan.marker,'seed-ready.json'),markerHash=sha(fs.readFileSync(marker));
  if(mode!=='history-save-nothing')fs.appendFileSync(plan.history,"Write-Output 'COMPONENT_ONLY_SYNTHETIC_APPEND'\n");
  const expected=mode==='history-save-nothing'?null:fs.readFileSync(plan.history);launch(1);
  expect(sha(fs.readFileSync(marker))).toBe(markerHash);expect(fs.existsSync(plan.history)).toBe(mode!=='history-save-nothing');if(expected)expect(fs.readFileSync(plan.history)).toEqual(expected);
  const records=fs.readdirSync(plan.launches).map(name=>JSON.parse(fs.readFileSync(p.join(plan.launches,name),'utf8'))).sort((a,b)=>a.readerCreated.localeCompare(b.readerCreated));
  expect(records).toHaveLength(2);expect(records.map(v=>v.seedApplied)).toEqual([true,false]);expect(new Set(records.map(v=>v.readerPid)).size).toBe(2);expect(records.every(v=>v.effectiveMaximum===71&&v.reuseId===plan.reuseId)).toBe(true);
  expect(records[1].historyBeforeReader.sha256).toBe(expected?sha(expected):null);expect(JSON.parse(fs.readFileSync(plan.record,'utf8')).readerPid).toBe(records[0].readerPid);
  const verified=await readWindowsHistoryReuseReceipt(evidence,{host,mode,reuseId:plan.reuseId,pid:records[1].readerPid,created:records[1].readerCreated,seedApplied:false,beforeReader:{exists:expected!==null,bytes:expected?.length??0,sha256:expected?sha(expected):null}});
  expect(verified.readerPid).toBe(records[1].readerPid);expect(verified.seedApplied).toBe(false);
  fs.writeFileSync(p.join(evidence,'scope.json'),JSON.stringify({componentOnly:true,syntheticDiskAppend:true,interactiveReaderStarted:false,actualAppCases:0,realModelRequests:0}));
 }
},90000);

it.skipIf(process.platform!=='win32').each(['incomplete-seed','missing-history','foreign-marker'])('refuses %s without recreating or overwriting a history file',fault=>{
 const evidence=p.join(project,'artifacts/tests/history-reuse-components',randomUUID()),home=p.join(evidence,'home'),data=p.join(evidence,'data');fs.mkdirSync(home,{recursive:true});fs.mkdirSync(data);
 const plan=prepareWindowsHistoryReuseProfile({host:'powerShell7',mode:'history-default',reuseId:randomUUID(),evidence,home,data}),phases=[];
 function launch(expected){const result=spawnSync('D:/Programs/PowerShell/7/pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',p.join(project,'scripts/fixtures/windows-history-profile-observe.ps1'),'-OwnedProfile',plan.profile,'-Module',p.join(project,'src-tauri/resources/powershell/PSReadLine/2.4.5/PSReadLine.psd1'),'-VariableKind','none','-Observation',p.join(evidence,'observation-'+phases.length+'.json')],{env:{...process.env,HOME:home,USERPROFILE:home,APPDATA:p.join(home,'AppData/Roaming'),LOCALAPPDATA:p.join(home,'AppData/Local')},windowsHide:true,encoding:'utf8',timeout:20000});phases.push({exitCode:result.status,error:result.stderr});fs.writeFileSync(p.join(evidence,'fault-process-exits.json'),JSON.stringify(phases,null,2));expect(result.status,result.stderr).toBe(expected);return result.stderr;}
 if(fault==='incomplete-seed'){
  fs.writeFileSync(p.join(plan.marker,'seed-started.json'),JSON.stringify({componentFaultOnly:true}),{flag:'wx'});
  expect(launch(1)).toContain('refusing reseed');expect(fs.existsSync(p.join(plan.marker,'seed-ready.json'))).toBe(false);
 }else if(fault==='missing-history'){
  launch(0);const original=fs.readFileSync(plan.history),saved=plan.history+'.preserved';expect(p.resolve(saved).startsWith(p.resolve(evidence)+p.sep)).toBe(true);fs.renameSync(plan.history,saved);
  expect(launch(1)).toContain('refusing reseed');expect(fs.readFileSync(saved)).toEqual(original);
 }else{
  launch(0);const original=fs.readFileSync(plan.history),marker=p.join(plan.marker,'seed-ready.json'),value=JSON.parse(fs.readFileSync(marker,'utf8'));
  fs.copyFileSync(marker,marker+'.original',fs.constants.COPYFILE_EXCL);fs.writeFileSync(marker,JSON.stringify({...value,reuseId:randomUUID()}));
  expect(launch(1)).toContain('ownership differs');expect(fs.readFileSync(plan.history)).toEqual(original);
 }
 expect(fs.existsSync(plan.history)).toBe(fault==='foreign-marker');fs.writeFileSync(p.join(evidence,'scope.json'),JSON.stringify({componentFaultOnly:true,actualAppCases:0,realModelRequests:0,interactiveReaderStarted:false}));
},30000);
