import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const cargoAvailable = spawnSync(process.env.CARGO || 'cargo', ['--version'], { encoding: 'utf8', timeout: 15000 }).status === 0;

it('forwards development options to the installed Tauri CLI', () => {
  const result = spawnSync(process.execPath, ['scripts/dev.mjs', '--help'], { cwd: root, encoding: 'utf8', timeout: 15000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('--no-watch');
  expect(result.stdout).toContain('--runner');
});

it.runIf(cargoAvailable)('preserves real Cargo subcommands other than run', () => {
  const result = spawnSync(process.execPath, ['scripts/dev-cargo-runner.mjs', '--version'], { cwd: root, encoding: 'utf8', timeout: 15000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/^cargo \d/);
});

it('reports an unavailable Cargo executable without starting the app', () => {
  const result = spawnSync(process.execPath, ['scripts/dev-cargo-runner.mjs', 'run'], {
    cwd: root, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, CARGO: resolve(import.meta.dirname, 'missing-cargo-executable') },
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('ENOENT');
  expect(result.stdout).not.toContain('KEYCHAIN_ACCESS_');
});

it.runIf(cargoAvailable && process.platform === 'darwin' && process.env.SHELLSPAN_NATIVE_SIGNING_TESTS === '1')(
  'never launches an unsigned development app when the requested identity is missing', () => {
    const result = spawnSync(process.execPath, ['scripts/dev.mjs', '--no-watch', '--config',
      JSON.stringify({ build: { beforeDevCommand: '' } }), '--', '--', '--check-keychain-access'], {
      cwd: root, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, SHELLSPAN_DEV_SIGNING_IDENTITY: `missing-shellspan-identity-${crypto.randomUUID()}` },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no identity found/i);
    expect(result.stdout).not.toContain('KEYCHAIN_ACCESS_');
  }, 125000,
);
