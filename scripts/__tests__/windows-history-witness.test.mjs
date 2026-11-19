import {expect, it} from 'vitest';
import fs from 'node:fs';
import p from 'node:path';
import {createHash} from 'node:crypto';
import {prepareWindowsHistoryProfile} from '../native-input/acceptance/windows-history-profile.mjs';
import {readWindowsHistoryDisk, readWindowsHistoryExit, windowsHistoryReaderArtifacts} from '../native-input/acceptance/windows-history-witness.mjs';

function fixture() {
  const base = p.resolve(import.meta.dirname, '../../artifacts/tests/windows-history-witness');
  fs.mkdirSync(base, {recursive: true});
  const evidence = fs.mkdtempSync(p.join(base, 'case-'));
  const plan = prepareWindowsHistoryProfile({host: 'powerShell7', mode: 'history-custom', evidence, home: p.join(evidence, 'home'), data: p.join(evidence, 'data')});
  fs.writeFileSync(p.join(evidence, 'native-history-plan.json'), JSON.stringify(plan), {flag: 'wx'});
  fs.writeFileSync(p.join(evidence, 'native-history-profile.json'), JSON.stringify({mode: plan.mode, expectedNativePath: plan.history}), {flag: 'wx'});
  return {evidence, plan, options: {mode: plan.mode, host: plan.host}};
}
it('reads only the fixed owned history file and hashes exact Unicode commands across native line endings', async () => {
  const {evidence, plan, options} = fixture();
  expect((await readWindowsHistoryDisk(evidence, options)).exists).toBe(false);
  const sources = ['Write-Output \'中文\'', 'exit'];
  fs.writeFileSync(plan.history, sources.join('\r\n') + '\r\n', {flag: 'wx'});
  const value = await readWindowsHistoryDisk(evidence, options);
  expect(value.items).toEqual(sources.map(source => ({sha256: createHash('sha256').update(source).digest('hex'), bytes: Buffer.byteLength(source)})));
  expect(value.sha256).toBe(createHash('sha256').update(fs.readFileSync(plan.history)).digest('hex'));
  fs.writeFileSync(p.join(evidence, 'native-history-plan.json'), JSON.stringify({...plan, history: p.join(evidence, 'different.txt')}));
  await expect(readWindowsHistoryDisk(evidence, options)).rejects.toThrow('fixed owned case path');
});
it('refuses history hardlinks and keeps passive held-handle exit evidence distinct from missing observations', async () => {
  const {evidence, plan, options} = fixture();
  const other = p.join(evidence, 'other.txt');fs.writeFileSync(other, 'sentinel', {flag: 'wx'});fs.linkSync(other, plan.history);
  await expect(readWindowsHistoryDisk(evidence, options)).rejects.toThrow('Invalid owned history evidence file');
  expect(await readWindowsHistoryExit(evidence)).toEqual({ready: null, result: null});
  const identity = {shellPid: 12345, created: '2026-11-06T00:00:00Z', handleHeld: true, inputInjected: false, terminationRequested: false};
  fs.writeFileSync(p.join(evidence, 'native-history-exit.json.ready.json'), JSON.stringify(identity), {flag: 'wx'});
  fs.writeFileSync(p.join(evidence, 'native-history-exit.json'), JSON.stringify({...identity, ended: true, exitCode: 7}), {flag: 'wx'});
  expect((await readWindowsHistoryExit(evidence)).result.exitCode).toBe(7);
});
it('keeps restart reader evidence separate and refuses a cross-reader exit substitution',async()=>{
 const {evidence}=fixture(),first=windowsHistoryReaderArtifacts('0'),second=windowsHistoryReaderArtifacts('1');
 const record={shellPid:12345,created:'2026-11-08T01:00:00.1234567Z',handleHeld:true,inputInjected:false,terminationRequested:false};
 for(const name of [first.exit+'.ready.json',first.exit])fs.writeFileSync(p.join(evidence,name),JSON.stringify({...record,ended:true,exitCode:0}),{flag:'wx'});
 expect((await readWindowsHistoryExit(evidence,'0')).result.exitCode).toBe(0);expect(await readWindowsHistoryExit(evidence,'1')).toEqual({ready:null,result:null});
 fs.writeFileSync(p.join(evidence,second.exit+'.ready.json'),JSON.stringify({...record,created:'2026-11-08T01:01:00.1234567Z'}),{flag:'wx'});
 fs.writeFileSync(p.join(evidence,second.exit),JSON.stringify({...record,ended:true,exitCode:0}),{flag:'wx'});
 await expect(readWindowsHistoryExit(evidence,'1')).rejects.toThrow('Original held Shell exit');
 expect(first.evidence).not.toBe(second.evidence);expect(first.observer).not.toBe(second.observer);
  expect(first.window).not.toBe(second.window);expect(windowsHistoryReaderArtifacts().window).toBe('native-window.png');
 await expect(readWindowsHistoryExit(evidence,'../../0')).rejects.toThrow('Exact history reader');
});
