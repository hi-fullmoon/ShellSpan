import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 1431;
const URL = `http://127.0.0.1:${PORT}/?aiPhase0Baseline=hello&theme=light`;
const EVIDENCE = join(ROOT, 'docs/ai-panel-phase0/evidence/before');
const WRITE_BEFORE = process.argv.includes('--write-before');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function waitForServer(process, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Phase 0 Vite server exited early (${String(process.exitCode)}):\n${output.join('')}`);
    }
    try {
      const response = await fetch(URL);
      if (response.ok) return;
    } catch {
      // The bounded readiness loop owns connection-refused during startup.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Phase 0 Vite server did not become ready:\n${output.join('')}`);
}

async function capture(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'zh-CN',
    reducedMotion: 'reduce',
  });
  try {
    const page = await context.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.locator('[data-baseline-ready="true"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
    const environment = await page.evaluate(() => ({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      deviceScaleFactor: window.devicePixelRatio,
      theme: document.documentElement.getAttribute('data-theme'),
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      fontSize: getComputedStyle(document.documentElement).fontSize,
      locale: document.documentElement.lang || navigator.language,
    }));
    const dom = await page.locator('[data-baseline-surface]').evaluate((element) => element.outerHTML);
    const fixture = await page.locator('[data-baseline-fixture]').textContent();
    const screenshot = await page.screenshot({ animations: 'disabled' });
    return { dom: `${dom}\n`, fixture: `${fixture ?? ''}\n`, screenshot, environment };
  } finally {
    await context.close();
  }
}

async function stopServer(server) {
  if (server.exitCode !== null) return;
  const exited = once(server, 'exit').catch(() => undefined);
  try {
    if (process.platform === 'win32' || server.pid === undefined) {
      server.kill('SIGTERM');
    } else {
      process.kill(-server.pid, 'SIGTERM');
    }
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

const output = [];
const server = spawn(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  },
);
server.stdout.on('data', (chunk) => output.push(String(chunk)));
server.stderr.on('data', (chunk) => output.push(String(chunk)));

let browser;
try {
  await waitForServer(server, output);
  browser = await chromium.launch({ headless: true });
  const first = await capture(browser);
  const second = await capture(browser);

  assert.deepEqual(first.environment, {
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    theme: 'light',
    colorScheme: 'light',
    fontSize: '16px',
    locale: 'zh-CN',
  });
  assert.deepEqual(second.environment, first.environment);
  assert.equal(second.fixture, first.fixture, 'fixture JSON changed between consecutive captures');
  assert.equal(second.dom, first.dom, 'DOM changed between consecutive captures');
  assert.equal(second.screenshot.equals(first.screenshot), true, 'screenshot changed between consecutive captures');

  if (WRITE_BEFORE) {
    await mkdir(EVIDENCE, { recursive: true });
    await Promise.all([
      writeFile(join(EVIDENCE, 'shellspan-hello.dom.html'), first.dom),
      writeFile(join(EVIDENCE, 'shellspan-hello.events.json'), first.fixture),
      writeFile(join(EVIDENCE, 'shellspan-hello.png'), first.screenshot),
    ]);
  }

  process.stdout.write(`${JSON.stringify({
    stable: true,
    runs: 2,
    environment: first.environment,
    fixtureSha256: sha256(first.fixture),
    domSha256: sha256(first.dom),
    screenshotSha256: sha256(first.screenshot),
  }, null, 2)}\n`);
} finally {
  await browser?.close();
  await stopServer(server);
}
