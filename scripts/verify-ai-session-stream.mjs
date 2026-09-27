import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Requires a native desktop and Rust/Tauri. Creates and removes one unique,
// idle development session; no provider calls or shell commands are executed.
const repository = resolve(import.meta.dirname, '..');
const token = randomUUID();
let settle;
const result = new Promise((resolveResult) => { settle = resolveResult; });
const server = await createServer({
  configFile: false,
  root: repository,
  cacheDir: resolve(repository, 'node_modules/.vite-agent-stream-native'),
  resolve: { alias: { '@': resolve(repository, 'src') } },
  plugins: [react(), tailwindcss(), {
    name: 'native-agent-stream-result',
    configureServer(vite) {
      vite.middlewares.use(`/__agent-stream-result/${token}`, async (request, response) => {
        if (request.method !== 'POST') { response.statusCode = 405; response.end(); return; }
        try {
          let body = '';
          for await (const chunk of request) {
            body += chunk;
            if (body.length > 8192) throw new Error('Oversized test result');
          }
          const value = JSON.parse(body);
          response.end('ok');
          settle(value);
        } catch {
          response.statusCode = 400;
          response.end();
          settle({ ok: false, error: 'Invalid native test result' });
        }
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
let child;
let timer;
try {
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== 'string');
  const devUrl = `http://127.0.0.1:${address.port}/src/lib/ai/__tests__/agent-session-stream.native.html?token=${token}`;
  child = spawn('pnpm', ['exec', 'tauri', 'dev', '--no-watch', '--config', JSON.stringify({
    identifier: 'com.shellspan-dev', build: { beforeDevCommand: '', devUrl },
  })], { cwd: repository, stdio: ['ignore', 'ignore', 'inherit'], detached: process.platform !== 'win32' });
  child.once('error', (error) => settle({ ok: false, error: error.message }));
  child.once('exit', (code) => settle({ ok: false, error: `Tauri exited before reporting results (${code})` }));
  timer = setTimeout(() => settle({ ok: false, error: 'Native stream regression timed out after 10 minutes' }), 600_000);
  const outcome = await result;
  assert.equal(outcome.ok, true, outcome.error);
  console.log('Native Agent stream passed: pending subscription/snapshot cancellation, error publication, automatic gap recovery and cleanup.');
} finally {
  clearTimeout(timer);
  if (child?.pid && child.exitCode === null) {
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await server.close();
}
