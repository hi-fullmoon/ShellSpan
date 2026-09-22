import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  includedRustFiles,
  rustIncludeSourceIsFormatted,
} from '../check-rust-includes.mjs';

const root = path.resolve(import.meta.dirname, '../..');
describe('quality gate wiring', () => {
  it.each(['quality-gate.yml', 'release.yml'])('prepares rustfmt before frontend tests in %s', async workflow => {
    const ci = parse(await readFile(path.join(root, '.github/workflows', workflow), 'utf8'));
    const toolchain = await readFile(path.join(root, 'rust-toolchain.toml'), 'utf8');
    let testedJobs = 0;
    for (const job of Object.values(ci.jobs)) {
      if (!job.steps) continue;
      const testIndex = job.steps.findIndex(step => /\bpnpm (test|review:frontend)\b/.test(step.run ?? ''));
      if (testIndex === -1) continue;
      testedJobs += 1;
      const setup = job.steps.slice(0, testIndex).find(step => step.uses?.startsWith('dtolnay/rust-toolchain@'));
      expect(setup, `${workflow}: ${job.name} needs Rust before tests`).toBeDefined();
      expect(setup.with.components).toContain('rustfmt');
      expect(toolchain).toContain(`channel = "${setup.with.toolchain}"`);
    }
    expect(testedJobs).toBeGreaterThan(0);
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
    expect(ci).toContain('--all-targets --all-features');
    expect(ci).toContain('--all-features --no-fail-fast');
  });
  it('runs the full native suite serially without filtering or ignoring tests', async () => {
    const ci = parse(await readFile(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8'));
    const step = ci.jobs.rust.steps.find(step => step.name === 'Run Rust tests');
    expect(step.run.trim().split(/\s+/)).toEqual([
      'cargo', 'test', '--manifest-path', 'src-tauri/Cargo.toml',
      '--all-features', '--no-fail-fast', '--locked', '--', '--test-threads=1',
    ]);
    expect(step['continue-on-error']).toBeUndefined();
  });
  it('discovers all handoff test modules which cargo fmt cannot discover through include!', async () => {
    const files = (await includedRustFiles(path.join(root, 'src-tauri/src')))
      .map(file => path.relative(root, file).split(path.sep).join('/'));
    expect(files).toEqual(expect.arrayContaining([
      'src-tauri/src/agent_runtime/tests/runtime/scheduler.rs',
      'src-tauri/src/agent_runtime/tests/runtime/questions.rs',
      'src-tauri/src/agent_runtime/tests/runtime/skills.rs',
      'src-tauri/src/agent_runtime/tests/runtime/skill_bridge.rs',
      'src-tauri/src/agent_runtime/tests/runtime/images.rs',
      'src-tauri/src/agent_runtime/tests/runtime/image_bridge.rs',
      'src-tauri/src/agent_runtime/tests/runtime/file_references.rs',
      'src-tauri/src/agent_runtime/tests/native_adapter/file_references_sftp.rs',
    ]));
  });
  it('accepts include context indentation but still rejects real Rust formatting defects', () => {
    const formatted = 'fn ready() {\n    let value = 1;\n}\n';
    const moduleIndented = formatted
      .split('\n')
      .map(line => line ? `    ${line}` : line)
      .join('\n');
    const unformatted = '    fn  broken( ){let value=1;}\n';

    expect(rustIncludeSourceIsFormatted(formatted)).toBe(true);
    expect(rustIncludeSourceIsFormatted(formatted.replaceAll('\n', '\r\n'))).toBe(true);
    expect(rustIncludeSourceIsFormatted(moduleIndented)).toBe(true);
    expect(rustIncludeSourceIsFormatted(unformatted)).toBe(false);
  });
});
