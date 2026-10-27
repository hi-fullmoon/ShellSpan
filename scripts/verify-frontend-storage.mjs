import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';

assert.equal(process.platform, 'darwin', 'This native storage runner currently requires macOS.');
const repository = path.resolve(import.meta.dirname, '..');
const directory = await mkdtemp(path.join(tmpdir(), 'shellspan-native-storage-'));
const server = await createServer({ root: repository, configFile: false, appType: 'custom',
  logLevel: 'error', resolve: { alias: { '@': path.join(repository, 'src') } },
  server: { host: '127.0.0.1', port: 0 } });
let complete;
let fail;
let child;
let reported = false;
server.middlewares.use(async (request, response, next) => {
  if (request.url?.startsWith('/result') && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.end('ok');
    const result = JSON.parse(body);
    reported = true;
    if (result.ok) complete?.(result); else fail?.(new Error(result.error));
  } else if (request.url?.startsWith('/?phase=')) {
    response.setHeader('Content-Type', 'text/html');
    response.end(await server.transformIndexHtml('/', '<!doctype html><html><body><script type="module" src="/src/test/frontend-storage-native.ts"></script></body></html>'));
  } else next();
});
try {
  await server.listen();
  for (const phase of ['write', 'reopen']) {
    reported = false;
    const result = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
    const url = `${server.resolvedUrls.local[0]}?phase=${phase}`;
    const config = JSON.stringify({ identifier: 'com.shellspan.validation.frontend-storage',
      build: { beforeDevCommand: '', devUrl: url },
      app: { windows: [{ label: 'main', title: 'ShellSpan storage verification', width: 640, height: 360 }] } });
    child = spawn('pnpm', ['exec', 'tauri', 'dev', '--no-watch', '--runner',
      path.join(repository, 'scripts/dev-cargo-runner.mjs'), '--config',
      path.join(repository, 'src-tauri/tauri.dev.conf.json'), '--config', config],
    { cwd: repository, env: { ...process.env, SHELLSPAN_DATA_DIR: directory }, stdio: ['ignore', 'ignore', 'inherit'], detached: true });
    const exited = new Promise(resolve => child.once('exit', code => {
      if (!reported) fail?.(new Error(`Verification app exited before reporting (${code})`));
      resolve(code);
    }));
    child.once('error', error => fail?.(error));
    const timer = setTimeout(() => fail?.(new Error(`Native storage ${phase} phase timed out`)), 180_000);
    try { await result; } finally { clearTimeout(timer); }
    let exitTimer;
    try {
      const code = await Promise.race([exited, new Promise((_, reject) => {
        exitTimer = setTimeout(() => reject(new Error('Verification app did not exit')), 15_000);
      })]);
      assert.equal(code, 0, 'Verification app exited unsuccessfully');
    } finally { clearTimeout(exitTimer); }
    child = undefined;
  }
  assert.ok((await stat(path.join(directory, 'frontend-state.db'))).isFile());
  assert.ok((await readdir(path.join(directory, 'logs'))).some(name => name === 'frontend.log'));
  console.log('Native storage passed: real IPC, SQLite reopen, revision conflicts, atomic detach, cancellation recovery, idempotent acknowledgement and shared log paths.');
} finally {
  if (child?.pid && child.exitCode === null) process.kill(-child.pid, 'SIGTERM');
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
