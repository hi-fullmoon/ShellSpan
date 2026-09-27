import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

// Supply an actual runtime JSONL log. No generated events or geometry stubs.
const events = (await readFile(process.argv[2], 'utf8')).trim().split('\n').map(JSON.parse);
assert.ok(events.some(event => event.type === 'turn/end'), 'A completed real session is required');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } }, plugins: [react(), tailwindcss(), {
    name: 'turn-completion-replay',
    resolveId: id => id === '/completion-entry.tsx' ? id : undefined,
    load(id) {
      if (id !== '/completion-entry.tsx') return;
      return `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { AiConversation } from '/src/components/ai/workspace/ai-conversation';
        import { projectAgentChatNodes } from '/src/lib/ai/conversation-projection';
        import { initI18n } from '/src/locales';
        import '/src/styles/base.css';
        import '/src/components/ai/styles/styles.css';
        await initI18n('zh-CN');
        const root = createRoot(document.getElementById('root'));
        window.replay = (events, status, pending = false) => {
          const nodes = projectAgentChatNodes(events);
          flushSync(() => root.render(<main className="ai-panel-shell flex h-dvh min-h-0 flex-col">
            <AiConversation nodes={nodes} status={status} pending={pending} throughSeq={events.at(-1)?.seq ?? null} />
          </main>));
          return nodes.filter(node => node.kind === 'userMessage').at(-1)?.key;
        };
      `;
    },
  }], server: { host: '127.0.0.1', port: 0 } });
server.middlewares.use('/', async (request, response, next) => {
  if (request.url !== '/') return next();
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/', '<html><body><div id="root"></div><script type="module" src="/completion-entry.tsx"></script></body></html>'));
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [420, 900]) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'no-preference' });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
        await page.waitForFunction(() => Boolean(window.replay));
        const failures = await page.evaluate(async events => {
          const failures = [];
          const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
          let status = 'idle';
          for (let index = 0; index < events.length; index++) {
            const event = events[index];
            if (event.type === 'turn/start') status = 'running';
            if (event.type === 'agent/status') status = event.data.status;
            const previousUser = [...document.querySelectorAll('[data-ai-node-kind="userMessage"]')].at(-1);
            const before = previousUser?.getBoundingClientRect().top;
            const key = window.replay(events.slice(0, index + 1), status);
            if (key && previousUser?.dataset.aiNodeKey !== key) {
              // Submission scrolling is intentional. Let it settle before
              // measuring subsequent completion events.
              await new Promise(resolve => setTimeout(resolve, 1300));
            }
            for (let tick = 0; tick < 5; tick++) {
              await frame();
              const user = [...document.querySelectorAll('[data-ai-node-key]')].find(node => node.dataset.aiNodeKey === key);
              const delta = user && before !== undefined ? user.getBoundingClientRect().top - before : 0;
              // turn/end adds the final footer. Other completion events must
              // not add or remove temporary rows around that persistent row.
              if (['assistant/message', 'agent/status'].includes(event.type)
                && previousUser === user && Math.abs(delta) > 2) {
                failures.push({ seq: event.seq, type: event.type, tick, delta });
              }
            }
            if (status === 'running' && document.querySelector('[data-ai-running-indicator]')) {
              failures.push({ seq: event.seq, reason: 'processing row is still rendered' });
            }
            if (event.type === 'turn/end') {
              if (document.querySelector('[data-ai-running-indicator]')) failures.push({ seq: event.seq, reason: 'stale running indicator' });
              if (document.querySelector('.ai-assistant-actions')) failures.push({ seq: event.seq, reason: 'temporary message actions' });
            }
          }
          // Pending submissions retain the generating button, without adding
          // a processing row to the transcript.
          window.replay(events, 'running', true);
          if (document.querySelector('[data-ai-running-indicator]')) failures.push({ reason: 'pending processing row' });
          if (!document.querySelector('[data-slot="message-scroller-button"] [data-slot="spinner"]')) failures.push({ reason: 'missing generating spinner' });
          window.replay(events, 'idle');
          return failures;
        }, events);
        assert.deepEqual(failures, [], `${engine.name()} ${width}: completion must not introduce temporary rows or scroll jumps`);
        await page.screenshot({ path: `/tmp/shellspan-completion-${engine.name()}-${width}.png` });
        // Read older content while the final turn is still completing.
        const end = events.map(event => event.type).lastIndexOf('turn/end');
        await page.setViewportSize({ width, height: 400 });
        await page.evaluate(events => window.replay(events, 'running'), events.slice(0, end));
        const viewport = page.locator('[data-message-scroller-viewport]');
        await viewport.focus();
        await page.keyboard.press('Home');
        await page.waitForTimeout(300);
        const reading = await viewport.evaluate(element => element.scrollTop);
        await page.evaluate(events => window.replay(events, 'running'), events.slice(0, end + 1));
        await page.waitForTimeout(150);
        assert.equal(await viewport.evaluate(element => element.scrollTop), reading, 'Completion must preserve the history reading position');
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  }
  console.log('Real-session completion passed in Chromium and WebKit at 420px and 900px');
} finally { await server.close(); }
