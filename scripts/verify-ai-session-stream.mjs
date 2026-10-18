import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { build, createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Requires a native desktop and Rust/Tauri. The default regression creates one
// idle session without provider calls. --performance also reads stored journals
// and creates temporary PTYs; model calls occur unless --no-model is supplied.
const repository = resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: {
  performance: { type: 'boolean' }, baseline: { type: 'boolean' },
  focus: { type: 'boolean' },
  'focus-background': { type: 'boolean' },
  'terminal-contention': { type: 'boolean' },
  'terminal-readiness': { type: 'boolean' },
  'no-model': { type: 'boolean' }, route: { type: 'string' }, model: { type: 'string' },
  'cleanup-session': { type: 'string', multiple: true },
  'baseline-ref': { type: 'string' },
} });
const performanceRun = values.performance === true;
const focusRun = values.focus === true;
const focusBackgroundRun = values['focus-background'] === true;
const terminalContentionRun = values['terminal-contention'] === true;
assert(!terminalContentionRun || (!focusBackgroundRun && !focusRun && !performanceRun && !values['terminal-readiness']), '--terminal-contention is a separate regression');
assert(!focusBackgroundRun || (!focusRun && !values.performance && !values['terminal-readiness']), '--focus-background is a separate regression');
const terminalReadinessRun = values['terminal-readiness'] === true;
assert(!terminalReadinessRun || (!focusRun && !performanceRun), '--terminal-readiness is a separate regression');
assert(!focusRun || !performanceRun, '--focus and --performance are separate regressions');
const baseline = values.baseline === true;
const noModel = values['no-model'] === true;
assert(!focusBackgroundRun || !noModel, '--focus-background requires real model calls');
assert(Boolean(values.route) === Boolean(values.model), '--route and --model must be supplied together');
assert(!values['baseline-ref'] || baseline, '--baseline-ref requires --baseline');
const baselineRef = values['baseline-ref'] ?? 'HEAD';
const baselineCommit = baseline ? execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${baselineRef}^{commit}`],
  { cwd: repository, encoding: 'utf8' }).trim() : undefined;
const baselineSources = baseline ? new Map([
  'src/lib/ai/agent-session-adapter.ts',
  'src/components/ai/workspace/use-ai-session-controller.ts',
].map(path => [resolve(repository, path), execFileSync('git', ['show', `${baselineCommit}:${path}`], { cwd: repository, encoding: 'utf8' })])) : new Map();
const token = randomUUID();
let settle;
const result = new Promise((resolveResult) => { settle = resolveResult; });
const page = performanceRun ? 'agent-panel-performance.native.html' : 'agent-session-stream.native.html';
const pagePath = terminalContentionRun ? 'src/components/terminal/__tests__/terminal-contention.native.html'
  : focusBackgroundRun ? 'src/components/terminal/__tests__/focus-background.native.html'
  : terminalReadinessRun ? 'src/components/terminal/__tests__/terminal-readiness.native.html'
  : focusRun ? 'src/components/focus/__tests__/focus.native.html' : `src/lib/ai/__tests__/${page}`;
const output = performanceRun ? await mkdtemp(resolve(tmpdir(), 'shellspan-agent-performance-')) : undefined;
const baselinePlugin = {
  name: 'agent-panel-performance-baseline',
  enforce: 'pre',
  load(id) { return baselineSources.get(id.split('?')[0]); },
};
const attachResult = (vite) => {
  if (terminalReadinessRun) vite.middlewares.use(`/__terminal-registry-reload/${token}`, async (request, response) => {
    if (request.method !== 'POST') { response.statusCode = 405; response.end(); return; }
    try {
      const module = vite.moduleGraph.getModuleById(resolve(repository, 'src/components/terminal/registry/terminal-registry.ts'));
      assert(module, 'Terminal registry module was not loaded');
      await vite.reloadModule(module);
      response.end('ok');
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error));
    }
  });
  vite.middlewares.use(`/__agent-stream-result/${token}`, async (request, response) => {
    if (request.method !== 'POST') { response.statusCode = 405; response.end(); return; }
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 8192) throw new Error('Oversized test result');
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.end('ok');
      if (value.progress) { console.log(value.progress); return; }
      settle(value);
    } catch {
      response.statusCode = 400;
      response.end();
      settle({ ok: false, error: 'Invalid native test result' });
    }
  });
};
const resultPlugin = { name: 'native-agent-stream-result', configureServer: attachResult, configurePreviewServer: attachResult };
let server;
try {
  if (output) await build({
    configFile: false, root: repository, logLevel: 'error',
    resolve: { alias: { '@': resolve(repository, 'src') } },
    plugins: [baselinePlugin, react(), tailwindcss()],
    build: { outDir: output, emptyOutDir: true,
      rolldownOptions: { input: resolve(repository, `src/lib/ai/__tests__/${page}`) } },
  });
  server = output ? await preview({
    configFile: false, root: repository, plugins: [resultPlugin], build: { outDir: output },
    preview: { host: '127.0.0.1', port: 0 },
  }) : await createServer({
    configFile: false,
    root: repository,
    cacheDir: resolve(repository, 'node_modules/.vite-agent-stream-native'),
    resolve: { alias: { '@': resolve(repository, 'src') } },
    plugins: [react(), tailwindcss(), resultPlugin],
    server: { host: '127.0.0.1', port: 0, hmr: terminalReadinessRun ? undefined : false, watch: null },
  });
} catch (error) {
  if (output) await rm(output, { recursive: true, force: true });
  throw error;
}
let child;
let timer;
try {
  if (!output) await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== 'string');
  const url = new URL(`http://127.0.0.1:${address.port}/${pagePath}`);
  url.searchParams.set('token', token);
  url.searchParams.set('baseline', String(baseline));
  url.searchParams.set('noModel', String(noModel));
  if (values.route) { url.searchParams.set('route', values.route); url.searchParams.set('model', values.model); }
  for (const id of values['cleanup-session'] ?? []) url.searchParams.append('cleanupSession', id);
  const devUrl = url.href;
  child = spawn('pnpm', ['exec', 'tauri', 'dev', '--no-watch', '--config', JSON.stringify({
    identifier: 'com.shellspan-dev', build: { beforeDevCommand: '', devUrl },
    ...((performanceRun || terminalContentionRun) && !values['cleanup-session']?.length ? { app: { windows: [{
      label: 'main', title: terminalContentionRun ? 'Terminal contention validation' : 'Agent panel validation', width: 1480, height: 920,
      minWidth: 1200, minHeight: 760, visible: true, focus: true, alwaysOnTop: true,
      transparent: true, titleBarStyle: 'Overlay',
    }] } } : {}),
  })], { cwd: repository, stdio: ['ignore', 'ignore', 'inherit'], detached: process.platform !== 'win32' });
  child.once('error', (error) => settle({ ok: false, error: error.message }));
  child.once('exit', (code) => settle({ ok: false, error: `Tauri exited before reporting results (${code})` }));
  timer = setTimeout(() => settle({ ok: false, error: 'Native stream regression timed out after 10 minutes' }), 600_000);
  const outcome = await result;
  assert.equal(outcome.ok, true, outcome.error);
  if (performanceRun) console.log(JSON.stringify({ baseline, baselineRef: baseline ? baselineRef : undefined, baselineCommit, productionBundle: true, ...outcome.metrics }));
  else if (terminalContentionRun && values['cleanup-session']?.length) console.log('Native contention fixture cleanup completed.');
  else if (terminalContentionRun && noModel) console.log('Native terminal close passed: real PTY command, production close confirmation, durable Agent cancellation, unrelated terminal preservation and real close-error Toast. No model calls were made.');
  else if (terminalContentionRun) console.log('Native terminal contention passed: two real Agents, one PTY, conflict draft retention, task navigation, manual retry, simultaneous admission, confirmed takeover, running-Agent close and close-error Toast.');
  else if (focusBackgroundRun) console.log('Native Focus background regression passed: two real visible commands completed on the leased PTY, with Focus selection and keyboard focus preserved.');
  else if (terminalReadinessRun) console.log('Native terminal readiness passed: registry identity across hot updates, existing and new local PTY output.');
  else if (focusRun) console.log('Native focus regression passed: real local terminals, explicit targets, collapse/restore, continuation IPC, and responsive geometry. No model or remote commands were executed.');
  else console.log('Native Agent stream passed: pending subscription/snapshot cancellation, error publication, automatic gap recovery and cleanup.');
} finally {
  clearTimeout(timer);
  if (child?.pid && child.exitCode === null) {
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  if (output) {
    await new Promise((resolveClose, reject) => server.httpServer.close(error => error ? reject(error) : resolveClose()));
    await rm(output, { recursive: true, force: true });
  } else await server.close();
}
