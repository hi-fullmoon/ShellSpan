import {afterAll,expect, it} from 'vitest';
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {nativeDisplayCursorDiagnostic} from './native-display-cursor-diagnostic';

it('refuses non-owned cursor diagnostic identifiers', () => {
  expect(() => nativeDisplayCursorDiagnostic('../foreign')).toThrow('Owned cursor diagnostic');
});
it.skipIf(process.platform !== 'win32')('compiles the read-only sampler and writes parseable numeric records in an isolated process', () => {
  const token = randomUUID(), root = path.resolve('artifacts/tests/native-display-cursor', token);fs.mkdirSync(root,{recursive:true});
  const module = path.resolve('src-tauri/resources/powershell/PSReadLine/2.4.5/PSReadLine.psd1').split("'").join("''");
  const script = path.join(root,'observe.ps1'), file = path.join(root,'display-cursor-'+token+'.jsonl');
  fs.writeFileSync(script, `Import-Module '${module}' -ErrorAction Stop\nGet-PSReadLineOption | Out-Null\n${nativeDisplayCursorDiagnostic(token)}\nStart-Sleep -Milliseconds 250\n`,{flag:'wx'});
  execFileSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',script],{env:{...process.env,SHELLSPAN_LOCAL_HOME:root},windowsHide:true,timeout:30000,stdio:'pipe'});
  const lines = fs.readFileSync(file,'utf8').trim().split(/\r?\n/);expect(lines.length).toBeGreaterThan(0);
  for(const line of lines){const record:Record<string,unknown>=JSON.parse(line);expect(Object.keys(record)).toEqual(['ticks','left','top','width','height','initialX','initialY','current','length','renderWidth','renderHeight']);expect(Object.values(record).every(value=>typeof value==='number')).toBe(true);}
},45000);

afterAll(() => { fs.rmSync(path.resolve('artifacts/tests/native-display-cursor'), { recursive: true, force: true }); });
