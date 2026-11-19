import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { build } from 'vite';

assert(platform() === 'darwin' && arch() === 'arm64', 'The acceptance bundle requires macOS arm64');
const { values: { 'keep-app': keepApp } } = parseArgs({ options: { 'keep-app': { type: 'boolean' } } });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const crateDirectory = join(root, 'src-tauri');
const entry = 'src/components/terminal/__tests__/mac-sandbox.native.html';
const label = 'ShellSpan Sandbox Acceptance';
const outputBase = join(root, 'artifacts/tests/agent-sandbox-phase1');
await mkdir(outputBase, { recursive: true });
const output = await mkdtemp(join(outputBase, 'desktop-mac-'));
const temporaryRoot = await realpath('/tmp');
const scratch = await mkdtemp(join(temporaryRoot, 'ss-sandbox-desktop-'));
const token = randomUUID();
const home = join(scratch, 'home');
const signals = join(scratch, 'signals');
const manifest = join(scratch, 'launcher.json');
const buildLog = join(output, 'build.log');
const programs = join(output, 'programs');
const cases = [];
let phase = 'execute';
let previous = [];
let app;

for (const directory of [home, signals, programs, join(scratch, 'temporary'), join(scratch, 'data'), join(scratch, 'app-directories')]) {
  await mkdir(directory, { mode: 0o700 });
}
await mkdir(join(home, 'review-fixture'), { mode: 0o700 });
await writeFile(join(home, 'review-fixture/input.txt'), 'reviewed sandbox input\n', { mode: 0o600 });

async function readOptional(path) {
  return readFile(path, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function witness(name) {
  assert(/^(?:gate|init|exit|pid|before|after|cancelled)-[0-9a-f-]{36}$/.test(name), 'Unexpected artifact name');
  const content = await readOptional(join(home, name));
  const pid = name.startsWith('pid-') && content ? Number(content.trim().split('\n')[0]) : 0;
  let running = false;
  if (Number.isSafeInteger(pid) && pid > 1) {
    try {
      process.kill(pid, 0);
      running = true;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  return { content, running };
}

async function guard() {
  const flags = Number(execFileSync('/usr/bin/stat', ['-f', '%f', scratch], { encoding: 'utf8' }).trim());
  const journal = await readOptional(join(scratch, 'data/managed-directory-guard.json'));
  return { protected: Boolean(flags & 2), phase: journal ? JSON.parse(journal).phase : null,
    beforeReady: Boolean(await readOptional(join(signals, 'crash-before'))),
    afterReady: Boolean(await readOptional(join(signals, 'crash-after'))) };
}

let transition = Promise.withResolvers();
const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') return response.writeHead(204).end();
  const url = new URL(request.url, 'http://127.0.0.1');
  if (!url.pathname.startsWith(`/${token}/`)) return response.writeHead(404).end();
  const route = url.pathname.slice(token.length + 2);
  const reply = (body) => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  try {
    if (route === 'config') return reply({ home, phase, previous });
    if (route === 'ready') return reply({ ready: Boolean(await readOptional(join(signals, 'approval-ready'))) });
    if (route === 'launch-ready') return reply({ ready: Boolean(await readOptional(join(signals, 'launch-ready'))) });
    if (route === 'guard') return reply(await guard());
    if (route === 'witness') return reply(await witness(url.searchParams.get('name') ?? ''));
    if (request.method !== 'POST') return response.writeHead(405).end();
    let json = '';
    for await (const chunk of request) {
      json += chunk;
      assert(json.length < 262_144, 'Acceptance report exceeded limit');
    }
    const payload = JSON.parse(json);
    if (route === 'release') await writeFile(join(signals, 'release'), '');
    else if (route === 'finish-running') {
      const record = previous.find(({ kind }) => kind === 'sandbox-restart');
      assert(record && /^[0-9a-f-]{36}$/.test(record.callId), 'Missing exact live command witness');
      await writeFile(join(home, `release-${record.callId}`), '');
    }
    else if (route === 'progress') {
      cases.push(payload);
      await writeFile(join(output, 'progress.json'), JSON.stringify(cases, null, 2));
    } else if (route === 'restart' || route === 'done') {
      reply({ ok: true });
      transition.resolve({ route, payload });
      return;
    } else return response.writeHead(404).end();
    return reply({ ok: true });
  } catch (error) {
    response.writeHead(500).end();
    transition.reject(error);
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');

async function run(program, args, { file = buildLog, environment = process.env } = {}) {
  const log = createWriteStream(file, { flags: 'a' });
  const child = spawn(program, args, { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  try {
    const [code] = await once(child, 'close');
    assert.equal(code, 0, `${program} failed; see ${file}`);
  } finally {
    log.end();
  }
}

function launch(executable, store) {
  const log = createWriteStream(join(output, `app-${phase}.log`), { flags: 'a' });
  app = spawn(executable, [], {
    cwd: scratch,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: home,
      TMPDIR: join(scratch, 'temporary'),
      SHELLSPAN_DATA_DIR: join(scratch, 'data'),
      SHELLSPAN_LOCAL_HOME: home,
      SHELLSPAN_ALLOW_FOREGROUND_TESTS: '1',
      SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR: scratch,
      SHELLSPAN_ACCEPTANCE_FROZEN_MANIFEST: manifest,
      SHELLSPAN_ACCEPTANCE_RAW_PTY: '1',
      SHELLSPAN_ACCEPTANCE_SUBMISSION: '1',
      SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO: 'local-sandbox-direct',
      SHELLSPAN_ACCEPTANCE_WEBKIT_STORE: store,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.pipe(log, { end: false });
  app.stderr.pipe(log, { end: false });
  const child = app;
  const closed = once(child, 'close').finally(() => log.end());
  void closed.catch(() => undefined);
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Desktop ${phase} exceeded 120 seconds`)), 120_000);
  });
  const observation = Promise.race([
    transition.promise,
    closed.then(([code, signal]) => { throw new Error(`Desktop ${phase} exited: ${code} ${signal ?? ''}`); }),
    deadline,
  ]).finally(() => clearTimeout(timer));
  return { closed, observation };
}

const report = { ok: false, cases, crashes: {}, platform: 'macOS arm64' };
let bundleDirectory;
try {
  const crate = join(root, 'scripts/agent-sandbox-phase1/Cargo.toml');
  const cargoTarget = join(crateDirectory, 'target/agent-sandbox-probe');
  await run('cargo', ['build', '--locked', '--manifest-path', crate, '--target-dir', cargoTarget]);
  const launcher = join(programs, 'nono-probe');
  await cp(join(cargoTarget, 'debug/shellspan-sandbox-probe'), launcher);
  await chmod(launcher, 0o755);
  const launcherSha256 = createHash('sha256').update(await readFile(launcher)).digest('hex');
  await writeFile(manifest, JSON.stringify({ sha256: launcherSha256 }));
  const frontend = join(output, 'frontend');
  await build({
    root, configFile: false, base: '/', plugins: [react(), tailwind()],
    resolve: { alias: { '@': join(root, 'src') } },
    define: { __SANDBOX_ACCEPTANCE_ENDPOINT__: JSON.stringify(`http://127.0.0.1:${server.address().port}/${token}`) },
    build: { outDir: frontend, rollupOptions: { input: join(root, entry) } },
  });
  const config = join(output, 'tauri-acceptance.json');
  const base = JSON.parse(await readFile(join(crateDirectory, 'tauri.conf.json'), 'utf8'));
  await writeFile(config, JSON.stringify({
    productName: label, identifier: 'com.shellspan.validation.agent-sandbox',
    build: { beforeBuildCommand: '', frontendDist: relative(crateDirectory, frontend) },
    app: { windows: [{ ...base.app.windows[0], url: entry }],
      security: { csp: "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:*" } },
    bundle: { createUpdaterArtifacts: false, macOS: { signingIdentity: '-' },
      resources: { ...base.bundle.resources, [relative(crateDirectory, launcher)]: 'acceptance/nono-probe' } },
  }));
  await run('pnpm', ['exec', 'tauri', 'build', '--debug', '--bundles', 'app', '--features',
    'native-input-acceptance', '--config', config], { environment: {
    ...process.env, CARGO_PROFILE_DEV_DEBUG: '0', SHELLSPAN_MAC_SANDBOX_LAUNCHER_SHA256: launcherSha256,
  } });
  bundleDirectory = keepApp ? output : await mkdtemp(join(temporaryRoot, 'ss-sandbox-bundle-'));
  const bundle = join(bundleDirectory, `${label}.app`);
  await cp(join(crateDirectory, 'target/debug/bundle/macos', `${label}.app`), bundle, { recursive: true, verbatimSymlinks: true });
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const installedLauncher = await readFile(join(bundle, 'Contents/Resources/acceptance/nono-probe'));
  assert.equal(createHash('sha256').update(installedLauncher).digest('hex'), launcherSha256);
  report.launcherSha256 = launcherSha256;
  if (keepApp) report.bundle = bundle;
  const binary = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw',
    join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  const executable = join(bundle, 'Contents/MacOS', binary);
  const store = randomUUID();
  async function crash(stage, expected) {
    phase = stage;
    transition = Promise.withResolvers();
    const current = launch(executable, store);
    const checkpoint = await current.observation;
    assert.equal(checkpoint.route, 'restart', JSON.stringify(checkpoint.payload));
    previous.push(...checkpoint.payload);
    const before = await guard();
    assert(before.protected && before.phase?.phase === expected, JSON.stringify(before));
    app.kill('SIGKILL');
    const [, signal] = await current.closed;
    assert.equal(signal, 'SIGKILL');
    const after = await guard();
    assert(after.protected && after.phase?.phase === expected, JSON.stringify(after));
    report.crashes[stage] = { before, after, signal };
    await delay(150);
  }
  async function replay(stage) {
    phase = stage;
    transition = Promise.withResolvers();
    const current = launch(executable, store);
    const outcome = await current.observation;
    assert.equal(outcome.route, 'done');
    assert.equal(outcome.payload.ok, true, outcome.payload.error);
    const after = await guard();
    assert(!after.protected && after.phase === null, JSON.stringify(after));
    report[stage] = outcome.payload;
    app.kill('SIGTERM');
    await current.closed;
    await delay(150);
  }
  await crash('execute', 'running');
  await replay('replay');
  await crash('cut-before', 'prepared');
  await replay('replay-before');
  await crash('cut-after', 'ended');
  await replay('replay-after');
  await replay('repeat');
  report.firstRun = previous;
  report.ok = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  if (app && app.exitCode === null && app.signalCode === null) {
    app.kill('SIGKILL');
    await once(app, 'close');
  }
  if (bundleDirectory && !keepApp) {
    try {
      await rm(bundleDirectory, { recursive: true, force: true });
    } catch (error) {
      report.ok = false;
      report.bundleCleanupError = error.message;
      report.retainedBundleDirectory = bundleDirectory;
      process.exitCode = 1;
    }
  }
  await cp(scratch, join(output, 'runtime'), { recursive: true, verbatimSymlinks: true });
  const remaining = await guard();
  if (remaining.protected || remaining.phase !== null) report.retainedFixture = scratch;
  else await rm(scratch, { recursive: true, force: true });
  server.close();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`${report.ok ? 'PASS' : 'FAIL'} macOS desktop acceptance · ${join(output, 'report.json')}`);
}
