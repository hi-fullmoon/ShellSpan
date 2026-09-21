import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const centerY = rect => rect.y + rect.height / 2;
const testUrl = process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420';

for (const engine of [chromium]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ deviceScaleFactor: 2 });
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(
        testUrl,
        { waitUntil: 'domcontentloaded' },
      );
      await page.evaluate(async () => {
        const { default: React } = await import('/@id/react');
        const { default: ReactDOM } = await import('/@id/react-dom/client');
        const { AgentExecutionSurfaceSelector } = await import('/src/components/ai/agent-execution-surface-selector.tsx');
        const { AgentPermissionSelector } = await import('/src/components/ai/agent-permission-selector.tsx');
        const { initI18n } = await import('/src/locales/index.ts');
        const { useTerminalStore } = await import('/src/stores/terminalStore.ts');
        await import('/src/styles/base.css');
        await import('/src/components/ai/styles/styles.css');

        await initI18n('zh-CN');
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
          h('div', {
            className: 'ai-composer-toolbar flex min-w-0 items-center justify-between gap-3 px-2',
            'data-slot': 'ai-composer-seat',
          },
          h('div', { className: 'ai-composer-tools flex min-w-0 flex-[0_1_auto] items-center gap-1' },
            h('button', { className: 'size-7 shrink-0' }, '+'),
            permissionControl(),
            executionSurfaceControl(),
          ),
          h('div', { className: 'ai-composer-trailing flex min-w-0 flex-1 basis-0 items-center justify-end gap-1.5' },
            h('button', { className: 'ai-model-trigger inline-flex h-7 min-w-0 max-w-full flex-[0_1_auto] items-center gap-1 overflow-hidden px-2 @min-[481px]/ai-workspace:shrink-0' },
              h('span', { className: 'ai-model-trigger-name min-w-0 max-w-60 flex-[0_1_auto] truncate' }, 'MiniMax-M3 · Default'),
            ),
            h('span', { className: 'size-7 shrink-0' }),
            h('button', { className: 'size-9 shrink-0' }, '↑'),
          ))),
        );
      });
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
      await composer.locator('.ai-execution-surface-label').evaluate(element => {
        element.textContent = 'Visible command';
      });
      assert.equal(await modelLabel.evaluate(element => element.scrollWidth <= element.clientWidth), true,
        'A longer execution surface label should yield width before the model is truncated');
    } finally {
      await browser.close();
    }
}
