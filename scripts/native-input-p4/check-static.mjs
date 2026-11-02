// Code-only P4 evidence. No test runner, shell/PTY fixture, browser or App.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, '.native-input-p4/static', randomUUID());
await mkdir(directory, { recursive: true, mode: 0o700 });
const syntax = [
  'scripts/check-terminal-command-boundary.mjs',
  'scripts/native-input-p4/check-static.mjs',
  'scripts/native-input-p2/browser.mjs',
  'src/components/terminal/__tests__/terminal-command-stream.browser.mjs',
  'src/components/terminal/__tests__/terminal-command-decorations.browser.mjs',
];
const checks = [
  ['types', 'pnpm', ['exec', 'tsc', '--noEmit']],
  ['frontend-build', 'pnpm', ['build']],
  ['rust-source-and-tests-compile', 'cargo', ['check', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--tests']],
  ['rust-format', 'cargo', ['fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--', '--check']],
  ['rust-includes', 'pnpm', ['check:rust:includes']],
  ['command-boundary', 'pnpm', ['check:terminal:boundary']],
  ...syntax.map((file, index) => [`node-syntax-${index}`, process.execPath, ['--check', file]]),
  ['diff-whitespace', 'git', ['diff', '--check']],
];
const results = [];
for (const [name, command, args] of checks) {
  const logPath = resolve(directory, `${name}.log`);
  const log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
  const started = Date.now();
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ error: error.message, exitCode: null }));
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  await new Promise(resolve => log.end(resolve));
  results.push({ name, command, args, ...result, elapsedMs: Date.now() - started, logPath });
}
const summary = { scope: 'P4 code/type/build/static only; no dynamic acceptance', directory, results };
await writeFile(resolve(directory, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ directory, failed: results.filter(result => result.exitCode !== 0).map(result => result.name) }));
process.exitCode = results.some(result => result.exitCode !== 0) ? 1 : 0;
