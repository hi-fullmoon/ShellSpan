import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

// Real browser layout: no substituted scroll metrics, observers, or timers.
// Run with node src/components/ai/__tests__/composer-scroll.browser.mjs.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  resolve: { alias: { '@': `${root}src` } },
  plugins: [tailwindcss(), {
    name: 'composer-scroll-browser-test',
    resolveId(id) {
      if (id === '/scroll-test-runtime.js') return id;
    },
    load(id) {
      if (id === '/scroll-test-runtime.js') return `
        export { default as React } from 'react';
        export { createRoot } from 'react-dom/client';
        export { MessageScroller } from '/src/components/ai/chat-primitives.tsx';
      `;
    },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><div id="root"></div></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
});

try {
  await server.listen();
  const address = server.httpServer.address();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const width of [400, 1000]) {
        const page = await browser.newPage({ viewport: { width, height: 720 } });
        await page.goto(`http://127.0.0.1:${address.port}/`);
        await page.evaluate(async () => {
          await import('/src/styles/base.css');
          const { React, createRoot, MessageScroller } = await import('/scroll-test-runtime.js');
          const { createElement: h, useState } = React;
          function Conversation() {
            const [messages, setMessages] = useState([]);
            const [draft, setDraft] = useState('');
            return h('main', { style: { height: '100vh', display: 'flex', flexDirection: 'column' } },
              h(MessageScroller, {
                followKey: String(messages.length),
                scrollToBottomKeys: messages.map((_, index) => String(index)),
                className: 'min-h-0 flex-1',
              }, messages.map((text, index) => h('p', {
                key: index, 'data-ai-node-key': String(index),
                style: { whiteSpace: 'pre-wrap' },
              }, text))),
              h('textarea', {
                'aria-label': 'Message', value: draft,
                style: { flexShrink: 0, height: draft ? 180 : 40 },
                onChange: event => setDraft(event.target.value),
                onKeyDown: event => {
                  if (event.key !== 'Enter' || event.shiftKey) return;
                  event.preventDefault();
                  setMessages(current => [...current, draft]);
                  setDraft('');
                },
              }));
          }
          createRoot(document.getElementById('root')).render(h(Conversation));
        });
        const input = page.getByRole('textbox', { name: 'Message' });
        const viewport = page.locator('[data-message-scroller-viewport]');
        for (let index = 0; index < 8; index++) {
          await input.fill(`Message ${index}\n` + 'A multiline message that wraps in a narrow panel. '.repeat(30));
          await input.press('Enter');
        }
        await viewport.hover();
        await page.mouse.wheel(0, -800);
        await page.waitForFunction(() => {
          const element = document.querySelector('[data-message-scroller-viewport]');
          return element.scrollHeight - element.clientHeight - element.scrollTop > 100;
        });
        await input.fill('Send from above the bottom\n' + 'More text\n'.repeat(8));
        await input.press('Enter');
        await page.waitForFunction(() => {
          const element = document.querySelector('[data-message-scroller-viewport]');
          return Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1;
        });
        assert.equal(await input.inputValue(), '');
        await viewport.hover();
        await page.mouse.wheel(0, -600);
        await page.waitForFunction(() => {
          const element = document.querySelector('[data-message-scroller-viewport]');
          return element.scrollHeight - element.clientHeight - element.scrollTop > 100;
        });
        console.log(`${engine.name()} ${width}px: Enter follows the bottom; upward scrolling remains available`);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
