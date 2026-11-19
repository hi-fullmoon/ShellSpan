import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { copyFile, readFile, writeFile, access, mkdir, open, readdir, rename, rmdir } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { verifyNsisInstalledImage } from '../native-input/acceptance/windows-package-image.mjs';
import { captureValidationAssets, captureValidationSources } from '../native-input/integration/frozen-validation.mjs';

assert.equal(process.platform, 'win32');
const root = resolve(import.meta.dirname, '../..');
const directory = resolve(process.argv[2]);
const testRoot = resolve(root, 'artifacts/tests/agent-sandbox');
const owned = relative(testRoot, directory);
assert(owned && !isAbsolute(owned) && owned !== '..' && !owned.startsWith(`..${sep}`));
const install = join(directory, 'installed');
const title = 'ShellSpan Windows Sandbox Retest';
const binary = 'ShellSpanWindowsSandboxRetest.exe';
const executable = join(install, binary);
const bundle = join(root, 'src-tauri/target/debug/bundle/nsis');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const reportPath = join(directory, 'desktop-report.json');
const sources = captureValidationSources(root);
const report = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  testedWorkingTree: true, checks: [] };
let child, childDone, browser, tcp, installed = false;

async function check(name, verify) {
  try {
    const evidence = await verify();
    report.checks.push({ name, passed: true, evidence });
    return evidence;
  }
  catch (error) { report.checks.push({ name, passed: false, error: String(error) }); throw error; }
  finally { await writeFile(reportPath, JSON.stringify(report, null, 2)); }
}

async function waitFor(probe, description, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}

async function start(program, args, log, env = process.env) {
  const file = await open(join(directory, log), 'wx');
  try {
    const process = spawn(program, args, { cwd: root, windowsHide: true, env,
      stdio: ['ignore', file.fd, file.fd] });
    const done = new Promise((resolve, reject) => { process.once('error', reject); process.once('close', resolve); });
    return { process, done };
  } finally { await file.close(); }
}

async function run(program, args, log) {
  assert.equal(await (await start(program, args, log)).done, 0, log);
}

async function stop(crash = false) {
  if (browser) { await browser.close(); browser = undefined; }
  if (!child) return;
  if (crash) {
    assert.equal(child.exitCode, null);
    assert(child.kill(), 'Owned process must still be running');
  } else {
    execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      join(root, 'scripts/native-input/acceptance/windows-image.ps1'), '-Action', 'Stop',
      '-ApplicationPid', String(child.pid), '-RunnerPid', String(process.pid), '-Executable', executable],
    { windowsHide: true, timeout: 30_000 });
  }
  await childDone;
  child = undefined;
}

async function launch(phase) {
  const socket = createServer();
  await new Promise(done => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port;
  await new Promise(done => socket.close(done));
  const launched = await start(executable, [], `${phase}-app.log`, {
    ...process.env,
    SHELLSPAN_DATA_DIR: join(directory, 'data'),
    SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR: directory,
    SHELLSPAN_ACCEPTANCE_SUBMISSION: '1',
    WEBVIEW2_USER_DATA_FOLDER: join(directory, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  });
  child = launched.process;
  childDone = launched.done;
  const origin = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    assert.equal(child.exitCode, null, 'Owned app exited before WebView2 startup');
    try { return (await fetch(`${origin}/json/version`)).ok; } catch { return false; }
  }, 'WebView2 devtools', 45_000);
  browser = await chromium.connectOverCDP(origin);
  const page = await waitFor(async () => browser.contexts().flatMap(context => context.pages())
    .find(page => /tauri\.localhost|^tauri:\/\//.test(page.url())), 'owned Tauri WebView');
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__ && !!document.querySelector('#root')?.children.length);
  assert.equal(await invoke(page, 'plugin:app|identifier'), 'com.shellspan.validation.windows-sandbox');
  return page;
}

function invoke(page, command, args = {}) {
  return page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
}
const rejection = promise => promise.then(() => '', String);
const events = async (page, sessionId) => (await invoke(page, 'agent_runtime_get_events', {
  request: { sessionId, limit: 250 },
})).events;
const snapshot = (page, sessionId) => invoke(page, 'agent_runtime_get_session', { input: { sessionId } });
const preference = async (page, key) => (await invoke(page, 'load_preferences')).find(([name]) => name === key)?.[1];
const save = (page, value) => invoke(page, 'save_preferences', { entries: [['ai.agentSandboxEnabled', String(value)]] });
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

function createLocalAgent(page, terminalId, sessionId = `windows-sandbox-acceptance-${randomUUID()}`) {
  return invoke(page, 'agent_runtime_create_session', { request: {
    sessionId, taskId: sessionId, goal: 'Verify Windows sandbox on test fixtures', executionSurface: 'direct',
    permissionMode: 'requestApproval',
    target: { kind: 'local', targetId: `terminal-${terminalId}`, sessionId: terminalId },
  } });
}

async function prepare(page, terminalId, sourceKind, toolArgument = null) {
  const sessionId = `windows-sandbox-acceptance-${randomUUID()}`;
  const callId = randomUUID();
  const created = await createLocalAgent(page, terminalId, sessionId);
  const workspace = created.header.target.cwd;
  assert.equal(created.header.target.windowsSandboxRequired, true);
  assert.equal(workspace, created.header.target.localRoot);
  const childPath = relative(join(directory, 'data/windows-agent-workspaces'), workspace);
  assert.match(childPath, /^[0-9a-f]{32}$/);
  assert.match(await rejection(invoke(page, 'agent_runtime_set_execution_surface', {
    input: { sessionId, surface: 'boundTerminal' },
  })), /WINDOWS_SANDBOX_DIRECT_REQUIRED/);
  await invoke(page, 'run_terminal_acceptance_command', { agentSessionId: sessionId, callId, sourceKind, toolArgument });
  const history = await events(page, sessionId);
  const approval = history.find(event => event.type === 'tool/approval'
    && event.data.callId === callId && event.data.status === 'requested');
  assert(approval, JSON.stringify(history.map(event => ({ type: event.type, status: event.data?.status, summary: event.data?.summary }))));
  assert.equal(history.some(event => event.type === 'tool/execution' && event.data.callId === callId), false);
  return { sessionId, callId, workspace, approve: () => invoke(page, 'decide_terminal_acceptance_command', {
    input: { sessionId, callId, turnId: approval.turnId, stepId: approval.stepId,
      requestId: approval.data.requestId, approvalId: approval.data.approvalId }, approve: true,
  }) };
}

async function result(page, record) {
  return waitFor(async () => (await events(page, record.sessionId)).find(event =>
    event.type === 'tool/result' && event.data.callId === record.callId)?.data, `result for ${record.callId}`);
}

async function processIds(workspace) {
  const get = async name => Number(await readFile(join(workspace, name), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  }));
  return waitFor(async () => {
    const pids = await Promise.all([get('leader.txt'), get('child.txt')]);
    return pids.every(pid => Number.isInteger(pid) && pid > 0 && pidAlive(pid)) && pids;
  }, 'sandbox leader and child start');
}

try {
  await check('NSIS install, image and resources', async () => {
    await assert.rejects(access(install), { code: 'ENOENT' });
    const entries = (await readdir(bundle)).filter(name => name.startsWith(title) && name.endsWith('-setup.exe'));
    assert.equal(entries.length, 1);
    const installer = join(directory, entries[0]);
    await copyFile(join(bundle, entries[0]), installer);
    report.installer = { path: installer, sha256: sha(await readFile(installer)) };
    await run(installer, ['/S', `/D=${install}`], 'install.log');
    installed = true;
    const proof = verifyNsisInstalledImage(await readFile(join(root, 'src-tauri/target/debug', binary)), await readFile(executable));
    assert.deepEqual(captureValidationAssets(join(install, 'native-input/generated')),
      captureValidationAssets(join(root, 'src-tauri/target/native-input/generated')));
    return proof;
  });
  let page = await launch('initial');
  const terminal = await invoke(page, 'create_local_session', { cols: 120, rows: 30 });
  const terminalId = terminal.sessionId;
  assert(terminalId);
  await check('One sandbox switch controls the selection of new local Agent sessions', async () => {
    // A preference from the previous Windows build must not supply a second opt-in.
    await invoke(page, 'save_preferences', { entries: [['ai.windowsAgentSandboxEnabled', 'false']] });
    const ordinary = await createLocalAgent(page, terminalId);
    assert.notEqual(ordinary.header.target.windowsSandboxRequired, true);
    await page.keyboard.press('Control+,');
    await page.getByRole('tab', { name: /^AI (助手|Assistant)$/i }).click();
    const global = page.getByRole('switch', { name: /^(Agent 沙箱|Agent sandbox)/i });
    assert.equal(await page.getByRole('switch').count(), 1);
    assert.equal(await global.getAttribute('aria-checked'), 'false');
    const descriptionId = await global.getAttribute('aria-describedby');
    assert(descriptionId);
    assert.match(await page.locator(`[id="${descriptionId}"]`).innerText(), /受管沙箱|managed sandbox/);
    await global.click();
    await waitFor(async () => (await global.getAttribute('aria-checked')) === 'true', 'Agent sandbox switch');
    assert.equal(await preference(page, 'ai.agentSandboxEnabled'), 'true');
    const managed = await createLocalAgent(page, terminalId);
    assert.equal(managed.header.target.windowsSandboxRequired, true);
    assert.equal(managed.header.executionSurface, 'direct');
    const retained = await snapshot(page, ordinary.header.sessionId);
    assert.notEqual(retained.header.target.windowsSandboxRequired, true);
    await page.screenshot({ path: join(directory, 'windows-sandbox-settings.png') });
    await page.keyboard.press('Escape');
    return { preference: 'true', ordinaryRetained: true, newSessionUsesManagedDirect: true };
  });
  await writeFile(join(directory, 'outside.txt'), 'outside', { flag: 'wx' });
  let connections = 0;
  tcp = createServer(socket => { connections++; socket.end(); });
  await new Promise(done => tcp.listen(0, '127.0.0.1', done));
  const port = tcp.address().port;
  const boundaries = await check('Approved sandbox command enforces filesystem and loopback boundaries', async () => {
    const record = await prepare(page, terminalId, 'sandbox-boundary', String(port));
    await record.approve();
    const observed = await result(page, record);
    assert.equal(observed.data?.sandbox, 'windowsAppContainer', JSON.stringify(observed));
    assert.equal(observed.data?.started, true);
    assert.equal(observed.data?.exitCode, 0, JSON.stringify(observed));
    assert.equal(observed.data?.stdout, 'boundaries');
    assert.equal(await readFile(join(record.workspace, 'inside.txt'), 'utf8'), 'inside');
    assert.equal(await readFile(join(directory, 'outside.txt'), 'utf8'), 'outside');
    assert.equal(connections, 0);
    return { ...observed, sessionId: record.sessionId };
  });
  await check('Approved call cannot dispatch after disabling the sandbox', async () => {
    const record = await prepare(page, terminalId, 'sandbox-write');
    await save(page, false);
    const ordinary = await createLocalAgent(page, terminalId);
    assert.notEqual(ordinary.header.target.windowsSandboxRequired, true);
    assert.equal((await snapshot(page, record.sessionId)).header.target.windowsSandboxRequired, true);
    await record.approve();
    const observed = await result(page, record);
    assert.match(observed.summary, /AGENT_SANDBOX_DISABLED/);
    assert.equal((await events(page, record.sessionId)).some(event => event.type === 'tool/execution'
      && event.data.callId === record.callId && event.data.status === 'dispatched'), false);
    await assert.rejects(access(join(record.workspace, 'approved.txt')), { code: 'ENOENT' });
    await save(page, true);
    return observed;
  });
  await check('Workspace replacement invalidates approval', async () => {
    const record = await prepare(page, terminalId, 'sandbox-write');
    const moved = `${record.workspace}-acceptance-moved`;
    await rename(record.workspace, moved);
    await mkdir(record.workspace);
    try {
      await record.approve();
      const observed = await result(page, record);
      assert.match(observed.summary, /SANDBOX|capability/i);
      assert.equal((await events(page, record.sessionId)).some(event => event.type === 'tool/execution'
        && event.data.callId === record.callId && event.data.status === 'dispatched'), false);
      await assert.rejects(access(join(moved, 'approved.txt')), { code: 'ENOENT' });
      await assert.rejects(access(join(record.workspace, 'approved.txt')), { code: 'ENOENT' });
      return observed;
    } finally {
      await rmdir(record.workspace);
      await rename(moved, record.workspace);
    }
  });
  await check('Command exit 125 retains actual streams and start evidence', async () => {
    const record = await prepare(page, terminalId, 'sandbox-exit');
    await record.approve();
    const observed = await result(page, record);
    assert.equal(observed.data?.started, true);
    assert.equal(observed.data?.exitCode, 125, JSON.stringify(observed));
    assert.equal(observed.data?.stdout, 'stdout');
    assert.equal(observed.data?.stderr, 'stderr');
    return observed;
  });
  for (const kind of ['timeout', 'cancel', 'crash']) {
    await check(`Sandbox process tree stops on ${kind}`, async () => {
      const record = await prepare(page, terminalId, `sandbox-${kind}`);
      const approved = record.approve().catch(error => ({ error: String(error) }));
      const pids = await processIds(record.workspace);
      if (kind === 'cancel') await invoke(page, 'agent_runtime_interrupt', { input: { sessionId: record.sessionId } });
      if (kind === 'crash') await stop(true);
      await waitFor(async () => pids.every(pid => !pidAlive(pid)), `both sandbox processes stopped after ${kind}`);
      if (kind === 'crash') {
        await approved;
        page = await launch('restart');
        const persisted = await snapshot(page, record.sessionId);
        assert.equal(persisted.recovery.kind, 'executionInFlight', JSON.stringify(persisted.recovery));
        assert.deepEqual((await result(page, { ...record, sessionId: boundaries.sessionId,
          callId: boundaries.callId })).data, boundaries.data);
        assert.equal(await preference(page, 'ai.agentSandboxEnabled'), 'true');
        assert.equal(pids.some(pidAlive), false);
        assert.deepEqual(await Promise.all(['leader.txt', 'child.txt'].map(async name =>
          Number(await readFile(join(record.workspace, name), 'utf8')))), pids);
        return { pids, recovery: persisted.recovery.kind };
      }
      await approved;
      const observed = await result(page, record);
      assert.equal(observed.status, kind === 'timeout' ? 'timedOut' : 'cancelled', JSON.stringify(observed));
      assert.equal(observed.data?.terminationConfirmed, true, JSON.stringify(observed));
      return { pids, status: observed.status };
    });
  }
} catch (error) {
  report.failure = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  if (tcp) tcp.close();
  try { await stop(); } catch (error) { report.stopFailure = String(error); process.exitCode = 1; }
  if (installed && !report.stopFailure) {
    try {
      await run(join(install, 'uninstall.exe'), ['/S'], 'uninstall.log');
      await waitFor(async () => access(executable).then(() => false, error => error.code === 'ENOENT'), 'owned uninstall');
      report.uninstalled = true;
    } catch (error) { report.uninstallFailure = String(error); process.exitCode = 1; }
  }
  try { assert.deepEqual(captureValidationSources(root), sources); report.sourcesUnchangedDuringRun = true; }
  catch (error) { report.sourceFailure = String(error); process.exitCode = 1; }
  report.passed = !process.exitCode;
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: reportPath, passed: report.passed, failure: report.failure }));
}
