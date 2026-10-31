import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const artifacts = join(tmpdir(), 'shellspan-terminal-command-fold');
await mkdir(artifacts, { recursive: true });
const args = ['log', '-1', '--format=fuller', '--',
  'src/components/ai/workspace/ai-tool-presentation.tsx',
  'src/components/ai/styles/tool-results.css',
  'src/components/ai/__tests__/ai-tool-presentation.test.tsx'];
const output = execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const command = `git ${args.join(' ')}`;
const shortArgs = ['rev-parse', '--short', 'HEAD'];
const scenarios = ['inline', 'details'].flatMap(surface => [
  { surface, name: 'short', command: `git ${shortArgs.join(' ')}`,
    output: execFileSync('git', shortArgs, { cwd: root, encoding: 'utf8' }) },
  { surface, name: 'wrapped', command, output },
  { surface, name: 'multiline', command: `git ${args.join(' \\\n  ')}`, output },
]);
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(artifacts, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' },
  plugins: [tailwindcss()], server: { host: '127.0.0.1', port: 0 },
});
server.middlewares.use('/__command', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body><main id="root" class="ai-panel-shell" style="height:900px"></main></body></html>');
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [380, 720]) {
        for (const { surface, name, command: displayCommand, output } of scenarios) {
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__command`);
          await page.evaluate(async ({ command, output, surface }) => {
            const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
            await import('/src/styles/base.css');
            await import('/src/components/ai/styles/styles.css');
            const { AiToolExpandedContent } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
            const { AiToolDetails } = await import('/src/components/ai/workspace/ai-tool-details.tsx');
            const { initI18n } = await import('/src/locales/index.ts');
            await initI18n('en-US');
            const node = { kind: 'tool', name: 'exec_command', nativeName: null, state: 'succeeded',
              input: { command }, output, error: null, target: null, summary: command, durationMs: null };
            createRoot(document.getElementById('root')).render(surface === 'details'
              ? React.createElement(AiToolDetails, { node, onBack() {} })
              : React.createElement(AiToolExpandedContent, { compact: true, node }));
          }, { command: displayCommand, output, surface });
          const toggle = page.locator('.ai-terminal-command');
          await toggle.waitFor();
          const geometry = () => toggle.evaluate(element => {
            const text = element.firstElementChild;
            return { height: element.getBoundingClientRect().height,
              textHeight: text.getBoundingClientRect().height,
              fullHeight: text.scrollHeight,
              lineHeight: parseFloat(getComputedStyle(text).lineHeight) };
          });
          const collapsed = await geometry();
          const context = `${engine.name()}/${width}/${surface}/${name}`;
          const spacing = () => page.locator('.ai-terminal-command-row').evaluate(element => {
            const style = getComputedStyle(element);
            const row = element.getBoundingClientRect();
            const title = element.querySelector('.ai-content-title').getBoundingClientRect();
            const output = element.closest('.ai-terminal-output').querySelector('[data-ai-terminal-output]').getBoundingClientRect();
            return { top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom),
              titleTop: title.top - row.top, outputGap: output.top - title.bottom };
          });
          assert.deepEqual(await spacing(), { top: 4, bottom: 4, titleTop: 4, outputGap: 4 },
            `${context}: command title must have compact, equal vertical spacing`);
          assert.ok(Math.abs(collapsed.height - collapsed.lineHeight * (name === 'short' ? 1 : 2)) <= 1,
            `${context}: short commands use one line and long previews use two`);
          assert.equal(collapsed.fullHeight > collapsed.textHeight, name !== 'short', `${context}: long command exceeds preview`);
          const copy = page.locator('.ai-terminal-command-row').locator('..').locator('.ai-tool-copy-button');
          assert.equal(await copy.count(), surface === 'inline' ? 1 : 0, `${context}: copy actions match the surface`);
          if (surface === 'inline') {
            const row = await page.locator('.ai-terminal-command-row').boundingBox();
            const button = await copy.boundingBox();
            assert.ok(button.y >= row.y && button.y + button.height <= row.y + row.height,
              `${context}: copy button stays inside the compact command row`);
            await copy.focus();
            assert.equal(await copy.evaluate(element => getComputedStyle(element).opacity), '1',
              `${context}: keyboard focus reveals the copy action`);
          }
          assert.equal(await toggle.textContent(), displayCommand);
          await page.screenshot({ path: join(artifacts, `${context.replaceAll('/', '-')}-collapsed.png`) });
          await toggle.click();
          assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
          const expanded = await geometry();
          assert.equal(expanded.height > collapsed.height, name !== 'short', `${context}: only long commands grow on expansion`);
          assert.ok(Math.abs(expanded.textHeight - expanded.fullHeight) <= 1, `${context}: all lines are visible`);
          const titleFrame = page.locator('.ai-terminal-command-row .ai-content-title');
          const titleViewport = titleFrame.locator('[data-slot="scroll-area-viewport"]');
          assert.deepEqual(await spacing(), { top: 4, bottom: 4, titleTop: 4, outputGap: 4 },
            `${context}: expanding must preserve the command title spacing`);
          assert.ok((await titleFrame.boundingBox()).height <= expanded.lineHeight * 6 + 1, `${context}: expanded command stays within six lines`);
          await titleViewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
          assert.ok(await titleViewport.evaluate(element => element.scrollHeight <= element.clientHeight || element.scrollTop > 0), `${context}: every command line is reachable`);
          await page.screenshot({ path: join(artifacts, `${context.replaceAll('/', '-')}-expanded.png`) });
          await toggle.press('Enter');
          assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
          assert.equal((await geometry()).height, collapsed.height);
          await toggle.press('Space');
          assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  console.log(`Command spacing, folding and copy geometry passed in Chromium/WebKit, inline/details, short/wrapped/multiline, at 380px/720px. Screenshots: ${artifacts}`);
} finally {
  await server.close();
}
