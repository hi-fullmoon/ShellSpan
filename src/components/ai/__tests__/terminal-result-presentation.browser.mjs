import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const artifacts = join(root, 'artifacts/tests/terminal-result-presentation/browser');
await mkdir(artifacts, { recursive: true });

function capture(command) {
  const submittedCommandLine = `(exit "$?"); builtin eval -- '${command}'`;
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', submittedCommandLine], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0);
  return { command, output: { commandLine: command, submittedCommandLine, cwd: root,
    execution: 'completed', exitCode: result.status, stdout: '', stderr: '', combinedOutput: result.stdout + result.stderr } };
}

const completed = capture(String.raw`git log -5 --format=fuller --color=always && printf "\030"`);
const plainOutput = capture('git log -5 --format=fuller --color=never').output.combinedOutput;
assert.ok(completed.output.combinedOutput.includes('\u001b['));
assert.ok(completed.output.combinedOutput.endsWith('\u0018'));
const empty = capture(':');
const { withNewline } = JSON.parse(await readFile(new URL('./fixtures/zsh-terminal-result.json', import.meta.url), 'utf8'));
const zsh = { command: withNewline.command, output: { execution: 'completed', exitCode: 0, combinedOutput: withNewline.output } };
const expectedOutput = { completed: plainOutput.trimEnd(), zsh: '100%\n%' };
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error', cacheDir: join(artifacts, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } },
  optimizeDeps: { entries: ['src/components/ai/workspace/ai-tool-details.tsx'], include: ['react', 'react-dom/client'] },
  plugins: [react(), tailwindcss()],
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
          for (const [name, result] of Object.entries({ completed, empty, running, zsh })) {
            for (const surface of ['inline', 'details']) {
              const page = await browser.newPage({ viewport: { width, height: 900 },
                permissions: engine === chromium ? ['clipboard-read', 'clipboard-write'] : [],
              });
              const errors = [];
              page.on('pageerror', error => errors.push(error.message));
              await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__terminal-result`);
              await page.evaluate(async ({ result, locale, surface }) => {
                const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
                await import('/src/styles/base.css');
                await import('/src/components/ai/styles/styles.css');
                const { AiToolRow } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
                const { AiToolDetails } = await import('/src/components/ai/workspace/ai-tool-details.tsx');
                const { initI18n } = await import('/src/locales/index.ts');
                const { useAppStore } = await import('/src/stores/appStore.ts');
                document.documentElement.dataset.theme = locale === 'zh-CN' ? 'light' : 'dark';
                useAppStore.setState({ locale });
                await initI18n(locale);
                const node = { kind: 'tool', name: 'run_terminal_command', nativeName: 'terminal_execute', state: 'succeeded',
                  input: { command: result.command }, output: result.output, error: null, target: null,
                  summary: result.command, durationMs: null, evidenceRefs: [] };
                createRoot(document.getElementById('root')).render(surface === 'inline'
                  ? React.createElement(AiToolRow, { node })
                  : React.createElement(AiToolDetails, { node, onBack() {} }));
              }, { result, locale, surface });
              if (surface === 'inline') await page.locator('.ai-tool-row').click();
              const output = page.locator('[data-ai-terminal-output]');
              await output.waitFor();
              const context = `${engine.name()}/${width}/${locale}/${name}/${surface}`;
              const text = await output.textContent();
              assert.ok(!text.includes('combinedOutput') && !text.includes('submittedCommandLine'), context);
              if (name in expectedOutput) {
                const lines = await output.locator('.ai-block-line').allTextContents();
                assert.equal(lines.map(line => line === '\u00a0' ? '' : line).join('\n'), expectedOutput[name], context);
              } else assert.ok(text.includes(locale === 'zh-CN' ? '无输出' : 'No output'), context);
              const status = page.locator('[data-ai-terminal-execution]');
              assert.equal(await status.evaluate(element => getComputedStyle(element).color),
                await page.locator('.ai-terminal-header').evaluate(element => getComputedStyle(element).color), context);
              const statusLabels = locale === 'zh-CN'
                ? { running: '进程运行中', succeeded: '成功', exited: '进程已退出' }
                : { running: 'Process running', succeeded: 'Succeeded', exited: 'Process exited' };
              assert.equal(await status.textContent(), statusLabels[name === 'running' ? 'running' : surface === 'inline' ? 'succeeded' : 'exited'], context);
              if (surface === 'inline') {
                const command = page.locator('.ai-terminal-command');
                assert.equal(await command.textContent(), result.command, context);
                assert.equal(await command.getAttribute('aria-expanded'), 'false', context);
                await command.press('Enter');
                assert.equal(await command.getAttribute('aria-expanded'), 'true', context);
                await command.press('Enter');
                assert.equal(await command.getAttribute('aria-expanded'), 'false', context);

                const footer = page.locator('.ai-terminal-footer');
                assert.equal(await footer.locator('[data-ai-terminal-execution]').count(), 1, context);
                assert.equal(await page.locator('.ai-terminal-header').textContent(), 'Shell', context);
                const cardBox = await page.locator('.ai-terminal-block').boundingBox();
                const footerBox = await footer.boundingBox();
                const statusBox = await status.boundingBox();
                const commandBox = await page.locator('.ai-terminal-command-row').boundingBox();
                const outputBox = await output.boundingBox();
                assert.ok(outputBox.y - (commandBox.y + commandBox.height) >= 8, `${context}: command and output must have a gap`);
                assert.ok(footerBox.y >= outputBox.y + outputBox.height, `${context}: status must sit below the output`);
                assert.ok(cardBox.x + cardBox.width - (statusBox.x + statusBox.width) <= 16, `${context}: status must align right`);

                const viewport = output.locator('[data-slot="scroll-area-viewport"]');
                const overflowBelow = viewport.and(page.locator('[data-overflow-y-end]'));
                const readFade = () => viewport.evaluate(element => getComputedStyle(element).maskImage);
                if (name === 'completed') {
                  await overflowBelow.waitFor();
                  assert.notEqual(await readFade(), 'none', `${context}: more output should fade at the bottom`);
                  if (width === 380) {
                    const horizontalOffset = await viewport.evaluate(element => {
                      element.scrollLeft = element.scrollWidth;
                      const offset = element.scrollLeft;
                      element.scrollLeft = 0;
                      return offset;
                    });
                    assert.ok(horizontalOffset > 0, `${context}: long lines should scroll horizontally`);
                  }
                  await viewport.focus();
                  await viewport.press('End');
                  await overflowBelow.waitFor({ state: 'detached' });
                  assert.equal(await readFade(), 'none', `${context}: the last output lines must be clear`);
                  await viewport.evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
                  await overflowBelow.waitFor();

                  if (engine === chromium) {
                    const copiedLabel = locale === 'zh-CN' ? '已复制' : 'Copied';
                    for (const [region, expected, label] of [
                      [page.locator('.ai-terminal-command-row').locator('..'), result.command, locale === 'zh-CN' ? '复制命令' : 'Copy command'],
                      [output, plainOutput, locale === 'zh-CN' ? '复制输出' : 'Copy output'],
                    ]) {
                      const copy = region.getByRole('button', { name: label, exact: true });
                      const tooltips = page.locator('[data-slot="tooltip-content"]');
                      await region.hover({ position: { x: 4, y: 4 } });
                      await copy.hover();
                      const tooltip = tooltips.filter({ hasText: label });
                      await tooltip.waitFor({ timeout: 4000 });
                      await copy.press('Enter');
                      await page.waitForFunction(expected => navigator.clipboard.readText().then(value => value === expected), expected);
                      await region.getByRole('button', { name: copiedLabel, exact: true }).locator('.lucide-check').waitFor();
                      assert.equal(await tooltip.isVisible(), false, context);
                      assert.equal(await tooltips.filter({ hasText: copiedLabel }).isVisible(), false, context);
                    }
                    await page.locator('.ai-tool-row').focus();
                  }
                } else {
                  assert.equal(await readFade(), 'none', `${context}: short output should stay clear`);
                }
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
