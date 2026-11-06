import {expect, it} from 'vitest';
import fs from 'node:fs';
import p from 'node:path';
import {createHash} from 'node:crypto';
import {prepareWindowsHistoryProfile} from '../native-input-p3/windows-history-profile.mjs';
import {readWindowsHistoryDisk, readWindowsHistoryExit} from '../native-input-p3/windows-history-witness.mjs';

function fixture() {
  const base = p.resolve(import.meta.dirname, '../../.artifacts/tests/windows-history-witness');
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
