import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { includedRustFiles } from '../check-rust-includes.mjs';
import { validateBenchmarkReport } from '../ai-panel-benchmark.mjs';

const root = path.resolve(import.meta.dirname, '../..');
describe('cumulative AI runtime gate wiring', () => {
  it('rejects empty/invalid benchmark samples even when the runner exits successfully', () => {
    const report = result => ({ files: [{ groups: [{ benchmarks: Array.from({ length: 3 }, () => result) }] }] });
    const measured = { name: 'workload', samples: [], sampleCount: 5, hz: 500, mean: 1.5, median: 1.5 };
    expect(validateBenchmarkReport(report(measured))).toHaveLength(3);
    expect(() => validateBenchmarkReport(report({ ...measured, sampleCount: 0 }))).toThrow();
    expect(() => validateBenchmarkReport(report({ ...measured, mean: NaN }))).toThrow();
    expect(() => validateBenchmarkReport(report({ ...measured, error: 'callback failed' }))).toThrow();
  });
  it('resolves every package script named by quality CI and every referenced script file', async () => {
    const { scripts } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const ci = await readFile(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8');
    for (const match of ci.matchAll(/\bpnpm[ \t]+([\w:-]+)/g)) {
      if (!['install', 'exec'].includes(match[1])) expect(scripts[match[1]], match[1]).toBeTruthy();
    }
    for (const command of Object.values(scripts)) {
      for (const match of command.matchAll(/\bscripts\/[\w./-]+\.(?:mjs|cjs|js|ts)\b/g)) {
        await expect(access(path.join(root, match[0]))).resolves.toBeUndefined();
      }
    }
    for (const gate of ['test:ai:phase3', 'test:ai:phase4', 'test:ai:phase5', 'test:ai:phase6',
      'test:ai:stage3:rust', 'test:ai:stage4', 'test:ai:stage3b', 'test:ai:stage5',
      'test:ai:stage6:frontend', 'test:ai:stage6:rust', 'test:ai:stage6:browser',
      'test:ai:stage6b:sftp', 'test:ai:stage6d:sftp', 'check:rust:includes',
      'benchmark:ai-panel', 'test:agent:providers:live']) {
      expect(scripts[gate], gate).toBeTruthy();
      expect(ci, gate).toContain(`pnpm ${gate}`);
    }
    expect(ci).toContain('--all-targets --all-features');
    expect(ci).toContain('--all-features --no-fail-fast');
  });
  it('discovers all handoff test modules which cargo fmt cannot discover through include!', async () => {
    const files = (await includedRustFiles(path.join(root, 'src-tauri/src'))).map(file => path.basename(file));
    expect(files).toEqual(expect.arrayContaining(['scheduler_tests.rs', 'question_tests.rs', 'skill_tests.rs',
      'skill_bridge_tests.rs', 'image_tests.rs', 'image_bridge_tests.rs', 'file_reference_tests.rs', 'file_reference_sftp_tests.rs']));
  });
});
