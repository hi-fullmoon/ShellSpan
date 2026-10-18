import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cli = require.resolve('@tauri-apps/cli/tauri.js');
const args = ['dev', '--config', fileURLToPath(new URL('../src-tauri/tauri.dev.conf.json', import.meta.url))];
if (process.platform === 'darwin') args.push('--runner', fileURLToPath(new URL('./dev-cargo-runner.mjs', import.meta.url)));
args.push(...process.argv.slice(2));
const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit', detached: process.platform !== 'win32' });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  if (child.pid && child.exitCode === null && !child.signalCode) {
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143); });
