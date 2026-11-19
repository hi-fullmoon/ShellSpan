import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {readOwnedHistoryJson, windowsHistoryReaderArtifacts} from './windows-history-witness.mjs';
import {windowsHistoryModes} from './windows-history-profile.mjs';

function ticks(created) {
  assert(typeof created === 'string', 'Exact reader creation time required');
  const match = created.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?Z$/);
  assert(match && Number.isFinite(Date.parse(match[1] + 'Z')), 'Exact UTC reader creation time required');
  assert.equal(new Date(match[1] + 'Z').toISOString().slice(0, 19), match[1], 'Invalid reader creation date');
  return (BigInt(Date.parse(match[1] + 'Z')) + 62135596800000n) * 10000n
    + BigInt((match[2] ?? '').padEnd(7, '0'));
}

// Select by the independently held OS identity, never by the newest file or PID alone.
export async function readWindowsHistoryReuseReceipt(evidence, expected) {
  const {mode, host, reuseId, pid, created, seedApplied, beforeReader} = expected;
  assert(windowsHistoryModes.includes(mode) && ['powerShell7', 'windowsPowerShell'].includes(host), 'Exact history configuration required');
  assert(/^[a-f0-9-]{36}$/.test(reuseId) && Number.isSafeInteger(pid) && pid > 1 && typeof seedApplied === 'boolean', 'Exact owned reader identity required');
  assert(beforeReader && typeof beforeReader.exists === 'boolean' && Number.isSafeInteger(beforeReader.bytes) && beforeReader.bytes >= 0, 'Independent prior history disk witness required');
  assert(beforeReader.exists ? /^[a-f0-9]{64}$/.test(beforeReader.sha256) : beforeReader.sha256 === null && beforeReader.bytes === 0, 'Independent prior history digest required');
  const nativePath = mode === 'history-custom' ? join(evidence, 'data/history custom/命令 history.txt') : join(evidence, 'data/shell-history', host + '.txt');
  const plan = await readOwnedHistoryJson(evidence, 'native-history-reuse/plan.json');
  assert(plan?.version === 1 && plan.reuseId === reuseId && plan.host === host && plan.mode === mode
    && resolve(plan.evidence) === resolve(evidence) && resolve(plan.history) === resolve(nativePath), 'History reuse plan ownership differs');
  const name = `${pid}-${ticks(created)}.json`;
  const names = await readdir(join(evidence, 'native-history-reuse/launches'));
  assert(names.includes(name), 'Matching held reader launch receipt missing');
  const receipt = await readOwnedHistoryJson(evidence, join('native-history-reuse/launches', name));
  const profilePath = join(evidence, 'home/Documents', host === 'powerShell7' ? 'PowerShell' : 'WindowsPowerShell', 'profile.ps1');
  assert(receipt?.readerPid === pid && ticks(receipt.readerCreated) === ticks(created)
    && receipt.reuseId === reuseId && receipt.mode === mode && receipt.maximumVariable === plan.maximumVariable
    && resolve(receipt.expectedNativePath) === resolve(nativePath) && resolve(receipt.profilePath) === resolve(profilePath)
    && ['SaveNothing', 'SaveAtExit', 'SaveIncrementally'].includes(receipt.style), 'History reader receipt identity differs');
  assert.equal(receipt.seedApplied, seedApplied, 'Reader unexpectedly reseeded history');
  assert.deepEqual(receipt.historyBeforeReader, {exists: beforeReader.exists, bytes: beforeReader.bytes, sha256: beforeReader.sha256}, 'Reader did not consume the independently observed prior disk');
  for (const marker of ['seed-started.json', 'seed-ready.json']) {
    const value = await readOwnedHistoryJson(evidence, join('native-history-reuse', marker));
    for (const key of ['reuseId', 'host', 'mode', 'maximumVariable', 'seedSha256']) assert.equal(value?.[key], plan[key], 'History seed marker ownership differs');
    assert.equal(resolve(value.history), resolve(nativePath));
    assert.equal(value.style, receipt.style, 'Reader changed history save style');
  }
  return {...receipt, receipt: join(evidence, 'native-history-reuse/launches', name), identitySource: 'Independently held OS PID and exact creation time'};
}

export async function readWindowsHistoryReuseCase(evidence, {mode, host, reader, token}) {
  assert(['0', '1'].includes(reader) && /^[a-f0-9-]{36}$/.test(token), 'Exact history reader stage required');
  const expectation = await readOwnedHistoryJson(evidence, `native-history-reuse-reader-${reader}.json`);
  const plan = await readOwnedHistoryJson(evidence, 'native-history-plan.json');
  const observer = await readOwnedHistoryJson(evidence, windowsHistoryReaderArtifacts(reader).observer);
  assert(expectation?.version === 1 && expectation.reader === reader && expectation.host === host && expectation.mode === mode
    && plan?.reusable === true && plan.host === host && plan.mode === mode && plan.reuseId === expectation.reuseId, 'History reader expectation differs from owned plan');
  assert(observer?.token === token && observer.handleHeld === true && observer.inputInjected === false && observer.terminationRequested === false, 'Independent held reader inspection required');
  assert(Array.isArray(expectation.initialSources) && expectation.initialSources.length <= 128
    && expectation.initialSources.every(source => typeof source === 'string' && !/[\r\n]/.test(source))
    && Buffer.byteLength(expectation.initialSources.join('\n')) <= 65536, 'Exact preplanned initial history sources required');
  const receipt = await readWindowsHistoryReuseReceipt(evidence, {
    host, mode, reuseId: plan.reuseId, pid: observer.shellPid, created: observer.handleCreated,
    seedApplied: reader === '0', beforeReader: expectation.beforeReader,
  });
  assert(Number.isSafeInteger(receipt.effectiveMaximum) && receipt.effectiveMaximum > 0, 'Actual positive reader history maximum required');
  return {...receipt, reader, expectedInitialSources: expectation.initialSources,
    expectedMaximum: plan.expectedMaximum ?? receipt.effectiveMaximum,
    expectedStyle: plan.expectedStyle ?? receipt.style};
}
