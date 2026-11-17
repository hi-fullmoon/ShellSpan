import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const runner = resolve(root, 'scripts/native-input-p2/matrix.mjs');
const directory = resolve(root, 'artifacts/tests/native-input-p2/app-matrix');
const entries = () => existsSync(directory) ? readdirSync(directory).sort() : [];
const environment = { ...process.env };
delete environment.SHELLSPAN_ALLOW_FOREGROUND_TESTS;
function run(...args) {
  const before = entries();
  const result = spawnSync(process.execPath, [runner, ...args], { cwd: root, env: environment, encoding: 'utf8', timeout: 5_000 });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(entries()).toEqual(before);
  return result;
}

describe('native input matrix transport selection', () => {
  it('lists the six release Bash local cases without a foreground grant or SSH fixture', () => {
    const result = run('--local-only', '--list-cases');
    expect(result.status).toBe(0);
    const listing = JSON.parse(result.stdout);
    expect(listing).toMatchObject({ execution: false, localOnly: true, fullMatrix: false });
    const scenarios = ['history-small', 'history-default', 'history-custom', 'history-empty', 'history-unset', 'jobs'];
    expect(listing.cases).toEqual(scenarios.map(scenario => ({ version: '5.3', scenario, transport: 'local' })));
  });
  it('preserves an explicit local subset without claiming complete coverage', () => {
    const result = run('--local-only', '--list-cases', '--case', '5.3/local/jobs');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ fullMatrix: false, cases: [{ version: '5.3', transport: 'local', scenario: 'jobs' }] });
  });
  it.each([
    ['4.1/ssh/jobs'],
    ['4.4/local/jobs'],
    ['5.3/local/lifecycle'],
    ['unknown/local/jobs'],
    ['5.3/local/jobs', '5.3/local/jobs'],
  ])('rejects selectors outside the local scope or repeated selectors: %j', (...cases) => {
    const result = run('--local-only', '--list-cases', ...cases.flatMap(value => ['--case', value]));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('within the selected transport scope');
  });
  it('rejects an SSH fixture argument in local-only mode', () => {
    const result = run('--local-only', '--list-cases', root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Local-only acceptance does not use an SSH fixture');
  });
  it('requires an owned SSH fixture to execute the full matrix', () => {
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Provide the owned fixture path');
  });
  it('lists all 13 release cases without an SSH fixture', () => {
    const result = run('--list-cases');
    expect(result.status).toBe(0);
    const listing = JSON.parse(result.stdout);
    expect(listing).toMatchObject({ execution: false, localOnly: false, fullMatrix: true });
    expect(listing.cases).toHaveLength(13);
    expect(new Set(listing.cases.map(item => item.version))).toEqual(new Set(['5.3']));
    expect(listing.cases.filter(item => item.transport === 'local')).toHaveLength(6);
    expect(listing.cases.filter(item => item.transport === 'ssh')).toHaveLength(7);
  });
  it('lists the original 39-case matrix when legacy Bash coverage is requested', () => {
    const result = run('--include-legacy', '--list-cases');
    expect(result.status).toBe(0);
    const listing = JSON.parse(result.stdout);
    expect(listing).toMatchObject({ execution: false, localOnly: false, fullMatrix: true });
    expect(listing.cases).toHaveLength(39);
    expect(new Set(listing.cases.map(item => item.version))).toEqual(new Set(['4.1', '4.4', '5.3']));
  });
  it('refuses a real local run before creating evidence when no foreground window is scheduled', () => {
    const result = run('--local-only');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Native App acceptance is disabled by default');
  });
});
