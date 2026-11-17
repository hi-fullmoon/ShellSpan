import {execFileSync} from 'node:child_process';
import {it,expect,afterEach} from 'vitest';import fs from 'node:fs';import p from 'node:path';import {randomUUID} from 'node:crypto';import {prepareWindowsHistoryProfile,windowsHistoryModes} from '../native-input-p3/windows-history-profile.mjs';const roots=[];afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
it('prepares all seven exact PowerShell-specific modes in owned Documents/data only',()=>{expect(windowsHistoryModes).toHaveLength(7);for(const host of ['powerShell7','windowsPowerShell'])for(const mode of windowsHistoryModes){const evidence=p.resolve('artifacts/tests/windows-history-profile',randomUUID());roots.push(evidence);const home=p.join(evidence,'home'),data=p.join(evidence,'data'),value=prepareWindowsHistoryProfile({host,mode,evidence,home,data}),bytes=fs.readFileSync(value.profile),text=bytes.toString('utf8');expect(value.profile.startsWith(home+p.sep)).toBe(true);expect(value.history.startsWith(data+p.sep)).toBe(true);expect(text).toContain('Import-Module PSReadLine');expect(text).toContain('HISTORY_SEED_A');expect(text).not.toContain('SendInput');expect(bytes.subarray(0,3).equals(Buffer.from([239,187,191]))).toBe(host==='windowsPowerShell');expect(text.split(String.fromCharCode(10)).length).toBeGreaterThan(5);if(mode==='history-custom')expect(value.history).toContain('命令 history.txt');if(mode==='history-empty'||mode==='history-null')expect(text).toContain('ValidationMetadataException');expect(()=>prepareWindowsHistoryProfile({host,mode,evidence,home,data})).toThrow('Do not replay');}});
it('refuses unknown hosts/modes or escaping HOME/data before writing a profile',()=>{const evidence=p.resolve('artifacts/tests/windows-history-profile',randomUUID()),base={host:'powerShell7',mode:'history-default',evidence,home:p.join(evidence,'home'),data:p.join(evidence,'data')};for(const input of [{...base,host:'bash'},{...base,mode:'history-unset'},{...base,home:p.resolve(evidence,'../other')},{...base,data:'relative'}])expect(()=>prepareWindowsHistoryProfile(input)).toThrow();expect(fs.existsSync(evidence)).toBe(false);});

it('prepares all four additional maximum-variable settings without changing the seven history modes',()=>{
 for(const [mode,maximumVariable] of [['history-default','int71'],['history-default','string71'],['history-default','unset'],['history-small','int71']]){
  const evidence=p.resolve('artifacts/tests/windows-history-profile',randomUUID());roots.push(evidence);
  const plan=prepareWindowsHistoryProfile({host:'powerShell7',mode,maximumVariable,evidence,home:p.join(evidence,'home'),data:p.join(evidence,'data')}),source=fs.readFileSync(plan.profile,'utf8');
  expect(plan.maximumVariable).toBe(maximumVariable);expect(source).toContain('Remove-Variable -Name MaximumHistoryCount -Scope Global');
  if(maximumVariable==='int71')expect(source).toContain('-Value ([int]71)');
  if(maximumVariable==='string71')expect(source).toContain("-Value ([string]'71')");
  if(mode==='history-small')expect(source).toContain('-MaximumHistoryCount 3');
 }
 const evidence=p.resolve('artifacts/tests/windows-history-profile',randomUUID());
 expect(()=>prepareWindowsHistoryProfile({host:'powerShell7',mode:'history-default',maximumVariable:'arbitrary-source',evidence,home:p.join(evidence,'home'),data:p.join(evidence,'data')})).toThrow('maximum variable mode');expect(fs.existsSync(evidence)).toBe(false);
});

it.skipIf(process.platform!=='win32').each(['powerShell7','windowsPowerShell'])('records lazy and effective history capacity from the actual private provider: %s',host=>{
 const project=p.resolve(import.meta.dirname,'../..');
 const shell=host==='powerShell7'?'pwsh.exe':p.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 const module=p.join(project,'src-tauri/resources/powershell/PSReadLine/2.4.5/PSReadLine.psd1');
 const pin=JSON.parse(fs.readFileSync(p.join(project,'scripts/dependency-builds/psreadline/build.json'),'utf8'));
 for(const [mode,variableKind] of [['history-default','none'],['history-default','int'],['history-default','string'],['history-small','int']]){
  const evidence=p.join(project,'artifacts/tests/windows-history-profile-native',randomUUID());
  const home=p.join(evidence,'home'),data=p.join(evidence,'data'),plan=prepareWindowsHistoryProfile({host,mode,evidence,home,data});
  const observation=p.join(evidence,'provider-observation.json');
  execFileSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-File',p.join(project,'scripts/fixtures/windows-history-profile-observe.ps1'),'-OwnedProfile',plan.profile,'-Module',module,'-VariableKind',variableKind,'-Observation',observation],{
   env:{...process.env,HOME:home,USERPROFILE:home,APPDATA:p.join(home,'AppData/Roaming'),LOCALAPPDATA:p.join(home,'AppData/Local'),PSModulePath:[p.resolve(p.dirname(module),'../..'),p.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/Modules'),process.env.PSModulePath].filter(Boolean).join(p.delimiter)},windowsHide:true,timeout:20000,stdio:'pipe',
  });
  const record=JSON.parse(fs.readFileSync(plan.record,'utf8')),provider=JSON.parse(fs.readFileSync(observation,'utf8'));
  expect(provider.version).toBe('2.4.5');expect(p.resolve(provider.assembly).toLowerCase()).toBe(p.resolve(p.dirname(module),'Microsoft.PowerShell.PSReadLine.dll').toLowerCase());
  expect(provider.assemblySha256).toBe(pin.outputs['Microsoft.PowerShell.PSReadLine.dll']);expect(provider.providerDefaultMaximum).toBeGreaterThan(0);
  expect(record.providerDefaultMaximum).toBe(provider.providerDefaultMaximum);expect(record.maximum).toBe(mode==='history-small'?3:0);
  if(variableKind!=='none')expect(record.historyCountVariableIsInt).toBe(variableKind==='int');
  const expected=mode==='history-small'?3:variableKind==='int'?71:variableKind==='string'?provider.providerDefaultMaximum:record.historyCountVariableIsInt?record.historyCountVariable:provider.providerDefaultMaximum;
  expect(record.effectiveMaximum).toBe(expected);expect(record.effectiveMaximum).toBeGreaterThan(0);
  expect(fs.readFileSync(plan.history,'utf8')).toBe(plan.seedSources.join('\n')+'\n');
 }
},60000);

it.skipIf(process.platform!=='win32').each(['powerShell7','windowsPowerShell'])('observes the four owned maximum-variable profiles in the private provider: %s',host=>{
 const project=p.resolve(import.meta.dirname,'../..'),shell=host==='powerShell7'?'pwsh.exe':p.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),module=p.join(project,'src-tauri/resources/powershell/PSReadLine/2.4.5/PSReadLine.psd1');
 for(const [mode,maximumVariable] of [['history-default','int71'],['history-default','string71'],['history-default','unset'],['history-small','int71']]){
  const evidence=p.join(project,'artifacts/tests/windows-history-profile-native',randomUUID()),home=p.join(evidence,'home'),data=p.join(evidence,'data'),plan=prepareWindowsHistoryProfile({host,mode,maximumVariable,evidence,home,data}),observation=p.join(evidence,'provider-observation.json');
  execFileSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-File',p.join(project,'scripts/fixtures/windows-history-profile-observe.ps1'),'-OwnedProfile',plan.profile,'-Module',module,'-VariableKind','none','-Observation',observation],{env:{...process.env,HOME:home,USERPROFILE:home,APPDATA:p.join(home,'AppData/Roaming'),LOCALAPPDATA:p.join(home,'AppData/Local')},windowsHide:true,timeout:20000,stdio:'pipe'});
  const record=JSON.parse(fs.readFileSync(plan.record,'utf8')),provider=JSON.parse(fs.readFileSync(observation,'utf8'));
  expect(record.maximumVariable).toBe(maximumVariable);expect(record.maximum).toBe(mode==='history-small'?3:0);expect(record.historyCountVariableIsInt).toBe(maximumVariable==='int71');
  expect(record.effectiveMaximum).toBe(mode==='history-small'?3:maximumVariable==='int71'?71:provider.providerDefaultMaximum);
  expect(provider.assemblySha256).toBe(JSON.parse(fs.readFileSync(p.join(project,'scripts/dependency-builds/psreadline/build.json'),'utf8')).outputs['Microsoft.PowerShell.PSReadLine.dll']);
 }
},60000);
