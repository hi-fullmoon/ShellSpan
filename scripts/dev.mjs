import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cli = require.resolve('@tauri-apps/cli/tauri.js');
const args = ['dev', '--config', fileURLToPath(new URL('../src-tauri/tauri.dev.conf.json', import.meta.url))];
if (process.platform === 'darwin') args.push('--runner', fileURLToPath(new URL('./dev-cargo-runner.mjs', import.meta.url)));
args.push(...process.argv.slice(2));
const detached = process.platform !== 'win32';
let child;
let interrupted;

function stop(signal) {
  if (!child?.pid) return;
  try {
    if (detached) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

const shutdownSignals = detached ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM'];
for (const signal of shutdownSignals) process.on(signal, () => {
  interrupted ??= signal;
  stop(signal);
});

let image;
try {
  if (process.platform === 'darwin' && !process.env.SHELLSPAN_ACCEPTANCE_FROZEN_MANIFEST) {
    const target = fileURLToPath(new URL('../src-tauri/target/', import.meta.url));
    await mkdir(target, { recursive: true });
    image = await mkdtemp(join(target, '.shellspan-dev-'));
  }
  if (!interrupted) {
    const env = image ? { ...process.env, SHELLSPAN_DEV_IMAGE_DIR: image } : process.env;
    child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit', detached, env });
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? 128 + constants.signals[signal]));
    });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (image) {
    // Stop the native app and Vite if the CLI exited while they were still running.
    stop('SIGTERM');
    await rm(image, { recursive: true, force: true });
  }
}
if (interrupted) process.exitCode = 128 + constants.signals[interrupted];
