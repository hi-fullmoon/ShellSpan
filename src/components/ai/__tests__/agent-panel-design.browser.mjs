import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

// Consume native snapshots exported by export_recorded_agent_panel_evidence.
// Normal scenes mount AiWorkspaceRoot; popup/error boundaries are isolated checks.
// The ignored Rust exporter takes SHELLSPAN_UI_REVIEW_{LEDGER,FAILURE_LEDGER,
// DATABASE,OUTPUT}; run it explicitly before passing its JSON output here.
const [evidencePath] = process.argv.slice(2);
assert.ok(evidencePath, 'Pass the real replay snapshot JSON exported by the Rust evidence test.');
const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = '/src/components/ai/__tests__/agent-panel-design.browser-entry.tsx';
const screenshots = '/tmp/shellspan-agent-panel-design';
await mkdir(screenshots, { recursive: true });
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src/` } },
  server: { host: '127.0.0.1', port: 0 } });
server.middlewares.use(async (request, response, next) => {
  if (request.url === '/evidence') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(evidence));
  } else if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end(await server.transformIndexHtml('/', '<!doctype html><html><body><div id="root"></div></body></html>'));
  } else next();
});
let checks = 0;
try {
  await server.listen();
  for (const engine of process.env.SHELLSPAN_TEST_ENGINE === 'webkit' ? [webkit] : [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(server.resolvedUrls.local[0]);
      const show = (locale, width, scene) => page.evaluate(async ({ entry, locale, width, scene }) => {
        return (await import(entry)).show(locale, width, scene);
      }, { entry, locale, width, scene });
      const unchangedDraft = async stage => {
        assert.equal(Number(await page.locator('body').getAttribute('data-draft-length') ?? 0), 0,
          `${stage}: control inspection must not change the draft`);
      };
      const fits = async locator => locator.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const parent = element.closest('main').getBoundingClientRect();
        return rect.width > 0 && rect.left >= parent.left - 1 && rect.right <= parent.right + 1
          && rect.top >= 0 && rect.bottom <= innerHeight + 1;
      });
      for (const locale of ['zh-CN', 'en-US']) {
        for (const width of [320, 400, 560, 720]) {
          await page.setViewportSize({ width: 1280, height: 720 });
          const labels = await show(locale, width, 'tasks');
          assert.equal(await page.locator('[data-slot="ai-workspace-header"] button').count(), 3,
            'Use the production header action geometry');
          await page.locator('.ai-task-strip-trigger').click();
          await unchangedDraft('expand tasks');
          const titles = await page.locator('.ai-task-strip-list li > span:last-child').evaluateAll(elements => elements.map(el => ({
            clipped: el.scrollWidth > el.clientWidth, height: el.getBoundingClientRect().height,
            lineHeight: parseFloat(getComputedStyle(el).lineHeight),
          })));
          assert.equal(titles.length, labels.planCount);
          assert.ok(titles.every(title => !title.clipped), 'Expanded task titles must not clip');
          if (width === 320) assert.ok(titles.some(title => title.height > title.lineHeight), 'Recorded long tasks must wrap');
          assert.ok(await page.locator('.ai-task-strip-list').evaluate(el => el.clientHeight <= 180));
          const taskPlacement = await page.locator('[data-slot="ai-composer-seat"]').evaluate(composer => {
            const task = composer.querySelector('[data-slot="ai-task-strip"]');
            const notices = composer.querySelector('[data-slot="ai-composer-notices"]');
            const input = composer.querySelector('.ai-composer-input-anchor');
            if (!task || !notices || !input) return null;
            return { gap: input.getBoundingClientRect().top - task.getBoundingClientRect().bottom,
              expectedGap: parseFloat(getComputedStyle(composer).rowGap),
              inNotices: task.parentElement === notices,
              adjacentToInput: notices.nextElementSibling === input };
          });
          assert.ok(taskPlacement, 'Tasks must render through the production composer');
          assert.equal(taskPlacement.inNotices, true);
          assert.equal(taskPlacement.adjacentToInput, true);
          assert.ok(Math.abs(taskPlacement.gap - taskPlacement.expectedGap) <= 1,
            'Expanded tasks must stay immediately above the input with the composer stack gap');
          assert.ok(await fits(page.locator('.ai-composer-primary')));
          const controls = await page.locator('.ai-composer-toolbar').evaluate(el => {
            const model = el.querySelector('.ai-model-trigger-name');
            const name = model.getBoundingClientRect();
            return { modelWidth: name.width, modelClipped: model.scrollWidth > model.clientWidth,
              overflow: el.scrollWidth > el.clientWidth,
              secondaryVisible: getComputedStyle(el.querySelector('.ai-permission-trigger-label')).display !== 'none' };
          });
          assert.equal(controls.overflow, false, 'Toolbar must fit inside the panel');
          assert.ok(controls.modelWidth >= Math.min(labels.model.length * 4, 60), 'Keep useful space for the model name');
          assert.equal(controls.secondaryVisible, width > 640);
          for (const selector of ['.ai-permission-trigger', '.ai-execution-surface-trigger']) {
            const button = page.locator(selector);
            const disabled = await button.isDisabled();
            assert.equal(disabled, selector === '.ai-execution-surface-trigger' && labels.executionLocked);
            await page.keyboard.press('Tab');
            await (disabled ? button.locator('..') : button).focus();
            await unchangedDraft(`${selector} focus`);
            const tooltip = page.getByRole('tooltip').filter({ hasText: await button.getAttribute('aria-label') });
            await tooltip.waitFor();
            assert.ok((await tooltip.innerText()).trim());
            if (disabled) {
              await button.locator('..').press('Enter');
              await unchangedDraft(`${selector} disabled Enter`);
              assert.equal(await page.getByRole('menu').count(), 0);
              await page.keyboard.press('Escape');
              await unchangedDraft(`${selector} disabled Escape`);
              continue;
            }
            await button.press('Enter');
            await unchangedDraft(`${selector} enabled Enter`);
            await page.getByRole('menu').waitFor();
            await page.getByRole('tooltip').waitFor({ state: 'hidden' });
            await page.keyboard.press('Escape');
            await page.getByRole('menu').waitFor({ state: 'hidden' });
            await page.waitForFunction(selector => document.activeElement?.matches(selector), selector);
            await unchangedDraft(`${selector} menu close`);
            assert.equal(await page.locator(selector).evaluate(el => el === document.activeElement), true);
          }
          await page.keyboard.press('Tab');
          await page.locator('.ai-model-trigger').focus();
          await unchangedDraft('model focus');
          const modelTooltip = page.getByRole('tooltip').filter({ hasText: labels.model });
          await modelTooltip.waitFor();
          assert.ok((await modelTooltip.innerText()).includes(labels.model));
          await page.locator('.ai-task-strip-trigger').focus();
          await unchangedDraft('task focus');
          await page.waitForFunction(() => document.querySelectorAll('[data-slot="tooltip-content"]').length === 0);
          assert.equal(await page.locator('[data-composer-editor]').textContent(), '',
            'Keyboard control inspection must not insert text into the draft');
          assert.equal(await page.locator('.ai-composer-placeholder').isVisible(), true,
            'The empty production editor must retain its placeholder');
          await page.locator('main').screenshot({ path: `${screenshots}/${engine.name()}-${locale}-${width}-tasks.png` });
          await page.locator('.ai-model-trigger').press('Enter');
          await page.getByRole('menuitem').filter({ hasText: labels.model }).first().click();
          assert.equal(await page.getByRole('menuitemradio', { checked: true }).count(), 1);
          await page.keyboard.press('Escape');
          await page.keyboard.press('Escape');
          await page.getByRole('menu').waitFor({ state: 'hidden' });

          const question = await show(locale, width, 'question');
          const footer = page.locator('.ai-question-panel-footer');
          assert.ok(await fits(footer));
          assert.equal(await footer.evaluate(el => getComputedStyle(el).flexWrap), width <= 421 ? 'wrap' : 'nowrap');
          const footerButtons = footer.getByRole('button');
          for (const button of await footerButtons.all()) assert.ok(await fits(button), 'Every question action must fit');
          await page.locator('main').screenshot({ path: `${screenshots}/${engine.name()}-${locale}-${width}-question.png` });
          const decline = locale === 'zh-CN' ? '跳过此题' : 'Skip question';
          for (let index = 0; index < question.questionCount; index++) {
            await footer.getByRole('button', { name: decline, exact: true }).click();
          }
          assert.equal(await page.locator('body').getAttribute('data-action'), 'answer');
          assert.equal(await footer.getByRole('button', { name: /正在保存答案|Saving answers/ }).isDisabled(), true);
          await show(locale, width, 'settled');
          const editor = page.locator('[contenteditable="true"]');
          await editor.fill(labels.draft);
          await page.locator('.ai-composer-primary').click();
          assert.equal(await page.locator('body').getAttribute('data-action'), 'submit');

          await show(locale, width, 'errors');
          const buttons = page.locator('[data-slot="ai-workspace-error-notices"] button');
          for (const button of await buttons.all()) {
            assert.ok(await fits(button));
            assert.equal(await button.evaluate(el => el.getBoundingClientRect().height), 24);
            assert.equal(await button.locator('svg').count(), 0);
          }
          await buttons.last().click();
          assert.equal(await page.locator('body').getAttribute('data-action'), 'draft');
          await buttons.first().click();
          assert.equal(await buttons.first().isDisabled(), true);
          assert.equal(await buttons.first().getAttribute('aria-busy'), 'true');
          const dismiss = page.getByRole('button', { name: locale === 'zh-CN' ? '关闭错误提示' : 'Dismiss error', exact: true });
          await dismiss.click();
          await dismiss.waitFor({ state: 'detached' });
          const details = page.getByRole('button', { name: locale === 'zh-CN' ? '技术详情' : 'Technical details', exact: true });
          assert.equal(await details.evaluate(el => el.getBoundingClientRect().height), 24);
          await details.focus();
          await page.keyboard.press('Enter');
          assert.equal(await details.getAttribute('aria-expanded'), 'true');
          await page.keyboard.press('Enter');
          assert.equal(await details.getAttribute('aria-expanded'), 'false');
          await show(locale, width, 'disabled');
          for (const selector of ['.ai-permission-trigger', '.ai-execution-surface-trigger', '.ai-model-trigger']) {
            const button = page.locator(selector);
            assert.equal(await button.isDisabled(), true);
            assert.ok(await fits(button), 'Disabled controls must keep their layout');
            await page.keyboard.press('Tab');
            await button.locator('..').focus();
            await page.getByRole('tooltip').filter({ hasText: await button.getAttribute('aria-label') }).waitFor();
            await page.keyboard.press('Enter');
            assert.equal(await page.getByRole('menu').count(), 0, 'Reading a disabled value must not enable its action');
          }
          checks++;
        }
        // The desktop viewport stays wide while only the panel is narrowed.
        for (const height of [300, 140]) {
        await page.setViewportSize({ width: 1280, height });
        for (const scene of ['contextTop', 'contextBottom']) {
          await show(locale, 320, scene);
          const meter = page.getByRole('button');
          await meter.focus();
          await page.keyboard.press('Enter');
          const panel = page.getByRole('dialog');
          await panel.waitFor();
          await panel.evaluate(async el => {
            await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
          });
          await page.locator('[data-slot="tooltip-content"]').waitFor({ state: 'hidden' });
          assert.ok(await panel.evaluate(el => {
            const r = el.getBoundingClientRect();
            return r.top >= 7 && r.bottom <= innerHeight - 7 && r.left >= 7 && r.right <= innerWidth - 7
              && getComputedStyle(el).overflowY === 'auto';
          }), 'Context popup must flip or shrink within the short viewport');
          if (height === 300) assert.equal(await panel.getAttribute('data-side'), scene === 'contextTop' ? 'bottom' : 'top');
          if (height === 140) assert.ok(await panel.evaluate(el => el.scrollHeight > el.clientHeight), 'Tiny windows must scroll the popup contents');
          await page.screenshot({ path: `${screenshots}/${engine.name()}-${locale}-${scene}-${height}.png` });
          await page.keyboard.press('Escape');
          await panel.waitFor({ state: 'hidden' });
          assert.equal(await meter.evaluate(el => el === document.activeElement), true);
        }
        }
        await page.setViewportSize({ width: 1280, height: 520 });
        await show(locale, 320, 'question');
        assert.ok(await fits(page.locator('.ai-question-panel-footer')));
        assert.ok(await fits(page.locator('.ai-composer-primary')));
        await show(locale, 320, 'empty');
        assert.ok((await page.locator('.ai-session-context').innerText()).includes(locale === 'zh-CN' ? '未连接终端' : 'No connected terminal'));
        const caption = await page.locator('[data-slot="ai-composer-disclaimer"]').evaluate(el => ({ color: getComputedStyle(el).color, opacity: getComputedStyle(el).opacity }));
        assert.equal(caption.opacity, '1');
        assert.ok(!caption.color.includes(' / '), 'Caption uses an opaque semantic text color');
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.evaluate(async () => (await import('/src/lib/theme.ts')).applyTheme('dark'));
        assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
        for (const width of [320, 720]) {
          await show(locale, width, 'question');
          assert.ok(await fits(page.locator('.ai-question-panel-footer')));
          assert.ok(await fits(page.locator('.ai-composer-primary')));
          await page.locator('main').screenshot({ path: `${screenshots}/${engine.name()}-${locale}-${width}-dark-question.png` });
        }
        await page.evaluate(async () => (await import('/src/lib/theme.ts')).applyTheme('light'));
      }
      assert.deepEqual(errors, [], 'Production components must not raise browser errors');
    } finally { await browser.close(); }
  }
  console.log(`Agent panel design checks passed: ${checks} panel/locale/engine combinations, short-window popovers, keyboard menus, question submission, retry and dismissal. Screenshots: ${screenshots}`);
} finally { await server.close(); }
