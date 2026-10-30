import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import frontend from '../../vitest.config.ts';
import native from '../../vitest.native.config.ts';

const root = path.resolve(import.meta.dirname, '../..');
const nativeTest = 'src/components/ai/__tests__/subagent-budget.native.test.tsx';
const run = promisify(execFile);

describe('explicit native frontend integration gate', () => {
  it('keeps the real-store integration out of default frontend discovery', async () => {
    expect(frontend.test.exclude).toContain('**/*.native.test.{ts,tsx}');
    const listing = await run(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'),
      'list', '--filesOnly'], { cwd: root, encoding: 'utf8', timeout: 20_000 });
    expect(listing.stdout).not.toContain('subagent-budget.native.test.tsx');
    expect(listing.stdout).toContain('session-error.test.ts');
    expect(native.test.include).toEqual([nativeTest]);
    expect(native.test.exclude).not.toContain('**/*.native.test.{ts,tsx}');
  }, 25_000);

  it('builds asynchronously before Vitest and executes only the compiled exporter inside the integration suite', async () => {
    const [test, runner, manifest] = await Promise.all([
      readFile(path.join(root, nativeTest), 'utf8'),
      readFile(path.join(root, 'scripts/verify-subagent-budget.mjs'), 'utf8'),
      readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
    ]);
    expect(manifest.scripts.test).toBe('vitest run');
    expect(manifest.scripts['test:subagent-budget:native']).toBe('node scripts/verify-subagent-budget.mjs');
    expect(test).not.toContain('execFileSync');
    expect(test).not.toContain("'cargo'");
    expect(test).not.toMatch(/\b(?:it|describe)\.(?:skip|todo)\b/);
    expect(test).toContain('SHELLSPAN_CHILD_CONTINUATION_TEST_BINARY');
    expect(runner).toContain("spawn('cargo'");
    expect(runner).toContain("'--no-run'");
    expect(runner).toContain("'--all-features'");
    expect(runner).toContain("'--locked'");
    expect(runner).not.toContain('timeout:');
    expect(runner.indexOf('await Promise.all([compiled, artifacts])')).toBeLessThan(runner.indexOf('const tests = spawn'));
  });

  it('requires the integration on the native quality gate after the full Rust suite', async () => {
    const quality = parse(await readFile(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8'));
    const release = parse(await readFile(path.join(root, '.github/workflows/release.yml'), 'utf8'));
    const steps = quality.jobs.rust.steps;
    const nativeStep = steps.findIndex(step => step.run === 'pnpm test:subagent-budget:native');
    expect(nativeStep).toBeGreaterThan(steps.findIndex(step => step.name === 'Run Rust tests'));
    expect(steps[nativeStep]['continue-on-error']).toBeUndefined();
    expect(steps[nativeStep].if).toBeUndefined();
    expect(quality.jobs.rust.strategy.matrix.include.map(target => target.platform)).toEqual(['windows', 'macos']);
    for (const job of [quality.jobs.frontend, ...Object.values(release.jobs)]) {
      for (const step of job.steps ?? []) expect(step.run ?? '').not.toContain('test:subagent-budget:native');
    }
  });
});
