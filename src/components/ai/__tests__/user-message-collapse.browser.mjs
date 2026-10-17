import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const lines = (await readFile(`${root}package.json`, 'utf8')).split('\n').slice(0, 4);
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src/` } },
  server: { host: '127.0.0.1', port: 0 } });
server.middlewares.use(async (request, response, next) => {
  if (request.url !== '/') return next();
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/', '<!doctype html><html><body><div id="root"></div></body></html>'));
});
await server.listen();
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(server.resolvedUrls.local[0]);
      await page.evaluate(async () => {
        const { default: React } = await import('/@id/react');
        const { default: ReactDOM } = await import('/@id/react-dom/client');
        const { AiUserMessageText } = await import('/src/components/ai/workspace/ai-user-message-text.tsx');
        const { Message, Bubble } = await import('/src/components/ai/chat-primitives.tsx');
        const { aiConversationNodeRenderers } = await import('/src/components/ai/workspace/ai-conversation-node-seat.tsx');
        const { encodeDocumentMessage } = await import('/src/lib/ai/document-message.ts');
        const { initI18n } = await import('/src/locales/index.ts');
        const { useAppStore } = await import('/src/stores/appStore.ts');
        await import('/src/styles/base.css');
        await import('/src/components/ai/styles/styles.css');
        const root = ReactDOM.createRoot(document.getElementById('root'));
        window.showMessage = async (text, locale, chat = false) => {
          await initI18n(locale);
          useAppStore.setState({ locale });
          const h = React.createElement;
          root.render(h('main', { className: 'ai-panel-shell p-4', style: { width: 900 } }, chat ?
            h(aiConversationNodeRenderers.userMessage, { node: {
              kind: 'userMessage', key: 'message', sourceKind: 'agent', sessionId: 'session',
              turnId: 'turn', stepId: null, firstSeq: 1, lastSeq: 1, timestamp: '2026-10-17T00:00:00Z',
              messageId: 'message', delivery: 'committed', content: encodeDocumentMessage(text, [
                { id: 'file', name: 'package.json', text, size: new Blob([text]).size },
                { id: 'chat', name: 'conversation.md', text, size: new Blob([text]).size, chatTitle: '了解AI助手功能' },
              ]),
            } }) :
            h(Message, { role: 'user' }, h(Bubble, { role: 'user' },
              h(AiUserMessageText, { key: text, text })))));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        };
      });
      for (const locale of ['zh-CN', 'en-US']) {
        const expand = locale === 'zh-CN' ? '展开' : 'Show more';
        const collapse = locale === 'zh-CN' ? '收起' : 'Show less';
        await page.evaluate(({ lines, locale }) => window.showMessage(lines.slice(0, 3).join('\n'), locale), { lines, locale });
        const text = page.locator('.ai-user-message-text');
        await text.waitFor();
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.getByRole('button', { name: expand, exact: true }).count(), 0, 'Exactly three lines remain fully visible');

        const fullText = lines.join('\n');
        await page.evaluate(({ text, locale }) => window.showMessage(text, locale), { text: fullText, locale });
        const toggle = page.getByRole('button', { name: expand, exact: true });
        await toggle.waitFor();
        assert.deepEqual(await toggle.evaluate(element => {
          const style = getComputedStyle(element);
          return [style.height, style.paddingRight, style.paddingLeft, style.borderTopWidth, style.textDecorationLine];
        }), ['24px', '0px', '0px', '0px', 'underline'], 'Expand and collapse controls remain borderless with a persistent link affordance');
        assert.notEqual(await toggle.evaluate(element => getComputedStyle(element).color),
          await text.evaluate(element => getComputedStyle(element).color), 'Action color distinguishes the toggle from message text');
        assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
        const clampedHeight = (await text.boundingBox()).height;
        assert.equal(await text.textContent(), fullText, 'Clamping preserves the complete original text');
        assert.equal(clampedHeight, 66, 'Collapsed text occupies exactly three 22px lines');
        await toggle.focus();
        await page.keyboard.press('Enter');
        await page.getByRole('button', { name: collapse, exact: true }).waitFor();
        assert.ok((await text.boundingBox()).height > clampedHeight, 'Keyboard expansion exposes the entire question');
        await page.getByRole('button', { name: collapse, exact: true }).click();
        assert.equal((await text.boundingBox()).height, clampedHeight);

        // A single long line must also collapse after wrapping in a narrow pane.
        const wrapped = lines.join(' ').repeat(3);
        await page.evaluate(({ text, locale }) => window.showMessage(text, locale), { text: wrapped, locale });
        await page.locator('main').evaluate(element => { element.style.width = '280px'; });
        await page.getByRole('button', { name: expand, exact: true }).waitFor();
        assert.equal((await text.boundingBox()).height, 66);
        await page.mouse.move(0, 0);
        await page.locator('main').screenshot({ path: `/tmp/shellspan-user-message-${engine.name()}-${locale}.png` });
        await page.getByRole('button', { name: expand, exact: true }).hover();
        await page.getByRole('button', { name: expand, exact: true }).evaluate(async element => {
          await Promise.all(element.getAnimations().map(animation => animation.finished));
        });
        assert.equal(await page.getByRole('button', { name: expand, exact: true }).evaluate(element =>
          getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)', 'Hover keeps the link background transparent');
        assert.ok(await page.getByRole('button', { name: expand, exact: true }).evaluate(element => {
          const style = getComputedStyle(element);
          return style.borderTopWidth === '0px' && style.textDecorationLine === 'underline';
        }), 'Hover preserves the borderless underlined action');
        await page.locator('main').screenshot({ path: `/tmp/shellspan-user-message-hover-${engine.name()}-${locale}.png` });
        await page.mouse.move(0, 0);
        await page.locator('main').evaluate(element => { element.style.width = '900px'; });
        await page.waitForFunction(() => !document.querySelector('button[aria-expanded]'));
      }
      const question = '了解AI助手功能 会话主要说明了什么';
      await page.evaluate(text => window.showMessage(text, 'zh-CN', true), question);
      await page.locator('.ai-chat-reference').waitFor();
      for (const width of [614, 320]) {
        await page.locator('main').evaluate((element, width) => { element.style.width = `${width}px`; }, width);
        const bubble = page.locator('.ai-message-bubble-content');
        assert.equal(await page.locator('.ai-user-message-text').textContent(), question);
        assert.deepEqual(await bubble.evaluate(element => {
          const style = getComputedStyle(element);
          return [style.fontSize, style.borderRadius, style.padding];
        }), ['14px', '22px', '10px 16px']);
        assert.equal(await page.locator('.ai-chat-reference [data-slot="attachment-title"]').evaluate(element => getComputedStyle(element).fontSize), '14px');
        assert.equal(await page.locator('.ai-chat-reference [data-slot="attachment-title"]').evaluate(element => getComputedStyle(element).fontWeight), '400', 'Chat reference titles use regular weight');
        const reference = await page.locator('.ai-chat-reference').boundingBox();
        const file = await page.locator('[data-document-name="package.json"]').boundingBox();
        assert.ok(reference.y >= file.y + file.height + 5, 'References occupy their own row below attachments');
        const bounds = await bubble.boundingBox();
        assert.ok(Math.abs(reference.x + reference.width - bounds.x - bounds.width) < 1, 'Reference and message align on the right');
        assert.equal(bounds.y - reference.y - reference.height, 6);
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'Message stays within the narrow pane');
        await page.locator('main').screenshot({ path: `/tmp/shellspan-chat-reference-${engine.name()}-${width}.png` });
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
