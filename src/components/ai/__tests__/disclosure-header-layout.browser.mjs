import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const artifacts = join(tmpdir(), 'shellspan-disclosure-header-layout');
await mkdir(artifacts, { recursive: true });
const source = await readFile(join(root, 'AGENTS.md'), 'utf8');
const summary = source.split('\n').sort((left, right) => right.length - left.length)[0];
const output = execFileSync('git', ['log', '-1', '--format=fuller'], { cwd: root, encoding: 'utf8' });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(artifacts, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' },
  plugins: [tailwindcss()], server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__disclosures', (_request, response) => {
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
          const page = await browser.newPage({ viewport: { width, height: 1200 }, reducedMotion: 'reduce' });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__disclosures`);
          await page.evaluate(async ({ source, summary, output, locale }) => {
            const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
            await import('/src/styles/base.css');
            await import('/src/components/ai/styles/styles.css');
            const { AiConversationNodeList, aiAskConversationNodeRenderers } = await import('/src/components/ai/workspace/ai-conversation-node-seat.tsx');
            const { initI18n } = await import('/src/locales/index.ts');
            const { useAppStore } = await import('/src/stores/appStore.ts');
            useAppStore.setState({ locale });
            await initI18n(locale);
            const nodes = [
              { kind: 'reasoning', key: 'reasoning', content: `${summary}\n\n${source}`, summary, state: 'completed' },
              { kind: 'contextInjection', key: 'context', content: source, provenance: { kind: 'user', label: summary } },
              { kind: 'tool', key: 'tool', name: 'exec_command', nativeName: null, state: 'succeeded',
                input: { command: 'git log -1 --format=fuller', explanation: summary },
                output, summary, durationMs: null, error: null, target: null },
            ];
            createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
              React.createElement('div', { id: 'agent-disclosures' }, React.createElement(AiConversationNodeList, { nodes })),
              React.createElement('div', { id: 'ask-disclosures' },
                React.createElement(AiConversationNodeList, { nodes: [nodes[0]], renderers: aiAskConversationNodeRenderers })),
            ));
          }, { source, summary, output, locale });
          const triggers = page.locator('#agent-disclosures :is(.ai-disclosure-row, .ai-tool-row)');
          await triggers.last().waitFor();
          assert.equal(await triggers.count(), 3);
          assert.equal(await triggers.first().locator('.ai-disclosure-title').textContent(), locale === 'zh-CN' ? '思考' : 'Reasoning');
          const toolHeight = (await triggers.nth(2).boundingBox()).height;
          const askTrigger = page.locator('#ask-disclosures .ai-disclosure-row');
          for (const trigger of [triggers.first(), askTrigger]) {
            assert.equal((await trigger.boundingBox()).height, toolHeight,
              `${engine.name()}/${locale}/${width}: reasoning matches the tool row height`);
          }
          await askTrigger.press('Enter');
          assert.equal(await askTrigger.getAttribute('aria-expanded'), 'true');
          assert.equal((await askTrigger.boundingBox()).height, toolHeight, 'expanded Ask reasoning preserves the tool row height');
          await askTrigger.press('Space');
          assert.equal(await askTrigger.getAttribute('aria-expanded'), 'false');
          await page.screenshot({ path: join(artifacts, `${engine.name()}-${locale}-${width}-collapsed.png`), fullPage: true });
          for (let index = 0; index < await triggers.count(); index++) {
            const trigger = triggers.nth(index);
            const context = `${engine.name()}/${locale}/${width}/${index}`;
            const preview = trigger.locator('.ai-disclosure-summary');
            const closed = await trigger.boundingBox();
            assert.equal(await preview.evaluate(element => getComputedStyle(element).whiteSpace), 'nowrap');
            await trigger.press('Enter');
            assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
            const geometry = await trigger.evaluate(element => {
              const row = element.getBoundingClientRect();
              const summary = element.querySelector('.ai-disclosure-summary');
              const box = summary.getBoundingClientRect();
              const line = parseFloat(getComputedStyle(summary).lineHeight);
              const content = document.getElementById(element.getAttribute('aria-controls')).getBoundingClientRect();
              const children = [...element.querySelectorAll('.ai-disclosure-leading, .ai-disclosure-title, .ai-tool-meta')];
              const style = getComputedStyle(summary);
              return { rowHeight: row.height, summaryHeight: box.height, fullWidth: summary.scrollWidth, width: summary.clientWidth, line,
                whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, overflow: style.overflowX,
                contained: [box, ...children.map(child => child.getBoundingClientRect())]
                  .every(child => child.top >= row.top - 1 && child.bottom <= row.bottom + 1),
                fits: row.left >= 0 && row.right <= innerWidth && box.right <= row.right,
                bodyTop: content.top, rowBottom: row.bottom };
            });
            assert.equal(geometry.summaryHeight, geometry.line, `${context}: expanded summary stays on one line`);
            assert.equal(geometry.rowHeight, closed.height, `${context}: expanding details preserves the header height`);
            assert.ok(geometry.fullWidth > geometry.width, `${context}: repository paragraph must exceed the preview width`);
            assert.deepEqual([geometry.whiteSpace, geometry.textOverflow, geometry.overflow], ['nowrap', 'ellipsis', 'hidden'],
              `${context}: long summaries stay clipped with an ellipsis`);
            assert.ok(geometry.contained, `${context}: expanded text and icons must stay inside the trigger`);
            assert.ok(geometry.fits, `${context}: expanded header fits the panel`);
            assert.ok(geometry.bodyTop >= geometry.rowBottom - 1, `${context}: body must follow the header`);
          }
          await page.screenshot({ path: join(artifacts, `${engine.name()}-${locale}-${width}-expanded.png`), fullPage: true });
          const viewports = page.locator('.ai-reasoning-viewport, .ai-semantic-note-body');
          for (let index = 0; index < await viewports.count(); index++) {
            const viewport = viewports.nth(index);
            const context = `${engine.name()}/${locale}/${width}/scrollbar-${index}`;
            await viewport.waitFor();
            await page.waitForFunction(element => element.clientHeight > 0 && element.scrollHeight > element.clientHeight,
              await viewport.elementHandle());
            const appearance = () => viewport.evaluate(element => ({
              thumb: getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor,
              width: element.clientWidth,
              height: element.clientHeight,
              overflow: getComputedStyle(element).overflowY,
              hovered: element.matches(':hover'),
            }));
            const waitHidden = async () => {
              await page.waitForFunction(element => !element.matches(':hover'), await viewport.elementHandle());
              await viewport.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            };
            await triggers.first().hover();
            await waitHidden();
            const hidden = await appearance();
            assert.equal(hidden.thumb, 'rgba(0, 0, 0, 0)', `${context}: thumb is hidden without hover`);
            assert.equal(hidden.overflow, 'auto', `${context}: hiding the thumb preserves scrolling`);
            await viewport.screenshot({ path: join(artifacts, `${context.replaceAll('/', '-')}-hidden.png`) });
            await viewport.hover();
            await viewport.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const hovered = await appearance();
            assert.equal(hovered.hovered, true, `${context}: pointer enters the scroll viewport`);
            assert.notEqual(hovered.thumb, hidden.thumb, `${context}: hovering reveals the thumb`);
            assert.deepEqual([hovered.width, hovered.height], [hidden.width, hidden.height],
              `${context}: showing the thumb must not change the content geometry`);
            await viewport.screenshot({ path: join(artifacts, `${context.replaceAll('/', '-')}-hover.png`) });
            await triggers.first().hover();
            await waitHidden();
            assert.equal((await appearance()).thumb, hidden.thumb, `${context}: leaving hides the thumb again`);

            await page.emulateMedia({ reducedMotion: 'no-preference' });
            const sampleFade = async expectedDuration => {
              await page.waitForFunction(element => element.getAnimations().some(animation => animation.transitionProperty === '--ai-scrollbar'),
                await viewport.elementHandle());
              const sample = await viewport.evaluate(element => {
                const animations = element.getAnimations().filter(animation =>
                  ['--ai-scrollbar', '--ai-scrollbar-hover'].includes(animation.transitionProperty));
                const fade = animations.find(animation => animation.transitionProperty === '--ai-scrollbar');
                const duration = fade.effect.getTiming().duration;
                for (const animation of animations) {
                  animation.pause();
                  animation.currentTime = duration / 2;
                }
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 1;
                const context = canvas.getContext('2d');
                const alpha = () => {
                  context.clearRect(0, 0, 1, 1);
                  context.fillStyle = getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor;
                  context.fillRect(0, 0, 1, 1);
                  return context.getImageData(0, 0, 1, 1).data[3];
                };
                const middle = alpha();
                for (const animation of animations) animation.finish();
                return { duration, middle, end: alpha(), width: element.clientWidth, height: element.clientHeight };
              });
              assert.equal(sample.duration, expectedDuration, `${context}: fade uses the shared motion duration`);
              assert.deepEqual([sample.width, sample.height], [hidden.width, hidden.height], `${context}: fading preserves geometry`);
              return sample;
            };
            await viewport.hover();
            const fadeIn = await sampleFade(200);
            assert.ok(fadeIn.middle > 0 && fadeIn.middle < fadeIn.end, `${context}: fade-in paints a partially visible thumb`);
            await triggers.first().hover();
            const fadeOut = await sampleFade(300);
            assert.ok(fadeOut.middle > 0 && fadeOut.middle < fadeIn.end, `${context}: fade-out paints a partially visible thumb`);
            assert.equal(fadeOut.end, 0, `${context}: fade-out finishes with a hidden thumb`);
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await viewport.hover();
            assert.equal(await viewport.evaluate(element => element.getAnimations().filter(animation =>
              ['--ai-scrollbar', '--ai-scrollbar-hover'].includes(animation.transitionProperty)).length), 0,
              `${context}: reduced motion disables scrollbar fades`);
            await triggers.first().hover();
            await waitHidden();
          }
          for (let index = 0; index < await triggers.count(); index++) {
            const trigger = triggers.nth(index);
            await trigger.press('Space');
            assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
            assert.equal(await trigger.locator('.ai-disclosure-summary').evaluate(element => getComputedStyle(element).whiteSpace), 'nowrap');
          }
          assert.deepEqual(errors, []);
          await page.close();
        }
      }
    } finally { await browser.close(); }
  }
  console.log(`Disclosure header layout passed in Chromium/WebKit, both languages, at 380px/720px. Screenshots: ${artifacts}`);
} finally { await server.close(); }
