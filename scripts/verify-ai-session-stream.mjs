import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
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
  'native-jobs': { type: 'boolean' },
  'native-jobs-ssh': { type: 'string' },
  'native-jobs-direct': { type: 'boolean' },
  'native-jobs-focus': { type: 'boolean' },
  'native-jobs-powershell': { type: 'string' },
  'native-jobs-narrow': { type: 'boolean' },
  'data-initialize': { type: 'boolean' },
  'data-scope': { type: 'string' },
  'terminal-contention': { type: 'boolean' },
  'composer-input-diagnostic': { type: 'boolean' },
  'native-binary': { type: 'string' },
  'terminal-readiness': { type: 'boolean' },
  'terminal-clear-screen': { type: 'boolean' },
  'terminal-reconnect': { type: 'boolean' },
  'terminal-reconnect-ssh': { type: 'boolean' },
  'no-model': { type: 'boolean' }, route: { type: 'string' }, model: { type: 'string' },
  'cleanup-session': { type: 'string', multiple: true },
  'baseline-ref': { type: 'string' },
} });
const performanceRun = values.performance === true;
const focusRun = values.focus === true;
const focusBackgroundRun = values['focus-background'] === true;
const terminalContentionRun = values['terminal-contention'] === true;
const stableNativeEntry = terminalContentionRun || Boolean(values['native-jobs-powershell']) || values['data-initialize'] === true;
assert(!values['native-binary'] || terminalContentionRun, '--native-binary requires --terminal-contention and a binary built for the fixed verification entry');
assert(!terminalContentionRun || (!focusBackgroundRun && !focusRun && !performanceRun && !values['terminal-readiness']), '--terminal-contention is a separate regression');
assert(!focusBackgroundRun || (!focusRun && !values.performance && !values['terminal-readiness']), '--focus-background is a separate regression');
const terminalReadinessRun = values['terminal-readiness'] === true;
const terminalClearScreenRun = values['terminal-clear-screen'] === true;
const terminalReconnectRun = values['terminal-reconnect'] === true || values['terminal-reconnect-ssh'] === true;
assert(!terminalReconnectRun || (!terminalClearScreenRun && !terminalReadinessRun && !terminalContentionRun && !focusBackgroundRun && !focusRun && !performanceRun), '--terminal-reconnect is a separate regression');
assert(!terminalClearScreenRun || (!terminalReadinessRun && !terminalContentionRun && !focusBackgroundRun && !focusRun && !performanceRun), '--terminal-clear-screen is a separate regression');
assert(!terminalReadinessRun || (!focusRun && !performanceRun), '--terminal-readiness is a separate regression');
assert(!focusRun || !performanceRun, '--focus and --performance are separate regressions');
const baseline = values.baseline === true;
const noModel = values['no-model'] === true;
assert(!values['composer-input-diagnostic'] || terminalContentionRun && noModel,
  '--composer-input-diagnostic requires --terminal-contention --no-model');
const initializationRun=values['data-initialize']===true;
assert(!initializationRun || noModel && values['data-scope'] && process.env.SHELLSPAN_DATA_DIR && isAbsolute(process.env.SHELLSPAN_DATA_DIR)
  && !values['native-jobs'] && !terminalContentionRun && !terminalReconnectRun && !performanceRun && !focusRun && !focusBackgroundRun && !terminalReadinessRun && !terminalClearScreenRun,
  '--data-initialize requires an independent explicit data directory, identifier and --no-model');
const windowsShell = values['native-jobs-powershell'];
assert(!windowsShell || process.platform === 'win32' && values['native-jobs'] && ['windowsPowerShell', 'powerShell7'].includes(windowsShell), '--native-jobs-powershell requires native Windows and an exact PowerShell kind');
if (windowsShell) {
  assert(process.env.SHELLSPAN_DATA_DIR && isAbsolute(process.env.SHELLSPAN_DATA_DIR)
    && values['data-scope'], 'Windows desktop acceptance requires explicit independent data directory and app identifier');
  assert(process.env.SHELLSPAN_LOCAL_SHELL, 'Windows desktop acceptance requires an explicit shell executable');
} else if (values['native-jobs']) {
  assert(process.platform !== 'win32', '--native-jobs layout acceptance currently supports POSIX editors; use the dedicated Windows gate');
  execFileSync('python3', ['-c', 'import pexpect, ptyprocess; assert pexpect.__version__ == "4.9.0" and ptyprocess.__version__ == "0.7.0", "Use scripts/requirements-native-layout.txt"'], { stdio: 'pipe' });
}
assert(!values['native-jobs-ssh'] || values['native-jobs'] && ['bash', 'zsh'].includes(values['native-jobs-ssh']), '--native-jobs-ssh requires --native-jobs and bash or zsh');
assert(!values['native-jobs-direct'] || values['native-jobs'] && !values['native-jobs-ssh'], '--native-jobs-direct requires local --native-jobs');
assert(!values['native-jobs-focus'] || values['native-jobs'], '--native-jobs-focus requires --native-jobs');
assert(!values['native-jobs-narrow'] || values['native-jobs'], '--native-jobs-narrow requires --native-jobs');
assert(!values['data-scope'] || /^com\.shellspan\.validation\.[a-z0-9-]+$/.test(values['data-scope']), '--data-scope must be a dedicated com.shellspan.validation.* identifier');
assert(!values['data-scope'] || !values['native-binary'], '--data-scope requires a native build with that Tauri identifier');
assert(!values['native-jobs'] || (!noModel && !focusRun && !focusBackgroundRun && !performanceRun && !terminalContentionRun && !terminalReadinessRun && !terminalClearScreenRun && !terminalReconnectRun), '--native-jobs is a separate real-model regression');
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
const windowsOutputMarker = windowsShell ? `native-jobs-${randomUUID()}` : undefined;
const windowsCompletionGate = windowsShell ? resolve(tmpdir(), `shellspan-completion-gate-${token}`) : undefined;
const nativeEnvironment = windowsShell ? { ...process.env, SHELLSPAN_ACCEPTANCE: windowsOutputMarker,
  SHELLSPAN_NATIVE_COMPLETION_GATE: windowsCompletionGate, SHELLSPAN_NATIVE_WORKSPACE:repository } : process.env;
const ownedEvidenceDirectory = process.env.SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR;
assert(!ownedEvidenceDirectory || isAbsolute(ownedEvidenceDirectory)
  && process.env.SHELLSPAN_DATA_DIR && resolve(ownedEvidenceDirectory, 'data') === resolve(process.env.SHELLSPAN_DATA_DIR),
  'Owned evidence directory must be the explicit independent data directory parent');
const nativeEvidencePath = values['native-jobs'] || terminalContentionRun
  ? ownedEvidenceDirectory ? resolve(ownedEvidenceDirectory, 'native-webview-evidence.json')
    : resolve(tmpdir(), `shellspan-${terminalContentionRun ? 'terminal-contention' : 'native-jobs'}-${token}.json`) : undefined;
// Keep the compiled macOS application identity stable between contention runs.
// The per-run token belongs in an HTTP redirect, not in Tauri's compiled config.
const contentionEntryPath = '/__native-agent-entry';
const contentionPort = 1432;
let contentionEntryUrl;
let settle;
const result = new Promise((resolveResult) => { settle = resolveResult; });
const page = performanceRun ? 'agent-panel-performance.native.html' : 'agent-session-stream.native.html';
const pagePath = initializationRun ? 'src/components/terminal/__tests__/native-data-initialize.native.html'
  : values['native-jobs'] ? 'src/components/terminal/__tests__/native-jobs.native.html'
  : terminalContentionRun ? 'src/components/terminal/__tests__/terminal-contention.native.html'
  : terminalReconnectRun ? 'src/components/terminal/__tests__/terminal-reconnect.native.html'
  : terminalClearScreenRun ? 'src/components/terminal/__tests__/terminal-clear-screen.native.html'
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
  let layoutRequests = 0;
  let windowRequests = 0;
  const contentionEvidence = [];
  let keyboardRequests = 0;
  if (process.platform === 'win32' && (terminalContentionRun || windowsShell)) vite.middlewares.use(`/__native-composer-input/${token}`, async (request, response) => {
    if (request.method !== 'POST') { response.statusCode = 405; response.end(); return; }
    let file;
    try {
      assert(++keyboardRequests <= 1, 'Only one owned native composer input is admitted');
      const chunks = [];
      let size = 0;
      for await (const chunk of request) { size += chunk.length; assert(size <= 65536, 'Oversized native keyboard request'); chunks.push(chunk); }
      const packet = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert(packet && Object.keys(packet).length === 1 && typeof packet.text === 'string'
        && packet.text.length <= 8192 && !/[\x00-\x09\x0b-\x1f\x7f]/.test(packet.text), 'Unsupported keyboard input');
      file = resolve(tmpdir(), `shellspan-composer-input-${token}.json`);
      await writeFile(file, JSON.stringify(packet), { flag: 'wx' });
      const metadata = await new Promise((complete, reject) => execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-File',
        resolve(repository, 'scripts/fixtures/windows-desktop-type.ps1'), '-Executable', resolve(repository, 'src-tauri/target/debug/ShellSpan.exe'), '-InputFile', file],
      { timeout: 15000, maxBuffer: 65536, windowsHide: true }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : complete(stdout)));
      response.setHeader('Content-Type', 'application/json'); response.end(metadata);
    } catch (error) { response.statusCode = 500; response.end(String(error)); }
    finally { if (file) await rm(file, { force: true }); }
  });
  if (windowsShell) vite.middlewares.use(`/__native-job-gate-proof/${token}`, async(request,response)=>{
    if(request.method!=='POST'){response.statusCode=405;response.end();return;}
    try { await assert.rejects(stat(windowsCompletionGate),{code:'ENOENT'}); response.setHeader('Content-Type','application/json'); response.end(JSON.stringify({closed:true,gate:windowsCompletionGate})); }
    catch {response.statusCode=500;response.end('Owned completion gate was unexpectedly released');}
  });
  if (windowsShell) vite.middlewares.use(`/__native-window-evidence/${token}`, async (request,response) => {
    if (request.method !== 'POST') { response.statusCode=405; response.end(); return; }
    try {
      assert(++windowRequests <= 1, 'Only one owned native window capture is admitted');
      const file = ownedEvidenceDirectory ? resolve(ownedEvidenceDirectory, 'native-window.png') : resolve(tmpdir(),`shellspan-desktop-${token}.png`);
      const metadata = await new Promise((complete,reject) => execFile('powershell.exe', ['-NoLogo','-NoProfile','-File',
        resolve(repository,'scripts/fixtures/windows-desktop-capture.ps1'), '-Executable',resolve(repository,'src-tauri/target/debug/ShellSpan.exe'), '-Output',file],
      { timeout:15000,maxBuffer:65536,windowsHide:true }, (error,stdout,stderr) => error ? reject(new Error(stderr || error.message)) : complete(stdout)));
      response.setHeader('Content-Type','application/json'); response.end(metadata);
    } catch(error) { response.statusCode=500; response.end(String(error)); }
  });
  if (values['native-jobs']) vite.middlewares.use(`/__native-editor-layout/${token}`, async (request, response) => {
    if (request.method !== 'POST') { response.statusCode = 405; response.end(); return; }
    try {
      assert(++layoutRequests <= 1, 'Only one native layout proof is admitted per run');
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert(size <= 131072, 'Oversized native layout request');
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert(Object.keys(input).every(key => ['shell', 'acceptedLine', 'columns', 'rows', 'prefixColumns'].includes(key)), 'Unknown native layout field');
      const shell = windowsShell ?? values['native-jobs-ssh'] ?? (process.env.SHELL?.endsWith('/bash') ? 'bash' : process.env.SHELL?.endsWith('/zsh') ? 'zsh' : undefined);
      assert(shell && input.shell === shell, 'Native editor must match the runner shell configuration');
      assert(typeof input.acceptedLine === 'string' && Buffer.byteLength(input.acceptedLine) <= 32768
        && (windowsShell ? /^job-[0-9a-f]{32} '/.test(input.acceptedLine)
          : /^\( job-[0-9a-f]{32};\n[\s\S]*\n\) &$/.test(input.acceptedLine)), 'Invalid actual native submission');
      assert(Number.isInteger(input.columns) && input.columns >= 32 && input.columns <= 1000
        && Number.isInteger(input.rows) && input.rows >= 10 && input.rows <= 300
        && Number.isInteger(input.prefixColumns) && input.prefixColumns >= 0 && input.prefixColumns < input.columns, 'Invalid native layout geometry');
      const base = ownedEvidenceDirectory ? resolve(ownedEvidenceDirectory, 'native-editor-layout') : resolve(tmpdir(), `shellspan-native-layout-${randomUUID()}`);
      await writeFile(`${base}.input.json`, JSON.stringify(windowsShell ? { acceptedLine: input.acceptedLine,
        columns: input.columns, rows: input.rows, prefixColumns: input.prefixColumns,
        executable: process.env.SHELLSPAN_LOCAL_SHELL,
      } : { acceptedLine: input.acceptedLine,
        columns: input.columns, rows: input.rows, prefixColumns: input.prefixColumns, shell,
        ssh: Boolean(values['native-jobs-ssh']), compose: resolve(repository, 'tests/ssh-e2e/compose.yml'),
        bashExecutable: process.env.SHELL,
      }));
      await new Promise((complete, reject) => execFile(windowsShell ? resolve(repository, 'src-tauri/target/debug/examples/native_editor_layout.exe') : 'python3',
        [...(windowsShell ? [] : [resolve(repository, 'scripts/verify-native-editor-layout.py')]), `${base}.input.json`, `${base}.bin`],
        { timeout: 25000, maxBuffer: 65536, windowsHide:true }, (error, _stdout, stderr) => error ? reject(new Error(`Native editor layout failed: ${stderr || error.message}`)) : complete()));
      const bytes = await readFile(`${base}.bin`);
      assert(bytes.length <= 2 * 1024 * 1024, 'Oversized native layout trace');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ rawBase64: bytes.toString('base64'),
        metadata: JSON.parse(await readFile(`${base}.bin.json`, 'utf8')), trace: `${base}.bin` }));
    } catch (error) { response.statusCode = 500; response.end(String(error)); }
  });
  if (stableNativeEntry) vite.middlewares.use(contentionEntryPath, (request, response) => {
    if (request.method !== 'GET' || !contentionEntryUrl) { response.statusCode = 404; response.end(); return; }
    response.statusCode = 302;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Location', contentionEntryUrl);
    response.end();
  });
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
        if (bytes > (nativeEvidencePath ? 1024 * 1024 : 8192)) throw new Error('Oversized test result');
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (value.evidence) {
        assert(nativeEvidencePath && typeof value.evidence === 'object', 'Unexpected native evidence payload');
        if (terminalContentionRun) contentionEvidence.push(value.evidence);
        await writeFile(nativeEvidencePath, JSON.stringify(terminalContentionRun ? { events: contentionEvidence } : value.evidence, null, 2));
        console.log(`Native target WebView evidence: ${nativeEvidencePath}`);
      }
      if (terminalContentionRun && !value.progress) {
        await writeFile(nativeEvidencePath, JSON.stringify({ events: contentionEvidence, result: value }, null, 2));
      }
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
    server: { host: '127.0.0.1', port: stableNativeEntry ? contentionPort : 0,
      strictPort: stableNativeEntry, hmr: terminalReadinessRun ? undefined : false, watch: null },
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
  if (values['composer-input-diagnostic']) url.searchParams.set('composerInputDiagnostic', 'true');
  if (values['terminal-reconnect-ssh']) url.searchParams.set('sshFixture', 'true');
  if (values['native-jobs-ssh']) url.searchParams.set('sshShell', values['native-jobs-ssh']);
  if (values['native-jobs-direct']) url.searchParams.set('directLifecycle', 'true');
  if (values['native-jobs-focus']) url.searchParams.set('focusPolling', 'true');
  if (values['native-jobs-narrow']) url.searchParams.set('narrow','true');
  if (windowsShell) url.searchParams.set('nativeShell', windowsShell);
  if (windowsOutputMarker) url.searchParams.set('outputMarker', windowsOutputMarker);
  if (windowsShell) url.searchParams.set('runId',process.env.SHELLSPAN_ACCEPTANCE_RUN_ID ?? '');
  if (values.route) { url.searchParams.set('route', values.route); url.searchParams.set('model', values.model); }
  for (const id of values['cleanup-session'] ?? []) url.searchParams.append('cleanupSession', id);
  contentionEntryUrl = url.href;
  const devUrl = stableNativeEntry ? `http://127.0.0.1:${contentionPort}${contentionEntryPath}` : url.href;
  child = values['native-binary']
    ? spawn(resolve(values['native-binary']), [], { cwd: repository, stdio: ['ignore', 'ignore', 'inherit'], detached: process.platform !== 'win32' })
    : spawn(process.platform === 'win32' ? process.execPath : 'pnpm', [
      ...(process.platform === 'win32' ? [fileURLToPath(new URL('./tauri.js', import.meta.resolve('@tauri-apps/cli')))] : ['exec','tauri']),
      'dev', '--no-watch',
      ...(process.platform === 'darwin' ? ['--runner', resolve(repository, 'scripts/dev-cargo-runner.mjs')] : []),
      '--config', resolve(repository, 'src-tauri/tauri.dev.conf.json'), '--config', JSON.stringify({
    identifier: values['data-scope'] ?? 'com.shellspan-dev', build: { beforeDevCommand: '', devUrl },
    ...((process.platform === 'win32' && stableNativeEntry || terminalContentionRun || performanceRun && !values['cleanup-session']?.length) ? { app: { windows: [{
      label: 'main', title: process.platform === 'win32' && stableNativeEntry ? 'ShellSpan native validation' : terminalContentionRun ? 'Terminal contention validation' : 'Agent panel validation', width: 1480, height: 920,
      minWidth: 1200, minHeight: 760, visible: true, focus: true, alwaysOnTop: true,
      transparent: true, titleBarStyle: 'Overlay',
    }] } } : {}),
  })], { cwd: repository, env: nativeEnvironment, stdio: ['ignore', 'ignore', 'inherit'], detached: process.platform !== 'win32' });
  child.once('error', (error) => settle({ ok: false, error: error.message }));
  child.once('exit', (code) => settle({ ok: false, error: `Tauri exited before reporting results (${code})` }));
  timer = setTimeout(() => settle({ ok: false, error: 'Native stream regression timed out after 10 minutes' }), 600_000);
  const outcome = await result;
  assert.equal(outcome.ok, true, outcome.error);
  if (initializationRun) console.log('Independent data initialized by the actual native backend; empty route store verified; no model calls made.');
  else if (performanceRun) console.log(JSON.stringify({ baseline, baselineRef: baseline ? baselineRef : undefined, baselineCommit, productionBundle: true, ...outcome.metrics }));
  else if (terminalContentionRun && values['cleanup-session']?.length) console.log('Native contention fixture cleanup completed.');
  else if (values['composer-input-diagnostic']) console.log('Native production composer input passed: complete two-line draft through actual keyboard input. No close or model acceptance was performed.');
  else if (terminalContentionRun && noModel) console.log(`Native terminal close passed: real PTY command, production close confirmation, durable Agent cancellation, unrelated terminal preservation, ${process.platform==='win32'?'actual shell exit':'idle disconnect'} and idempotent close without error Toasts. No model calls were made.`);
  else if (terminalContentionRun) console.log('Native terminal contention passed: two real Agents, one PTY, conflict draft retention, task navigation, manual retry, simultaneous admission, confirmed takeover, running-Agent close and idempotent stale-tab cleanup.');
  else if (values['native-jobs']) console.log('Native model shell jobs passed: complete script, native job handle, three waits, terminate, nonzero exit and workspace/draft/focus preservation.');
  else if (focusBackgroundRun) console.log('Native Focus background regression passed: two real visible commands completed on the leased PTY, with Focus selection and keyboard focus preserved.');
  else if (terminalReadinessRun) console.log('Native terminal readiness passed: registry identity across hot updates, existing and new local PTY output.');
  else if (terminalClearScreenRun) console.log('Native terminal clear-screen passed: production controller, native IPC and real local PTY.');
  else if (terminalReconnectRun) console.log(`Native ${values['terminal-reconnect-ssh'] ? 'SSH' : 'local PTY'} reconnect passed: ${process.platform==='win32'?'actual shell exit':'shell idle timeout'}, Enter reconnect, original Agent identity and draft, repeated reconnects, closed-panel restoration and backend ancestry rejection. No model calls were made.`);
  else if (focusRun) console.log('Native focus regression passed: real local terminals, explicit targets, collapse/restore, continuation IPC, and responsive geometry. No model or remote commands were executed.');
  else console.log('Native Agent stream passed: pending subscription/snapshot cancellation, error publication, automatic gap recovery and cleanup.');
} finally {
  clearTimeout(timer);
  if (child?.pid && child.exitCode === null) {
    try {
      if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
        resolve(repository, 'scripts/fixtures/windows-desktop-process-cleanup.ps1'), '-RootPid', String(child.pid), '-OwnerPid', String(process.pid),
        '-RootExecutable', values['native-binary'] ? resolve(values['native-binary']) : process.execPath,
        ...(ownedEvidenceDirectory ? ['-Output', resolve(ownedEvidenceDirectory, initializationRun ? 'native-data-initialize-cleanup.json' : 'native-model-cleanup.json')] : [])],
      { stdio: 'pipe', windowsHide: true, timeout: 20000 });
      else process.kill(-child.pid, 'SIGTERM');
    }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  if (output) {
    await new Promise((resolveClose, reject) => server.httpServer.close(error => error ? reject(error) : resolveClose()));
    await rm(output, { recursive: true, force: true });
  } else await server.close();
}
