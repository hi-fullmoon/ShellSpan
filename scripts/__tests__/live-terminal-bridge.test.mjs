import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach, expect, it, vi} from 'vitest';
import {driveTerminal} from '../native-input-p3/live-terminal-bridge.mjs';

const roots = [];
afterEach(() => {for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true});});
const create = () => {
  const root = path.resolve('.artifacts/tests/live-terminal-bridge', randomUUID());
  fs.mkdirSync(root, {recursive: true});roots.push(root);return root;
};

it('drains a final event appended while the browser callback awaits and the producer exits', async () => {
  const root = create(), file = path.join(root, 'live-events.jsonl');
  fs.writeFileSync(file, JSON.stringify({kind:'data',offset:0,bytes:[65]})+'\n');
  let active = true;
  const evaluate = vi.fn().mockImplementationOnce(async (_callback, events) => {
    expect(events).toEqual([{kind:'data',offset:0,bytes:[65]}]);
    fs.appendFileSync(file, JSON.stringify({kind:'data',offset:1,bytes:[66,67]})+'\n');
    active = false;return [];
  }).mockResolvedValue([]);
  await driveTerminal({evaluate}, root, () => active);
  expect(evaluate).toHaveBeenCalledTimes(2);
  expect(evaluate.mock.calls[1][1]).toEqual([{kind:'data',offset:1,bytes:[66,67]}]);
  expect(JSON.parse(fs.readFileSync(path.join(root,'actual-xterm-responses.json'),'utf8'))).toMatchObject({rawBytesForwarded:3,timelineEvents:2});
});

it('does not claim missing or reordered bytes as a completed drain', async () => {
  const root = create();
  fs.writeFileSync(path.join(root,'live-events.jsonl'), JSON.stringify({kind:'data',offset:4,bytes:[65]})+'\n');
  await expect(driveTerminal({evaluate:vi.fn()}, root, () => false)).rejects.toThrow();
  expect(fs.existsSync(path.join(root,'actual-xterm-responses.json'))).toBe(false);
});

it('rejects a final partial timeline entry instead of reporting zero lost bytes', async () => {
  const root = create();
  fs.writeFileSync(path.join(root,'live-events.jsonl'), '{"kind":"data","offset":0');
  await expect(driveTerminal({evaluate:vi.fn()}, root, () => false)).rejects.toThrow('incomplete timeline');
  expect(fs.existsSync(path.join(root,'actual-xterm-responses.json'))).toBe(false);
});
