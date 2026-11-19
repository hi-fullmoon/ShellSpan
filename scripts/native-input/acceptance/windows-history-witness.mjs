import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {windowsHistoryModes} from './windows-history-profile.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (first, second) => resolve(first).toLowerCase() === resolve(second).toLowerCase();
export function windowsHistoryReaderArtifacts(reader) {
  assert(reader === undefined || ['0', '1'].includes(reader), 'Exact history reader 0/1 required');
  const suffix = reader === undefined ? '' : '-history-reader-' + reader;
  return {evidence: 'native-webview-evidence' + suffix + '.json', observer: 'native-job-observer' + suffix + '.json',
    shell: 'native-history-shell-record' + suffix + '.json', exit: 'native-history-exit' + suffix + '.json', window: 'native-window' + suffix + '.png'};
}
async function ownedFile(root, file) {
  assert(isAbsolute(root) && isAbsolute(file), 'Absolute owned history paths required');
  let cursor = dirname(file);
  for (;;) {
    const info = await lstat(cursor);
    assert(info.isDirectory() && !info.isSymbolicLink(), 'History evidence ancestor is not an owned directory');
    if (same(cursor, root)) break;
    const parent = dirname(cursor);
    assert(parent !== cursor && resolve(cursor).toLowerCase().startsWith(resolve(root).toLowerCase()), 'History evidence escaped owned root');
    cursor = parent;
  }
  let info;
  try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 131072, 'Invalid owned history evidence file');
  const bytes = await readFile(file);
  const after = await lstat(file);
  assert(bytes.length === info.size && after.size === info.size && after.mtimeMs === info.mtimeMs && after.ctimeMs === info.ctimeMs, 'History evidence changed while reading');
  return bytes;
}
export async function readOwnedHistoryJson(root, name) {
  assert(!name.split(/[\\/]/).includes('..') && !isAbsolute(name), 'History evidence name escaped owned root');
  const bytes = await ownedFile(root, join(root, name));
  return bytes === null ? null : JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
}

export async function readWindowsHistoryDisk(evidence, {mode, host}) {
  assert(windowsHistoryModes.includes(mode) && ['powerShell7', 'windowsPowerShell'].includes(host), 'Exact Windows history mode and host required');
  const plan = await readOwnedHistoryJson(evidence, 'native-history-plan.json');
  const profile = await readOwnedHistoryJson(evidence, 'native-history-profile.json');
  const expected = mode === 'history-custom' ? join(evidence, 'data/history custom/命令 history.txt') : join(evidence, 'data/shell-history', host + '.txt');
  assert(plan?.mode === mode && plan.host === host && profile?.mode === mode && same(plan.history, expected) && same(profile.expectedNativePath, expected), 'History disk witness differs from fixed owned case path');
  const bytes = await ownedFile(evidence, expected);
  if (bytes === null) return {exists: false, path: expected, bytes: 0, sha256: null, items: []};
  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  const lines = text.length ? text.split(/\r?\n/) : [];
  if (lines.at(-1) === '') lines.pop();
  return {exists: true, path: expected, bytes: bytes.length, sha256: sha(bytes), items: lines.map(source => ({sha256: sha(Buffer.from(source, 'utf8')), bytes: Buffer.byteLength(source, 'utf8')}))};
}

export async function readWindowsHistoryExit(evidence, reader) {
  const artifact = windowsHistoryReaderArtifacts(reader);
  const ready = await readOwnedHistoryJson(evidence, artifact.exit + '.ready.json');
  const result = await readOwnedHistoryJson(evidence, artifact.exit);
  for (const value of [ready, result].filter(Boolean)) assert(Number.isInteger(value.shellPid) && value.shellPid > 1 && value.created && value.handleHeld === true && value.inputInjected === false && value.terminationRequested === false, 'Invalid passive Shell exit observation');
  if (result) assert(ready && result.shellPid === ready.shellPid && result.created === ready.created && result.ended === true && Number.isInteger(result.exitCode), 'Original held Shell exit was not observed');
  return {ready, result};
}
