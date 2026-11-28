import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const artifacts = `${root}artifacts/tests/composer-toolbar-hover`;
await mkdir(artifacts, { recursive: true });
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `${artifacts}/vite`,
  optimizeDeps: {
    entries: ['src/components/ai/workspace/ai-composer-seat.tsx', 'src/components/ai/agent-permission-selector.tsx',
      'src/components/ai/agent-execution-surface-selector.tsx', 'src/components/ui/button.tsx'],
    include: ['react', 'react-dom/client'],
  },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use(async (request, response, next) => {
  if (request.url !== '/') return next();
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/', '<!doctype html><html><body><div id="root"></div></body></html>'));
});

const background = locator => locator.evaluate(element => getComputedStyle(element).backgroundColor);
const tokenBackground = (locator, token) => locator.evaluate((element, token) => {
  const probe = document.createElement('span');
  probe.style.backgroundColor = `var(${token})`;
  element.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
}, token);
const settle = locator => locator.evaluate(element => Promise.all(
  element.getAnimations().map(animation => animation.finished),
));

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      for (const locale of ['zh-CN', 'en-US']) {
        await page.goto(server.resolvedUrls.local[0]);
        await page.evaluate(async locale => {
          const { default: React } = await import('/@id/react');
          const { default: ReactDOM } = await import('/@id/react-dom/client');
          const { AiComposerSeat } = await import('/src/components/ai/workspace/ai-composer-seat.tsx');
          const { AgentExecutionSurfaceSelector } = await import('/src/components/ai/agent-execution-surface-selector.tsx');
          const { AgentPermissionSelector } = await import('/src/components/ai/agent-permission-selector.tsx');
          const { Button } = await import('/src/components/ui/button.tsx');
          const { initI18n } = await import('/src/locales/index.ts');
          const { useAppStore } = await import('/src/stores/appStore.ts');
          await import('/src/styles/base.css');
          await import('/src/components/ai/styles/styles.css');
          await initI18n(locale);
          useAppStore.setState({ locale });
          const h = React.createElement;
          ReactDOM.createRoot(document.getElementById('root')).render(h('main', {
            className: 'ai-panel-shell @container/ai-workspace p-4',
          }, h(Button, { variant: 'ghost', 'data-testid': 'outside' }, 'Model'),
          h(AiComposerSeat, {
            phase: 'active', status: 'running', modelLabel: 'Model',
            onOpenModel: () => { document.documentElement.dataset.modelOpened = 'true'; },
            permissionControl: h(AgentPermissionSelector, {
              sessionId: '', mode: 'fullAccess', variant: 'composer',
            }),
            executionSurfaceControl: h(AgentExecutionSurfaceSelector, { surface: 'direct' }),
            contextUsage: { source: 'pending', usedTokens: null, contextWindow: 128_000 },
          })));
        }, locale);
        const toolbar = page.locator('.ai-composer-toolbar');
        await toolbar.waitFor();
        for (const theme of ['light', 'dark']) {
          await page.evaluate(async theme => (await import('/src/lib/theme.ts')).applyTheme(theme), theme);
          for (const width of [760, 360]) {
            await page.setViewportSize({ width, height: 400 });
            const controls = toolbar.locator([
              '.ai-composer-add', '.ai-execution-surface-trigger', '.ai-model-trigger',
              '.ai-context-meter-trigger',
            ].join(', '));
            assert.equal(await controls.count(), 4);
            const expected = await tokenBackground(toolbar, '--accent');
            for (const control of await controls.all()) {
              assert.ok(await control.getAttribute('aria-label'), 'Toolbar actions retain readable labels');
              const before = await control.boundingBox();
              await control.hover();
              await settle(control);
              assert.equal(await background(control), expected,
                `${engine.name()}/${locale}/${theme}/${width}: ${await control.getAttribute('class')}`);
              assert.deepEqual(await control.boundingBox(), before, 'Hover preserves control dimensions and placement');
            }
            const permission = toolbar.locator('.ai-permission-trigger');
            assert.equal(await permission.isDisabled(), true, 'An unconnected terminal cannot change permissions');
            assert.equal(await background(permission), 'rgba(0, 0, 0, 0)', 'Disabled actions retain a transparent background');
            assert.equal(await toolbar.locator('.ai-composer-primary').isDisabled(), true);
            assert.notEqual(await background(toolbar.locator('.ai-composer-primary')), expected,
              'The primary action retains its distinct background');
            const add = toolbar.locator('.ai-composer-add');
            await add.click();
            await page.getByRole('menu').waitFor();
            await page.mouse.move(0, 0);
            await settle(add);
            assert.equal(await background(add), expected, 'An open menu retains the toolbar highlight');
            await page.keyboard.press('Escape');
            await page.getByRole('menu').waitFor({ state: 'hidden' });
            await add.focus();
            await page.keyboard.press('Enter');
            await page.getByRole('menu').waitFor();
            await page.keyboard.press('Escape');
            await page.getByRole('menu').waitFor({ state: 'hidden' });
            await toolbar.locator('.ai-context-meter-trigger').click();
            const contextPanel = page.getByRole('dialog');
            const track = contextPanel.locator('.ai-context-meter-bar');
            await track.waitFor();
            assert.equal(await background(track), await tokenBackground(track, '--muted'),
              'The context usage track uses the muted background');
            await contextPanel.screenshot({ path: `${artifacts}/${engine.name()}-${locale}-${theme}-${width}-context-panel.png` });
            await page.keyboard.press('Escape');
            await contextPanel.waitFor({ state: 'hidden' });
            await toolbar.locator('.ai-model-trigger').hover();
            await settle(toolbar.locator('.ai-model-trigger'));
            await page.screenshot({ path: `${artifacts}/${engine.name()}-${locale}-${theme}-${width}.png` });
            const outside = page.getByTestId('outside');
            await outside.hover();
            await settle(outside);
            const accent = await tokenBackground(outside, '--accent');
            assert.equal(await background(outside), accent, 'Buttons outside the toolbar retain the shared ghost style');
          }
        }
      }
      assert.deepEqual(errors, [], 'The composer renders without browser errors');
      await page.close();
    } finally {
      await browser.close();
    }
  }
  console.log('Composer toolbar hover checks passed in Chromium and WebKit, both locales and themes, at 360px and 760px.');
} finally {
  await server.close();
}
