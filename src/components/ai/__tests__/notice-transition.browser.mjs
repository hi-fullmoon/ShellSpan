import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { chromium, webkit } from 'playwright';

const browser = await (process.env.SHELLSPAN_TEST_ENGINE === 'webkit' ? webkit : chromium).launch();
try {
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [1000, 320]) {
      for (const reducedMotion of ['no-preference', 'reduce']) {
        const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        // Mount the real workspace in isolation; the desktop app entry requires Tauri.
        await page.route('**/*', async route => {
          if (!route.request().isNavigationRequest()) return route.continue();
          const response = await route.fetch();
          const dom = new JSDOM(await response.text());
          dom.window.document.querySelector('script[src^="/src/main.tsx"]').remove();
          await route.fulfill({ response, body: dom.serialize() });
          dom.window.close();
        });
        await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
        const labels = await page.evaluate(async locale => {
          const source = await (await fetch('/src/hooks/useI18n.ts')).text();
          const reactUrl = source.match(/from "([^"]*\/react\.js\?v=[^"]+)"/)[1];
          const mainSource = await (await fetch('/src/main.tsx')).text();
          const domUrl = mainSource.match(/from "([^"]*\/react-dom_client\.js\?v=[^"]+)"/)[1];
          const { default: React } = await import(reactUrl);
          const { default: ReactDOM } = await import(domUrl);
          const { AiWorkspaceRoot } = await import('/src/components/ai/workspace/ai-workspace-root.tsx');
          const { createAiComposerState } = await import('/src/lib/ai/composer-machine.ts');
          const { taskTokenBudgetView } = await import('/src/tests/fixtures/task-token-budget.ts');
          const { initI18n, t } = await import('/src/locales/index.ts');
          const { useAppStore } = await import('/src/stores/appStore.ts');
          await import('/src/styles/base.css');
          await import('/src/components/ai/styles/styles.css');
          useAppStore.setState({ locale });
          await initI18n(locale);
          const h = React.createElement;
          const failure = taskTokenBudgetView();
          // Pause the real entrance transitions before they finish, including first mount.
          const entered = new Set();
          const captureEntrance = event => {
            const panel = event.target;
            if (!panel.matches('[data-slot="ai-notice-transition"][data-open]') || entered.has(panel)) return;
            entered.add(panel);
            panel.dataset.entranceCaptured = '';
            for (const animation of panel.getAnimations()) {
              animation.pause();
              animation.currentTime = 90;
            }
            if (entered.size === 3) document.removeEventListener('transitionrun', captureEntrance);
          };
          document.addEventListener('transitionrun', captureEntrance);
          function Preview() {
            const [error, setError] = React.useState(true);
            const [reconnect, setReconnect] = React.useState(true);
            const [failed, setFailed] = React.useState(true);
            React.useEffect(() => {
              const restore = () => { setError(true); setReconnect(true); };
              document.addEventListener('restore-notices', restore);
              return () => document.removeEventListener('restore-notices', restore);
            }, []);
            return h('main', { className: 'ai-panel-shell p-4', 'data-ai-scope': 'terminal' },
              h(AiWorkspaceRoot, {
                scope: 'terminal', view: null, canStartAgent: true,
                composerState: {
                  ...createAiComposerState({ phase: 'idle', runtimeStatus: 'idle', draft: t('ai.workspace.reconnectAvailable') }),
                  lastError: error ? { message: t('ai.workspace.reconnectUnsettled') } : null,
                  failedDrafts: failed ? [{ id: failure.summary.id, content: failure.snapshot.value.header.goal,
                    mode: 'nextTurn', error: failure.error }] : [],
                },
                onRetryFailedDraft: () => setFailed(false),
                onDismissError: () => setError(false),
                onContinueOnReconnectedTerminal: reconnect ? () => setReconnect(false) : undefined,
              }));
          }
          ReactDOM.createRoot(document.getElementById('root')).render(h(Preview));
          return { dismiss: t('ai.workspace.recovery.dismiss'),
            continue: t('ai.workspace.continueOnReconnectedTerminal'), retry: t('common.retry') };
        }, locale);
        const panels = page.locator('[data-slot="ai-notice-transition"]');
        await panels.first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await panels.count(), 3);
        if (reducedMotion === 'no-preference') {
          await page.waitForFunction(() => document.querySelectorAll('[data-entrance-captured]').length === 3);
          const entrances = await panels.evaluateAll(elements => elements.map(el => ({
            height: el.getBoundingClientRect().height, fullHeight: el.scrollHeight,
            opacity: Number(getComputedStyle(el).opacity), inert: el.inert,
          })));
          assert.ok(entrances.every(panel => panel.height > 0 && panel.height < panel.fullHeight),
            'Initially present errors, failed drafts and reconnect notices expand during entrance');
          assert.ok(entrances.every(panel => panel.opacity > 0 && panel.opacity < 1 && !panel.inert),
            'Notices fade in while their controls remain available');
          await page.screenshot({ path: `/tmp/shellspan-notice-transition-${locale}-${width}-entering.png` });
          await panels.evaluateAll(elements => elements.forEach(el => el.getAnimations().forEach(animation => animation.finish())));
        }
        if (reducedMotion === 'reduce') {
          const durations = await panels.evaluateAll(elements => elements.map(el => ({
            transition: getComputedStyle(el).transitionDuration,
            animation: getComputedStyle(el).animationDuration,
          })));
          assert.ok(durations.every(duration => duration.transition === '0s' && duration.animation === '0s'),
            'Reduced motion disables both transitions and animations');
        }
        const draft = await page.getByRole('textbox').textContent();
        const panelBoxes = await panels.evaluateAll(elements => elements.map(el => ({
          height: el.getBoundingClientRect().height, fits: el.scrollWidth <= el.clientWidth,
        })));
        assert.ok(panelBoxes.every(box => box.height > 0 && box.fits), 'Both notices fit the container');
        if (reducedMotion === 'no-preference') {
          await page.screenshot({ path: `/tmp/shellspan-notice-transition-${locale}-${width}-before.png` });
        }
        await page.getByRole('button', { name: labels.retry, exact: true }).click();
        assert.equal(await panels.count(), 2);
        for (const label of [labels.dismiss, labels.continue]) {
          const button = page.locator('button').filter({ hasText: label });
          const panel = button.locator('xpath=ancestor::*[@data-slot="ai-notice-transition"]');
          const before = await panel.evaluate(el => ({ height: el.getBoundingClientRect().height, text: el.textContent }));
          // Start the real action and inspect the browser's actual CSS transition.
          await button.evaluate(el => el.click());
          if (reducedMotion === 'no-preference') {
            await panel.waitFor();
            await page.waitForFunction(() => document.querySelector('[data-slot="ai-notice-transition"][data-ending-style]')?.getAnimations().length > 0);
            const middle = await panel.evaluate(el => {
              for (const animation of el.getAnimations()) {
                animation.pause();
                animation.currentTime = 90;
              }
              return { height: el.getBoundingClientRect().height, opacity: Number(getComputedStyle(el).opacity),
                inert: el.inert, hidden: el.getAttribute('aria-hidden'), text: el.textContent };
            });
            assert.ok(middle.height > 0 && middle.height < before.height, 'Notice height shrinks during exit');
            assert.ok(middle.opacity > 0 && middle.opacity < 1, 'Notice fades during exit');
            assert.equal(middle.inert, true, 'Departing controls cannot receive focus or clicks');
            assert.equal(middle.hidden, 'true');
            assert.equal(middle.text, before.text, 'Exit keeps the original notice text and action');
            await page.screenshot({ path: `/tmp/shellspan-notice-transition-${locale}-${width}-${label === labels.dismiss ? 'error' : 'reconnect'}-exiting.png` });
            // Restore the notice during exit to cover cancellation and rapid state changes.
            await page.evaluate(() => document.dispatchEvent(new Event('restore-notices')));
            await page.waitForFunction(() => !document.querySelector('[data-slot="ai-notice-transition"][data-ending-style]'));
            assert.equal(await panel.getAttribute('inert'), null);
            await button.evaluate(el => el.click());
            await page.waitForFunction(() => document.querySelector('[data-slot="ai-notice-transition"][data-ending-style]')?.getAnimations().length > 0);
            await panel.evaluate(el => el.getAnimations().forEach(animation => animation.finish()));
          }
          await button.waitFor({ state: 'detached' });
          assert.equal(await page.getByRole('textbox').textContent(), draft, 'Exit preserves the unsent draft');
        }
        // Restoration above also restores the first notice; dismiss it if necessary.
        const dismiss = page.locator('button').filter({ hasText: labels.dismiss });
        if (await dismiss.count()) {
          await dismiss.click();
          await dismiss.waitFor({ state: 'detached' });
        }
        assert.equal(await panels.count(), 0, 'No hidden panels remain after exit');
        assert.equal(await page.locator('[data-slot="ai-workspace-error-notices"]').isVisible(), false);
        assert.equal(await page.locator('[data-slot="ai-workspace-status-notices"]').isVisible(), false);
        // Notices arriving after the workspace is already mounted also animate.
        await page.evaluate(() => {
          const capture = event => {
            const panel = event.target;
            if (!panel.matches('[data-slot="ai-notice-transition"][data-open]')) return;
            panel.dataset.reentryCaptured = '';
            panel.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = 90; });
          };
          document.addEventListener('transitionrun', capture);
          document.dispatchEvent(new Event('restore-notices'));
        });
        await panels.first().waitFor();
        if (reducedMotion === 'no-preference') {
          await page.waitForFunction(() => document.querySelectorAll('[data-reentry-captured]').length === 2);
          const opacity = await panels.evaluateAll(elements => elements.map(el => Number(getComputedStyle(el).opacity)));
          assert.ok(opacity.every(value => value > 0 && value < 1), 'Restored notices fade in again');
        }
        assert.deepEqual(errors, []);
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
}
