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
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(artifacts, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' },
  plugins: [tailwindcss()], server: { host: '127.0.0.1', port: 0 },
});
server.middlewares.use('/__command', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body><main id="root" class="ai-panel-shell"></main></body></html>');
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [380, 720]) {
        for (const multiline of [false, true]) {
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__command`);
          const displayCommand = multiline ? `git ${args.join(' \\\n  ')}` : command;
          await page.evaluate(async ({ command, output }) => {
            const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
            await import('/src/styles/base.css');
            await import('/src/components/ai/styles/styles.css');
            const { AiToolExpandedContent } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
            const { initI18n } = await import('/src/locales/index.ts');
            await initI18n('en-US');
            createRoot(document.getElementById('root')).render(React.createElement(AiToolExpandedContent, {
              compact: true,
              node: { kind: 'tool', name: 'exec_command', nativeName: null, state: 'succeeded',
                input: { command }, output, error: null, target: null },
            }));
          }, { command: displayCommand, output });
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
          const context = `${engine.name()}/${width}/${multiline}`;
          assert.ok(Math.abs(collapsed.height - collapsed.lineHeight * 2) <= 1, `${context}: exactly two visible lines`);
          assert.ok(collapsed.fullHeight > collapsed.textHeight, `${context}: command exceeds preview`);
          assert.equal(await toggle.textContent(), displayCommand);
          await page.screenshot({ path: join(artifacts, `${context.replaceAll('/', '-')}-collapsed.png`) });
          await toggle.click();
          assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
          const expanded = await geometry();
          assert.ok(expanded.height > collapsed.height, `${context}: click expands command`);
          assert.ok(Math.abs(expanded.textHeight - expanded.fullHeight) <= 1, `${context}: all lines are visible`);
          const titleFrame = toggle.locator('..');
          assert.ok((await titleFrame.boundingBox()).height <= expanded.lineHeight * 6 + 1, `${context}: expanded command stays within six lines`);
          await titleFrame.evaluate(element => { element.scrollTop = element.scrollHeight; });
          assert.ok(await titleFrame.evaluate(element => element.scrollHeight <= element.clientHeight || element.scrollTop > 0), `${context}: every command line is reachable`);
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
  console.log(`Command folding passed in Chromium and WebKit at 380px and 720px. Screenshots: ${artifacts}`);
} finally {
  await server.close();
}
