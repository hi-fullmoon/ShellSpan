import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

// Read a local runtime capture without copying private conversations into the repo.
let events = (await readFile(process.argv[2], 'utf8')).trim().split('\n').map(JSON.parse);
if (process.argv.includes('--first-two-turns')) {
  const ends = events.flatMap((event, index) => event.type === 'turn/end' ? [index] : []);
  assert.ok(ends.length >= 2, 'Two recorded completed turns are required');
  events = events.slice(0, ends[1] + 2);
}
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `/tmp/shellspan-runtime-scroll-${process.pid}`,
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__runtime-scroll', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__runtime-scroll',
    '<html><body><div id="root"></div><script type="module" src="/src/components/ai/__tests__/runtime-scroll-replay.browser.tsx"></script></body></html>'));
});
try {
  await server.listen();
  for (const engine of process.argv.includes('--chromium-only') ? [chromium] : [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of process.argv.includes('--chromium-only') ? [615] : [615, 900]) {
        const page = await browser.newPage({ viewport: { width, height: 910 }, reducedMotion: 'reduce' });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__runtime-scroll`);
        await page.waitForFunction(() => Boolean(window.initializeRuntimeReplay));
        await page.evaluate(({ recorded, workspace }) => window.initializeRuntimeReplay(recorded, workspace),
          { recorded: events, workspace: process.argv.includes('--workspace') });
        const lastUser = events.filter(event => event.type === 'user/message' && event.data.message.source.kind === 'user' && event.data.message.clientSubmissionId)[1];
        if (process.argv.includes('--select-before-followup')) assert.ok(lastUser, 'A second recorded user question is required');
        const selectionIndex = process.argv.includes('--select-before-followup')
          ? events.findIndex(event => event.type === 'agent/inbox/spliced' && event.data.operation === 'enqueued'
            && event.data.messages.some(message => message.messageId === lastUser.data.message.messageId)) : -1;
        if (process.argv.includes('--select-before-followup')) assert.ok(selectionIndex >= 0, 'A captured follow-up submission is required');
        const results = await page.evaluate(async ({ count, selectionIndex }) => {
          const failures = [];
          let followed = false;
          let selectedMode;
          let selectedAnchor;
          for (let index = 0; index < count; index++) {
            if (index === selectionIndex) {
              const message = [...document.querySelectorAll('[data-ai-node-kind="assistantMessage"]')].at(-1);
              const text = document.createTreeWalker(message, NodeFilter.SHOW_TEXT).nextNode();
              const range = document.createRange();
              range.setStart(text, 0);
              range.setEnd(text, Math.min(10, text.length));
              window.getSelection().removeAllRanges();
              window.getSelection().addRange(range);
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              selectedMode = document.querySelector('[data-slot="message-scroller"]').dataset.scrollMode;
              selectedAnchor = [...document.querySelectorAll('[data-ai-node-kind="userMessage"]')].at(-1)?.closest('[data-message-id]')?.dataset.messageId;
            }
            window.replayUntil(index + 1);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const viewport = document.querySelector('[data-message-scroller-viewport]');
            const content = document.querySelector('[data-slot="message-scroller-content"]');
            if (!viewport || !content) continue;
            const anchor = [...content.querySelectorAll('[data-ai-node-kind="userMessage"]')].at(-1)?.closest('[data-message-id]');
            const last = content.querySelector('[data-message-scroller-spacer]').previousElementSibling;
            const mode = viewport.parentElement.dataset.scrollMode;
            if (mode === 'following' && anchor) followed = true;
            if (!anchor || !last) continue;
            const style = getComputedStyle(content);
            const height = last.getBoundingClientRect().bottom - anchor.getBoundingClientRect().top
              + (parseFloat(style.paddingBlockStart) || 0) + (parseFloat(style.paddingBlockEnd) || 0);
            const gap = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
            if (mode === 'reading' && anchor.dataset.messageId !== selectedAnchor && failures.length < 4) {
              failures.push({ index, mode, reason: 'New questions must not inherit the previous reading pause' });
            }
            const spacer = content.querySelector('[data-message-scroller-spacer]');
            if ((content.querySelector('[data-scroll-anchor="true"]') || getComputedStyle(spacer).display !== 'none') && failures.length < 4) {
              failures.push({ index, mode, reason: 'Questions must not create top anchors or reserved space' });
            }
            if (height >= viewport.clientHeight && (mode !== 'following' || gap > 8) && failures.length < 4) {
              failures.push({ index, mode, height, viewport: viewport.clientHeight, top: viewport.scrollTop, gap });
            }
          }
          return { failures, followed, selectedMode };
        }, { count: events.length, selectionIndex });
        assert.ok(results.followed, `${engine.name()} ${width}: a recorded answer must enter following mode`);
        if (selectionIndex >= 0) assert.equal(results.selectedMode, 'reading', 'Selecting the previous answer must pause following before the new submission');
        assert.deepEqual(results.failures, [], `${engine.name()} ${width}: uninterrupted real output must follow`);
        await page.close();
      }
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
