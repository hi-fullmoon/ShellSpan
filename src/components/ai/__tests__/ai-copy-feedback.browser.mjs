import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = join(root, 'artifacts/tests/ai-copy-feedback');
await mkdir(output, { recursive: true });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(output, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } },
  optimizeDeps: {
    entries: ['src/components/ai/assistant-message-content.tsx', 'src/components/ai/chat-primitives.tsx', 'src/components/ai/workspace/ai-tool-presentation.tsx'],
    include: ['react', 'react-dom/client'],
  },
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  plugins: [tailwindcss(), {
    name: 'ai-copy-feedback-review',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell" style="padding:12px"></main></body></html>');
      });
    },
  }],
});
let browser;
let checks = 0;
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.SHELLSPAN_BROWSER_CHANNEL || 'chromium' });
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [320, 760]) {
      for (const theme of ['light', 'dark']) {
        const page = await browser.newPage({ viewport: { width, height: 640 }, permissions: ['clipboard-read', 'clipboard-write'], reducedMotion: 'reduce' });
        page.setDefaultTimeout(15_000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
        await page.evaluate(async ({ locale, theme }) => {
          const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
          await import('/src/styles/base.css');
          await import('/src/components/ai/styles/styles.css');
          const { MarkdownContent } = await import('/src/components/ai/assistant-message-content.tsx');
          const { MessageActions } = await import('/src/components/ai/chat-primitives.tsx');
          const { AiToolCopyButton } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
          const { TooltipProvider } = await import('/src/components/ui/tooltip.tsx');
          const { Toaster } = await import('/src/components/ui/sonner.tsx');
          const { initI18n, t } = await import('/src/locales/index.ts');
          const { useAppStore } = await import('/src/stores/appStore.ts');
          await initI18n(locale);
          useAppStore.setState({ locale, theme });
          document.documentElement.dataset.theme = theme;
          createRoot(document.getElementById('root')).render(React.createElement(TooltipProvider, null,
            React.createElement(MarkdownContent, {
              copyLabel: t('common.copy'), copiedLabel: t('common.copied'), showCodeBlockActions: true,
              children: '[Preview](https://example.com/preview)\n\n[Report](file:///C:/Users/example/report.txt)\n\n```sh\nprintf "hello world"\n```',
            }),
            React.createElement('section', { 'data-review': 'message' }, React.createElement(MessageActions, { text: 'Complete message\n第二行', align: 'start', reveal: 'always' })),
            React.createElement('section', { 'data-review': 'tool', className: 'ai-tool-content-region relative', 'data-ai-copy-region': '' },
              React.createElement('pre', { className: 'ai-content-code px-3.5 py-2' }, 'Complete tool output'),
              React.createElement(AiToolCopyButton, { text: 'Complete tool output' })),
            React.createElement(Toaster),
          ));
        }, { locale, theme });
        const copiedLabel = locale === 'zh-CN' ? '已复制' : 'Copied';
        await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
        const copyLabel = locale === 'zh-CN' ? '复制' : 'Copy';
        const expectClipboard = async expected => {
          assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), expected);
          assert.equal(await page.locator('[data-sonner-toast]').count(), 0, 'Copy success must not display a Toast.');
        };
        for (const [selector, expected] of [
          ['.ai-markdown-code-block', 'printf "hello world"'],
          ['[data-review="message"]', 'Complete message\n第二行'],
          ['[data-review="tool"]', 'Complete tool output'],
        ]) {
          const region = page.locator(selector);
          await region.hover();
          await region.getByRole('button', { name: copyLabel, exact: true }).click();
          const copied = region.getByRole('button', { name: copiedLabel, exact: true });
          await copied.waitFor();
          assert.equal(await copied.locator('.lucide-check').count(), 1);
          await expectClipboard(expected);
        }
        for (const [linkName, itemLabel, expected] of [
          ['Preview', locale === 'zh-CN' ? '复制链接地址' : 'Copy link address', 'https://example.com/preview'],
          ['Preview', locale === 'zh-CN' ? '复制链接文字' : 'Copy link text', 'Preview'],
          ['Report', locale === 'zh-CN' ? '复制路径' : 'Copy path', 'C:/Users/example/report.txt'],
        ]) {
          await page.getByRole('link', { name: linkName, exact: true }).click({ button: 'right' });
          const item = page.getByRole('menuitem', { name: itemLabel, exact: true });
          await item.waitFor();
          await page.getByRole('menu').evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
          const before = await page.getByRole('menu').boundingBox();
          await item.focus();
          await page.keyboard.press('Enter');
          const copied = page.getByRole('menuitem', { name: copiedLabel, exact: true });
          await copied.waitFor();
          assert.equal(await copied.locator('.lucide-check').count(), 1);
          assert.equal(await copied.evaluate(element => element === document.activeElement), true);
          const gap = await copied.evaluate(element => {
            const icon = element.querySelector('svg').getBoundingClientRect();
            const text = element.querySelector('span').getBoundingClientRect();
            return text.left - icon.right;
          });
          assert.ok(Math.abs(gap - 4) <= 0.5, `Menu icon/text gap must be 4px, got ${gap}.`);
          const after = await page.getByRole('menu').boundingBox();
          assert.ok(Math.abs(before.width - after.width) <= 0.5, `Feedback must preserve menu width: ${JSON.stringify({ locale, width, itemLabel, before, after })}`);
          assert.ok(after.x >= 0 && after.x + after.width <= width, 'Menu must fit inside the panel.');
          await expectClipboard(expected);
          await page.screenshot({ path: join(output, `${locale}-${width}-${theme}-${linkName}-${expected === 'Preview' ? 'text' : 'address'}.png`) });
          await page.keyboard.press('Escape');
          await page.getByRole('menu').waitFor({ state: 'hidden' });
        }
        assert.deepEqual(errors, []);
        checks++;
        await page.close();
      }
    }
  }
  console.log(`AI copy feedback passed ${checks} locale/width/theme combinations. Screenshots: ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
