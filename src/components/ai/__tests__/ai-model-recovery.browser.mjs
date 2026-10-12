import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { webkit } from 'playwright';

// Inspect a real persisted failure without modifying the ledger or calling a provider.
const ledger = process.argv[2];
assert.ok(ledger, 'Pass an existing Agent session JSONL ledger');
const events = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse);
assert.ok(events.some(event => event.type === 'request/failure'), 'Ledger must contain a real model failure');
const root = path.resolve(import.meta.dirname, '../../../..');
const server = await createServer({ root, configFile: false, logLevel: 'error',
  resolve: { alias: { '@': path.join(root, 'src') } },
  plugins: [tailwindcss(), {
    name: 'model-recovery-review',
    resolveId(id) { if (id === '/recovery-entry') return id; },
    load(id) {
      if (id !== '/recovery-entry') return;
      return `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { AiConversationNodeList } from '/src/components/ai/workspace/ai-conversation-node-seat.tsx';
        import { AiFailureRecoveryContext } from '/src/components/ai/workspace/ai-failure-recovery.tsx';
        import { projectAgentChatNodes } from '/src/lib/ai/conversation-projection.ts';
        import { modelFailureRecovery } from '/src/lib/ai/failure-recovery.ts';
        import { initI18n } from '/src/locales/index.ts';
        import { useAppStore } from '/src/stores/appStore.ts';
        import '/src/styles/base.css';
        import '/src/components/ai/styles/styles.css';
        const locale = new URLSearchParams(location.search).get('locale');
        useAppStore.setState({ locale });
        await initI18n(locale);
        const events = await fetch('/recovery-events').then(response => response.json());
        const nodes = projectAgentChatNodes(events);
        const latest = [...nodes].reverse().find(node => node.kind === 'turnProcess');
        const error = latest.children.find(node => node.kind === 'error');
        const recovery = { turnId: latest.turnId, kind: modelFailureRecovery(error), retryAt: error.retryAt };
        function Review() {
          const [busy, setBusy] = React.useState(false);
          return React.createElement(AiFailureRecoveryContext.Provider, { value: {
            recovery, busy, onRetry: turnId => { document.body.dataset.retried = turnId; setBusy(true); },
          } }, React.createElement('div', { className: 'ai-panel-shell', 'data-slot': 'ai-workspace-root', style: { padding: 16 } },
            React.createElement(AiConversationNodeList, { nodes: nodes.filter(node => node.kind === 'turnProcess') })));
        }
        createRoot(document.getElementById('root')).render(React.createElement(Review));
      `;
    },
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url === '/recovery-events') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(events));
        } else if (req.url?.startsWith('/recovery-review')) {
          res.setHeader('Content-Type', 'text/html');
          res.end('<html data-theme="light"><body><div id="root"></div><script type="module" src="/recovery-entry"></script></body></html>');
        } else next();
      });
    },
  }], server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  browser = await webkit.launch();
  const page = await browser.newPage();
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [1280, 400]) {
      await page.setViewportSize({ width, height: 720 });
      await page.goto(server.resolvedUrls.local[0] + 'recovery-review?locale=' + locale);
      const triggers = page.locator('.ai-turn-process-trigger');
      await triggers.last().waitFor();
      await triggers.last().click();
      const button = page.getByRole('button', { name: locale === 'zh-CN' ? '重试' : 'Retry', exact: true });
      await button.waitFor();
      await page.waitForFunction(() => {
        const process = [...document.querySelectorAll('.ai-turn-process')].at(-1);
        const action = process?.querySelector('.ai-turn-error [data-slot="button"]');
        return action && action.getBoundingClientRect().bottom <= process.getBoundingClientRect().bottom;
      });
      await page.locator('.ai-turn-process').last().evaluate(async element => {
        await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
      });
      assert.equal(await button.count(), 1);
      const geometry = await button.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const icon = element.querySelector('svg').getBoundingClientRect();
        const row = element.closest('.ai-turn-error').getBoundingClientRect();
        return { height: rect.height, icon: icon.width, gap: getComputedStyle(element).columnGap,
          fits: rect.right <= row.right && rect.left >= row.left,
          overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(geometry.height, 24);
      assert.equal(geometry.icon, 12);
      assert.equal(geometry.gap, '4px');
      assert.equal(geometry.fits, true);
      assert.equal(geometry.overflow, false);
      const details = page.locator('.ai-turn-process').last().locator('.ai-error-details [data-slot="collapsible-trigger"]');
      await details.focus();
      await page.keyboard.press('Enter');
      const panel = page.locator('.ai-turn-process').last().locator('.ai-error-details > [data-slot="collapsible-content"]');
      await panel.waitFor();
      const motion = await panel.evaluate(async element => {
        const style = getComputedStyle(element);
        const animations = element.getAnimations().filter(animation => animation.transitionProperty === 'height');
        const frames = animations.flatMap(animation => animation.effect.getKeyframes());
        await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
        return { transition: style.transitionProperty, overflow: style.overflow,
          animated: frames.some(frame => frame.height === '0px'), height: element.getBoundingClientRect().height };
      });
      assert.equal(motion.transition, 'height, opacity');
      assert.equal(motion.overflow, 'hidden');
      assert.equal(motion.animated, true, 'Error details must animate from zero height');
      assert.ok(motion.height > 0);
      assert.equal(await details.getAttribute('aria-expanded'), 'true');
      await page.keyboard.press('Enter');
      assert.equal(await details.getAttribute('aria-expanded'), 'false');
      await page.waitForFunction(() => {
        const element = [...document.querySelectorAll('.ai-error-details > [data-slot="collapsible-content"]')].at(-1);
        return element?.getAnimations().some(animation => animation.transitionProperty === 'height'
          && animation.effect.getKeyframes().some(frame => frame.height === '0px'));
      }, undefined, { polling: 'raf', timeout: 2000 });
      await panel.waitFor({ state: 'hidden' });
      // Interrupt a closing transition, then resize the open panel.
      await details.evaluate(element => element.click());
      await panel.waitFor();
      await panel.evaluate(async element => {
        await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
      });
      await details.evaluate(element => element.click());
      await details.evaluate(element => element.click());
      await page.setViewportSize({ width: width === 400 ? 1280 : 400, height: 720 });
      await page.waitForFunction(() => {
        const element = [...document.querySelectorAll('.ai-error-details > [data-slot="collapsible-content"]')].at(-1);
        return element && element.getBoundingClientRect().height >= element.firstElementChild.getBoundingClientRect().height - 1;
      });
      assert.equal(await details.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.setViewportSize({ width, height: 720 });
      await details.click();
      await panel.waitFor({ state: 'hidden' });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await details.click();
      await panel.waitFor();
      assert.equal(await panel.evaluate(element => getComputedStyle(element).transitionDuration), '0s');
      assert.equal(await panel.evaluate(element => element.getAnimations().length), 0);
      await details.click();
      await panel.waitFor({ state: 'hidden' });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.screenshot({ path: '/tmp/shellspan-model-recovery-' + locale + '-' + width + '.png' });
      await button.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: locale === 'zh-CN' ? '正在重试' : 'Retrying', exact: true }).waitFor();
      assert.ok(await page.locator('body').getAttribute('data-retried'));
      assert.equal(await page.getByRole('button', { name: locale === 'zh-CN' ? '正在重试' : 'Retrying', exact: true }).isDisabled(), true);
    }
  }
  console.log('Real failure ledger rendering, disclosure motion, interrupted close, resize, reduced motion, keyboard action and busy state passed in both locales at 1280px and 400px.');
} finally {
  await browser?.close();
  await server.close();
}
