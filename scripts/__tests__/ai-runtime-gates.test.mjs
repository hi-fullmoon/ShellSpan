import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { includedRustFiles } from '../check-rust-includes.mjs';

const root = path.resolve(import.meta.dirname, '../..');
describe('quality gate wiring', () => {
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
  it('discovers all handoff test modules which cargo fmt cannot discover through include!', async () => {
    const files = (await includedRustFiles(path.join(root, 'src-tauri/src'))).map(file => path.basename(file));
    expect(files).toEqual(expect.arrayContaining(['scheduler_tests.rs', 'question_tests.rs', 'skill_tests.rs',
      'skill_bridge_tests.rs', 'image_tests.rs', 'image_bridge_tests.rs', 'file_reference_tests.rs', 'file_reference_sftp_tests.rs']));
  });
});
