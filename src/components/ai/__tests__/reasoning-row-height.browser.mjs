import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const artifacts = join(tmpdir(), 'shellspan-reasoning-row-height');
await mkdir(artifacts, { recursive: true });
const source = await readFile(join(root, 'AGENTS.md'), 'utf8');
const summary = source.split('\n')[0];
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(artifacts, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' },
  plugins: [tailwindcss()], server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__reasoning-height', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body><main id="root" class="ai-panel-shell"></main></body></html>');
});

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const locale of ['zh-CN', 'en-US']) {
        for (const width of [380, 720]) {
          const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__reasoning-height`);
          await page.evaluate(async ({ source, summary, locale }) => {
            const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
            await import('/src/styles/base.css');
            await import('/src/components/ai/styles/styles.css');
            const { AiConversationNodeList, aiAskConversationNodeRenderers } = await import('/src/components/ai/workspace/ai-conversation-node-seat.tsx');
            const { initI18n } = await import('/src/locales/index.ts');
            const { useAppStore } = await import('/src/stores/appStore.ts');
            useAppStore.setState({ locale });
            await initI18n(locale);
            const reasoning = ['completed', 'streaming', 'interrupted'].map(state => ({
              kind: 'reasoning', key: state, state, summary, content: `${summary}\n\n${source}\n${summary}`,
            }));
            const tool = { kind: 'tool', key: 'tool', name: 'exec_command', nativeName: null, state: 'succeeded',
              input: { command: 'cat AGENTS.md', explanation: summary }, output: source,
              summary, durationMs: null, error: null, target: null };
            createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
              React.createElement(AiConversationNodeList, { nodes: [...reasoning, tool] }),
              React.createElement(AiConversationNodeList, { nodes: reasoning, renderers: aiAskConversationNodeRenderers }),
            ));
          }, { source, summary, locale });
          const rows = page.locator('.ai-reasoning-row > .ai-disclosure-row');
          await rows.last().waitFor();
          assert.equal(await rows.count(), 6);
          const toolHeight = (await page.locator('.ai-tool-row').boundingBox()).height;
          assert.equal(toolHeight, 24);
          assert.equal(await rows.first().locator('.ai-disclosure-title').textContent(), locale === 'zh-CN' ? '思考' : 'Reasoning');
          for (let index = 0; index < await rows.count(); index++) {
            const row = rows.nth(index);
            const context = `${engine.name()}/${locale}/${width}/${index}`;
            if (await row.getAttribute('aria-expanded') === 'true') await row.press('Space');
            assert.equal(await row.getAttribute('aria-expanded'), 'false');
            assert.equal((await row.boundingBox()).height, toolHeight, `${context}: collapsed reasoning matches tool height`);
            await row.press('Enter');
            assert.equal(await row.getAttribute('aria-expanded'), 'true');
            assert.equal((await row.boundingBox()).height, toolHeight, `${context}: expanded reasoning matches tool height`);
            await row.press('Space');
            assert.equal(await row.getAttribute('aria-expanded'), 'false');
            assert.equal((await row.boundingBox()).height, toolHeight, `${context}: closing preserves height`);
          }
          assert.deepEqual(errors, []);
          await page.screenshot({ path: join(artifacts, `${engine.name()}-${locale}-${width}.png`), fullPage: true });
          await page.close();
        }
      }
    } finally { await browser.close(); }
  }
  console.log(`Reasoning row height passed in Chromium/WebKit, both languages, at 380px/720px. Screenshots: ${artifacts}`);
} finally { await server.close(); }
