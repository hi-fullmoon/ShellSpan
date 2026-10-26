import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';

// Run explicitly in a desktop session: node scripts/verify-single-instance.mjs
// Exercises the real app and native windows with isolated identifiers/data.
assert(['darwin', 'linux'].includes(process.platform), 'This native check requires macOS or Linux');
const repository = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'shellspan-single-instance-'));
const token = randomUUID();
const roles = new Map(['first', 'independent'].map(role => [role, { commands: [], messages: [] }]));
const children = [];
let diagnostics = '';
const server = await createServer({
  root: repository,
  configFile: false,
  optimizeDeps: { entries: ['scripts/__tests__/single-instance.html'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  plugins: [{
    name: 'native-single-instance-result',
    configureServer(vite) {
      vite.middlewares.use(`/__single-instance/${token}/`, async (request, response) => {
        const role = roles.get(request.url?.slice(1));
        if (!role) { response.statusCode = 404; response.end(); return; }
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        if (request.method === 'GET') {
          response.end(JSON.stringify(role.commands.shift() ?? null));
          return;
        }
        if (request.method !== 'POST') { response.statusCode = 405; response.end(); return; }
        try {
          let body = '';
          for await (const chunk of request) {
            body += chunk;
            assert(body.length < 8192, 'Oversized native result');
          }
          role.messages.push(JSON.parse(body));
          response.end('{}');
        } catch (error) {
          role.messages.push({ type: 'error', error: String(error) });
          response.statusCode = 400;
          response.end('{}');
        }
      });
    },
  }],
});

function launch(command, args, role) {
  const child = spawn(command, args, {
    cwd: repository,
    env: { ...process.env, SHELLSPAN_DATA_DIR: join(temporary, role) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const entry = { child, exited: false, code: null, error: null };
  child.once('error', error => { entry.error = error; entry.exited = true; });
  child.once('exit', code => { entry.code = code; entry.exited = true; });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-12000); });
  }
  children.push(entry);
  return entry;
}

async function waitFor(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const role of roles.values()) {
      const failure = role.messages.find(message => message.type === 'error');
      assert(!failure, failure?.error);
    }
    assert(!children.some(entry => entry.error), String(children.find(entry => entry.error)?.error));
    if (predicate()) return;
    await delay(100);
  }
  assert.fail(`${label}\n${diagnostics}`);
}

async function inspect(role, type = 'inspect') {
  const state = roles.get(role);
  const id = randomUUID();
  state.commands.push({ type, id });
  await waitFor(() => state.messages.some(message => message.id === id), `No ${type} result from ${role}`);
  return state.messages.find(message => message.id === id);
}

async function waitForState(role, predicate, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (predicate(await inspect(role))) return;
    await delay(100);
  }
  assert.fail(label);
}

async function stop(entry) {
  if (!entry.exited) {
    try { process.kill(-entry.child.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    const deadline = Date.now() + 15000;
    while (!entry.exited && Date.now() < deadline) await delay(100);
    assert(entry.exited, 'Native app did not stop');
  }
}

try {
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== 'string');
  const buildAndLaunch = role => {
    const config = {
      identifier: `com.shellspan.validation.si.${token}.${role}`,
      build: {
        beforeDevCommand: '',
        devUrl: `http://127.0.0.1:${address.port}/scripts/__tests__/single-instance.html?token=${token}&role=${role}`,
      },
      app: { security: { capabilities: ['default', {
        identifier: 'single-instance-regression', windows: ['main'],
        permissions: ['core:window:allow-hide'],
      }] } },
    };
    return launch('pnpm', ['exec', 'tauri', 'dev', '--no-watch', '--config', JSON.stringify(config)], role);
  };
  const first = buildAndLaunch('first');
  await waitFor(() => roles.get('first').messages.some(message => message.type === 'ready'), 'First app did not start', 600000);
  const executable = join(repository, 'src-tauri/target/debug/ShellSpan');
  const firstBinary = join(temporary, 'ShellSpan-first');
  await copyFile(executable, firstBinary);

  const duplicate = async (binary, role) => {
    const entry = launch(binary, [], role);
    await waitFor(() => entry.exited, 'Duplicate app did not exit');
    assert.equal(entry.code, 0, diagnostics);
    await waitForState(role, state => state.visible && !state.minimized && state.focused, 'Existing window was not restored and focused');
  };
  await duplicate(firstBinary, 'first');
  await inspect('first', 'minimize');
  await waitForState('first', state => state.minimized, 'Window did not minimize');
  await duplicate(firstBinary, 'first');
  await inspect('first', 'hide');
  await waitForState('first', state => !state.visible, 'Window did not hide');
  await duplicate(firstBinary, 'first');
  assert.equal(roles.get('first').messages.filter(message => message.type === 'ready').length, 1, 'Duplicate reached the frontend');

  const independent = buildAndLaunch('independent');
  await waitFor(() => roles.get('independent').messages.some(message => message.type === 'ready'), 'Independent identifier was blocked', 600000);
  assert(!first.exited, 'First app exited when the independent identifier started');
  assert((await inspect('first')).visible, 'First app stopped responding');
  const independentBinary = join(temporary, 'ShellSpan-independent');
  await copyFile(executable, independentBinary);
  await duplicate(independentBinary, 'independent');

  await stop(first);
  roles.get('first').messages.length = 0;
  const restarted = launch(firstBinary, [], 'first');
  await waitFor(() => roles.get('first').messages.some(message => message.type === 'ready'), 'App did not restart after termination');
  assert(!restarted.exited, 'Restarted app exited unexpectedly');
  await duplicate(firstBinary, 'first');
  await stop(independent);
  console.log('Native single instance regression passed: duplicate exit, focus, minimized/hidden restore, identifier isolation and restart.');
} finally {
  try {
    for (const entry of children.toReversed()) await stop(entry);
  } finally {
    await server.close();
    await rm(temporary, { recursive: true, force: true });
  }
}
