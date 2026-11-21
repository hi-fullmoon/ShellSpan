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
const artifacts = join(tmpdir(), 'shellspan-terminal-command-scrollbar');
await mkdir(artifacts, { recursive: true });
const paths = execFileSync('git', ['ls-files', 'src/components/ai/workspace'], { cwd: root, encoding: 'utf8' }).trim().split('\n').slice(0, 12);
const args = ['log', '-1', '--format=fuller', '--', ...paths];
const command = `git ${args.join(' ')}`;
const output = execFileSync('git', ['log', '-3', '--format=fuller'], { cwd: root, encoding: 'utf8' });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(artifacts, 'vite-cache'), resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' }, plugins: [tailwindcss()],
  server: { host: '127.0.0.1', port: 0 },
});
server.middlewares.use('/__command-scrollbar', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body><main id="root" class="ai-panel-shell"></main></body></html>');
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [380, 720]) {
        for (const showCopyActions of [true, false]) {
          const context = `${engine.name()}-${width}-${showCopyActions ? 'copy' : 'no-copy'}`;
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__command-scrollbar`);
          await page.evaluate(async ({ command, output, showCopyActions }) => {
            const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
            await import('/src/styles/base.css');
            await import('/src/components/ai/styles/styles.css');
            const { AiToolExpandedContent } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
            const { initI18n } = await import('/src/locales/index.ts');
            await initI18n('zh-CN');
            createRoot(document.getElementById('root')).render(React.createElement(AiToolExpandedContent, {
              compact: true, showCopyActions,
              node: { kind: 'tool', name: 'exec_command', nativeName: null, state: 'succeeded',
                input: { command }, output, error: null, target: null },
            }));
          }, { command, output, showCopyActions });
          const toggle = page.locator('.ai-terminal-command');
          await toggle.waitFor();
          const title = page.locator('.ai-terminal-command-row .ai-content-title');
          const viewport = title.locator('[data-slot="scroll-area-viewport"]');
          const textRight = () => toggle.locator('span').evaluate(element => element.getBoundingClientRect().right);
          const collapsedRight = await textRight();
          const collapsedHeight = (await title.boundingBox()).height;
          await toggle.click();
          assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
          await title.locator('[data-slot="scroll-area-scrollbar"]').waitFor({ state: 'attached' });
          const geometry = await title.evaluate(element => {
            const rect = element.getBoundingClientRect();
            const region = element.closest('.ai-tool-content-region').getBoundingClientRect();
            const button = element.querySelector('button');
            const viewport = element.querySelector('[data-slot="scroll-area-viewport"]');
            const thumb = element.querySelector('[data-slot="scroll-area-thumb"]');
            const output = element.closest('.ai-terminal-output').querySelector('.ai-terminal-transcript');
            const outputThumb = output.querySelector('[data-orientation="vertical"] [data-slot="scroll-area-thumb"]');
            const thumbRect = thumb.getBoundingClientRect();
            const outputRect = outputThumb.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.right - 2, rect.top + rect.height / 2);
            return { rightGap: region.right - rect.right, height: rect.height,
              lineHeight: parseFloat(getComputedStyle(element).lineHeight),
              scrolls: viewport.scrollHeight > viewport.clientHeight,
              padding: parseFloat(getComputedStyle(button).paddingRight),
              textGap: region.right - button.firstElementChild.getBoundingClientRect().right,
              thumbRight: region.right - thumbRect.right,
              outputThumbRight: region.right - outputRect.right,
              thumbWidth: thumbRect.width, outputThumbWidth: outputRect.width,
              edgeVisible: hit === element || element.contains(hit) };
          });
          assert.ok(Math.abs(geometry.rightGap) <= 1, `${context}: scrollbar must reach the card's inner right edge: ${JSON.stringify(geometry)}`);
          assert.ok(geometry.edgeVisible, `${context}: scrollbar edge must remain outside ancestor clipping`);
          assert.ok(geometry.scrolls && geometry.height <= geometry.lineHeight * 6 + 1,
            `${context}: expanded command scrolls within six lines`);
          assert.equal(geometry.padding, 14, `${context}: copy action must not reserve a full column beside every command line`);
          assert.equal(geometry.textGap, 14, `${context}: command text uses the same right padding as output content`);
          assert.equal(geometry.thumbRight, geometry.outputThumbRight, `${context}: command and output scrollbar insets match`);
          assert.ok(geometry.thumbRight >= 2, `${context}: scrollbar thumb retains clearance from the card edge`);
          assert.equal(geometry.thumbWidth, geometry.outputThumbWidth, `${context}: command and output scrollbar widths match`);
          assert.ok(Math.abs(await textRight() - collapsedRight) <= 6, `${context}: expansion preserves text alignment within scrollbar width`);
          const promptBeforeScroll = await page.locator('.ai-terminal-prompt').boundingBox();
          await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
          const scrolledTop = await viewport.evaluate(element => element.scrollTop);
          assert.ok(scrolledTop > 0, `${context}: final command lines remain reachable`);
          const promptAfterScroll = await page.locator('.ai-terminal-prompt').boundingBox();
          assert.ok(promptBeforeScroll.y - promptAfterScroll.y >= scrolledTop - 1,
            `${context}: prompt $ must scroll with the first command line`);
          await title.hover();
          await page.screenshot({ path: join(artifacts, `${context}.png`) });
          if (showCopyActions) {
            const copy = page.locator('.ai-terminal-command-row').locator('..').locator('.ai-tool-copy-button');
            assert.equal(await copy.evaluate(element => getComputedStyle(element).opacity), '1', `${context}: hovering the command reveals its copy action`);
            await page.mouse.move(0, 899);
            await page.keyboard.press('Tab');
            await copy.focus();
            assert.equal(await copy.evaluate(element => getComputedStyle(element).opacity), '1', `${context}: keyboard focus reveals the copy action`);
          }
          await toggle.press('Enter');
          assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
          assert.equal((await title.boundingBox()).height, collapsedHeight);
          await toggle.press('Space');
          assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
          assert.deepEqual(errors, [], `${context}: browser errors`);
          await page.close();
        }
      }
    } finally { await browser.close(); }
  }
  console.log(`Command scrollbar alignment and keyboard folding passed in Chromium/WebKit at 380px/720px, with and without copy actions. Screenshots: ${artifacts}`);
} finally { await server.close(); }
