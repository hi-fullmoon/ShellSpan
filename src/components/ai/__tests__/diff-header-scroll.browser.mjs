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
const artifacts = join(tmpdir(), 'shellspan-diff-header-scroll');
await mkdir(artifacts, { recursive: true });
const path = 'src/components/ai/workspace/ai-tool-presentation.tsx';
const revision = execFileSync('git', ['log', '-1', '--format=%H', '--', path], { cwd: root, encoding: 'utf8' }).trim();
const patch = execFileSync('git', ['show', '--format=', '--unified=20', revision, '--', path,
  'src/components/ai/styles/tool-results.css'], { cwd: root, encoding: 'utf8' });
assert.ok(patch.length, 'Use a real repository patch');
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(artifacts, 'vite-cache'), resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' }, plugins: [tailwindcss()],
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__diff', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell"></main></body></html>');
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [380, 720]) {
        for (const detail of [false, true]) {
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__diff`);
          await page.evaluate(async ({ patch, detail }) => {
            const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
            await import('/src/styles/base.css');
            await import('/src/components/ai/styles/styles.css');
            const { AiToolExpandedContent } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
            const { AiToolDetails } = await import('/src/components/ai/workspace/ai-tool-details.tsx');
            const { initI18n } = await import('/src/locales/index.ts');
            await initI18n('zh-CN');
            const host = document.getElementById('root');
            if (detail) host.style.height = '100vh';
            const node = { kind: 'tool', name: 'apply_patch', nativeName: null, state: 'succeeded',
              input: { patch }, output: { diff: patch }, error: null, target: null,
              durationMs: null, evidenceRefs: [], approval: null, idempotency: null, effect: 'write' };
            createRoot(host).render(detail
              ? React.createElement(AiToolDetails, { node, onBack() {} })
              : React.createElement(AiToolExpandedContent, { node }));
          }, { patch, detail });
          await page.locator('.ai-diff-body').first().waitFor();
          const context = `${engine.name()}/${width}/${detail}`;
          let checked = 0;
          for (const section of await page.locator('.ai-diff-block section').all()) {
            const body = section.locator('.ai-diff-content [data-slot="scroll-area-viewport"]');
            if (!await body.evaluate(element => element.scrollWidth > element.clientWidth)) continue;
            const header = section.locator('.ai-tool-surface-header');
            await header.scrollIntoViewIfNeeded();
            const before = await header.boundingBox();
            const counts = await header.locator('.ai-diff-counts').boundingBox();
            const copy = section.locator('.ai-tool-copy-button');
            const copyBefore = await copy.count() ? await copy.boundingBox() : null;
            await body.evaluate(element => { element.scrollLeft = element.scrollWidth; });
            assert.ok(await body.evaluate(element => element.scrollLeft > 0), `${context}: diff body scrolls horizontally`);
            assert.deepEqual(await header.boundingBox(), before, `${context}: file header stays fixed`);
            assert.deepEqual(await header.locator('.ai-diff-counts').boundingBox(), counts, `${context}: counts stay fixed`);
            if (copyBefore) assert.deepEqual(await copy.boundingBox(), copyBefore, `${context}: copy stays fixed`);
            assert.ok(before.x >= 0 && before.x + before.width <= width, `${context}: header fits the card`);
            checked++;
          }
          assert.ok(checked > 1, `${context}: cover multiple files with long lines`);
          if (!detail) {
            const viewport = page.locator('.ai-diff-content [data-slot="scroll-area-viewport"]').first();
            assert.ok((await page.locator('.ai-diff-content').first().boundingBox()).height <= 260);
            await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
            assert.ok(await viewport.evaluate(element => element.scrollTop > 0), `${context}: vertical scrolling is retained`);
            await viewport.evaluate(element => { element.scrollTop = 0; });
          }
          await page.screenshot({ path: join(artifacts, `${context.replaceAll('/', '-')}.png`) });
          assert.deepEqual(errors, []);
          await page.close();
        }
      }
    } finally { await browser.close(); }
  }
  console.log(`Diff headers stay fixed in Chromium/WebKit at 380px/720px, including detail styles. Screenshots: ${artifacts}`);
} finally { await server.close(); }
