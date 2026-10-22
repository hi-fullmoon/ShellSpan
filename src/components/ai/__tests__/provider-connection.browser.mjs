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
    name: 'provider-connection-review',
    resolveId(id) { if (id === '/provider-connection-entry') return id; },
    load(id) {
      if (id !== '/provider-connection-entry') return;
      return `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { ProviderSetupDialog } from '/src/components/ai/provider-setup-dialog.tsx';
        import { Toaster } from '/src/components/ui/sonner.tsx';
        import { initI18n } from '/src/locales/index.ts';
        import { useAppStore } from '/src/stores/appStore.ts';
        import { useAiSettingsStore } from '/src/stores/aiSettingsStore.ts';
        import { useToastStore } from '/src/stores/toastStore.ts';
        import '/src/styles/base.css';
        const locale = new URLSearchParams(location.search).get('locale');
        useAppStore.setState({ locale });
        await initI18n(locale);
        const preset = new URLSearchParams(location.search).get('preset') ?? 'ollama';
        const id = useAiSettingsStore.getState().addProvider(preset);
        const provider = useAiSettingsStore.getState().providers.find(item => item.id === id);
        window.readConnectionReview = () => ({
          settings: JSON.stringify(useAiSettingsStore.getState().providers),
          toasts: useToastStore.getState().toasts,
        });
        function Review() {
          const [open, setOpen] = React.useState(true);
          return React.createElement(React.Fragment, null,
            React.createElement(ProviderSetupDialog, {
              open, provider, onOpenChange: setOpen, onSaved: () => setOpen(false),
              onDelete: () => { useAiSettingsStore.getState().removeProvider(id); setOpen(false); },
            }),
            React.createElement(Toaster));
        }
        createRoot(document.getElementById('root')).render(
          React.createElement(React.StrictMode, null, React.createElement(Review)));
      `;
    },
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/provider-connection-review')) return next();
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html data-theme="light"><body><div id="root"></div><script type="module" src="/provider-connection-entry"></script></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0, forwardConsole: false },
});

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      for (const locale of ['zh-CN', 'en-US']) {
        for (const viewport of [{ width: 1280, height: 800 }, { width: 400, height: 520 }]) {
          await page.setViewportSize(viewport);
          await page.goto(`${server.resolvedUrls.local[0]}provider-connection-review?locale=${locale}`);
          const test = page.getByRole('button', { name: locale === 'zh-CN' ? '测试连接' : 'Test connection', exact: true });
          await test.waitFor();
          await page.locator('[data-slot="dialog-content"]').evaluate(element =>
            Promise.all(element.getAnimations().map(animation => animation.finished)));
          assert.equal(await test.isEnabled(), true, 'Ollama checks require no API key');
          assert.match(await test.getAttribute('title'), locale === 'zh-CN' ? /费用/ : /charge/);
          const geometry = await test.evaluate(button => {
            const footer = button.closest('[data-slot="dialog-footer"]');
            const dialog = button.closest('[data-slot="dialog-content"]');
            const buttons = [...button.parentElement.querySelectorAll('button')];
            return {
              footerBorder: getComputedStyle(footer).borderTopWidth,
              overflow: dialog.scrollWidth - dialog.clientWidth,
              footerControls: [...footer.querySelectorAll('button')].map(control => {
                const r = control.getBoundingClientRect();
                return { center: r.top + r.height / 2, left: r.left, right: r.right, label: control.textContent };
              }),
              controls: buttons.map(control => {
                const r = control.getBoundingClientRect();
                const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                return { height: r.height, visible: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
                  hittable: hit === control || control.contains(hit), label: control.textContent };
              }),
            };
          });
          assert.equal(geometry.controls.length, 3);
          assert.equal(geometry.footerControls.length, 4);
          const centers = geometry.footerControls.map(control => control.center);
          assert.ok(Math.max(...centers) - Math.min(...centers) <= 1, `footer actions must share one row: ${JSON.stringify(geometry)}`);
          assert.ok(geometry.footerControls.every(control => control.left >= 0 && control.right <= viewport.width), JSON.stringify(geometry));
          assert.equal(new Set(geometry.controls.map(control => control.height)).size, 1);
          assert.ok(geometry.controls.every(control => control.visible && control.hittable), JSON.stringify(geometry));
          assert.equal(geometry.footerBorder, '0px');
          assert.ok(geometry.overflow <= 1, JSON.stringify(geometry));
          await page.screenshot({ path: `/tmp/shellspan-provider-connection-${engine.name()}-${locale}-${viewport.width}.png` });

          // No IPC substitution: a plain browser really has no Tauri backend. The
          // failed start must persist inline and must never save the edited provider.
          const before = await page.evaluate(() => window.readConnectionReview().settings);
          await test.focus();
          await page.keyboard.press('Enter');
          const testFeedback = page.getByRole('alert');
          await testFeedback.waitFor();
          const after = await page.evaluate(() => window.readConnectionReview());
          assert.equal(after.settings, before);
          assert.equal(after.toasts.length, 0, 'inline results must not also create a Toast');
          assert.equal(await testFeedback.innerText(), locale === 'zh-CN' ? '连接测试失败' : 'Connection test failed');
          const details = testFeedback.getByRole('button');
          assert.match(await details.getAttribute('aria-label'), locale === 'zh-CN' ? /桌面应用/ : /desktop app/);
          await details.hover();
          const tooltip = page.locator('[data-slot="tooltip-content"]');
          await tooltip.waitFor();
          assert.match(await tooltip.innerText(), locale === 'zh-CN' ? /桌面应用/ : /desktop app/);
          await test.hover();
          assert.equal(await test.isEnabled(), true);
          await page.screenshot({ path: `/tmp/shellspan-provider-test-result-${engine.name()}-${locale}-${viewport.width}.png` });
          await page.getByRole('button', { name: locale === 'zh-CN' ? '保存' : 'Save', exact: true }).click();
          await page.locator('[role="alert"]').waitFor();
          const overlaps = await page.locator('[data-slot="dialog-footer"]').evaluate(footer => {
            const regions = [...footer.children].map(child => child.getBoundingClientRect());
            const first = footer.firstElementChild;
            const last = regions[1];
            return [...first.children].some(child => child.getBoundingClientRect().right > last.left);
          });
          assert.equal(overlaps, false, 'inline feedback must not overlap the action buttons');
          const feedbackFits = await page.locator('[role="alert"]').evaluate(element => {
            const bounds = element.getBoundingClientRect();
            const actions = element.closest('[data-slot="dialog-footer"]').lastElementChild.getBoundingClientRect();
            return Math.abs((bounds.top + bounds.bottom - actions.top - actions.bottom) / 2) <= 1
              && bounds.bottom <= innerHeight && bounds.width > 0;
          });
          assert.equal(feedbackFits, true, 'feedback must remain visible on the action row');
          await page.screenshot({ path: `/tmp/shellspan-provider-feedback-${engine.name()}-${locale}-${viewport.width}.png` });
          const cancel = page.getByRole('button', { name: locale === 'zh-CN' ? '取消' : 'Cancel', exact: true });
          await cancel.click();
          await page.locator('[data-slot="dialog-content"]').waitFor({ state: 'hidden' });
        }
      }
      await page.setViewportSize({ width: 400, height: 520 });
      await page.goto(`${server.resolvedUrls.local[0]}provider-connection-review?locale=zh-CN&preset=openai`);
      const requiresKey = page.getByRole('button', { name: '测试连接', exact: true });
      await requiresKey.waitFor();
      assert.equal(await requiresKey.isDisabled(), true, 'cloud provider checks require a key');
      assert.equal(await page.locator('input[type="password"]').count(), 1);
      await page.locator('[data-slot="dialog-content"]').evaluate(element =>
        Promise.all(element.getAnimations().map(animation => animation.finished)));
      await page.screenshot({ path: `/tmp/shellspan-provider-connection-${engine.name()}-cloud-400.png` });
      // Render the reported OpenRouter failure through the real feedback/Toast
      // components; this does not replace or intercept any service request.
      await page.evaluate(async () => {
        const { connectionTestFailureKey } = await import('/src/components/ai/provider-setup-dialog.tsx');
        const { t } = await import('/src/locales/index.ts');
        const { useToastStore } = await import('/src/stores/toastStore.ts');
        const key = connectionTestFailureKey({ type: 'failed', kind: 'terminal', status: 404 }, 'openrouter');
        useToastStore.getState().addToast(t('settings.ai.testConnectionHttpError', {
          status: 404,
          reason: t(key, { model: 'apodex/apodex-1.1-mini:free' }),
        }), 'error', 6000);
      });
      const unavailable = page.locator('[data-sonner-toast]').filter({ hasText: 'apodex/apodex-1.1-mini:free' });
      await unavailable.waitFor();
      assert.match(await unavailable.innerText(), /没有可用节点/);
      const toastBounds = await unavailable.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, bottom: bounds.bottom,
          overflow: element.scrollWidth - element.clientWidth };
      });
      assert.ok(toastBounds.left >= 0 && toastBounds.right <= 400 && toastBounds.bottom <= 520);
      assert.ok(toastBounds.overflow <= 1, JSON.stringify(toastBounds));
      await page.screenshot({ path: `/tmp/shellspan-provider-connection-${engine.name()}-openrouter-404.png` });
    } finally {
      await browser.close();
    }
  }
  console.log('Provider connection controls passed in Chromium and WebKit at wide/narrow sizes in both locales; real missing-backend errors persist inline without duplicate Toasts or saving.');
} finally {
  await server.close();
}
