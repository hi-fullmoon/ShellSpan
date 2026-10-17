import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const centerY = rect => rect.y + rect.height / 2;
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src/` } },
  server: { host: '127.0.0.1', port: 0 } });
server.middlewares.use(async (request, response, next) => {
  if (request.url !== '/') return next();
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/', '<!doctype html><html><body><div id="root"></div></body></html>'));
});
await server.listen();
const testUrl = server.resolvedUrls.local[0];

try {
  for (const { engine, locale } of [chromium, webkit].flatMap(engine =>
    ['zh-CN', 'en-US'].map(locale => ({ engine, locale })))) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ deviceScaleFactor: 2 });
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(
        testUrl,
        { waitUntil: 'domcontentloaded' },
      );
      await page.evaluate(async locale => {
        const { default: React } = await import('/@id/react');
        const { default: ReactDOM } = await import('/@id/react-dom/client');
        const { AgentExecutionSurfaceSelector } = await import('/src/components/ai/agent-execution-surface-selector.tsx');
        const { AgentPermissionSelector } = await import('/src/components/ai/agent-permission-selector.tsx');
        const { AiComposerSeat } = await import('/src/components/ai/workspace/ai-composer-seat.tsx');
        const { initI18n } = await import('/src/locales/index.ts');
        const { useTerminalStore } = await import('/src/stores/terminalStore.ts');
        await import('/src/styles/base.css');
        await import('/src/components/ai/styles/styles.css');

        await initI18n(locale);
        const { useAppStore } = await import('/src/stores/appStore.ts');
        useAppStore.setState({ locale });
        useTerminalStore.getState().addSession({
          sessionId: 'alignment-session', title: 'Alignment', host: 'local', port: 0, username: 'tester',
        }, 'alignment-profile');
        useTerminalStore.getState().setStatus('alignment-session', {
          sessionId: 'alignment-session', status: 'connected',
        });
        const h = React.createElement;
        const permissionControl = () => h(AgentPermissionSelector, {
          sessionId: 'alignment-session', mode: 'fullAccess', variant: 'composer',
        });
        const executionSurfaceControl = () => h(AgentExecutionSurfaceSelector, {
          surface: 'boundTerminal', realTerminalState: 'ready',
        });
        ReactDOM.createRoot(document.getElementById('root')).render(
          h('main', {
            className: 'ai-panel-shell @container/ai-workspace flex flex-col gap-4 p-4',
            'data-ai-scope': 'terminal',
          },
          h('div', { className: 'flex items-center gap-1', 'data-testid': 'alignment-row' },
            permissionControl(),
            executionSurfaceControl(),
          ),
          h(AiComposerSeat, {
            phase: 'active', status: 'idle', modelLabel: 'MiniMax-M3 · Default',
            permissionControl: permissionControl(), executionSurfaceControl: executionSurfaceControl(),
          })),
        );
      }, locale);
      await page.locator('.ai-composer-control-content').first().waitFor({ timeout: 10_000 })
        .catch(error => assert.fail(`${error.message}\n${pageErrors.join('\n')}`));
      await page.evaluate(() => document.fonts.ready);
      for (const width of [720, 760]) {
        await page.setViewportSize({ width, height: 180 });

        const controls = await page.locator('[data-testid="alignment-row"] .ai-composer-control-content').evaluateAll(elements => (
          elements.map(element => {
            const rect = node => {
              const bounds = node.getBoundingClientRect();
              return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
            };
            const children = [...element.children];
            return {
              content: rect(element),
              icon: rect(children[0]),
              label: rect(children[1]),
              chevron: rect(children[2]),
              gap: getComputedStyle(element).columnGap,
            };
          })
        ));

        assert.equal(controls.length, 2);
        for (const control of controls) {
          assert.equal(control.gap, '4px', 'Composer control icon spacing must stay at 4px');
          assert.ok(Math.abs(centerY(control.icon) - centerY(control.content)) < 0.1,
            'Leading icon must be vertically centered');
          assert.ok(Math.abs(centerY(control.label) - centerY(control.content)) < 0.1,
            'Label must be vertically centered');
          assert.ok(Math.abs(centerY(control.chevron) - centerY(control.content)) < 0.1,
            'Trailing icon must be vertically centered');
          assert.equal(control.label.x - (control.icon.x + control.icon.width), 4,
            'Leading icon and label must be 4px apart');
          assert.equal(control.chevron.x - (control.label.x + control.label.width), 4,
            'Label and trailing icon must be 4px apart');
        }
        assert.ok(Math.abs(centerY(controls[0].content) - centerY(controls[1].content)) < 0.1,
          'Adjacent Composer controls must share one vertical center');
      }

      await page.setViewportSize({ width: 664, height: 260 });
      const composer = page.locator('[data-slot="ai-composer-seat"]');
      await composer.waitFor();
      assert.notEqual(await composer.locator('.ai-execution-surface-label').evaluate(element => getComputedStyle(element).display), 'none',
        'Execution surface label should remain visible when the toolbar has room');
      assert.equal(await composer.locator('.ai-execution-surface-label').evaluate(element => element.scrollWidth <= element.clientWidth), true,
        'Execution surface label should remain fully visible when the toolbar has room');
      assert.notEqual(await composer.locator('.ai-permission-trigger-label').evaluate(element => getComputedStyle(element).display), 'none',
        'Permission label should remain visible at the intermediate compact width');
      const modelLabel = composer.locator('.ai-model-trigger-name');
      assert.equal(await modelLabel.evaluate(element => element.scrollWidth <= element.clientWidth), true,
        'Model label should remain fully visible while toolbar controls compete for width');
      const stages = [];
      for (const width of [760, 600, 540, 520, 500, 480, 460, 450, 440, 420, 360, 320, 280, 600]) {
        await page.setViewportSize({ width, height: 260 });
        await page.waitForTimeout(80);
        const stage = await composer.locator('.ai-composer-toolbar').getAttribute('data-compact');
        stages.push(stage);
        const visible = selector => composer.locator(selector).evaluate(element => getComputedStyle(element).display !== 'none');
        assert.equal(await visible('.ai-permission-trigger-label'), stage !== 'permission');
        assert.equal(await visible('.ai-execution-surface-label'), !['surface', 'permission'].includes(stage));
        if (width === 600) {
          assert.equal(await visible('.ai-permission-trigger-label'), true, 'Permission text must return when space is available');
          assert.equal(await visible('.ai-execution-surface-label'), true, 'Surface text must remain visible below the old 640px breakpoint');
        }
        const spacing = await composer.evaluate(() => {
          const toolbar = document.querySelector('.ai-composer-toolbar');
          const groups = [...toolbar.children].map(group => group.getBoundingClientRect());
          const items = [...toolbar.children].flatMap(group => [...group.children]
            .map(child => child.getBoundingClientRect())
            .filter(rect => rect.width > 0));
          const gapsFor = rects => rects
            .map((rect, index) => (index === 0 ? Number.POSITIVE_INFINITY : rect.x - rects[index - 1].right))
            .filter(gap => Number.isFinite(gap));
          return { groups: gapsFor(groups), items: gapsFor(items) };
        });
        assert.ok(spacing.groups.every(gap => gap >= 0),
          `Toolbar groups must not overlap at width ${width}: ${spacing.groups}`);
        assert.ok(spacing.items.every(gap => gap >= 0),
          `Toolbar controls must not overlap at width ${width} (${stage}): ${spacing.items}`);
        await page.screenshot({ path: `/tmp/shellspan-composer-${engine.name()}-${locale}-${width}.png`, fullPage: true });
      }
      for (const stage of ['full', 'model', 'surface', 'permission']) {
        assert.ok(stages.includes(stage), `Expected progressive stage ${stage}, got ${stages}`);
      }
      await page.setViewportSize({ width: 280, height: 300 });
      const permission = composer.locator('.ai-permission-trigger');
      await permission.focus();
      await page.getByRole('tooltip').waitFor();
      assert.ok((await page.getByRole('tooltip').innerText()).length > 0, 'Icon controls retain keyboard tooltips');
      await page.keyboard.press('Escape');
      // A docked panel changes its own width without resizing the window.
      await page.setViewportSize({ width: 1000, height: 400 });
      for (const width of [360, 600]) {
        await page.locator('main').evaluate((element, width) => {
          element.style.width = `${width}px`;
        }, width);
        await page.waitForTimeout(80);
        assert.equal(await composer.locator('.ai-permission-trigger-label').isVisible(), width === 600,
          'Permission text must follow container width independently of the viewport');
        assert.equal(await composer.locator('.ai-execution-surface-label').isVisible(), width === 600,
          'Execution text must return when a docked panel expands');
      }
      assert.deepEqual(pageErrors, [], 'Rendering the real composer must not raise browser errors');
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
