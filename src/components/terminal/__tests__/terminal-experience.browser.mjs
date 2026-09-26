import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { userInfo, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { webkit } from 'playwright';

// Exercise real xterm parsing, searching, scrolling, browser clipboard failures
// and the production React components. Terminal text comes from the repository.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = execFileSync('git', ['ls-files', 'src/components/terminal'], { cwd: root, encoding: 'utf8' });
const allFiles = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
const mixedCaseOutput = readFileSync(`${root}src/components/terminal/terminal-search.tsx`, 'utf8');
const identity = { sessionId: crypto.randomUUID(), title: userInfo().shell, host: hostname(), username: userInfo().username, port: 22, status: 'disconnected' };
const server = await createServer({
  root,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  plugins: [tailwindcss(), {
    name: 'terminal-experience-test',
    resolveId(id) { if (id === '/experience-runtime.js') return id; },
    load(id) {
      if (id !== '/experience-runtime.js') return;
      return `
        export { default as React } from 'react';
        export { createRoot } from 'react-dom/client';
        export { Terminal } from '@xterm/xterm';
        export { SearchAddon } from '@xterm/addon-search';
        export { TerminalSearch } from '/src/components/terminal/terminal-search.tsx';
        export { TerminalScrollButton } from '/src/components/terminal/terminal-scroll-button.tsx';
        export { TerminalPastePreview } from '/src/components/terminal/terminal-paste-preview.tsx';
        export { TerminalCloseDetails } from '/src/components/terminal/terminal-close-details.tsx';
        export { TerminalPane } from '/src/components/terminal/terminal-pane.tsx';
        export { agentTerminalLeaseState } from '/src/components/terminal/agent-terminal-lease-state.ts';
        export { FitAddon } from '@xterm/addon-fit';
        export { resolveTerminalTheme } from '/src/components/terminal/registry/terminal-registry.ts';
        export { TERMINAL_CONTAINER_CLASS } from '/src/components/terminal/registry/terminal-geometry.ts';
        export { ConfirmationDialog } from '/src/components/ui/confirmation-dialog.tsx';
        export { terminalInputReadiness } from '/src/components/terminal/terminal-input-readiness.ts';
        export { copyTerminalText } from '/src/components/terminal/terminal-clipboard.ts';
        export { useTerminalStore } from '/src/stores/terminalStore.ts';
        export { useToastStore } from '/src/stores/toastStore.ts';
        export { useAppStore } from '/src/stores/appStore.ts';
        export { initI18n, t } from '/src/locales/index.ts';
        import '@xterm/xterm/css/xterm.css';
        import '/src/styles/base.css';
      `;
    },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><div id="pane" style="position:relative;height:360px;overflow:hidden"><div id="terminal"></div><div id="controls"></div></div><div id="dialog"></div></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
});

let browser;
try {
  await server.listen();
  browser = await webkit.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.evaluate(async ({ output, identity }) => {
    const runtime = await import('/experience-runtime.js');
    window.runtime = runtime;
    const { React, createRoot, Terminal, SearchAddon, FitAddon, resolveTerminalTheme, TERMINAL_CONTAINER_CLASS, TerminalSearch, TerminalScrollButton, useAppStore, initI18n } = runtime;
    useAppStore.setState({ locale: 'zh-CN' });
    await initI18n('zh-CN');
    document.documentElement.setAttribute('data-theme', 'light');
    const terminal = new Terminal({ cols: 100, rows: 14, scrollback: 10000, allowProposedApi: true, theme: resolveTerminalTheme('light') });
    const addon = new SearchAddon();
    const fit = new FitAddon();
    terminal.loadAddon(addon);
    terminal.loadAddon(fit);
    document.getElementById('terminal').className = TERMINAL_CONTAINER_CLASS;
    terminal.open(document.getElementById('terminal'));
    fit.fit();
    await new Promise((resolve) => terminal.write(output.replace(/\n/g, '\r\n'), resolve));
    window.terminal = terminal;
    window.addon = addon;
    window.fit = fit;
    window.identity = identity;
    const controls = createRoot(document.getElementById('controls'));
    const dialog = createRoot(document.getElementById('dialog'));
    window.dialogRoot = dialog;
    window.unmountControls = () => controls.render(null);
    window.renderControls = (search = true) => controls.render(React.createElement(React.Fragment, null,
      search && React.createElement(TerminalSearch, { terminal, addon, onClose: () => { window.renderControls(false); terminal.focus(); } }),
      React.createElement(TerminalScrollButton, { terminal })));
    window.renderControls();
  }, { output, identity });

  const search = page.getByRole('textbox', { name: '搜索...' });
  await search.fill('terminal');
  const count = [...output.matchAll(/terminal/gi)].length;
  await page.waitForFunction((count) => document.querySelector('[data-terminal-search] [role=status]')?.textContent === `1/${count}`, count);
  await search.press('Enter');
  assert.equal(await page.locator('[data-terminal-search] [role=status]').textContent(), `2/${count}`);
  await search.press('Shift+Enter');
  assert.equal(await page.locator('[data-terminal-search] [role=status]').textContent(), `1/${count}`);
  await search.fill('TERMINAL');
  await page.getByRole('button', { name: '区分大小写' }).click();
  await page.getByRole('status', { name: '未找到匹配项' }).waitFor();
  assert.equal(await page.getByRole('status', { name: '未找到匹配项' }).textContent().then(text => text.trim()), '0/0');
  await page.getByRole('button', { name: '区分大小写' }).click();
  await page.waitForFunction((count) => document.querySelector('[data-terminal-search] [role=status]')?.textContent === `1/${count}`, count);

  // Changing Aa must invalidate the addon's cached highlights even when both
  // modes have matches. The no-match case alone does not catch stale counts.
  await search.fill('');
  await page.evaluate(async (text) => {
    window.terminal.reset();
    await new Promise((resolve) => window.terminal.write(text.replace(/\n/g, '\r\n'), resolve));
  }, mixedCaseOutput);
  const insensitiveCount = [...mixedCaseOutput.matchAll(/terminal/gi)].length;
  const sensitiveCount = [...mixedCaseOutput.matchAll(/terminal/g)].length;
  assert.ok(sensitiveCount > 0 && insensitiveCount > sensitiveCount);
  await search.fill('terminal');
  await page.waitForFunction((count) => document.querySelector('[data-terminal-search] [role=status]')?.textContent.endsWith(`/${count}`), insensitiveCount);
  await page.getByRole('button', { name: '区分大小写' }).click();
  await page.waitForFunction((count) => document.querySelector('[data-terminal-search] [role=status]')?.textContent.endsWith(`/${count}`), sensitiveCount);
  // The uppercase-only import must lose its highlight in case-sensitive mode.
  assert.equal(await page.evaluate(() => window.terminal.markers.some((marker) =>
    window.terminal.buffer.active.getLine(marker.line)?.translateToString(true) === "import type { Terminal } from '@xterm/xterm';",
  )), false);
  assert.equal(await page.evaluate(() => window.terminal.getSelection()), 'terminal');
  await page.getByRole('button', { name: '区分大小写' }).click();
  await page.waitForFunction((count) => document.querySelector('[data-terminal-search] [role=status]')?.textContent.endsWith(`/${count}`), insensitiveCount);
  await search.fill('');
  await page.evaluate(async (text) => {
    window.terminal.reset();
    await new Promise((resolve) => window.terminal.write(text.replace(/\n/g, '\r\n'), resolve));
  }, output);
  await search.fill('terminal');

  const regexToggle = page.getByRole('button', { name: '使用正则表达式' });
  assert.equal(await regexToggle.getAttribute('aria-pressed'), 'false');
  await search.fill('term(?:inal)');
  await page.getByRole('status', { name: '未找到匹配项' }).waitFor();
  await regexToggle.click();
  await page.waitForFunction((count) => document.querySelector('[data-terminal-search] [role=status]')?.textContent === `1/${count}`, count);
  await search.press('Enter');
  assert.equal(await page.locator('[data-terminal-search] [role=status]').textContent(), `2/${count}`);
  await search.press('Shift+Enter');
  assert.equal(await page.locator('[data-terminal-search] [role=status]').textContent(), `1/${count}`);
  await search.fill('TERM(?:INAL)');
  await page.getByRole('button', { name: '区分大小写' }).click();
  await page.getByRole('status', { name: '未找到匹配项' }).waitFor();
  await page.getByRole('button', { name: '区分大小写' }).click();
  await page.waitForFunction((count) => document.querySelector('[data-terminal-search] [role=status]')?.textContent === `1/${count}`, count);
  const regexInputWidth = (await search.boundingBox()).width;
  await search.fill('[');
  await page.getByRole('status', { name: '正则表达式无效，请检查语法' }).waitFor();
  assert.equal(await search.getAttribute('aria-invalid'), 'true');
  assert.equal((await search.boundingBox()).width, regexInputWidth);
  assert.ok(await page.getByRole('button', { name: '下一个', exact: true }).isDisabled());
  await search.press('Enter');
  await regexToggle.click();
  await page.getByRole('status', { name: '未找到匹配项' }).waitFor();
  assert.equal(await search.getAttribute('aria-invalid'), null);
  await search.fill('terminal');

  for (const scheme of ['catppuccinMocha', 'solarizedDark', 'light', 'app']) {
    for (const appTheme of ['light', 'dark']) {
      await page.evaluate(({ scheme, appTheme }) => {
        document.documentElement.dataset.theme = appTheme;
        window.runtime.useAppStore.setState({ terminalColorScheme: scheme });
        window.terminal.options.theme = window.runtime.resolveTerminalTheme(scheme);
      }, { scheme, appTheme });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.locator('[data-terminal-search]').evaluate(async element => {
        await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished));
      });
      const colors = await page.locator('[data-terminal-search]').evaluate((element, scheme) => {
        const theme = window.runtime.resolveTerminalTheme(scheme);
        const probe = document.createElement('div');
        probe.style.color = theme.foreground;
        probe.style.backgroundColor = theme.background;
        document.body.appendChild(probe);
        const expected = getComputedStyle(probe);
        const input = element.querySelector('input');
        const result = {
          text: [...element.querySelectorAll('input,button,[role=status]')].every(control => getComputedStyle(control).color === expected.color),
          inputBackground: getComputedStyle(input).backgroundColor === expected.backgroundColor,
          actual: [...element.querySelectorAll('input,button')].map(control => ({ color: getComputedStyle(control).color, background: getComputedStyle(control).backgroundColor })),
          expected: { color: expected.color, background: expected.backgroundColor },
        };
        probe.remove();
        return result;
      }, scheme);
      assert.ok(colors.text && colors.inputBackground, `${scheme}/${appTheme}: ${JSON.stringify(colors)}`);
    }
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    window.runtime.useAppStore.setState({ terminalColorScheme: 'catppuccinMocha' });
    window.terminal.options.theme = window.runtime.resolveTerminalTheme('catppuccinMocha');
  });

  for (const { width, height, paneWidth } of [
    { width: 1280, height: 800, paneWidth: 900 },
    { width: 1280, height: 800, paneWidth: 260 },
    { width: 320, height: 420, paneWidth: 320 },
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate((paneWidth) => {
      document.getElementById('pane').style.width = `${paneWidth}px`;
      window.fit.fit();
    }, paneWidth);
    const geometry = await page.locator('[data-terminal-search]').evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const pane = document.getElementById('pane').getBoundingClientRect();
      const controls = [...element.querySelectorAll('input,button')].map((control) => control.getBoundingClientRect().height);
      const centers = [...element.querySelectorAll('input,button,[role=status]')].map(control => {
        const rect = control.getBoundingClientRect();
        return rect.top + rect.height / 2;
      });
      return { inside: bounds.left >= pane.left && bounds.right <= pane.right, controls, centers, height: bounds.height, overflow: element.scrollWidth > element.clientWidth };
    });
    assert.ok(geometry.inside && !geometry.overflow, JSON.stringify(geometry));
    assert.ok(geometry.controls.every((height) => height === geometry.controls[0]), JSON.stringify(geometry));
    assert.equal(geometry.height, 34, 'Search should remain a compact single row');
    assert.ok(geometry.centers.every(center => Math.abs(center - geometry.centers[0]) < 1), JSON.stringify(geometry));
    const originalQuery = await search.inputValue();
    const inputWidth = (await search.boundingBox()).width;
    await search.fill(crypto.randomUUID());
    const noResults = page.getByRole('status', { name: '未找到匹配项' });
    await noResults.waitFor();
    assert.equal(await noResults.getAttribute('title'), '未找到匹配项');
    assert.equal((await search.boundingBox()).width, inputWidth, 'No matches must not shrink the input');
    assert.ok(await page.getByRole('button', { name: '上一个', exact: true }).isDisabled());
    assert.ok(await page.getByRole('button', { name: '下一个', exact: true }).isDisabled());
    await search.fill('');
    assert.equal((await search.boundingBox()).width, inputWidth, 'An empty query must retain the count space');
    assert.equal((await page.locator('[data-terminal-search] [role=status]').textContent()).trim(), '0/0');
    await page.screenshot({ path: `/tmp/shellspan-terminal-search-empty-${paneWidth}.png` });
    await search.fill(originalQuery);
    await page.waitForFunction(() => document.querySelector('[data-terminal-search] [role=status]')?.textContent.includes('/'));
    await page.screenshot({ path: `/tmp/shellspan-terminal-search-${paneWidth}.png` });
  }

  // Search still works when matches exceed the addon's default tracking cap.
  await page.evaluate(async (text) => {
    window.terminal.reset();
    await new Promise((resolve) => window.terminal.write(text.replace(/\n/g, '\r\n'), resolve));
  }, allFiles);
  const common = allFiles.length > 1000 ? '/' : 'src';
  await search.fill(common);
  if ([...allFiles.matchAll(/\//g)].length >= 1000) {
    await page.waitForFunction(() => document.querySelector('[data-terminal-search] [role=status]')?.textContent.includes('1000+'));
  }
  await search.press('Escape');
  assert.equal(await page.locator('[data-terminal-search]').count(), 0);
  assert.ok(await page.locator('.xterm-helper-textarea').evaluate((element) => element === document.activeElement));

  await page.evaluate(() => window.terminal.scrollToTop());
  await page.getByRole('button', { name: '回到最新输出' }).waitFor();
  await page.evaluate(async (text) => {
    await new Promise((resolve) => window.terminal.write(text.replace(/\n/g, '\r\n'), resolve));
  }, output);
  const latest = page.getByRole('button', { name: '有新输出 · 回到底部' });
  await latest.waitFor();
  // TerminalCarousel unmounts inactive panes. Remounting must keep unread state.
  await page.evaluate(() => window.unmountControls());
  await latest.waitFor({ state: 'detached' });
  await page.evaluate(() => window.renderControls(false));
  await latest.waitFor();
  const iconGap = await latest.evaluate((button) => getComputedStyle(button).columnGap);
  assert.equal(iconGap, '4px');
  await latest.click();
  await page.waitForFunction(() => window.terminal.buffer.active.viewportY === window.terminal.buffer.active.baseY);
  assert.equal(await latest.count(), 0);
  // Also track output that first arrives while the pane is unmounted.
  await page.evaluate(() => window.terminal.scrollToTop());
  await page.getByRole('button', { name: '回到最新输出' }).waitFor();
  await page.evaluate(() => window.unmountControls());
  await page.getByRole('button', { name: '回到最新输出' }).waitFor({ state: 'detached' });
  await page.evaluate(async (text) => {
    await new Promise((resolve) => window.terminal.write(text.replace(/\n/g, '\r\n'), resolve));
    window.renderControls(false);
  }, output);
  await latest.waitFor();
  await latest.click();
  await latest.waitFor({ state: 'detached' });
  await page.evaluate(() => window.unmountControls());
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  await page.evaluate(() => window.renderControls(false));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  assert.equal(await page.getByRole('button', { name: /回到最新输出|有新输出/ }).count(), 0);
  await page.evaluate(async () => {
    window.terminal.scrollToTop();
    await new Promise((resolve) => window.terminal.write('\x1b[?1049h', resolve));
  });
  assert.equal(await page.getByRole('button', { name: /回到最新输出|有新输出/ }).count(), 0);
  await page.evaluate(async () => { await new Promise((resolve) => window.terminal.write('\x1b[?1049l', resolve)); });

  await page.evaluate((text) => {
    const { React, ConfirmationDialog, TerminalPastePreview, t } = window.runtime;
    const target = `${window.identity.username}@${window.identity.host}`;
    window.dialogRoot.render(React.createElement(ConfirmationDialog, {
      open: true, onOpenChange: () => window.dialogRoot.render(null), title: t('terminal.pasteWarning.title'),
      description: t('terminal.pasteWarning.description', { lines: text.split('\n').length, characters: text.length }),
      confirmLabel: t('terminal.pasteWarning.confirm'), onConfirm: () => window.dialogRoot.render(null),
    }, React.createElement(TerminalPastePreview, { text, target })));
  }, output);
  await page.getByRole('alertdialog').waitFor();
  await page.getByRole('alertdialog').evaluate(async (dialog) => {
    await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
  });
  await page.getByText(`目标终端：${identity.username}@${identity.host}`, { exact: true }).waitFor();
  await page.getByText('内容以换行结尾，粘贴可能直接提交命令。', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-terminal-paste-preview] pre').textContent(), output);
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 420 : 800 });
    const geometry = await page.getByRole('alertdialog').evaluate((dialog) => {
      const bounds = dialog.getBoundingClientRect();
      const footer = dialog.querySelector('[data-slot=alert-dialog-footer]');
      const footerRect = footer.getBoundingClientRect();
      const preview = dialog.querySelector('[data-terminal-paste-preview] [data-slot=scroll-area-viewport]');
      preview.scrollTop = preview.scrollHeight;
      return {
        inside: bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.left >= 0 && bounds.right <= innerWidth,
        footerVisible: footerRect.top >= bounds.top && footerRect.bottom <= bounds.bottom,
        footerBorder: getComputedStyle(footer).borderTopWidth,
        scrollable: preview.scrollHeight > preview.clientHeight && preview.scrollTop > 0,
        overflow: dialog.scrollWidth > dialog.clientWidth,
      };
    });
    assert.ok(geometry.inside && geometry.footerVisible && geometry.scrollable && !geometry.overflow, JSON.stringify(geometry));
    assert.equal(geometry.footerBorder, '0px');
    await page.screenshot({ path: `/tmp/shellspan-terminal-paste-${width}.png` });
  }
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('alertdialog').waitFor({ state: 'detached' });

  // Clipboard writes outside a user gesture are denied by WebKit. Exercise the
  // real rejected promise, and verify repeated failures create one active toast.
  const copyFailures = await page.evaluate(async () => {
    const { copyTerminalText, useToastStore, t } = window.runtime;
    // Playwright evaluate itself grants transient activation. Let the browser's
    // actual activation expire before attempting the background clipboard write.
    await new Promise((resolve) => {
      const waitForExpiry = () => {
        if (navigator.userActivation.isActive) setTimeout(waitForExpiry, 100);
        else resolve();
      };
      setTimeout(waitForExpiry, 100);
    });
    useToastStore.setState({ toasts: [] });
    await Promise.all([copyTerminalText(location.origin), copyTerminalText(location.origin)]);
    return useToastStore.getState().toasts.filter((toast) => toast.message === t('terminal.feedback.copyFailed')).length;
  });
  assert.equal(copyFailures, 1);

  const readiness = await page.evaluate(async () => {
    const { terminalInputReadiness: readiness } = window.runtime;
    const id = window.identity.sessionId;
    const states = [];
    const unsubscribe = readiness.subscribe(() => states.push(readiness.isPreparing(id)));
    readiness.begin(id);
    readiness.finish(id);
    const early = !readiness.isPreparing(id);
    readiness.begin(id);
    await new Promise((resolve) => setTimeout(resolve, 850));
    const expired = !readiness.isPreparing(id);
    unsubscribe();
    return { early, expired, states };
  });
  assert.deepEqual(readiness, { early: true, expired: true, states: [true, false, true, false] });

  await page.evaluate(() => {
    const { React, ConfirmationDialog, TerminalCloseDetails, useTerminalStore, t } = window.runtime;
    useTerminalStore.setState({ sessions: [window.identity] });
    window.dialogRoot.render(React.createElement(ConfirmationDialog, {
      open: true, onOpenChange: () => window.dialogRoot.render(null), title: t('terminal.tab.closeConfirmTitle'),
      description: t('terminal.tab.closeConfirmMessage', { title: window.identity.title }),
      confirmLabel: t('common.close'), onConfirm: () => window.dialogRoot.render(null),
    }, React.createElement(TerminalCloseDetails, { sessions: [window.identity] })));
  });
  await page.locator('[data-terminal-close-details]').getByText('已断开', { exact: true }).waitFor();
  await page.evaluate(() => window.runtime.useTerminalStore.getState().setStatus(window.identity.sessionId, { status: 'connected' }));
  await page.getByText('无法确认是否有命令正在运行。', { exact: true }).waitFor();
  await page.evaluate(() => window.runtime.useTerminalStore.setState({ sessions: [{ ...window.identity, status: 'connected', integrationState: 'ready', promptReady: false }] }));
  await page.getByText('Shell 尚未返回提示符，可能有命令正在运行。', { exact: true }).waitFor();
  await page.getByRole('alertdialog').evaluate(async (dialog) => {
    await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
  });
  await page.screenshot({ path: '/tmp/shellspan-terminal-close.png' });
  await page.evaluate(() => window.runtime.useTerminalStore.setState({ sessions: [{ ...window.identity, status: 'connected', integrationState: 'ready', promptReady: true }] }));
  await page.getByText('Shell 已就绪。', { exact: true }).waitFor();
  await page.evaluate(() => {
    const { agentTerminalLeaseState } = window.runtime;
    agentTerminalLeaseState.set({
      sessionId: window.identity.sessionId, agentSessionId: crypto.randomUUID(), taskId: crypto.randomUUID(),
      operationId: crypto.randomUUID(), acquiredAtUnixMs: Date.now(), state: 'acquired', commandDisplay: '',
      terminalOwned: true, inputBlocked: false, takeoverRequested: false, takeoverFailed: false,
      requestTakeover: () => agentTerminalLeaseState.clearAll(),
    });
  });
  await page.getByText('AI 正在使用此终端，关闭会中断终端操作。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('alertdialog').waitFor({ state: 'detached' });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const { React, TerminalPane, agentTerminalLeaseState, terminalInputReadiness } = window.runtime;
    document.getElementById('dialog').style.height = '300px';
    agentTerminalLeaseState.clearAll();
    terminalInputReadiness.begin(window.identity.sessionId);
    window.dialogRoot.render(React.createElement(TerminalPane, { activeSession: { ...window.identity, status: 'connected' } }));
  });
  await page.getByRole('status', { name: '正在准备终端，暂时无法输入' }).waitFor();
  await page.evaluate(() => window.runtime.terminalInputReadiness.finish(window.identity.sessionId));
  await page.getByRole('status', { name: '正在准备终端，暂时无法输入' }).waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  process.stdout.write('Terminal experience regressions passed with real xterm and WebKit at wide and narrow sizes.\n');
} finally {
  await browser?.close();
  await server.close();
}
