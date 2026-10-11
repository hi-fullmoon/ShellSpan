import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { webkit } from 'playwright';

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
        import { AiWorkspaceErrorNotices } from '/src/components/ai/workspace/ai-workspace-error-notices.tsx';
        import { createAiComposerState, reduceAiComposer } from '/src/lib/ai/composer-machine.ts';
        import { initI18n } from '/src/locales/index.ts';
        import { useAppStore } from '/src/stores/appStore.ts';
        import '/src/styles/base.css';
        const locale = new URLSearchParams(location.search).get('locale');
        useAppStore.setState({ locale });
        await initI18n(locale);
        const started = reduceAiComposer(createAiComposerState({ draft: '帮我看看 nginx 状态' }), {
          type: 'submit.requested', gesture: 'keyboard', accelerated: false,
          clientOperationId: 'retry-review', now: Date.now(), hasProvider: true, canCreateSession: true,
        }).state;
        const failed = reduceAiComposer(started, {
          type: 'submit.failed', clientOperationId: 'retry-review',
          error: { kind: 'offline', message: 'Disconnected', retryable: true },
        }).state;
        createRoot(document.getElementById('root')).render(React.createElement(AiWorkspaceErrorNotices, {
          composerState: { ...failed, lastError: undefined },
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
  browser = await webkit.launch();
  const page = await browser.newPage();
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [1280, 400]) {
      await page.setViewportSize({ width, height: 400 });
      await page.goto(`${server.resolvedUrls.local[0]}retry-review?locale=${locale}`);
      const button = page.getByRole('button', { name: locale === 'zh-CN' ? '重试' : 'Retry', exact: true });
      await button.waitFor();
      const geometry = await button.evaluate(el => {
        const rect = el.getBoundingClientRect();
        const notice = el.closest('[data-ai-error-notice]').getBoundingClientRect();
        const style = getComputedStyle(el);
        return { height: rect.height, border: style.borderTopWidth,
          fits: rect.top >= notice.top && rect.bottom <= notice.bottom && rect.right <= notice.right,
          gap: style.columnGap, fontSize: style.fontSize,
          iconWidth: el.querySelector('svg').getBoundingClientRect().width,
          iconHeight: el.querySelector('svg').getBoundingClientRect().height };
      });
      assert.equal(geometry.height, 20);
      assert.equal(geometry.iconWidth, 10);
      assert.equal(geometry.iconHeight, 10);
      assert.equal(geometry.border, '0px');
      assert.equal(geometry.gap, '4px');
      assert.equal(geometry.fontSize, '10px');
      assert.equal(geometry.fits, true);
      await page.screenshot({ path: `/tmp/shellspan-retry-${locale}-${width}.png` });
      await button.focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('body').getAttribute('data-retried'), 'retry-review');
    }
  }
  console.log('Retry rendering and keyboard interaction passed at wide and narrow widths in both locales.');
} finally {
  await browser?.close();
  await server.close();
}
