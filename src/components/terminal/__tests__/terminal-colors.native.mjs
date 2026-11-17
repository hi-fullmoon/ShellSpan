import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

assert.equal(process.platform, 'darwin', 'Native terminal color verification requires macOS.');
const artifacts = resolve('artifacts/tests/terminal-colors');
await mkdir(artifacts, { recursive: true });
const directory = await mkdtemp(`${artifacts}/native-`);
const server = await createServer({
  configFile: false, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': resolve('src') } }, plugins: [tailwindcss()],
  server: { host: '127.0.0.1', port: 0 },
});
let complete;
let fail;
let child;
let reported = false;
server.middlewares.use(async (request, response, next) => {
  if (request.url === '/result' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const result = JSON.parse(body);
    reported = true;
    response.end('ok');
    if (result.ok) complete(result); else fail(new Error(result.error));
  } else if (request.url?.startsWith('/?phase=')) {
    response.setHeader('Content-Type', 'text/html');
    response.end(await server.transformIndexHtml('/', '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/components/terminal/__tests__/terminal-colors.native.tsx"></script></body></html>'));
  } else next();
});
try {
  await server.listen();
  for (const phase of ['write', 'reopen', 'reset-reopen']) {
    reported = false;
    const result = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
    const config = JSON.stringify({ identifier: 'com.shellspan.validation.terminal-colors',
      build: { beforeDevCommand: '', devUrl: `${server.resolvedUrls.local[0]}?phase=${phase}` },
      app: { windows: [{ label: 'main', title: 'ShellSpan terminal color verification', width: 900, height: 760 }] } });
    child = spawn('pnpm', ['exec', 'tauri', 'dev', '--no-watch', '--runner', resolve('scripts/dev-cargo-runner.mjs'),
      '--config', resolve('src-tauri/tauri.dev.conf.json'), '--config', config],
    { cwd: resolve('.'), env: { ...process.env, SHELLSPAN_DATA_DIR: directory }, stdio: ['ignore', 'ignore', 'inherit'], detached: true });
    const exited = new Promise(resolve => child.once('exit', code => {
      if (!reported) fail(new Error(`Native color verification exited before reporting (${code})`));
      resolve(code);
    }));
    child.once('error', error => fail(error));
    const timer = setTimeout(() => fail(new Error(`Native color ${phase} verification timed out`)), 900_000);
    try { await result; } finally { clearTimeout(timer); }
    let exitTimer;
    try {
      assert.equal(await Promise.race([exited, new Promise((_, reject) => {
        exitTimer = setTimeout(() => reject(new Error('Verification app did not exit')), 15_000);
      })]), 0);
    } finally { clearTimeout(exitTimer); }
    child = undefined;
  }
  console.log('Native terminal colors passed: real local PTY, live theme updates, SQLite automatic save, application restart and persisted reset.');
} finally {
  if (child?.pid && child.exitCode === null) process.kill(-child.pid, 'SIGTERM');
  await server.close();
}
