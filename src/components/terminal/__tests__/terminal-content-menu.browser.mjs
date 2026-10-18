import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = readFileSync(new URL('../terminal-pane.tsx', import.meta.url), 'utf8');
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  plugins: [tailwindcss(), {
    name: 'terminal-content-menu-regression',
    resolveId(id) { if (id === '/menu-runtime.js') return id; },
    load(id) {
      if (id !== '/menu-runtime.js') return;
      return `
        export { default as React } from 'react';
        export { createRoot } from 'react-dom/client';
        export { flushSync } from 'react-dom';
        export { TerminalPane } from '/src/components/terminal/terminal-pane.tsx';
        export { terminalContextTarget } from '/src/components/terminal/terminal-content-menu.tsx';
        export { terminalRegistry } from '/src/components/terminal/registry/terminal-registry.ts';
        export { useAppStore } from '/src/stores/appStore.ts';
        export { useTerminalStore } from '/src/stores/terminalStore.ts';
        export { useAiDraftStore } from '/src/stores/aiDraftStore.ts';
        export { useAiPanelStore } from '/src/stores/aiPanelStore.ts';
        export { useAiSessionController } from '/src/components/ai/workspace/use-ai-session-controller.ts';
        export { initI18n } from '/src/locales/index.ts';
        import '@xterm/xterm/css/xterm.css';
        import '/src/styles/base.css';
      `;
    },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><div id="root" style="height:480px"></div></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
});

try {
  await server.listen();
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(10000);
      if (name === 'chromium') await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
      await page.evaluate(async ({ output, username, shell }) => {
        const runtime = await import('/menu-runtime.js');
        window.runtime = runtime;
        const { React, createRoot, flushSync, useTerminalStore, useAppStore, terminalRegistry, TerminalPane, initI18n } = runtime;
        await initI18n('zh-CN');
        document.documentElement.dataset.theme = 'light';
        useAppStore.setState({ terminalCopyOnSelect: false });
        const id = crypto.randomUUID();
        useTerminalStore.getState().addSession({ sessionId: id, host: 'local', port: 0, username, title: shell });
        useTerminalStore.getState().setStatus(id, { sessionId: id, status: 'disconnected' });
        window.session = useTerminalStore.getState().sessions.find(item => item.sessionId === id);
        const store = useTerminalStore.getState();
        const controller = terminalRegistry.create(id, store.setStatus, store.setClosed, () => 'disconnected', () => {});
        window.terminal = controller.terminal;
        window.terminalInputs = [];
        controller.terminal.onData(data => window.terminalInputs.push(data));
        window.root = createRoot(document.getElementById('root'));
        flushSync(() => window.root.render(React.createElement(TerminalPane, { activeSession: window.session })));
        await new Promise(resolve => controller.terminal.write(output.replace(/\n/g, '\r\n'), resolve));
        controller.terminal.select(0, controller.terminal.buffer.active.baseY, 12);
      }, { output, username: userInfo().username, shell: userInfo().shell });
      const screen = page.locator('.xterm-screen');
      const menu = page.getByRole('menu', { name: '终端菜单' });
      for (const width of [1200, 400]) {
        await page.setViewportSize({ width, height: 700 });
        await page.evaluate(async () => {
          window.runtime.terminalRegistry.get(window.session.sessionId).fit();
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          window.terminal.select(0, window.terminal.buffer.active.baseY, 12);
        });
        const selected = await page.evaluate(() => window.terminal.getSelection());
        await screen.click({ button: 'right', position: { x: 15, y: 20 } });
        await menu.waitFor();
        assert.deepEqual(await page.evaluate(() => window.terminalInputs), [], 'Opening the menu must never write clipboard contents into xterm');
        assert.equal(await page.evaluate(() => window.terminal.getSelection()), selected, 'Opening the menu must preserve the xterm selection');
        assert.equal(await page.getByRole('menuitem', { name: /^粘贴/ }).getAttribute('aria-disabled'), 'true');
        await page.getByRole('menuitem', { name: '重新连接' }).waitFor();
        const bounds = await menu.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 700, JSON.stringify(bounds));
        await menu.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)); });
        await page.screenshot({ path: `/tmp/shellspan-terminal-menu-${name}-${width}.png` });
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'hidden' });
        assert.ok(await page.locator('.xterm-helper-textarea').evaluate(element => element === document.activeElement));
      }
      const blockedPaste = await page.evaluate(text => {
        const data = new DataTransfer();
        data.setData('text/plain', text);
        const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
        window.terminal.textarea.dispatchEvent(event);
        return { prevented: event.defaultPrevented, inputs: window.terminalInputs };
      }, output);
      assert.deepEqual(blockedPaste, { prevented: true, inputs: [] }, 'The pane must intercept paste before xterm and reject disconnected input');
      await screen.click({ button: 'right', position: { x: 15, y: 20 } });
      await page.getByRole('menuitem', { name: '查找…' }).click();
      await page.locator('[data-terminal-search] input').waitFor();
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.terminal.scrollToTop());
      await screen.click({ button: 'right', position: { x: 15, y: 20 } });
      await page.getByRole('menuitem', { name: '滚动到底部' }).click();
      assert.equal(await page.evaluate(() => window.terminal.buffer.active.viewportY === window.terminal.buffer.active.baseY), true);

      await page.evaluate(() => window.terminal.select(0, window.terminal.buffer.active.baseY, 12));
      await screen.click({ button: 'right', position: { x: 15, y: 20 } });
      await page.getByRole('menuitem', { name: '发送给 AI…' }).click();
      const transfer = await page.evaluate(() => ({
        open: window.runtime.useAiPanelStore.getState().panelOpenBySection.terminal,
        text: window.runtime.useAiDraftStore.getState().terminalInsertions[`terminal:${window.session.sessionId}`],
      }));
      assert.ok(transfer.open && transfer.text.includes('终端：') && transfer.text.length > 12);
      await page.evaluate(() => {
        const { React, createRoot, flushSync, useAiSessionController, useAiDraftStore } = window.runtime;
        const owner = `new:agent:terminal:${window.session.sessionId}`;
        useAiDraftStore.getState().saveDraft(owner, window.session.title);
        useAiDraftStore.getState().insertTerminalText(`focus:${window.session.sessionId}`, window.session.title);
        const host = document.createElement('div');
        document.body.appendChild(host);
        window.aiRoot = createRoot(host);
        function Composer() {
          const controller = useAiSessionController({ scope: 'terminal' });
          window.aiController = controller;
          return React.createElement('textarea', { 'data-menu-ai-draft': '', value: controller.composer.draft, readOnly: true });
        }
        flushSync(() => window.aiRoot.render(React.createElement(React.StrictMode, null, React.createElement(Composer))));
      });
      await page.waitForFunction(text => document.querySelector('[data-menu-ai-draft]').value.includes(text), transfer.text);
      const draft = await page.locator('[data-menu-ai-draft]').inputValue();
      assert.equal(draft.split(transfer.text).length, 2, 'Strict Mode must consume an insertion only once');
      assert.ok(draft.startsWith(await page.evaluate(() => window.session.title)), 'AI insertion must retain the existing draft');
      assert.ok(await page.evaluate(() => window.runtime.useAiDraftStore.getState().terminalInsertions[`focus:${window.session.sessionId}`]), 'Terminal and Focus insertions must stay separate');
      await page.evaluate(() => window.aiRoot.unmount());

      await screen.click({ button: 'right', position: { x: 15, y: 20 } });
      await page.getByRole('menuitem', { name: '清除滚动历史…' }).click();
      const confirm = page.getByRole('alertdialog');
      await confirm.waitFor();
      const history = await page.evaluate(() => window.terminal.buffer.normal.baseY);
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await confirm.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => window.terminal.buffer.normal.baseY), history);
      await screen.click({ button: 'right', position: { x: 15, y: 20 } });
      await page.getByRole('menuitem', { name: '清除滚动历史…' }).click();
      await page.getByRole('button', { name: '确认', exact: true }).click();
      await confirm.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => window.terminal.buffer.normal.baseY === 0);

      await screen.click({ button: 'right', modifiers: ['Shift'], position: { x: 15, y: 20 } });
      await menu.waitFor();
      await page.waitForFunction(() => document.activeElement?.closest('[role="menu"]'));
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
      await page.evaluate(async () => {
        await new Promise(resolve => window.terminal.write('\u001b[?1000h', resolve));
      });
      await screen.click({ button: 'right', position: { x: 15, y: 20 } });
      assert.equal(await menu.isVisible(), false, 'Applications that own the mouse retain normal right-click');
      await screen.click({ button: 'right', modifiers: ['Shift'], position: { x: 15, y: 20 } });
      await menu.waitFor();
      await page.waitForFunction(() => document.activeElement?.closest('[role="menu"]'));
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });

      const hit = await page.evaluate(async () => {
        const text = window.location.origin;
        window.terminal.reset();
        await new Promise(resolve => window.terminal.write(text, resolve));
        const bounds = window.terminal.element.querySelector('.xterm-screen').getBoundingClientRect();
        const target = window.runtime.terminalContextTarget(window.terminal, bounds.left + 2, bounds.top + 2);
        return { target, text };
      });
      assert.equal(hit.target.url, hit.text);
      await screen.click({ button: 'right', position: { x: 2, y: 2 } });
      await page.getByRole('menuitem', { name: '在浏览器中打开', exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement?.closest('[role="menu"]'));
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
      const path = fileURLToPath(new URL('../terminal-pane.tsx', import.meta.url));
      const detectedPath = await page.evaluate(async path => {
        window.terminal.reset();
        await new Promise(resolve => window.terminal.write(path, resolve));
        window.terminal.select(0, 0, path.length);
        const bounds = window.terminal.element.querySelector('.xterm-screen').getBoundingClientRect();
        return window.runtime.terminalContextTarget(window.terminal, bounds.left + 2, bounds.top + 2).path;
      }, path);
      assert.equal(detectedPath, path, 'A selected absolute path may span wrapped terminal rows');
      await screen.click({ button: 'right', position: { x: 2, y: 2 } });
      await page.getByRole('menuitem', { name: '复制路径', exact: true }).waitFor();
      if (name === 'chromium') {
        await menu.getByRole('menuitem').first().click();
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), path);
      } else {
        await page.waitForFunction(() => document.activeElement?.closest('[role="menu"]'));
        await page.keyboard.press('Escape');
      }
      await menu.waitFor({ state: 'hidden' });
      // Connected clear-screen behavior is verified in terminal-clear-screen.native.tsx.
      await page.evaluate(() => {
        window.root.unmount();
        window.runtime.terminalRegistry.dispose(window.session.sessionId);
      });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
  process.stdout.write('Terminal content menu regressions passed with real xterm in Chromium and WebKit.\n');
} finally {
  await server.close();
}
