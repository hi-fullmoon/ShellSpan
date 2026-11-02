import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const artifacts = join(tmpdir(), 'shellspan-transcript-row-height');
await mkdir(artifacts, { recursive: true });
const recordings = await Promise.all(['agent-skills-runtime.json', 'task-token-budget.json']
  .map(async file => JSON.parse(await readFile(join(root, 'src/tests/fixtures', file), 'utf8'))));
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(artifacts, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  plugins: [tailwindcss()],
});
server.middlewares.use('/', (request, response, next) => {
  if (request.url !== '/') return next();
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell"></main></body></html>');
});

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      for (const locale of ['zh-CN', 'en-US']) {
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
        await page.evaluate(async ({ recordings, locale }) => {
          const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
          await import('/src/styles/base.css');
          await import('/src/components/ai/styles/styles.css');
          const { AiConversationNodeList } = await import('/src/components/ai/workspace/ai-conversation-node-seat.tsx');
          const { projectAgentChatNodes } = await import('/src/lib/ai/conversation-projection.ts');
          const { initI18n } = await import('/src/locales/index.ts');
          const { useAppStore } = await import('/src/stores/appStore.ts');
          await initI18n(locale);
          useAppStore.setState({ locale });
          const [skills, budget] = recordings;
          // Render original projected nodes independently so collapsed parents
          // cannot hide a child header from the geometry checks.
          const flatten = nodes => nodes.flatMap(node => node.kind === 'turnProcess'
            ? [node, ...flatten(node.children)] : [node]);
          const nodes = [...flatten(projectAgentChatNodes(skills)), ...flatten(projectAgentChatNodes(budget.events))];
          createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
            ...nodes.map((node, index) => React.createElement('section', { key: index, 'data-recorded-row': node.kind },
              React.createElement(AiConversationNodeList, { nodes: [node] })))));
        }, { recordings, locale });
        await page.locator('[data-recorded-row="systemPrompt"] .ai-disclosure-row').first().waitFor();
        for (const kind of ['systemPrompt', 'contextInjection', 'runtimeArtifacts', 'turnProcess', 'tool']) {
          assert.ok(await page.locator(`[data-recorded-row="${kind}"] :is(.ai-disclosure-row, .ai-tool-row)`).count(),
            `The original recordings cover ${kind}`);
        }
        const rows = page.locator(':is(.ai-disclosure-row, .ai-tool-row):visible');
        const checkRows = async context => {
          const geometry = await rows.evaluateAll(elements => elements.map(element => {
            const row = element.getBoundingClientRect();
            return { label: element.getAttribute('aria-label'), height: row.height,
              contained: [...element.querySelectorAll('.ai-disclosure-leading, .ai-disclosure-title, .ai-disclosure-summary')]
                .every(child => {
                  const box = child.getBoundingClientRect();
                  return box.top >= row.top && box.bottom <= row.bottom;
                }) };
          }));
          for (const row of geometry) {
            assert.equal(row.height, 24, `${context}: ${row.label}`);
            assert.ok(row.contained, `${context}: title, summary and icon stay inside ${row.label}`);
          }
        };
        for (const width of [220, 390, 720]) {
          await page.setViewportSize({ width, height: 900 });
          await checkRows(`${engine.name()}/${locale}/${width}`);
          await page.screenshot({ path: join(artifacts, `${engine.name()}-${locale}-${width}.png`), fullPage: true });
        }
        // Cover both expanded and collapsed headers with actual keyboard input.
        let toggled = 0;
        for (const section of await page.locator('[data-recorded-row]').all()) {
          const row = section.locator(':is(.ai-disclosure-row, .ai-tool-row)').first();
          if (!await row.count()) continue;
          const open = await row.getAttribute('aria-expanded');
          await row.press('Enter');
          assert.notEqual(await row.getAttribute('aria-expanded'), open);
          assert.equal((await row.boundingBox()).height, 24);
          await row.press('Space');
          assert.equal(await row.getAttribute('aria-expanded'), open);
          toggled++;
        }
        assert.ok(toggled >= 5, 'Keyboard checks cover the recorded header kinds');
        await checkRows(`${engine.name()}/${locale}/after toggling`);
        await page.screenshot({ path: join(artifacts, `${engine.name()}-${locale}.png`), fullPage: true });
      }
      assert.deepEqual(errors, []);
      await page.close();
    } finally { await browser.close(); }
  }
  console.log(`Transcript row heights passed in Chromium/WebKit, both languages, at 220px/390px/720px. Screenshots: ${artifacts}`);
} finally { await server.close(); }
