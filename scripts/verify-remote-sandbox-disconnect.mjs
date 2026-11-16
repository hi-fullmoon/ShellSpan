import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { openSshRecoveryForwarder } from './native-input-p3/ssh-recovery-witness.mjs';

export async function renderSandboxDisconnectSession(cwd, evidence, recording) {
  const server = await createServer({
    configFile: false, root: cwd, cacheDir: resolve(evidence, 'vite-cache'),
    resolve: { alias: { '@': resolve(cwd, 'src') } },
    optimizeDeps: { entries: ['src/components/ai/__tests__/ai-sandbox-disconnect.browser-entry.tsx'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [react(), tailwindcss(), { name: 'sandbox-disconnect-recording', configureServer(vite) {
      vite.middlewares.use('/sandbox-disconnect-recording', (_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(recording));
      });
      vite.middlewares.use('/sandbox-disconnect', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml('/sandbox-disconnect', '<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell" style="height:100vh"></main><script type="module" src="/src/components/ai/__tests__/ai-sandbox-disconnect.browser-entry.tsx"></script></body></html>'));
      });
    } }],
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.resolvedUrls.local[0]}sandbox-disconnect`);
    const turn = page.locator('.ai-turn-process-trigger').first();
    await turn.waitFor().catch(error => { throw new Error(errors.join('\n') || error.message); });
    if (await turn.getAttribute('aria-expanded') !== 'true') await turn.click();
    const row = page.locator('[data-tool-state="uncertain"]');
    await row.waitFor();
    assert.match(await row.innerText(), /执行结果未知/);
    assert.equal(await page.getByRole('button', { name: /^(重试|重新执行)$/ }).count(), 0);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: resolve(evidence, 'session-uncertain.png') });
    return { label: '执行结果未知', automaticRetryAction: false };
  } finally {
    await browser?.close();
    await server.close();
  }
}

export async function verifySandboxDisconnect({ cwd, evidence, fixture, workspace, docker }) {
  const forwarder = await openSshRecoveryForwarder(fixture);
  const output = resolve(evidence, 'session-recording.json');
  const child = spawn('cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--lib',
    'linux_bubblewrap_disconnect_reaches_session_recovery', '--', '--ignored'], {
    cwd, stdio: 'inherit', env: { ...process.env, SHELLSPAN_SANDBOX_FIXTURE_PORT: String(fixture.port),
      SHELLSPAN_SANDBOX_DISCONNECT_PORT: String(forwarder.port), SHELLSPAN_SANDBOX_DISCONNECT_RECORDING: output },
  });
  const exited = new Promise((resolveExit, reject) => {
    child.once('exit', resolveExit);
    child.once('error', reject);
  });
  const observe = () => docker(['exec', fixture.container, 'sh', '-c',
    'if [ -s "$1/disconnect-started" ]; then cat "$1/disconnect-started"; fi', 'sh', workspace]);
  try {
    let marker;
    const deadline = Date.now() + 180_000;
    while (!marker) {
      assert.equal(child.exitCode, null, 'The Rust test exited before the remote command started');
      assert(Date.now() < deadline, 'The remote command did not leave a start witness');
      marker = observe();
      if (!marker) await delay(250);
    }
    const start = /^(\d+) (pid:\[\d+\])$/.exec(marker);
    assert(start, 'The sandbox command must leave exactly one PID witness');
    const hostPidNamespace = docker(['exec', fixture.container, 'readlink', '/proc/self/ns/pid']);
    assert.notEqual(start[2], hostPidNamespace, 'The witness must come from the Bubblewrap PID namespace');
    docker(['exec', fixture.container, 'sh', '-c',
      'test ! -e "$1/disconnect-release" && test ! -e "$1/disconnect-completed"', 'sh', workspace]);
    const connectionsBefore = forwarder.connectionCount();
    const cut = forwarder.disconnect();
    assert.equal(cut.socketIds.length, 1, 'Cut exactly the dedicated execution connection');
    assert.equal(await exited, 0, 'The Rust session recovery assertions failed');
    assert.equal(forwarder.connectionCount(), connectionsBefore, 'Unexpected direct SSH retry or fallback');
    assert.equal(observe(), marker, 'Unexpected remote command replay');
    docker(['exec', fixture.container, 'test', '!', '-e', `${workspace}/disconnect-completed`]);
    const recording = JSON.parse(await readFile(output, 'utf8'));
    const ui = await renderSandboxDisconnectSession(cwd, evidence, recording);
    return { cut, connectionsBefore, connectionsAfter: forwarder.connectionCount(),
      remoteStartCount: 1, sandboxPidNamespace: start[2], hostPidNamespace,
      completionMarker: false, recovery: recording.snapshot.recovery.status, ui };
  } finally {
    if (child.exitCode === null) child.kill();
    await forwarder.close();
  }
}
