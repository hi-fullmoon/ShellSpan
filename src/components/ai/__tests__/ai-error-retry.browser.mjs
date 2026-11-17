import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = path.resolve(import.meta.dirname, '../../../..');
const server = await createServer({
  root, configFile: false, logLevel: 'error',
  resolve: { alias: { '@': path.join(root, 'src') } },
  plugins: [tailwindcss(), {
    name: 'retry-review',
    resolveId(id) { if (id === '/retry-entry') return id; },
    load(id) {
      if (id !== '/retry-entry') return;
      return `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { AiFailedDraftRecovery } from '/src/components/ai/workspace/ai-failed-draft-recovery.tsx';
        import { createAiComposerState, reduceAiComposer } from '/src/lib/ai/composer-machine.ts';
        import { AiPreparationTimeoutError, normalizeAiSessionError } from '/src/lib/ai/session-error.ts';
        import { initI18n } from '/src/locales/index.ts';
        import { useAppStore } from '/src/stores/appStore.ts';
        import '/src/styles/base.css';
        import '/src/components/ai/styles/styles.css';
        const locale = new URLSearchParams(location.search).get('locale');
        useAppStore.setState({ locale });
        await initI18n(locale);
        const started = reduceAiComposer(createAiComposerState({ draft: '帮我看看 nginx 状态' }), {
          type: 'submit.requested', gesture: 'keyboard', accelerated: false,
          clientOperationId: 'retry-review', now: Date.now(), hasProvider: true, canCreateSession: true,
        }).state;
        const failed = reduceAiComposer(started, {
          type: 'submit.failed', clientOperationId: 'retry-review',
          error: normalizeAiSessionError(new AiPreparationTimeoutError()),
        }).state;
        document.getElementById('root').className = 'ai-panel-shell';
        createRoot(document.getElementById('root')).render(React.createElement(AiFailedDraftRecovery, {
          composerState: failed,
          failed: failed.failedDrafts[0],
          onRetryFailedDraft: id => { document.body.dataset.retried = id; },
        }));
      `;
    },
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/retry-review')) return next();
        res.setHeader('Content-Type', 'text/html');
        res.end('<html data-theme="light"><body><div id="root"></div><script type="module" src="/retry-entry"></script></body></html>');
      });
    },
  }], server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
  browser = await engine.launch();
  const page = await browser.newPage();
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [1280, 400, 240]) {
      await page.setViewportSize({ width, height: 400 });
      await page.goto(`${server.resolvedUrls.local[0]}retry-review?locale=${locale}`);
      const button = page.getByRole('button', { name: locale === 'zh-CN' ? '重试' : 'Retry', exact: true });
      await button.waitFor();
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await button.innerText(), locale === 'zh-CN' ? '重试' : 'Retry');
      assert.equal(await button.locator('svg').count(), 0);
      const details = page.locator('[data-ai-failed-details]');
      await details.hover();
      await page.getByRole('tooltip').waitFor();
      assert.equal(await page.getByText(locale === 'zh-CN'
        ? '消息准备超时，尚未发送。请检查终端连接后重试。'
        : 'Message preparation timed out before sending. Check the terminal connection and retry.', { exact: true }).count(), 1);
      await page.mouse.move(0, 0);
      await page.keyboard.press('Escape');
      const geometry = await button.evaluate(el => {
        const rect = el.getBoundingClientRect();
        const notice = el.closest('[data-ai-failed-draft]').getBoundingClientRect();
        const style = getComputedStyle(el);
        return { height: rect.height, border: style.borderTopWidth,
          fits: rect.top >= notice.top && rect.bottom <= notice.bottom && rect.right <= notice.right,
          padding: style.padding, margin: style.margin, background: style.backgroundColor,
          icon: (() => {
            const icon = el.closest('[data-ai-failed-draft]').querySelector(':scope > svg').getBoundingClientRect();
            const copy = el.closest('[data-ai-failed-draft]').querySelector(':scope > div');
            const text = copy.getBoundingClientRect();
            return { center: icon.y + icon.height / 2, textCenter: text.y + text.height / 2 };
          })() };
      });
      assert.equal(geometry.height, 24);
      assert.ok(Math.abs(geometry.icon.center - geometry.icon.textCenter) < 0.1, JSON.stringify(geometry));
      assert.equal(geometry.border, '0px');
      assert.equal(geometry.padding, '0px');
      assert.equal(geometry.margin, '0px');
      assert.equal(geometry.background, 'rgba(0, 0, 0, 0)');
      assert.equal(geometry.fits, true);
      await page.screenshot({ path: `/tmp/shellspan-retry-${engine.name()}-${locale}-${width}.png` });
      await button.focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('body').getAttribute('data-retried'), 'retry-review');
    }
  }
  await browser.close();
  }
  console.log('Retry rendering and keyboard interaction passed at wide and narrow widths in both locales.');
} finally {
  await browser?.close();
  await server.close();
}
