import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = '/src/components/ai/__tests__/reasoning-reveal.browser-entry.tsx';
const content = await readFile(new URL('../../../../AGENTS.md', import.meta.url), 'utf8');
const paragraph = content.split('\n').find(line => line.startsWith('本文件'));
const server = await createServer({ root, configFile: false, appType: 'custom',
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src/` } },
  server: { host: '127.0.0.1', port: 0 } });
server.middlewares.use('/reveal', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/reveal', `<html><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));
});
await server.listen();
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [420, 900]) {
        for (const mode of ['agent', 'ask']) {
          const page = await browser.newPage({ viewport: { width, height: 720 }, reducedMotion: 'no-preference' });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/reveal`);
          const show = (text, streaming, key = 0) => page.evaluate(async args => {
            const { show } = await import(args.entry);
            show(args.text, args.mode, args.streaming, args.key);
          }, { entry, text, mode, streaming, key });
          const open = async () => {
            const button = page.locator('.ai-reasoning-row button').first();
            if (await button.getAttribute('aria-expanded') === 'false') await button.click();
            await page.locator('.ai-reasoning-body').waitFor();
          };
          if (mode === 'agent') {
            const longLine = content.split('\n').sort((a, b) => b.length - a.length)[0];
            await show(longLine.slice(0, 20), true, -1);
            const summary = page.locator('.ai-reasoning-row .ai-disclosure-summary');
            const height = await summary.evaluate(element => element.getBoundingClientRect().height);
            const prefix = await summary.locator('.ai-stream-text-fragment').elementHandle();
            for (const [text, streaming] of [[longLine, true], [longLine + '\n' + paragraph, true], [longLine + '\n' + paragraph, false]]) {
              await show(text, streaming, -1);
              if (streaming) {
                assert.ok(await summary.locator('[data-reveal]').count() > 0,
                  'New reasoning preview text must use the incremental reveal');
                if (text === longLine) {
                  assert.ok(await summary.locator('.ai-stream-text-fragment').first().evaluate(
                    (element, previous) => element === previous, prefix),
                  'Appending a batch must preserve the previously displayed text node');
                  const reveal = await summary.evaluate(element => {
                    const animations = element.getAnimations({ subtree: true });
                    const latest = animations.at(-1);
                    latest.pause();
                    latest.currentTime = 60;
                    const target = latest.effect.target;
                    const opacity = Number(getComputedStyle(target).opacity);
                    latest.finish();
                    return { opacity, count: animations.length };
                  });
                  assert.ok(reveal.count > 1 && reveal.opacity < 1,
                    'A received batch must reveal gradually instead of appearing fully opaque');
                }
              }
              const geometry = await summary.evaluate(element => ({
                text: element.textContent,
                left: element.scrollLeft,
                end: element.scrollWidth - element.clientWidth,
                height: element.getBoundingClientRect().height,
                overflowing: element.scrollWidth > element.clientWidth,
                overflowStyle: getComputedStyle(element).textOverflow,
              }));
              assert.equal(geometry.text, streaming ? text.trim().split('\n').at(-1) : longLine);
              assert.ok(Math.abs(geometry.left - (streaming ? geometry.end : 0)) <= 1,
                `Streaming must reveal the newest text; completion must restore the leading summary: ${engine.name()}/${width}/${streaming} ${JSON.stringify(geometry)}`);
              assert.equal(geometry.height, height, 'The reasoning preview must stay on one line');
              assert.equal(geometry.overflowStyle, streaming ? 'clip' : 'ellipsis',
                'Live preview must not hide scrolled text behind an ellipsis');
              if (text === longLine || !streaming) {
                assert.equal(geometry.overflowing, true, 'The long repository paragraph must exercise scrolling');
              }
            }
            await show(longLine, true, -1);
            await page.screenshot({ path: `/tmp/reasoning-preview-${engine.name()}-${width}.png` });
          }
          await show(paragraph.slice(0, 6), true);
          await open();
          const reveal = await page.evaluate(async ({ entry, paragraph, mode }) => {
            const { show } = await import(entry);
            show(paragraph, mode, true, 0);
            const body = document.querySelector('.ai-reasoning-body');
            body.getBoundingClientRect();
            const animations = body.getAnimations({ subtree: true }).filter(animation => animation.animationName === 'ai-stream-text-reveal');
            animations.forEach(animation => { animation.pause(); animation.currentTime = 120; });
            const element = animations[animations.length - 1]?.effect.target;
            return { count: animations.length, duration: animations[0]?.effect.getTiming().duration,
              filter: element && getComputedStyle(element).filter,
              opacity: element && Number(getComputedStyle(element).opacity),
              overflow: body.scrollWidth > body.clientWidth };
          }, { entry, paragraph, mode });
          assert.ok(reveal.count > 0);
          assert.equal(reveal.duration, 180);
          assert.equal(reveal.filter, 'none');
          assert.ok(reveal.opacity >= 0 && reveal.opacity < 1);
          assert.equal(reveal.overflow, false);
          await page.screenshot({ path: `/tmp/reasoning-reveal-${engine.name()}-${width}-${mode}.png` });
          const boundary = await page.evaluate(async ({ entry, content, mode }) => {
            const { show } = await import(entry);
            const { splitStreamingMarkdown } = await import('/src/lib/streaming-markdown.ts');
            const chunks = splitStreamingMarkdown(content);
            const before = chunks[0] + chunks[1].split('\n')[0];
            show(before, mode, true, 2);
            const button = document.querySelector('.ai-reasoning-row button');
            if (button.getAttribute('aria-expanded') === 'false') button.click();
            await new Promise(resolve => setTimeout(resolve, 700));
            const body = document.querySelector('.ai-reasoning-body');
            const previousText = body.lastElementChild.lastElementChild.textContent;
            show(before + '\n', mode, true, 2);
            body.getBoundingClientRect();
            const last = body.lastElementChild.lastElementChild;
            const replayed = last.getAnimations({ subtree: true }).length;
            const unchanged = previousText === last.textContent;
            // A genuinely new paragraph must still receive the reveal effect.
            show(before + '\n\n' + content.split('\n').find(line => line.startsWith('本文件')), mode, true, 2);
            body.getBoundingClientRect();
            return { unchanged, replayed, appendedAnimations: body.lastElementChild.lastElementChild.getAnimations({ subtree: true }).length };
          }, { entry, content, mode });
          assert.equal(boundary.unchanged, true);
          assert.equal(boundary.replayed, 0, 'A chunk split must not fade out already visible text');
          assert.ok(boundary.appendedAnimations > 0, 'New text must still fade in');
          await page.emulateMedia({ reducedMotion: 'reduce' });
          assert.equal(await page.locator('.ai-reasoning-body').evaluate(body => body.getAnimations({ subtree: true }).length), 0);
          await show(paragraph, false, 1);
          await open();
          assert.equal(await page.locator('.ai-reasoning-body [data-reveal]').count(), 0);
          assert.deepEqual(errors, []);
          await page.close();
        }
      }
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
