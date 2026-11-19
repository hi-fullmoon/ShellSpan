import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';

const fixtureDirectory = resolve(import.meta.dirname, '../../src/lib/terminal/__tests__/fixtures');
const captureRoot = 'artifacts/tests/native-input/acceptance/';
const displayCommand = 'node scripts/native-input/export-fixture.mjs display <ownership-window capture directory>';
const usage = `Usage:
  ${displayCommand} [output.json]
  node scripts/native-input/export-fixture.mjs selection <ZLE capture directory> [output.json]
  node scripts/native-input/export-fixture.mjs viewport <viewport report.json> [output.json]`;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const packet = bytes => ({ base64: bytes.toString('base64'), length: bytes.length, sha256: sha256(bytes) });

function capturePath(input) {
  const normalized = input.split(sep).join('/');
  const index = normalized.indexOf(captureRoot);
  return index < 0 ? basename(input) : normalized.slice(index);
}

async function displayFixture(input) {
  const manifest = await readJson(resolve(input, 'manifest.json'));
  assert.equal(manifest.nativeFailures.length, 0, 'Native capture contains failures');
  const name = manifest.cases.find(name => name.startsWith('commit-'));
  assert(name, 'Native capture has no commit case');
  const raw = await readFile(resolve(input, name, 'pty.bin'));
  const packets = {};
  for (const [label, value] of [['enter', 'MQ=='], ['exit', 'MA==']]) {
    const expected = Buffer.from(`\x1b]1337;SetUserVar=ShellSpanP0ReflowCursorLine=${value}\x07`);
    const offset = raw.indexOf(expected);
    assert(offset >= 0, `Missing actual native ${label} packet`);
    packets[label] = { offset, ...packet(raw.subarray(offset, offset + expected.length)) };
  }
  return {
    kind: 'actual native PTY display-packet excerpt; untrusted presentation, not control acknowledgement',
    provenance: {
      captureCase: name, rawPtySha256: sha256(raw),
      shellSha256: manifest.inputs.shell.sha256, bridgeSha256: manifest.inputs.bridge.sha256,
      platform: 'macOS arm64', bash: '5.3', readline: '8.3.6', regenerate: displayCommand,
    },
    packets,
  };
}

async function selectionFixture(input) {
  const [raw, geometry, binding, corpus] = await Promise.all([
    readFile(resolve(input, 'raw.bin')),
    readJson(resolve(input, 'geometry.json')),
    readJson(resolve(input, 'verified-display-binding.json')),
    readJson(resolve(input, 'source-corpus.json')),
  ]);
  const marker = Buffer.from('P3_HISTORY_60\r\n');
  const offset = raw.indexOf(marker);
  assert(offset >= 0, 'ZLE capture is missing the history line marker');
  const end = offset + marker.length;
  const resizeColumns = geometry.resizeEvents.map(event => event.columns);
  assert.equal(geometry.columns, 100);
  assert.equal(resizeColumns.length, 7);
  return {
    version: 1,
    scope: 'Actual controlled ZLE prefix through sixty genuine output lines; dependency coordinate regression only, not P3 acceptance',
    provenance: { capture: capturePath(input), rawSha256: sha256(raw), byteRange: [0, end] },
    columns: geometry.columns, rows: geometry.rows, resizeColumns, binding,
    source: corpus[0].source, packet: packet(raw.subarray(0, end)),
  };
}

async function viewportFixture(input) {
  const report = await readJson(input);
  const item = report.results.find(item => item.theme === 'adam1' && item.columns === 32);
  assert(item?.exitCode === 0, 'Missing successful 32-column viewport capture');
  const parked = item.observations.find(item => item.role === 'parked');
  const frames = parked.frames.filter(frame => frame.at >= parked.parkedAt);
  assert(frames.some(frame => frame.viewportY === frame.baseY), 'Capture does not show the viewport jump');
  const first = frames[0];
  const [raw, events] = await Promise.all([
    readFile(resolve(item.evidence, 'raw.bin')),
    readJson(resolve(item.evidence, 'geometry-events.json')),
  ]);
  assert(first.offset < events[0].offset);
  const bytes = raw.subarray(0, events.at(-1).offset);
  return {
    version: 1,
    scope: 'Real live PTY failure; viewport coordinate regression only, not new native acceptance',
    provenance: { report: capturePath(input), rawSha256: sha256(raw), byteRange: [0, bytes.length] },
    columns: item.columns, rows: 30, binding: parked.binding,
    park: { offset: first.offset, viewportY: first.viewportY }, events, packet: packet(bytes),
  };
}

const exporters = new Map([
  ['display', { filename: 'native-input-display.json', load: displayFixture }],
  ['selection', { filename: 'native-selection-reflow.json', load: selectionFixture }],
  ['viewport', { filename: 'native-viewport-reflow.json', load: viewportFixture }],
]);

const [kind, input, destination, ...extra] = process.argv.slice(2);
if ((kind === '-h' || kind === '--help') && process.argv.length === 3) {
  console.log(usage);
} else {
  const exporter = exporters.get(kind);
  if (!exporter || !input || input.startsWith('--') || extra.length > 0) throw new Error(usage);
  const fixture = await exporter.load(resolve(input));
  const output = destination ? resolve(destination) : resolve(fixtureDirectory, exporter.filename);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(fixture, null, 2) + '\n');
  console.log(fixture.packet ? JSON.stringify({ output, bytes: fixture.packet.length, sha256: fixture.packet.sha256 }) : output);
}
