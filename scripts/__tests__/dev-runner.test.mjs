import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveConfig } from 'vite';
import { expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const cargoAvailable = spawnSync(process.env.CARGO || 'cargo', ['--version'], { encoding: 'utf8', timeout: 15000 }).status === 0;
const testNativeSigning = cargoAvailable && process.platform === 'darwin' && process.env.SHELLSPAN_NATIVE_SIGNING_TESTS === '1';

it('uses the same fixed loopback endpoint for Tauri and Vite development', async () => {
  const tauri = JSON.parse(await readFile(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const vite = await resolveConfig({ root }, 'serve');

  expect(vite.server).toMatchObject({ host: '127.0.0.1', port: 1420, strictPort: true });
  expect(tauri.build.devUrl).toBe(`http://${vite.server.host}:${vite.server.port}`);
});

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

it.runIf(testNativeSigning)(
  'never launches an unsigned development app when the requested identity is missing', () => {
    const result = spawnSync(process.execPath, ['scripts/dev.mjs', '--no-watch', '--no-dev-server-wait', '--config',
      JSON.stringify({ build: { beforeDevCommand: '' } }), '--', '--', '--check-keychain-access'], {
      cwd: root, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, SHELLSPAN_DEV_SIGNING_IDENTITY: `missing-shellspan-identity-${crypto.randomUUID()}` },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no identity found/i);
    expect(result.stdout).not.toContain('KEYCHAIN_ACCESS_');
  }, 125000,
);

it.runIf(testNativeSigning)('replaces the native desktop app on reload and shuts it down on Ctrl+C', async () => {
  const artifacts = join(root, 'artifacts/tests');
  await mkdir(artifacts, { recursive: true });
  const temporary = await mkdtemp(join(artifacts, 'dev-exit-'));
  const watch = join(temporary, 'watch');
  const changedFile = join(watch, 'reload.txt');
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((done, reject) => reservation.close(error => error ? reject(error) : done()));
  const devUrl = `http://127.0.0.1:${port}`;
  const config = {
    identifier: `com.shellspan.validation.dev-exit.${crypto.randomUUID()}`,
    build: { devUrl, beforeDevCommand: `pnpm run dev --port ${port}` },
  };
  await mkdir(watch);
  await writeFile(changedFile, 'before reload\n');
  const launcher = spawn(process.execPath, ['scripts/dev.mjs', '--config', JSON.stringify(config),
    '--additional-watch-folders', watch], {
    cwd: root,
    env: { ...process.env, SHELLSPAN_DATA_DIR: join(temporary, 'data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(launcher, 'exit');
  let output = '';
  for (const stream of [launcher.stdout, launcher.stderr]) {
    stream.on('data', chunk => { output = (output + chunk).slice(-16000); });
  }
  const processes = () => execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,comm='], { encoding: 'utf8' }).trim().split('\n')
    .map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line))
    .filter(Boolean);
  let group;
  const apps = () => processes()
    .filter(([, , , pgid, command]) => pgid === group && command.endsWith('/ShellSpan Dev.app/Contents/MacOS/ShellSpan'));
  async function waitFor(check, description, timeout = 120000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = check();
      if (result) return result;
      await delay(100);
    }
    assert.fail(`${description}\n${output}`);
  }
  try {
    group = await waitFor(() => processes().find(([, pid, ppid, pgid]) => ppid === String(launcher.pid) && pid === pgid)?.[1],
      'Tauri did not start its process group', 10000);
    const [, firstPid] = await waitFor(() => apps()[0], 'Desktop app did not start');
    const frontendReady = 'invoke load_terminal_workspace completed';
    await waitFor(() => output.includes(frontendReady), 'Desktop app did not load the workspace');
    output = '';
    await writeFile(changedFile, 'after reload\n');
    await waitFor(() => output.includes('Rebuilding application'), 'Tauri did not detect the file change', 10000);
    await waitFor(() => apps().every(([, pid]) => pid !== firstPid), 'Hot reload left the previous desktop app running', 10000);
    const [, nextPid, , , nextBinary] = await waitFor(() => apps()[0], 'Replacement desktop app did not start');
    await waitFor(() => output.includes(frontendReady), 'Replacement app did not load the workspace');

    launcher.kill('SIGINT');
    await waitFor(() => launcher.exitCode !== null || launcher.signalCode !== null, 'Development launcher did not exit', 10000);
    assert.deepEqual(await exited, [130, null], output);
    await waitFor(() => apps().every(([, pid]) => pid !== nextPid), 'Ctrl+C left the desktop app running', 10000);
    await assert.rejects(access(resolve(dirname(nextBinary), '../../..')), { code: 'ENOENT' });
    await assert.rejects(fetch(devUrl), 'Ctrl+C left Vite listening');
  } finally {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGTERM');
    if (group) {
      try { process.kill(-Number(group), 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await exited;
    await rm(temporary, { recursive: true, force: true });
  }
}, 270000);
