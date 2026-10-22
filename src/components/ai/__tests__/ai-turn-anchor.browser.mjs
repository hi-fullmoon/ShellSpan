import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const document = await readFile(new URL('../../../../AGENTS.md', import.meta.url), 'utf8');
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `/tmp/shellspan-turn-anchor-${process.pid}`,
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__turn-anchor', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__turn-anchor',
    '<html><body><div id="root"></div><script type="module" src="/src/components/ai/__tests__/ai-turn-anchor.browser.tsx"></script></body></html>'));
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [360, 900]) for (const reducedMotion of ['no-preference', 'reduce']) {
        const page = await browser.newPage({ viewport: { width, height: 700 }, reducedMotion });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__turn-anchor`);
        await page.waitForFunction(() => Boolean(window.renderExistingComposer));
        await page.evaluate(() => window.renderExistingComposer());
        await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
        assert.ok(await page.locator('.ai-message-bubble-user').evaluateAll(elements =>
          elements.every(element => getComputedStyle(element).animationName === 'none')),
        'Committed history must not replay the send animation');
        const editor = page.locator('[contenteditable]');
        const viewport = page.locator('[data-message-scroller-viewport]');
        await editor.fill(document.split('\n').filter(Boolean).slice(0, 6).join('\n'));
        await viewport.focus();
        await page.keyboard.press('End');
        await viewport.hover();
        await page.mouse.wheel(0, -100);
        await page.waitForFunction(() => document.querySelector('[data-slot="message-scroller"]').dataset.following === 'false');
        await editor.focus();
        await page.evaluate(() => {
          window.submissionFrames = [];
          document.addEventListener('keydown', () => {
            let remaining = 20;
            const sample = () => {
              const viewport = document.querySelector('[data-message-scroller-viewport]');
              const content = document.querySelector('[data-slot="message-scroller-content"]');
              const bubble = [...content.querySelectorAll('.ai-message-bubble-user')].at(-1);
              window.submissionFrames.push({ top: viewport.scrollTop,
                end: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
                visibility: getComputedStyle(viewport.parentElement).visibility,
                opacity: getComputedStyle(content).opacity,
                anchors: content.querySelectorAll('[data-scroll-anchor="true"]').length,
                bubbleOpacity: Number(getComputedStyle(bubble).opacity), bubbleHeight: bubble.getBoundingClientRect().height });
              if (--remaining > 0) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          }, { once: true, capture: true });
        });
        await editor.press('Enter');
        await page.waitForFunction(() => window.submissionFrames.length === 20);
        const frames = await page.evaluate(() => window.submissionFrames);
        assert.ok(frames.every(frame => Math.abs(frame.bubbleHeight - frames[0].bubbleHeight) < 1),
          'The send animation must not change bubble layout');
        if (reducedMotion === 'reduce') assert.ok(frames.every(frame => frame.bubbleOpacity === 1));
        else assert.ok(frames.some(frame => frame.bubbleOpacity >= 0.35 && frame.bubbleOpacity < 1),
          'A newly submitted bubble must fade in');
        assert.equal(frames.at(-1).bubbleOpacity, 1);
        assert.ok(frames.every(frame => frame.visibility === 'visible' && frame.opacity === '1'
          && frame.anchors === 0 && frame.top >= -1 && frame.top <= frame.end + 1),
        `Submission must remain visible and inside its real scroll range: ${JSON.stringify(frames)}`);
        assert.ok(frames.every((frame, index) => index === 0
          || Math.abs(frame.end - frames[index - 1].end) > 1 || frame.top >= frames[index - 1].top - 1),
        `Submission must not reverse direction after its layout settles: ${JSON.stringify(frames)}`);
        await page.waitForFunction(() => {
          const viewport = document.querySelector('[data-message-scroller-viewport]');
          return document.querySelector('[contenteditable]').textContent === ''
            && viewport.parentElement.dataset.following === 'true'
            && Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop) <= 2;
        });
        assert.equal(await page.locator('[data-scroll-anchor="true"]').count(), 0,
          'Submitting a question must not top-align it');
        assert.equal(await page.locator('[data-message-scroller-spacer]').evaluate(element => getComputedStyle(element).display), 'none');
        assert.equal(await page.locator('[data-slot="message-scroller-content"]').evaluate(element => element.style.minHeight), '');
        await viewport.hover();
        const tail = await viewport.evaluate(element => element.scrollTop);
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(200);
        assert.ok(Math.abs(await viewport.evaluate(element => element.scrollTop) - tail) < 2,
          'The bottom must not expose additional empty scroll range');
        if (width === 900) {
          await page.reload();
          await page.waitForFunction(() => Boolean(window.recordedUserIndices));
          const receipt = await page.evaluate(async () => {
            const index = window.recordedUserIndices.at(-1);
            window.renderRecordedEvents(index, 'running', true);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const bubble = [...document.querySelectorAll('.ai-user-bubble-enter')].at(-1);
            if (!bubble) return { missing: true };
            const animation = bubble.getAnimations()[0];
            if (animation) { animation.pause(); animation.currentTime = 80; }
            const opacity = getComputedStyle(bubble).opacity;
            window.renderRecordedEvents(index + 1, 'running');
            const sameBubble = [...document.querySelectorAll('.ai-message-bubble-user')].at(-1) === bubble;
            const sameAnimation = bubble.getAnimations()[0] === animation;
            const sameOpacity = getComputedStyle(bubble).opacity === opacity;
            if (animation) animation.finish();
            window.renderRecordedEvents(index + 1, 'completed');
            return { sameBubble, sameAnimation, sameOpacity, settledOpacity: getComputedStyle(bubble).opacity,
              active: bubble.getAnimations().length };
          });
          assert.deepEqual(receipt, { sameBubble: true, sameAnimation: true, sameOpacity: true,
            settledOpacity: '1', active: 0 }, 'A real recorded receipt must preserve the bubble and animation timeline');
        }
        await page.close();
      }
    } finally { await browser.close(); }
  }
  console.log('New questions resume bottom following without top anchors or reserved space in Chromium and WebKit at 360px and 900px');
} finally { await server.close(); }
