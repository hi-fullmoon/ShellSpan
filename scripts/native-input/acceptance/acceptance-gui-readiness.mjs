import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';

export function foreignNativeValidations(processes,owner,runnerPid){
  const prefix=resolve(owner).replaceAll('\\','/').toLowerCase()+'/';
  return processes.flatMap(value=>{
    if(value.pid===runnerPid)return [];
    const name=value.name??'',command=(value.commandLine??'').replaceAll('\\','/').toLowerCase();
    const executable=(value.executablePath??'').replaceAll('\\','/').toLowerCase();
    const app=/^shellspan.*\.exe$/i.test(name)&&executable.startsWith(prefix+'artifacts/tests/');
    const driver=/^node\.exe$/i.test(name)&&command.includes(prefix)
      &&/\/scripts\/(?:(?:verification\/agent\/)?verify-ai-session-stream\.mjs|(?:native-input\/acceptance|native-input-p3)\/(?:windows-package-(?:batch|smoke)\.mjs|app\.mjs))(?=[\s"']|$)/.test(command)
      &&!/(?:^|\s)--(?:list-only|frontend-only)(?:\s|$)/.test(command);
    return app||driver?[{pid:value.pid,name,kind:app?'application':'driver'}]:[];
  });
}
export async function assertNativeGuiIdle(owner,runnerPid){
  const query="Import-Module (Join-Path $PSHOME 'Modules/CimCmdlets/CimCmdlets.psd1') -ErrorAction Stop; @((Get-CimInstance Win32_Process | Where-Object {$_.Name -like 'node.exe' -or $_.Name -like 'ShellSpan*.exe'}) | ForEach-Object {@{pid=$_.ProcessId;name=$_.Name;commandLine=$_.CommandLine;executablePath=$_.ExecutablePath}}) | ConvertTo-Json -Depth 3 -Compress";
  const result=await promisify(execFile)('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',query],{windowsHide:true,timeout:20000,encoding:'utf8'});
  const parsed=JSON.parse(result.stdout),other=foreignNativeValidations(Array.isArray(parsed)?parsed:[parsed],owner,runnerPid);
  assert.equal(other.length,0,`Another native acceptance is active; no process was stopped: ${JSON.stringify(other)}`);
}
