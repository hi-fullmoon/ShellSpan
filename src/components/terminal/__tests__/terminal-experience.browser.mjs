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
        export { flushSync } from 'react-dom';
        export { Terminal } from '@xterm/xterm';
        export { SearchAddon } from '@xterm/addon-search';
        export { TerminalSearch } from '/src/components/terminal/terminal-search.tsx';
        export { TerminalScrollButton } from '/src/components/terminal/terminal-scroll-button.tsx';
        export { TerminalPastePreview } from '/src/components/terminal/terminal-paste-preview.tsx';
        export { TerminalCloseDetails } from '/src/components/terminal/terminal-close-details.tsx';
        export { TerminalPane } from '/src/components/terminal/terminal-pane.tsx';
        export { TerminalResizeIndicator } from '/src/components/terminal/terminal-resize-indicator.tsx';
        export { TerminalCarousel } from '/src/components/terminal/terminal-carousel.tsx';
        export { default as TerminalWorkspace } from '/src/components/terminal/index.tsx';
        export { agentTerminalLeaseState } from '/src/components/terminal/agent-terminal-lease-state.ts';
        export { createAgentTerminalLeaseCoordinator } from '/src/components/terminal/terminal-controller-layer.tsx';
        export { FitAddon } from '@xterm/addon-fit';
        export { resolveTerminalTheme, terminalRegistry } from '/src/components/terminal/registry/terminal-registry.ts';
        export { TERMINAL_CONTAINER_CLASS } from '/src/components/terminal/registry/terminal-geometry.ts';
        export { ConfirmationDialog } from '/src/components/ui/confirmation-dialog.tsx';
        export { terminalInputReadiness } from '/src/components/terminal/terminal-input-readiness.ts';
        export { copyTerminalText } from '/src/components/terminal/terminal-clipboard.ts';
        export { useTerminalStore } from '/src/stores/terminalStore.ts';
        export { useFocusStore } from '/src/stores/focusStore.ts';
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
    { width: 1280, height: 800, paneWidth: 240 },
    { width: 1280, height: 800, paneWidth: 130 },
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
    const wrapped = paneWidth < 326;
    assert.equal(geometry.centers[2], geometry.centers[3], 'Previous and next arrows must always wrap together');
    if (paneWidth === 130) {
      assert.ok(geometry.height > 62, 'Very narrow panes should allow additional control rows');
      assert.ok(geometry.centers[2] > geometry.centers[1], 'Both arrows should move below the result count together');
    } else {
      assert.equal(geometry.height, wrapped ? 62 : 34, 'Narrow panes should wrap without compressing controls');
      assert.ok(geometry.centers.slice(1).every(center => Math.abs(center - geometry.centers[1]) < 1), JSON.stringify(geometry));
      assert.equal(geometry.centers[1] - geometry.centers[0], wrapped ? 28 : 0);
    }
    const originalQuery = await search.inputValue();
    const inputWidth = (await search.boundingBox()).width;
    assert.ok(inputWidth >= 96, `Search input must remain usable at pane width ${paneWidth}: ${inputWidth}`);
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
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.evaluate(() => {
    const { React, createRoot, TerminalResizeIndicator } = window.runtime;
    window.resizeHost = document.createElement('div');
    document.getElementById('pane').appendChild(window.resizeHost);
    window.resizeRoot = createRoot(window.resizeHost);
    window.resizeRoot.render(React.createElement(TerminalResizeIndicator, { terminal: window.terminal, boundary: { current: document.getElementById('pane') } }));
  });
  await page.waitForTimeout(50);
  assert.equal(await page.getByTestId('terminal-resize-indicator').count(), 0);
  await page.evaluate(() => {
    const host = document.getElementById('pane');
    host.style.width = '700px';
    host.style.height = '300px';
    window.fit.fit();
  });
  const resizeIndicator = page.getByTestId('terminal-resize-indicator');
  await resizeIndicator.waitFor();
  assert.equal(await resizeIndicator.innerText(), await page.evaluate(() => `${window.terminal.cols} × ${window.terminal.rows}`));
  assert.equal(await resizeIndicator.evaluate(element => getComputedStyle(element).pointerEvents), 'none');
  assert.equal(await resizeIndicator.evaluate(element => {
    const badge = element.firstElementChild.getBoundingClientRect();
    const pane = document.getElementById('pane').getBoundingClientRect();
    return Math.abs(badge.x + badge.width / 2 - pane.x - pane.width / 2) < 1
      && Math.abs(badge.y + badge.height / 2 - pane.y - pane.height / 2) < 1;
  }), true, 'Resize indicator must be centered inside its own terminal pane');
  await page.screenshot({ path: '/tmp/shellspan-terminal-resize.png' });
  await page.evaluate(() => {
    document.getElementById('pane').style.paddingTop = '40px';
    window.runtime.flushSync(() => window.fit.fit());
  });
  assert.equal(await resizeIndicator.count(), 0, 'Toolbar changes immediately dismiss an existing resize hint');
  await page.evaluate(() => {
    document.getElementById('pane').style.paddingTop = '';
    window.fit.fit();
  });
  assert.equal(await resizeIndicator.count(), 0, 'Internal layout changes dismiss stale dimensions without showing new ones');
  await page.evaluate(() => {
    document.getElementById('pane').style.width = '740px';
    window.fit.fit();
  });
  await resizeIndicator.waitFor();
  assert.equal(await resizeIndicator.innerText(), await page.evaluate(() => `${window.terminal.cols} × ${window.terminal.rows}`), 'Resizing remains enabled after toolbar transitions');
  await resizeIndicator.waitFor({ state: 'detached' });
  const rowsBeforeToolbar = await page.evaluate(() => window.terminal.rows);
  await page.evaluate(() => {
    document.getElementById('pane').style.paddingTop = '40px';
    window.fit.fit();
  });
  assert.notEqual(await page.evaluate(() => window.terminal.rows), rowsBeforeToolbar, 'Toolbar space still updates the terminal grid');
  assert.equal(await resizeIndicator.count(), 0, 'Internal toolbar changes do not display a resize hint');
  await page.evaluate(() => {
    document.getElementById('pane').style.paddingTop = '';
    window.fit.fit();
  });
  assert.equal(await resizeIndicator.count(), 0, 'Removing the toolbar does not display a resize hint');
  await page.evaluate(() => {
    window.resizeRoot.unmount();
    window.resizeHost.remove();
    document.getElementById('pane').style.width = '';
    document.getElementById('pane').style.height = '360px';
    window.fit.fit();
  });
  await latest.waitFor({ state: 'detached' });
  await page.evaluate(() => window.renderControls(false));
  await latest.waitFor();
  const iconGap = await latest.evaluate((button) => getComputedStyle(button).columnGap);
  assert.equal(iconGap, '4px');
  for (const width of [900, 320]) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate((width) => { document.getElementById('pane').style.width = `${width}px`; }, width);
    const geometry = await latest.evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      const pane = document.getElementById('pane').getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        height: bounds.height,
        bottom: pane.bottom - bounds.bottom,
        right: pane.right - bounds.right,
        inside: bounds.left >= pane.left && button.scrollWidth <= button.clientWidth,
        border: style.borderTopWidth,
        radius: style.borderTopLeftRadius,
        fontSize: style.fontSize,
      };
    });
    assert.equal(geometry.height, 24);
    assert.equal(geometry.fontSize, '11px');
    assert.equal(geometry.bottom, 16);
    assert.equal(geometry.right, 16);
    assert.equal(geometry.border, '0px');
    assert.ok(parseFloat(geometry.radius) >= 12, JSON.stringify(geometry));
    assert.ok(geometry.inside, JSON.stringify(geometry));
    await page.screenshot({ path: `/tmp/shellspan-terminal-scroll-${width}.png` });
  }
  await latest.focus();
  await latest.press('Enter');
  await page.waitForFunction(() => window.terminal.buffer.active.viewportY === window.terminal.buffer.active.baseY);
  assert.equal(await latest.count(), 0);
  assert.ok(await page.locator('.xterm-helper-textarea').evaluate((element) => element === document.activeElement));
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

  for (const viewport of [{ width: 1280, height: 800 }, { width: 400, height: 600 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => {
      const { React, ConfirmationDialog, TerminalCloseDetails, useTerminalStore, t } = window.runtime;
      // Real local connection attempts supply the long list without IPC substitutes.
      for (let i = 0; i < 8; i++) useTerminalStore.getState().beginConnectionAttempt({
        title: window.identity.title, host: window.identity.host,
        username: window.identity.username, port: window.identity.port,
      });
      const sessions = useTerminalStore.getState().sessions;
      window.dialogRoot.render(React.createElement(ConfirmationDialog, {
        open: true, onOpenChange: () => window.dialogRoot.render(null),
        title: t('terminal.tab.closeOthersConfirmTitle'),
        description: t('terminal.tab.closeOthersConfirmMessage', { count: sessions.length }),
        contentClassName: '[&>[data-slot=scroll-area]]:max-h-[min(280px,calc(100vh-12rem))]',
        confirmLabel: t('common.close'), onConfirm: () => {},
      }, React.createElement(TerminalCloseDetails, { sessions })));
    });
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    await dialog.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.height <= 420, `close others dialog too tall: ${bounds.height}`);
    const scrolling = await dialog.locator('[data-slot="scroll-area-viewport"]').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return { height: element.clientHeight, total: element.scrollHeight, top: element.scrollTop };
    });
    assert.ok(scrolling.height <= 280 && scrolling.total > scrolling.height && scrolling.top > 0);
    const button = await dialog.getByRole('button', { name: '关闭', exact: true }).boundingBox();
    assert.ok(button.y >= bounds.y && button.y + button.height <= bounds.y + bounds.height);
    await page.screenshot({ path: `/tmp/shellspan-close-others-${viewport.width}.png` });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
  }

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
  // Render both command phases with the real lease store and production pane.
  // Phase changes must preserve the status bar and takeover button geometry.
  await page.evaluate(() => {
    const { agentTerminalLeaseState } = window.runtime;
    agentTerminalLeaseState.set({
      sessionId: window.identity.sessionId, agentSessionId: crypto.randomUUID(), taskId: crypto.randomUUID(),
      operationId: crypto.randomUUID(), acquiredAtUnixMs: Date.now(), state: 'acquired', commandPhase: 'typing',
      terminalOwned: true, inputBlocked: false, takeoverRequested: false, takeoverFailed: false,
      requestTakeover: () => agentTerminalLeaseState.clearAll(),
    });
  });
  for (const width of [1280, 420]) {
    await page.setViewportSize({ width, height: 800 });
    const bar = page.getByTestId('agent-terminal-lease-bar');
    await bar.locator('.agent-terminal-lease-description').filter({ hasText: '正在输入命令…' }).waitFor();
    assert.equal(await bar.locator('.agent-terminal-lease-status > *').count(), 1);
    assert.equal(await bar.getByText('键盘已锁定', { exact: true }).count(), 0);
    const typingBar = await bar.boundingBox();
    const takeover = bar.getByRole('button', { name: '停止并接管', exact: true });
    const typingButton = await takeover.boundingBox();
    assert.ok(typingButton.x >= typingBar.x && typingButton.x + typingButton.width <= typingBar.x + typingBar.width);
    await page.screenshot({ path: `/tmp/shellspan-terminal-typing-${width}.png` });
    await page.evaluate(async () => {
      const store = window.runtime.agentTerminalLeaseState;
      const lease = store.get(window.identity.sessionId);
      const coordinator = window.runtime.createAgentTerminalLeaseCoordinator();
      await coordinator.handle({ ...lease, operationId: crypto.randomUUID(), state: 'activity', commandPhase: 'running' });
      if (store.get(lease.sessionId).commandPhase !== 'typing') throw new Error('Stale activity changed the active lease');
      await coordinator.handle({ ...lease, state: 'activity', commandPhase: 'running' });
      coordinator.dispose();
    });
    await bar.locator('.agent-terminal-lease-description').filter({ hasText: 'Agent 正在此终端执行命令' }).waitFor();
    assert.deepEqual(await bar.boundingBox(), typingBar);
    assert.deepEqual(await takeover.boundingBox(), typingButton);
    await page.evaluate(async () => {
      const store = window.runtime.agentTerminalLeaseState;
      const lease = store.get(window.identity.sessionId);
      const coordinator = window.runtime.createAgentTerminalLeaseCoordinator();
      await coordinator.handle({ ...lease, state: 'activity', commandPhase: 'typing' });
      coordinator.dispose();
    });
  }
  for (const locale of ['en-US', 'zh-CN']) {
    await page.evaluate(async locale => {
      window.runtime.useAppStore.setState({ locale });
      await window.runtime.initI18n(locale);
      const store = window.runtime.agentTerminalLeaseState;
      const lease = store.get(window.identity.sessionId);
      store.update(lease.sessionId, lease.operationId, current => ({ ...current, terminalOwned: false }));
    }, locale);
    for (const width of [1280, 760, 600, 420, 320]) {
      await page.setViewportSize({ width, height: 800 });
      const bar = page.getByTestId('agent-terminal-lease-bar');
      const geometry = await bar.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const selectors = ['.agent-terminal-lease-status', '.agent-terminal-lease-description', '.agent-terminal-takeover'];
        return { width: element.clientWidth, overflow: element.scrollWidth > element.clientWidth,
          items: selectors.map(selector => {
            const rect = element.querySelector(selector).getBoundingClientRect();
            return { left: rect.left - bounds.left, right: rect.right - bounds.left, top: rect.top, bottom: rect.bottom };
          }) };
      });
      assert.equal(geometry.overflow, false, `Lease bar must fit ${locale} at ${width}px`);
      assert.ok(geometry.items.every(item => item.left >= 0 && item.right <= geometry.width + 1));
      const [status, description, action] = geometry.items;
      assert.ok(description.left >= status.right && action.left >= description.right,
        'Status, description and takeover must not overlap');
      assert.ok(Math.abs(status.top - action.top) < 1 && Math.abs(status.bottom - action.bottom) < 1,
        'Status and takeover must stay on one row');
      assert.ok(description.top >= status.top && description.bottom <= status.bottom,
        'Description must stay within the same row');
      assert.equal(await bar.locator('.agent-terminal-input-state').count(), 0);
      assert.equal(await bar.locator('.agent-terminal-lease-status > *').count(), 1);
      assert.equal(await bar.getByText(locale === 'zh-CN' ? '键盘已锁定' : 'Keyboard locked', { exact: true }).count(), 0);
      await bar.evaluate(async element => {
        await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished));
      });
      const iconAlignment = await bar.getByTestId('agent-terminal-lease-identity').evaluateAll(badges => badges.map(badge => {
        const bounds = badge.getBoundingClientRect();
        const icon = badge.querySelector('svg').getBoundingClientRect();
        const label = badge.querySelector('span');
        return {
          iconOnly: getComputedStyle(label).display === 'none',
          horizontal: Math.abs(icon.x + icon.width / 2 - bounds.x - bounds.width / 2),
          vertical: Math.abs(icon.y + icon.height / 2 - bounds.y - bounds.height / 2),
        };
      }));
      for (const alignment of iconAlignment) {
        assert.ok(alignment.vertical < 0.1, `Badge icon must be vertically centered at ${locale} ${width}px`);
        if (alignment.iconOnly) assert.ok(alignment.horizontal < 0.1,
          `Icon-only badge must be horizontally centered at ${locale} ${width}px: ${JSON.stringify(alignment)}`);
      }
      await bar.screenshot({ path: `/tmp/shellspan-terminal-lease-${locale}-${width}.png` });
    }
  }
  await page.getByTestId('agent-terminal-lease-bar').getByRole('button', { name: '停止并接管', exact: true }).click();
  await page.getByTestId('agent-terminal-lease-bar').waitFor({ state: 'detached' });
  if (process.env.SHELLSPAN_TYPING_TRACE_PATH) {
    const trace = readFileSync(process.env.SHELLSPAN_TYPING_TRACE_PATH, 'utf8');
    const rendered = await page.evaluate(async (trace) => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;inset:0;background:#1e1e2e;padding:12px';
      document.body.appendChild(host);
      const terminal = new window.runtime.Terminal({ cols: 32, rows: 30, cursorBlink: false });
      terminal.open(host);
      await new Promise((resolve) => terminal.write(trace, resolve));
      await new Promise(requestAnimationFrame);
      const lines = Array.from({ length: terminal.buffer.active.length }, (_, index) => terminal.buffer.active.getLine(index));
      return {
        rows: lines.map((line) => line.translateToString(true)).filter((line) => line.trim()),
        text: lines.map((line) => line.translateToString(true)).join(''),
      };
    }, trace);
    await page.screenshot({ path: '/tmp/shellspan-terminal-typing-wrap.png' });
    // ZLE emits explicit cursor/line controls when wrapping; xterm's isWrapped
    // flag only describes its own automatic wrap, not the rendered Shell layout.
    const commandStart = rendered.rows.findIndex((row) => row.includes("printf '%s' 'wrapped-com"));
    assert.ok(commandStart >= 0, JSON.stringify(rendered));
    const commandRows = rendered.rows.slice(commandStart);
    const nextPrompt = commandRows.findIndex((row, index) => index > 0 && row.startsWith('typing>'));
    assert.ok(nextPrompt >= 3, JSON.stringify(rendered));
    const commandText = commandRows.slice(0, nextPrompt).join('');
    assert.ok(commandText.includes("printf '%s' 'wrapped-command'"), commandText);
    assert.ok(commandText.endsWith("/wrap'"), commandText);
  }
  for (const width of [1200, 400]) {
    await page.setViewportSize({ width, height: 700 });
    const failure = await page.evaluate(async () => {
      const { terminalRegistry, useTerminalStore, t } = window.runtime;
      const store = useTerminalStore.getState();
      const id = store.beginConnectionAttempt({ title: 'SSH', host: '', port: 22, username: '' });
      const message = t('error.authenticationFailed');
      store.setStatus(id, { sessionId: id, status: 'error', message });
      store.endConnectionAttempt(id);
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;inset:0;background:white';
      document.body.appendChild(host);
      const controller = terminalRegistry.create(id, store.setStatus, store.setClosed,
        () => useTerminalStore.getState().sessions.find((s) => s.sessionId === id).status,
        () => {});
      controller.attach(host);
      controller.focus();
      await new Promise((resolve) => controller.terminal.write('\u001b[?25h', resolve));
      await new Promise(requestAnimationFrame);
      // WebGL draws the cursor on a canvas; check xterm's parsed cursor mode
      // shared by both renderers rather than a DOM-only selector.
      const cursorInitiallyVisible = !controller.terminal._core.coreService.isCursorHidden;
      controller.writeConnectionFailure(message);
      controller.writeConnectionFailure(message);
      await new Promise((resolve) => controller.terminal.write('', resolve));
      await new Promise(requestAnimationFrame);
      const text = Array.from({ length: controller.terminal.buffer.active.length }, (_, index) =>
        controller.terminal.buffer.active.getLine(index).translateToString(true)).join('');
      const cursorVisible = !controller.terminal._core.coreService.isCursorHidden;
      controller.rebindSession(`${id}-retry`);
      await new Promise((resolve) => controller.terminal.write('', resolve));
      await new Promise(requestAnimationFrame);
      const cursorRestored = !controller.terminal._core.coreService.isCursorHidden;
      terminalRegistry.dispose(`${id}-retry`);
      store.removeSession(id);
      host.remove();
      return { text, message, hint: t('terminal.notice.connectionFailedHint'), cursorInitiallyVisible, cursorVisible, cursorRestored };
    });
    assert.ok(failure.text.includes(failure.message), failure.text);
    assert.ok(failure.text.includes(failure.hint), failure.text);
    assert.equal(failure.text.split(failure.message).length - 1, 1);
    assert.equal(failure.cursorVisible, false);
    assert.equal(failure.cursorInitiallyVisible, true);
    assert.equal(failure.cursorRestored, true);
  }
  for (const width of [1200, 400]) {
    await page.setViewportSize({ width, height: 700 });
    const focusResult = await page.evaluate(async (terminalOutput) => {
      const { React, createRoot, flushSync, TerminalCarousel, terminalRegistry, useTerminalStore,
        useAppStore, useFocusStore, agentTerminalLeaseState, createAgentTerminalLeaseCoordinator } = window.runtime;
      const store = useTerminalStore.getState();
      const id = store.beginConnectionAttempt(window.identity);
      store.setStatus(id, { sessionId: id, status: 'disconnected' });
      const controller = terminalRegistry.create(id, store.setStatus, store.setClosed,
        () => useTerminalStore.getState().sessions.find((session) => session.sessionId === id).status,
        () => {});
      const otherId = store.beginConnectionAttempt(window.identity);
      store.setStatus(otherId, { sessionId: otherId, status: 'disconnected' });
      const otherController = terminalRegistry.create(otherId, store.setStatus, store.setClosed,
        () => useTerminalStore.getState().sessions.find((session) => session.sessionId === otherId).status,
        () => {});
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;inset:0;background:white';
      document.body.appendChild(host);
      const input = document.createElement('textarea');
      host.appendChild(input);
      const pane = document.createElement('div');
      pane.style.cssText = 'position:relative;height:300px';
      host.appendChild(pane);
      const root = createRoot(pane);
      window.dialogRoot.render(null);
      const Surface = () => {
        const section = useAppStore((state) => state.activeSection);
        const activeId = useTerminalStore((state) => state.activeSessionId);
        const sessions = useTerminalStore((state) => state.sessions);
        return React.createElement(TerminalCarousel, {
          sessions: sessions.filter((session) => session.sessionId === id || session.sessionId === otherId),
          activeSessionId: activeId,
          isActive: section === 'terminal', isVisible: section === 'terminal',
          onActivate: store.setActiveSession, onSettle: () => {},
        });
      };
      useAppStore.getState().setActiveSection('terminal');
      store.setActiveSession(otherId);
      flushSync(() => root.render(React.createElement(Surface)));
      otherController.focus();
      const otherInitiallyFocused = document.activeElement === otherController.terminal.textarea;
      flushSync(() => useAppStore.getState().setActiveSection('workbench'));
      input.focus();
      const coordinator = createAgentTerminalLeaseCoordinator();
      const reboundId = crypto.randomUUID();
      const lease = {
        sessionId: id, agentSessionId: crypto.randomUUID(), taskId: crypto.randomUUID(),
        operationId: crypto.randomUUID(), acquiredAtUnixMs: Date.now(), state: 'acquired',
      };
      try {
        await coordinator.handle(lease);
        const focused = document.activeElement === controller.terminal.textarea;
        await new Promise(requestAnimationFrame);
        const focusedAfterFrame = document.activeElement === controller.terminal.textarea;
        input.focus();
        await coordinator.handle(lease);
        await coordinator.handle({ ...lease, operationId: crypto.randomUUID(), state: 'activity', commandPhase: 'typing' });
        const duplicatePreservedFocus = document.activeElement === input;
        flushSync(() => store.setActiveSession(otherId));
        otherController.focus();
        await coordinator.handle({ ...lease, operationId: crypto.randomUUID() });
        await new Promise((resolve) => controller.terminal.write(terminalOutput.replace(/\n/g, '\r\n'), resolve));
        if (controller.terminal.buffer.active.type !== 'normal' || controller.terminal.buffer.active.baseY === 0) {
          throw new Error('Scroll-button regression requires real terminal scrollback');
        }
        controller.terminal.scrollToTop();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (controller.terminal.buffer.active.viewportY >= controller.terminal.buffer.active.baseY) {
          throw new Error('Scroll-button regression requires the terminal to be away from the bottom');
        }
        if (Array.from(pane.querySelectorAll('button')).some((button) => /回到最新输出|有新输出|Jump to latest output|Jump to bottom/.test(button.textContent))) {
          throw new Error('Terminal pane must not show the removed scroll button');
        }
        const result = {
          otherInitiallyFocused, focused, focusedAfterFrame, duplicatePreservedFocus,
          nextCommandFocused: document.activeElement === controller.terminal.textarea,
          selected: useTerminalStore.getState().activeSessionId === id,
          visible: useAppStore.getState().activeSection === 'terminal',
        };
        flushSync(() => useFocusStore.getState().enter());
        flushSync(() => store.setActiveSession(otherId));
        input.focus();
        const focusTarget = useFocusStore.getState().targetSessionId;
        try {
          for (let command = 0; command < 2; command++) {
            const backgroundLease = { ...lease, agentSessionId: 'agent-background-terminal', operationId: crypto.randomUUID() };
            await coordinator.handle(backgroundLease);
            assertBackgroundView();
            if (!agentTerminalLeaseState.get(id)?.terminalOwned) throw new Error('Background command must retain terminal ownership');
            if (await controller.writeUserInput('blocked')) throw new Error('Background lease must still block user input');
            await coordinator.handle({ ...backgroundLease, state: 'released' });
            assertBackgroundView();
          }
        } finally {
          flushSync(() => useFocusStore.getState().leave());
        }
        function assertBackgroundView() {
          if (!useFocusStore.getState().enabled || useTerminalStore.getState().workspace !== 'focus'
            || useTerminalStore.getState().activeSessionId !== otherId
            || useFocusStore.getState().targetSessionId !== focusTarget
            || useAppStore.getState().activeSection !== 'terminal'
            || document.activeElement !== input) throw new Error('Background command changed the Focus workspace or keyboard focus');
        }
        input.focus();
        const pending = coordinator.handle({ ...lease, operationId: crypto.randomUUID() });
        // Let acquisition capture its controller and await output readiness,
        // then exercise the real reconnect/rebind lifecycle before it resumes.
        await Promise.resolve();
        terminalRegistry.rebindSession(id, reboundId);
        await pending;
        return { ...result, rebindPreservedFocus: document.activeElement === input };
      } finally {
        coordinator.dispose();
        root.unmount();
        terminalRegistry.dispose(id);
        terminalRegistry.dispose(reboundId);
        terminalRegistry.dispose(otherId);
        store.removeSession(id);
        store.removeSession(otherId);
        host.remove();
      }
    }, output);
    assert.deepEqual(focusResult, {
      otherInitiallyFocused: true, focused: true, focusedAfterFrame: true, duplicatePreservedFocus: true,
      nextCommandFocused: true, selected: true, visible: true, rebindPreservedFocus: true,
    });
  }
  for (const width of [1200, 400]) {
    await page.setViewportSize({ width, height: 700 });
    const splitFocus = await page.evaluate(async () => {
      const { React, createRoot, flushSync, TerminalWorkspace, terminalRegistry,
        useTerminalStore, useFocusStore, useAppStore, createAgentTerminalLeaseCoordinator } = window.runtime;
      const previousSessions = useTerminalStore.getState().sessions;
      const ids = [crypto.randomUUID(), crypto.randomUUID()];
      useTerminalStore.setState({ sessions: [], activeSessionId: null, restoredLayout: null });
      useTerminalStore.getState().addRestoredSessions(ids.map((sessionId) => ({ ...window.identity, sessionId })));
      useTerminalStore.setState({ activeSessionId: ids[0], restoredLayout: {
        kind: 'split', orientation: 'horizontal', split: 0.5,
        first: { kind: 'group', id: 'first', sessionIds: [ids[0]], activeSessionId: ids[0] },
        second: { kind: 'group', id: 'second', sessionIds: [ids[1]], activeSessionId: ids[1] },
      } });
      useAppStore.setState({ activeSection: 'terminal', restoreWorkspace: false });
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;inset:0;background:white';
      document.body.appendChild(host);
      const input = document.createElement('textarea');
      host.appendChild(input);
      const surface = document.createElement('div');
      surface.style.cssText = 'height:500px;position:relative';
      host.appendChild(surface);
      const root = createRoot(surface);
      const coordinator = createAgentTerminalLeaseCoordinator();
      const focusedIds = [];
      const recordFocus = (event) => {
        for (const id of ids) if (event.target === terminalRegistry.get(id)?.terminal.textarea) focusedIds.push(id);
      };
      try {
        flushSync(() => root.render(React.createElement(TerminalWorkspace)));
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const first = terminalRegistry.get(ids[0]);
        const second = terminalRegistry.get(ids[1]);
        const store = useTerminalStore.getState();
        flushSync(() => store.switchWorkspace('focus'));
        const focusStartsUnsplit = surface.querySelectorAll('[data-terminal-group]').length === 0;
        flushSync(() => {
          store.setActiveSession(ids[1]);
          store.reorderSessions(ids[1], 0);
        });
        flushSync(() => store.switchWorkspace('terminal'));
        await new Promise(requestAnimationFrame);
        const terminalRestored = surface.querySelectorAll('[data-terminal-group]').length === 2
          && useTerminalStore.getState().activeSessionId === ids[0]
          && useTerminalStore.getState().sessions[0].sessionId === ids[0];
        flushSync(() => store.switchWorkspace('focus'));
        await new Promise(requestAnimationFrame);
        const focusRestored = useTerminalStore.getState().activeSessionId === ids[1]
          && useTerminalStore.getState().sessions[0].sessionId === ids[1]
          && surface.querySelectorAll('[data-terminal-group]').length === 0;
        const controllersRetained = terminalRegistry.get(ids[0]) === first && terminalRegistry.get(ids[1]) === second;
        const activePage = surface.querySelector(`[data-terminal-carousel-page="${ids[1]}"]`);
        const carousel = surface.querySelector('[data-terminal-carousel]');
        const activePageAligned = activePage && carousel
          && Math.abs(activePage.getBoundingClientRect().left - carousel.getBoundingClientRect().left) <= 1;
        flushSync(() => {
          useFocusStore.getState().enter();
          useFocusStore.getState().leave();
        });
        await new Promise(requestAnimationFrame);
        await coordinator.handle({
          sessionId: ids[1], agentSessionId: `focus-agent-${crypto.randomUUID()}`, taskId: crypto.randomUUID(),
          operationId: crypto.randomUUID(), acquiredAtUnixMs: Date.now(), state: 'acquired',
        });
        const focusCommandRouted = !useFocusStore.getState().enabled
          && useTerminalStore.getState().workspace === 'terminal'
          && useTerminalStore.getState().activeSessionId === ids[1]
          && document.activeElement === second.terminal.textarea;
        const focusSelectionPreserved = useTerminalStore.getState().workspaceViews.focus.activeSessionId === ids[1];
        flushSync(() => store.setActiveSession(ids[0]));
        first.focus();
        const sourceInitiallyFocused = document.activeElement === first.terminal.textarea;
        flushSync(() => {
          useFocusStore.getState().enter();
          store.setActiveSession(ids[0]);
        });
        flushSync(() => useAppStore.getState().setActiveSection('workbench'));
        input.focus();
        document.addEventListener('focusin', recordFocus);
        const terminalLease = {
          sessionId: ids[1], agentSessionId: `agent-${crypto.randomUUID()}`, taskId: crypto.randomUUID(),
          operationId: crypto.randomUUID(), acquiredAtUnixMs: Date.now(), state: 'acquired',
        };
        await coordinator.handle(terminalLease);
        await new Promise(requestAnimationFrame);
        const backgroundPreservedFocus = useFocusStore.getState().enabled
          && useTerminalStore.getState().workspace === 'focus'
          && useTerminalStore.getState().activeSessionId === ids[0]
          && useAppStore.getState().activeSection === 'workbench'
          && document.activeElement === input && focusedIds.length === 0;
        await coordinator.handle({ ...terminalLease, state: 'released' });
        const releasePreservedFocus = document.activeElement === input;
        flushSync(() => useFocusStore.getState().leave());
        await coordinator.handle({
          ...terminalLease, operationId: crypto.randomUUID(),
        });
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return {
          workspaceIsolation: Boolean(focusStartsUnsplit && terminalRestored && focusRestored && controllersRetained && activePageAligned),
          commandWorkspaceRouting: focusCommandRouted && focusSelectionPreserved
            && !useFocusStore.getState().enabled && useTerminalStore.getState().workspace === 'terminal'
            && useTerminalStore.getState().workspaceViews.focus.activeSessionId === ids[0],
          sourceInitiallyFocused,
          backgroundPreservedFocus, releasePreservedFocus,
          targetFocused: document.activeElement === terminalRegistry.get(ids[1]).terminal.textarea,
          focusedOtherTerminal: focusedIds.includes(ids[0]),
          targetFocusObserved: focusedIds.includes(ids[1]),
          targetGroupSelected: surface.querySelector('[data-terminal-group="second"] [data-session-tab][aria-selected="true"]') !== null,
        };
      } finally {
        document.removeEventListener('focusin', recordFocus);
        coordinator.dispose();
        useFocusStore.getState().leave();
        root.unmount();
        for (const id of ids) terminalRegistry.dispose(id);
        useTerminalStore.setState({ sessions: previousSessions, activeSessionId: window.identity.sessionId, restoredLayout: null });
        useTerminalStore.setState({ workspace: 'terminal', workspaceViews: {}, workspaceSplit: null, workspaceFocusedSlot: 'first' });
        host.remove();
      }
    });
    assert.deepEqual(splitFocus, {
      workspaceIsolation: true,
      commandWorkspaceRouting: true,
      sourceInitiallyFocused: true, targetFocused: true, focusedOtherTerminal: false,
      backgroundPreservedFocus: true, releasePreservedFocus: true,
      targetFocusObserved: true, targetGroupSelected: true,
    });
  }
  const carouselResize = await page.evaluate(async ({ output, identity }) => {
    const { React, createRoot, TerminalCarousel, terminalRegistry, useTerminalStore } = window.runtime;
    const store = useTerminalStore.getState();
    const ids = Array.from({ length: 3 }, () => {
      const sessionId = crypto.randomUUID();
      store.addSession({ ...identity, sessionId });
      return sessionId;
    });
    for (const id of ids) {
      store.setStatus(id, { sessionId: id, status: 'disconnected' });
      terminalRegistry.create(id, store.setStatus, store.setClosed,
        () => useTerminalStore.getState().sessions.find((session) => session.sessionId === id).status,
        () => {});
    }
    const sessions = useTerminalStore.getState().sessions.filter((session) => ids.includes(session.sessionId));
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:700px;height:500px;background:white';
    document.body.appendChild(host);
    const root = createRoot(host);
    const activations = [];
    const settlements = [];
    root.render(React.createElement(TerminalCarousel, {
      sessions, activeSessionId: ids[1], isActive: false, isVisible: true,
      onActivate: (id) => activations.push(id), onSettle: (id) => settlements.push(id),
    }));
    const frame = () => new Promise(requestAnimationFrame);
    try {
      for (let i = 0; i < 10; i++) await frame();
      await new Promise((resolve) => terminalRegistry.get(ids[1]).terminal.write(output, resolve));
      await new Promise((resolve) => setTimeout(resolve, 200));
      activations.length = 0;
      settlements.length = 0;
      let terminalMounts = 0;
      const observer = new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof Element) terminalMounts += Number(node.matches('.xterm')) + node.querySelectorAll('.xterm').length;
        }
      });
      observer.observe(host, { childList: true, subtree: true });
      for (const width of [680, 600, 480, 350, 420, 560, 700]) {
        host.style.width = `${width}px`;
        for (let i = 0; i < 12; i++) await frame();
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      observer.disconnect();
      const viewport = host.querySelector('[data-terminal-carousel]');
      const activePage = host.querySelector(`[data-terminal-carousel-page="${ids[1]}"]`);
      const aligned = Math.abs(activePage.getBoundingClientRect().left - viewport.getBoundingClientRect().left) < 1;
      return { activations, settlements, terminalMounts, aligned };
    } finally {
      root.unmount();
      for (const id of ids) { terminalRegistry.dispose(id); store.removeSession(id); }
      host.remove();
    }
  }, { output, identity });
  assert.deepEqual(carouselResize, { activations: [], settlements: [], terminalMounts: 0, aligned: true });
  assert.deepEqual(errors, []);
  process.stdout.write('Terminal experience regressions passed with real xterm and WebKit at wide and narrow sizes.\n');
} finally {
  await browser?.close();
  await server.close();
}
