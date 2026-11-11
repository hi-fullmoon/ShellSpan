import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const artifacts = join(root, '.artifacts/tests/terminal-result-presentation/browser');
await mkdir(artifacts, { recursive: true });

function capture(command) {
  const submittedCommandLine = `(exit "$?"); builtin eval -- '${command}'`;
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', submittedCommandLine], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0);
  return { command, output: { commandLine: command, submittedCommandLine, cwd: root,
    execution: 'completed', exitCode: result.status, stdout: '', stderr: '', combinedOutput: result.stdout + result.stderr } };
}

const completed = capture('git log -5 --format=fuller --color=always');
const plainOutput = capture('git log -5 --format=fuller --color=never').output.combinedOutput;
assert.ok(completed.output.combinedOutput.includes('\u001b['));
const empty = capture(':');
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error', cacheDir: join(artifacts, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] }, plugins: [tailwindcss()],
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
});
server.middlewares.use('/__terminal-result', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell" style="height:900px"></main></body></html>');
});

const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
try {
  await once(child, 'spawn');
  assert.equal(child.exitCode, null);
  const running = { command: `${process.execPath} -e 'process.stdin.resume()'`,
    output: { execution: 'running', exitCode: 0, combinedOutput: '', pid: child.pid } };
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [380, 720]) {
        for (const locale of ['zh-CN', 'en-US']) {
          for (const [name, result] of Object.entries({ completed, empty, running })) {
            for (const surface of ['inline', 'details']) {
              const page = await browser.newPage({ viewport: { width, height: 900 } });
              const errors = [];
              page.on('pageerror', error => errors.push(error.message));
              await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__terminal-result`);
              await page.evaluate(async ({ result, locale, surface }) => {
                const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
                await import('/src/styles/base.css');
                await import('/src/components/ai/styles/styles.css');
                const { AiToolExpandedContent } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
                const { AiToolDetails } = await import('/src/components/ai/workspace/ai-tool-details.tsx');
                const { initI18n } = await import('/src/locales/index.ts');
                const { useAppStore } = await import('/src/stores/appStore.ts');
                useAppStore.setState({ locale });
                await initI18n(locale);
                const node = { kind: 'tool', name: 'run_terminal_command', nativeName: 'terminal_execute', state: 'succeeded',
                  input: { command: result.command }, output: result.output, error: null, target: null,
                  summary: result.command, durationMs: null, evidenceRefs: [] };
                createRoot(document.getElementById('root')).render(surface === 'inline'
                  ? React.createElement(AiToolExpandedContent, { node })
                  : React.createElement(AiToolDetails, { node, onBack() {} }));
              }, { result, locale, surface });
              const output = page.locator('[data-ai-terminal-output]');
              await output.waitFor();
              const context = `${engine.name()}/${width}/${locale}/${name}/${surface}`;
              const text = await output.textContent();
              assert.ok(!text.includes('combinedOutput') && !text.includes('submittedCommandLine'), context);
              if (name === 'completed') {
                const lines = await output.locator('.ai-block-line').allTextContents();
                assert.equal(lines.map(line => line === '\u00a0' ? '' : line).join('\n'), plainOutput.trimEnd(), context);
              } else assert.ok(text.includes(locale === 'zh-CN' ? '无输出' : 'No output'), context);
              const status = page.locator('[data-ai-terminal-execution]');
              assert.equal(await status.evaluate(element => getComputedStyle(element).color),
                await page.locator('.ai-terminal-header').evaluate(element => getComputedStyle(element).color), context);
              assert.equal(await status.textContent(), name === 'running'
                ? locale === 'zh-CN' ? '进程运行中' : 'Process running'
                : locale === 'zh-CN' ? '进程已退出' : 'Process exited', context);
              if (surface === 'inline') {
                assert.equal(await page.locator('.ai-terminal-command').textContent(), result.command, context);
              } else {
                const details = page.locator('.ai-detail-section').nth(2);
                const { combinedOutput, stdout, stderr, ...metadata } = result.output;
                assert.equal(await details.locator('code').textContent(), JSON.stringify(metadata, null, 2), context);
                const copy = details.locator('.ai-tool-copy-button');
                await copy.focus();
                assert.equal(await copy.evaluate(element => getComputedStyle(element).opacity), '1', context);
                await details.locator('[data-slot="scroll-area-viewport"]').evaluate(element => { element.scrollTop = element.scrollHeight; });
              }
              assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), context);
              assert.deepEqual(errors, [], context);
              await page.screenshot({ path: join(artifacts, `${context.replaceAll('/', '-')}.png`) });
              await page.close();
            }
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
  console.log(`Terminal output, execution details and keyboard checks passed in Chromium/WebKit at 380px/720px, in Chinese/English. Screenshots: ${artifacts}`);
} finally {
  await server.close();
  const exited = once(child, 'exit');
  child.stdin.end();
  await exited;
}
