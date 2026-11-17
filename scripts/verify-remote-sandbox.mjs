import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { verifySandboxDisconnect } from './verify-remote-sandbox-disconnect.mjs';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sandboxPath = '/srv/shellspan-workspaces/project';
const runId = randomUUID();
const image = `shellspan-bwrap-acceptance:${runId}`;
const artifacts = resolve(cwd, 'artifacts/tests/remote-sandbox');
mkdirSync(artifacts, { recursive: true });
const evidence = mkdtempSync(resolve(artifacts, 'linux-'));
const docker = (args) => execFileSync('docker', args, { cwd, encoding: 'utf8' }).trim();
const fixture = (name) => `shellspan-bwrap-${name}-${runId}`;
const report = { rust: [], ui: [] };
const owned = [];

function start(name, privileged) {
  const container = fixture(name);
  docker(['run', '-d', '--name', container, ...(privileged ? ['--privileged'] : []),
    '--tmpfs', `${sandboxPath}:rw,nosuid,nodev,size=64m`, '-p', '127.0.0.1::22', image]);
  owned.push(container);
  const port = Number(/^127\.0\.0\.1:(\d+)$/.exec(docker(['port', container, '22/tcp']))?.[1]);
  assert(port, 'No isolated SSH port');
  docker(['exec', container, 'ssh-keygen', '-A']);
  return { container, port };
}

function rust(scenario, port) {
  execFileSync('cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', 'linux_ssh_bubblewrap_acceptance', '--', '--ignored'], {
    cwd, stdio: 'inherit', env: { ...process.env, SHELLSPAN_SANDBOX_FIXTURE_SCENARIO: scenario, SHELLSPAN_SANDBOX_FIXTURE_PORT: String(port) },
  });
  report.rust.push(scenario);
}

async function nativeUi(port, available) {
  const token = randomUUID();
  const page = 'src/components/workbench/__tests__/connection-sandbox.native.html';
  const data = resolve(evidence, available ? 'ui-zh-data' : 'ui-en-data');
  mkdirSync(data);
  let finish;
  let reject;
  const result = new Promise((resolveResult, rejectResult) => { finish = resolveResult; reject = rejectResult; });
  const server = await createServer({
    configFile: false, root: cwd,
    cacheDir: resolve(data, 'vite-cache'),
    resolve: { alias: { '@': resolve(cwd, 'src') } },
    optimizeDeps: { entries: [page] },
    plugins: [react(), tailwindcss(), { name: 'sandbox-native-regression', configureServer(vite) {
      vite.middlewares.use(`/__sandbox-config/${token}`, (_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ port, available }));
      });
      vite.middlewares.use(`/__sandbox-result/${token}`, async (request, response) => {
        try {
          let body = '';
          for await (const chunk of request) { body += chunk; assert(body.length < 8192); }
          finish(JSON.parse(body));
          response.end('ok');
        } catch (error) { reject(error); response.writeHead(400).end(); }
      });
    } }],
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  });
  await server.listen();
  const app = spawn('pnpm', ['exec', 'tauri', 'dev', '--no-watch', '--config', JSON.stringify({
    identifier: 'com.shellspan.validation.remote-sandbox', build: { beforeDevCommand: '', devUrl: `http://127.0.0.1:${server.httpServer.address().port}/${page}?token=${token}` },
    app: { windows: [{ label: 'main', title: 'ShellSpan sandbox verification', width: available ? 1180 : 420, height: available ? 780 : 580 }] },
  })], { cwd, env: { ...process.env, SHELLSPAN_DATA_DIR: data }, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = '';
  app.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-5000); });
  app.on('exit', (code) => reject(new Error(`Native app exited: ${code}\n${diagnostics}`)));
  app.on('error', reject);
  const timer = setTimeout(() => reject(new Error(`Native UI did not report\n${diagnostics}`)), 180_000);
  try {
    const observed = await result;
    report.ui.push(observed);
    assert.equal(observed.ok, true, observed.error);
  } finally {
    clearTimeout(timer);
    if (app.pid) {
      try { process.kill(-app.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await server.close();
  }
}

const build = mkdtempSync(resolve(tmpdir(), 'shellspan-bwrap-build-'));
try {
  for (const path of ['tests/ssh-e2e/Dockerfile.sandbox', 'tests/ssh-e2e/sshd_sandbox_config', 'scripts/remote-sandbox/shellspan-bwrap-v1']) {
    mkdirSync(dirname(resolve(build, path)), { recursive: true });
    cpSync(resolve(cwd, path), resolve(build, path));
  }
  const base = process.env.SHELLSPAN_SANDBOX_FIXTURE_BASE_IMAGE;
  execFileSync('docker', ['build', '-t', image, '-f', resolve(build, 'tests/ssh-e2e/Dockerfile.sandbox'),
    ...(base ? ['--build-arg', `BASE_IMAGE=${base}`] : []), build], { cwd, stdio: 'inherit' });
  const allowed = start('allowed', true);
  report.linux = docker(['exec', allowed.container, 'uname', '-srmo']);
  report.distro = docker(['exec', allowed.container, 'cat', '/etc/alpine-release']);
  const disconnectOnly = process.argv.includes('--disconnect');
  if (!disconnectOnly) {
    rust('missing', allowed.port);
    if (process.argv.includes('--ui')) await nativeUi(allowed.port, false);
  }
  // This is the test operator's package-manager step on the disposable host.
  docker(['exec', allowed.container, 'apk', 'add', '--no-cache', 'bubblewrap']);
  report.bubblewrap = docker(['exec', allowed.container, '/usr/bin/bwrap', '--version']);
  if (disconnectOnly) {
    report.disconnect = await verifySandboxDisconnect({ cwd, evidence, fixture: allowed, workspace: sandboxPath, docker });
  } else {
    rust('available', allowed.port);
    if (process.argv.includes('--ui')) await nativeUi(allowed.port, true);
    const blocked = start('blocked', false);
    docker(['exec', blocked.container, 'apk', 'add', '--no-cache', 'bubblewrap']);
    rust('unavailable', blocked.port);
  }
} finally {
  writeFileSync(resolve(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  for (const container of owned) docker(['rm', '-f', container]);
  if (owned.length) docker(['image', 'rm', image]);
  rmSync(build, { recursive: true, force: true });
  console.log(`Sandbox verification report: ${resolve(evidence, 'report.json')}`);
}
