import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const screenshots = join(tmpdir(), 'shellspan-question-queue-layout');
await mkdir(screenshots, { recursive: true });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'question-queue-layout',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><main id="root" class="ai-panel-shell @container/ai-workspace flex h-dvh flex-col justify-end" data-ai-scope="workbench"></main></body></html>');
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  for (const locale of ['zh-CN', 'en-US']) {
    for (const [width, height] of [[360, 600], [680, 910], [1100, 700]]) {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
      await page.evaluate(async (language) => {
        const { default: React } = await import('/node_modules/.vite/deps/react.js');
        const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
        await import('/src/styles/base.css');
        await import('/src/components/ai/styles/styles.css');
        const { AiComposerSeat } = await import('/src/components/ai/workspace/ai-composer-seat.tsx');
        const { initI18n } = await import('/src/locales/index.ts');
        const { useAppStore } = await import('/src/stores/appStore.ts');
        useAppStore.setState({ locale: language });
        await initI18n(language);
        // Reproduce the question and queued inputs from the user's screenshot,
        // rendering production components without replacing their dependencies.
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AiComposerSeat, {
          phase: 'active', status: 'waiting', modelLabel: 'MiniMax-M3',
          inbox: ['你好', 'hello'].map(content => ({ id: content, content, lane: 'nextTurn', state: 'queued', source: 'user' })),
          pendingQuestion: {
            identity: { sessionId: 'layout', turnId: 'turn', stepId: 'step', requestId: 'request', callId: 'call', questionRequestId: 'question' },
            questions: [{ id: 'nginx', header: 'Nginx 主题', question: '你想了解 nginx 的哪个方面？', multi_select: false,
              options: [
                { label: 'Nginx 入门介绍', description: '从零讲解 nginx 的核心概念、常用指令、配置文件结构' },
                { label: '结合上一轮购物车架构', description: '结合购物车系统，讲解 nginx 作为网关/反向代理/负载均衡的落地方案' },
                { label: '配置实践与最佳实践', description: '给出 nginx 的常用配置模板、反代、限流、缓存、动静分离等' },
                { label: '性能调优与高并发', description: '针对高并发电商场景讲 nginx 性能调优、连接池、内核参数等' },
              ],
            }],
            status: 'pending', answers: [], firstSeq: 1, lastSeq: 1, timestamp: '2026-09-27T00:00:00Z',
          },
        }));
      }, locale);
      const question = page.locator('[data-slot="ai-question-panel"]');
      const queue = page.locator('[data-slot="ai-queue-dock"]');
      const composer = page.locator('[data-composer-card]');
      await question.waitFor();
      const q = await question.boundingBox();
      const k = await queue.boundingBox();
      const c = await composer.boundingBox();
      assert.ok(q.y >= 0 && q.y + q.height + 6 <= k.y, 'Question must sit above the queue with a visible gap');
      assert.ok(k.y + k.height + 6 <= c.y, 'Queue must not overlap the composer');
      assert.equal(q.x, k.x);
      assert.equal(k.x, c.x);
      assert.equal(q.width, k.width);
      assert.equal(k.width, c.width);
      assert.ok(c.y + c.height <= height, 'Composer must remain in view');
      assert.ok(q.height <= Math.min(440, height * 0.4) + 1, 'Question must leave room for the conversation and input');
      const content = question.locator('.ai-question-panel-content');
      assert.equal(await content.evaluate(element => getComputedStyle(element).overflowY), 'auto');
      if (width === 360) {
        assert.ok(await content.evaluate(element => element.scrollHeight > element.clientHeight), 'Long question must scroll internally in the narrow panel');
      }
      const footer = question.locator('.ai-question-panel-footer');
      const before = await footer.boundingBox();
      await content.evaluate(element => { element.scrollTop = element.scrollHeight; });
      assert.deepEqual(await footer.boundingBox(), before, 'Question actions must remain fixed while answers scroll');
      await page.getByRole('button', { name: '性能调优与高并发', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: '性能调优与高并发', exact: true }).getAttribute('aria-pressed'), 'true');
      const queueHeader = queue.getByRole('button', { name: locale === 'zh-CN' ? '队列 · 2' : 'Queue · 2' });
      await queueHeader.focus();
      await page.keyboard.press('Enter');
      assert.equal(await queueHeader.getAttribute('aria-expanded'), 'false');
      await page.keyboard.press('Enter');
      assert.equal(await queueHeader.getAttribute('aria-expanded'), 'true');
      await content.evaluate(element => { element.scrollTop = 0; });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(screenshots, `${locale}-${width}.png`) });
      await page.close();
    }
  }
  console.log(`Question/queue layout, internal scrolling and keyboard checks passed. Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await server.close();
}
