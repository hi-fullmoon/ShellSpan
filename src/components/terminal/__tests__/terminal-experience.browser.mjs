import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { userInfo, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';
import { createCanvas, loadImage } from 'canvas';

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
  cacheDir: `${root}artifacts/tests/terminal-experience/vite-cache`,
  optimizeDeps: {
    entries: ['src/components/terminal/index.tsx', 'src/components/ai/ai-panel.tsx'],
    include: ['react', 'react-dom/client', '@xterm/xterm', '@xterm/addon-search', '@xterm/addon-fit'],
  },
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
        export { TerminalSearchAddon } from '/src/components/terminal/terminal-search-addon.ts';
        export { TerminalSearch } from '/src/components/terminal/terminal-search.tsx';
        export { TerminalPastePreview } from '/src/components/terminal/terminal-paste-preview.tsx';
        export { TerminalCloseDetails } from '/src/components/terminal/terminal-close-details.tsx';
        export { TerminalPane } from '/src/components/terminal/terminal-pane.tsx';
        export { TerminalResizeIndicator } from '/src/components/terminal/terminal-resize-indicator.tsx';
        export { default as TerminalWorkspace } from '/src/components/terminal/index.tsx';
        export { AppShell } from '/src/components/layout/app-shell.tsx';
        export { AiPanel } from '/src/components/ai/ai-panel.tsx';
        export { agentTerminalLeaseState } from '/src/components/terminal/agent-terminal-lease-state.ts';
        export { useTerminalTaskNavigation } from '/src/components/terminal/agent-terminal-task-navigation.ts';
        export { useAiPanelStore } from '/src/stores/aiPanelStore.ts';
        export { useAgentPermissionStore } from '/src/stores/agentPermissionStore.ts';
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
  browser = process.env.SHELLSPAN_BROWSER_CHANNEL
    ? await chromium.launch({ channel: process.env.SHELLSPAN_BROWSER_CHANNEL })
    : await webkit.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.evaluate(async (identity) => {
    const runtime = await import('/experience-runtime.js');
    window.runtime = runtime;
    window.observeReboundOutput = (controller) => controller.whenOutputReady().catch((error) => {
      // A browser can exercise the renderer rebind, while IPC listeners require Tauri.
      if (!(error instanceof TypeError) || window.__TAURI_INTERNALS__
        || !/(__TAURI_INTERNALS__|transformCallback)/.test(error.message)) throw error;
    });
    const { React, createRoot, Terminal, TerminalSearchAddon, FitAddon, resolveTerminalTheme, TERMINAL_CONTAINER_CLASS, TerminalSearch, useAppStore, initI18n } = runtime;
    useAppStore.setState({ locale: 'zh-CN' });
    await initI18n('zh-CN');
    document.documentElement.setAttribute('data-theme', 'light');
    const terminal = new Terminal({ cols: 100, rows: 14, scrollback: 10000, allowProposedApi: true, theme: resolveTerminalTheme('light') });
    const addon = new TerminalSearchAddon();
    const fit = new FitAddon();
    terminal.loadAddon(addon);
    terminal.loadAddon(fit);
    document.getElementById('terminal').className = TERMINAL_CONTAINER_CLASS;
    terminal.open(document.getElementById('terminal'));
    fit.fit();
    window.terminal = terminal;
    window.addon = addon;
    window.fit = fit;
    window.identity = identity;
    const controls = createRoot(document.getElementById('controls'));
    const dialog = createRoot(document.getElementById('dialog'));
    window.dialogRoot = dialog;
    controls.render(React.createElement(TerminalSearch, {
      addon,
      onClose: () => { controls.render(null); terminal.focus(); },
    }));
  }, identity);

  // Exercise an actual xterm hyperlink, then plain terminal text.
  const linkPosition = await page.evaluate(async () => {
    const terminal = window.terminal;
    const url = new URL('/package.json', location.href).href;
    await new Promise(resolve => terminal.write(`\x1b]8;;${url}\x1b\\package.json\x1b]8;;\x1b\\`, resolve));
    const rect = terminal.element.querySelector('.xterm-screen').getBoundingClientRect();
    return { x: rect.x + 1.5 * rect.width / terminal.cols, y: rect.y + 0.5 * rect.height / terminal.rows };
  });
  const terminalSurface = page.locator('#terminal .xterm-screen');
  await page.mouse.move(linkPosition.x, linkPosition.y);
  await page.locator('#terminal .xterm-cursor-pointer').waitFor();
  assert.equal(await terminalSurface.evaluate(element => getComputedStyle(element).cursor), 'default', 'Terminal links use the default cursor');
  await page.mouse.move(0, 400);
  await page.evaluate(async (output) => {
    window.terminal.reset();
    await new Promise(resolve => window.terminal.write(output.replace(/\n/g, '\r\n'), resolve));
  }, output);
  assert.equal(await terminalSurface.evaluate(element => getComputedStyle(element).cursor), 'text', 'Plain terminal text retains the text cursor');

  const search = page.getByRole('textbox', { name: '搜索...' });
  const searchBar = page.locator('[data-terminal-search]');
  const searchField = searchBar.locator('[data-slot=input-group]');
  const caseToggle = page.getByRole('button', { name: '区分大小写' });
  const regexToggle = page.getByRole('button', { name: '使用正则表达式' });
  assert.equal(await searchField.getByRole('textbox').count(), 1);
  assert.equal(await searchField.getByRole('button', { name: '区分大小写' }).count(), 1);
  assert.equal(await searchField.getByRole('button', { name: '使用正则表达式' }).count(), 1);
  await search.focus();
  await search.press('Tab');
  assert.ok(await caseToggle.evaluate(element => element === document.activeElement));
  await caseToggle.press('Tab');
  assert.ok(await regexToggle.evaluate(element => element === document.activeElement));
  await search.fill('terminal');
  const count = [...output.matchAll(/terminal/gi)].length;
  await page.waitForFunction((count) => document.querySelector('[data-terminal-search] [role=status]')?.textContent === `1/${count}`, count);
  await search.press('Enter');
  assert.equal(await page.locator('[data-terminal-search] [role=status]').textContent(), `2/${count}`);
  await search.press('Shift+Enter');
  assert.equal(await page.locator('[data-terminal-search] [role=status]').textContent(), `1/${count}`);
  await page.getByRole('button', { name: '下一个', exact: true }).click();
  assert.equal(await page.locator('[data-terminal-search] [role=status]').textContent(), `2/${count}`);
  await page.getByRole('button', { name: '上一个', exact: true }).click();
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
  const word = 'word' + crypto.randomUUID().replaceAll('-', '');
  await page.evaluate(async (value) => {
    await new Promise(resolve => window.terminal.write('\r\n' + value + ' ' + value + 's ' + value + '\r\n', resolve));
  }, word);
  await search.fill(word);
  const searchStatus = searchBar.getByRole('status');
  await page.waitForFunction(() => document.querySelector('[data-terminal-search] [role=status]')?.textContent.endsWith('/3'));
  const wholeWordToggle = searchBar.getByRole('button', { name: '全词匹配', exact: true });
  await wholeWordToggle.click();
  await page.waitForFunction(() => document.querySelector('[data-terminal-search] [role=status]')?.textContent.endsWith('/2'));
  const firstWord = await searchStatus.textContent();
  await search.press('Control+g');
  assert.notEqual(await searchStatus.textContent(), firstWord);
  await search.press('Control+Shift+g');
  assert.equal(await searchStatus.textContent(), firstWord);
  await wholeWordToggle.click();
  await page.evaluate(async (text) => {
    window.terminal.reset();
    await new Promise(resolve => window.terminal.write(text.replace(/\n/g, '\r\n'), resolve));
  }, output);
  await search.fill('terminal');
  await page.mouse.move(0, 400);

  for (const scheme of ['catppuccinMocha', 'solarizedDark', 'light', 'app']) {
    for (const appTheme of ['light', 'dark']) {
      await page.evaluate(({ scheme, appTheme }) => {
        document.documentElement.dataset.theme = appTheme;
        window.runtime.useAppStore.setState({ terminalColorScheme: scheme });
        window.terminal.options.theme = window.runtime.resolveTerminalTheme(scheme);
      }, { scheme, appTheme });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await searchBar.evaluate(async element => {
        await Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished));
      });
      const colors = await page.locator('[data-terminal-search]').evaluate((element, scheme) => {
        const theme = window.runtime.resolveTerminalTheme(scheme);
        const probe = document.createElement('div');
        probe.style.color = theme.foreground;
        probe.style.backgroundColor = theme.background;
        document.body.appendChild(probe);
        const expected = getComputedStyle(probe);
        const inputGroup = element.querySelector('[data-slot=input-group]');
        const result = {
          text: [...element.querySelectorAll('input,button,[role=status]')].every(control => getComputedStyle(control).color === expected.color),
          inputBackground: getComputedStyle(inputGroup).backgroundColor === expected.backgroundColor,
          actual: [...element.querySelectorAll('input,button')].map(control => ({ color: getComputedStyle(control).color, background: getComputedStyle(control).backgroundColor })),
          expected: { color: expected.color, background: expected.backgroundColor },
        };
        probe.remove();
        return result;
      }, scheme);
      assert.ok(colors.text && colors.inputBackground, `${scheme}/${appTheme}: ${JSON.stringify(colors)}`);
    }
  }
  for (const { width, height, paneWidth, paneHeight = 360 } of [
    { width: 1280, height: 800, paneWidth: 900 },
    { width: 1280, height: 800, paneWidth: 260 },
    { width: 1280, height: 800, paneWidth: 240 },
    { width: 1280, height: 800, paneWidth: 130 },
    { width: 1280, height: 800, paneWidth: 140, paneHeight: 98 },
    { width: 320, height: 420, paneWidth: 320 },
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(({ paneWidth, paneHeight }) => {
      const pane = document.getElementById('pane');
      pane.style.width = `${paneWidth}px`;
      pane.style.height = `${paneHeight}px`;
      window.fit.fit();
    }, { paneWidth, paneHeight });
    const geometry = await searchBar.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const pane = document.getElementById('pane').getBoundingClientRect();
      const controls = [...element.querySelectorAll('input,button')].map((control) => control.getBoundingClientRect().height);
      const buttons = [...element.querySelectorAll('button')].map((button) => {
        const { width, height } = button.getBoundingClientRect();
        return { width, height };
      });
      const rects = [...element.querySelectorAll('input,button,[role=status]')].map(control => control.getBoundingClientRect());
      const field = element.querySelector('[data-slot=input-group]');
      const fieldRect = field.getBoundingClientRect();
      const fieldStyle = getComputedStyle(field);
      const fieldTopInner = fieldRect.top + parseFloat(fieldStyle.borderTopWidth);
      const fieldBottomInner = fieldRect.bottom - parseFloat(fieldStyle.borderBottomWidth);
      const optionInsets = [...field.querySelectorAll('button')].map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          top: rect.top - fieldTopInner,
          bottom: fieldBottomInner - rect.bottom,
        };
      });
      return {
        inside: bounds.left >= pane.left && bounds.right <= pane.right && bounds.top >= pane.top && bounds.bottom <= pane.bottom,
        height: bounds.height,
        controls,
        buttons,
        optionInsets,
        fieldRadius: parseFloat(fieldStyle.borderTopLeftRadius),
        barRadius: parseFloat(getComputedStyle(element).borderTopLeftRadius),
        centers: rects.map(rect => rect.top + rect.height / 2),
        leftEdges: rects.map(rect => rect.left),
        overflow: element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight,
      };
    });
    assert.ok(geometry.inside && !geometry.overflow, JSON.stringify(geometry));
    assert.ok(geometry.controls.every((height) => height === geometry.controls[0]), JSON.stringify(geometry));
    assert.ok(geometry.buttons.every(({ width, height }) => width === height), `Search buttons must be square: ${JSON.stringify(geometry.buttons)}`);
    assert.ok(geometry.optionInsets.every(({ top, bottom }) => top >= 2 && bottom >= 2), `Search option buttons must not touch the field border: ${JSON.stringify(geometry.optionInsets)}`);
    assert.ok(geometry.fieldRadius > 0 && geometry.fieldRadius < geometry.barRadius, 'The search field should have tighter corners than the search bar');
    const [input, caseOption, regexOption, wholeWordOption, status, previous, next, close] = geometry.centers;
    assert.ok(caseOption === regexOption && regexOption === wholeWordOption, 'The search options must stay together');
    assert.ok(previous === next && next === close, 'The arrows and close button must stay together');
    if (paneWidth === 900) {
      assert.equal(geometry.height, 32, 'The single-line search bar should be 32px tall');
      assert.ok(geometry.centers.every(center => Math.abs(center - input) < 1), JSON.stringify(geometry));
      assert.ok(geometry.leftEdges.every((left, index, edges) => index === 0 || left > edges[index - 1]), JSON.stringify(geometry));
    } else {
      assert.ok(status > caseOption, 'The result count must wrap below the search field');
      if (paneWidth <= 140) {
        assert.ok(caseOption > input && previous > status, 'Very narrow panes must give the input and navigation room to wrap');
      } else {
        assert.equal(input, caseOption, 'Search options should stay beside the input when space allows');
        assert.ok(Math.abs(status - previous) < 1, 'The result count should stay beside the navigation when space allows');
      }
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
    await search.fill(originalQuery);
    await page.waitForFunction(() => document.querySelector('[data-terminal-search] [role=status]')?.textContent.includes('/'));
    if (paneHeight === 98) {
      for (const name of ['上一个', '下一个', '关闭搜索']) {
        await searchBar.getByRole('button', { name, exact: true }).click({ trial: true });
      }
    }
    await searchBar.screenshot({ animations: 'disabled', path: `${root}artifacts/tests/terminal-search/dark-${paneWidth}.png` });
    if (paneWidth === 900) {
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      await searchBar.screenshot({ animations: 'disabled', path: `${root}artifacts/tests/terminal-search/light-${paneWidth}.png` });
    }
    if (paneWidth === 900 || paneWidth === 260) {
      const closeButton = searchBar.getByRole('button', { name: '关闭搜索', exact: true });
      const idleFill = await closeButton.evaluate(button => getComputedStyle(button).backgroundColor);
      await closeButton.hover();
      const theme = paneWidth === 900 ? 'light' : 'dark';
      await searchBar.screenshot({ animations: 'disabled', path: `${root}artifacts/tests/terminal-search/${theme}-${paneWidth}-hover.png` });
      assert.notEqual(await closeButton.evaluate(button => getComputedStyle(button).backgroundColor), idleFill);
      await page.mouse.move(0, 400);
    }
    if (paneWidth === 900) {
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    }
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
  await regexToggle.focus();
  await regexToggle.press('Escape');
  assert.equal(await page.locator('[data-terminal-search]').count(), 0);
  assert.ok(await page.locator('.xterm-helper-textarea').evaluate((element) => element === document.activeElement));
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    window.runtime.useAppStore.setState({ terminalColorScheme: 'catppuccinMocha' });
    window.terminal.options.theme = window.runtime.resolveTerminalTheme('catppuccinMocha');
  });

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
  const reconnectResize = await page.evaluate(() => {
    const { React, flushSync, TerminalPane, terminalRegistry, useTerminalStore, t } = window.runtime;
    const store = useTerminalStore.getState();
    const id = store.beginConnectionAttempt(window.identity);
    store.setStatus(id, { sessionId: id, status: 'disconnected' });
    const getSession = () => useTerminalStore.getState().sessions.find((session) => session.sessionId === id);
    const controller = terminalRegistry.create(id, store.setStatus, store.setClosed, () => getSession().status, () => {});
    const host = document.getElementById('dialog');
    const renderPane = () => window.dialogRoot.render(React.createElement(TerminalPane, { activeSession: getSession() }));
    const resize = (width) => flushSync(() => { host.style.width = `${width}px`; controller.fit(); });
    const inspect = () => ({
      cols: controller.terminal.cols,
      hint: host.querySelector('[data-testid="terminal-resize-indicator"]')?.textContent ?? null,
      reconnecting: [...host.querySelectorAll('[role="status"]')].some((element) =>
        element.getAttribute('aria-label') === t('terminal.notice.reconnectingLabel')),
    });
    try {
      host.style.height = '300px';
      flushSync(renderPane);
      resize(760);
      const initial = inspect();
      store.setReconnecting(id, true);
      flushSync(renderPane);
      const started = inspect();
      resize(360);
      const during = inspect();
      store.setReconnecting(id, false);
      flushSync(renderPane);
      const ended = inspect();
      resize(760);
      return { initial, started, during, ended, next: inspect() };
    } finally {
      flushSync(() => window.dialogRoot.render(null));
      controller.dispose();
      store.removeSession(id);
      host.style.removeProperty('width');
      host.style.removeProperty('height');
    }
  });
  const { initial, started, during, ended, next } = reconnectResize;
  assert.ok(initial.hint, 'A pane resize displays the grid dimensions');
  assert.deepEqual(started, { cols: initial.cols, hint: null, reconnecting: true }, 'Reconnecting dismisses visible dimensions');
  assert.ok(during.cols < started.cols, 'The terminal grid still resizes during reconnect');
  assert.deepEqual(during, { cols: during.cols, hint: null, reconnecting: true }, 'The reconnect prompt remains visible on a narrow pane');
  assert.deepEqual(ended, { cols: during.cols, hint: null, reconnecting: false }, 'Ending reconnect does not restore stale dimensions');
  assert.ok(next.hint && next.cols === initial.cols, 'The next resize displays dimensions again');

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
  const leaseBar = page.getByTestId('agent-terminal-lease-bar');
  const terminalBounds = () => leaseBar.evaluate(element => element.nextElementSibling.getBoundingClientRect().toJSON());
  await leaseBar.waitFor({ state: 'detached' });
  const measureEntrance = () => page.evaluate(() => {
    const { flushSync, useAgentPermissionStore } = window.runtime;
    flushSync(() => useAgentPermissionStore.getState().setExecutionSurface(window.identity.sessionId, 'boundTerminal'));
    const bar = document.querySelector('[data-testid="agent-terminal-lease-bar"]');
    const row = bar.firstElementChild;
    const animation = row.getAnimations()[0];
    const opacity = () => Number(getComputedStyle(row).opacity);
    if (!animation) return { animated: false, opacity: opacity() };
    const terminalBounds = () => bar.nextElementSibling.getBoundingClientRect().toJSON();
    const duration = animation.effect.getComputedTiming().duration;
    animation.pause();
    animation.currentTime = 0;
    const start = { opacity: opacity(), bounds: terminalBounds() };
    animation.currentTime = duration / 2;
    const middle = { opacity: opacity(), bounds: terminalBounds() };
    animation.finish();
    const end = { opacity: opacity(), bounds: terminalBounds() };
    return { animated: true, duration, start, middle, end };
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.deepEqual(await measureEntrance(), { animated: false, opacity: 1 });
  await page.evaluate(() => window.runtime.useAgentPermissionStore.getState().setExecutionSurface(window.identity.sessionId, 'direct'));
  await leaseBar.waitFor({ state: 'detached' });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const entrance = await measureEntrance();
  assert.equal(entrance.animated, true);
  assert.equal(entrance.duration, 150);
  assert.equal(entrance.start.opacity, 0);
  assert.ok(entrance.middle.opacity > 0 && entrance.middle.opacity < 1);
  assert.equal(entrance.end.opacity, 1);
  assert.deepEqual(entrance.start.bounds, entrance.middle.bounds);
  assert.deepEqual(entrance.middle.bounds, entrance.end.bounds);
  const inputAvailable = leaseBar.getByText('输入可用', { exact: true });
  const idleTerminalBounds = new Map();
  for (const width of [1280, 420, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await inputAvailable.waitFor();
    await leaseBar.getByText('可视命令', { exact: true }).waitFor();
    assert.equal(await leaseBar.getByRole('button').count(), 0);
    idleTerminalBounds.set(width, await terminalBounds());
  }
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
    await bar.getByText('输入锁定', { exact: true }).waitFor();
    assert.deepEqual(await terminalBounds(), idleTerminalBounds.get(width), 'Starting an Agent command must preserve the terminal viewport');
    assert.equal(await bar.evaluate(element => element.firstElementChild.getAnimations().some(animation => animation.playState === 'running')), false,
      'Changing the state of an already visible status bar must not replay the entrance');
    const typingBar = await bar.boundingBox();
    const takeover = bar.getByRole('button', { name: '停止并接管', exact: true });
    const typingButton = await takeover.boundingBox();
    assert.ok(typingButton.x >= typingBar.x && typingButton.x + typingButton.width <= typingBar.x + typingBar.width);
    await page.evaluate(async () => {
      const store = window.runtime.agentTerminalLeaseState;
      const lease = store.get(window.identity.sessionId);
      const coordinator = window.runtime.createAgentTerminalLeaseCoordinator();
      await coordinator.handle({ ...lease, operationId: crypto.randomUUID(), state: 'activity', commandPhase: 'running' });
      if (store.get(lease.sessionId).commandPhase !== 'typing') throw new Error('Stale activity changed the active lease');
      await coordinator.handle({ ...lease, state: 'activity', commandPhase: 'running' });
      coordinator.dispose();
    });
    await bar.locator('.agent-terminal-lease-description').filter({ hasText: 'Agent 正在执行命令' }).waitFor();
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
      const activity = locale === 'zh-CN' ? 'Agent 正在处理' : 'Agent is working';
      const lock = locale === 'zh-CN' ? '输入锁定' : 'Input locked';
      const taskButton = bar.getByRole('button', { name: locale === 'zh-CN' ? '查看任务' : 'View task', exact: true });
      const takeover = bar.getByRole('button', { name: locale === 'zh-CN' ? '停止并接管' : 'Stop & take over', exact: true });
      const description = bar.getByText(activity, { exact: true });
      const lockLabel = bar.getByText(lock, { exact: true });
      await description.waitFor();
      await lockLabel.waitFor();
      await taskButton.waitFor();
      const identityBadge = bar.getByTestId('agent-terminal-lease-identity');
      const badgeBounds = await identityBadge.boundingBox();
      const iconBounds = await identityBadge.locator('svg').boundingBox();
      assert.deepEqual([badgeBounds.width, badgeBounds.height], [24, 24], 'The status icon background must stay compact');
      assert.deepEqual([iconBounds.width, iconBounds.height], [12, 12], 'The terminal glyph must fit the compact background');
      assert.equal(await takeover.locator('svg').count(), 0, 'The takeover button should contain text only');
      const geometry = await bar.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const status = element.querySelector('.agent-terminal-lease-status');
        const items = [status, ...element.querySelectorAll('button')].map(item => item.getBoundingClientRect().toJSON());
        return { left: bounds.left, right: bounds.right, height: bounds.height, items,
          overflow: element.scrollWidth > element.clientWidth,
          terminalTop: element.nextElementSibling.getBoundingClientRect().top, bottom: bounds.bottom };
      });
      assert.equal(geometry.overflow, false, `Lease bar must fit ${locale} at ${width}px`);
      const [status, task, action] = geometry.items;
      assert.equal(status.left - geometry.left, 4, `Status inset at ${locale} ${width}px`);
      assert.equal(geometry.right - action.right, 4, `Action inset at ${locale} ${width}px`);
      assert.ok(task.left >= status.right && action.left >= task.right, 'Status and actions must not overlap');
      assert.equal(task.height, action.height, 'Actions must have equal heights');
      assert.ok(Math.abs(status.y + status.height / 2 - action.y - action.height / 2) < 1,
        'Status and actions must stay vertically centered');
      assert.ok(geometry.height <= 36 && Math.abs(geometry.terminalTop - geometry.bottom) < 1,
        'The compact bar must sit directly above the terminal');
      assert.equal(await description.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true,
        `Activity text must be legible at ${locale} ${width}px`);
      const caption = lockLabel.locator('..');
      assert.equal(await caption.locator('svg').count(), 0, 'The caption should contain text only');
      if (width === 760) {
        const mode = locale === 'zh-CN' ? '可视命令' : 'Visible command';
        assert.equal((await caption.innerText()).replace(/\s+/g, ' ').trim(), `${mode} · ${lock}`);
      }
      if (width === 320) {
        await taskButton.focus();
        await page.keyboard.press('Tab');
        assert.equal(await takeover.evaluate(element => element === document.activeElement), true);
        await takeover.blur();
        await bar.screenshot({ path: `${root}artifacts/tests/terminal-lease/${locale}-compact.png` });
      }
      await page.evaluate(() => {
        const { useTerminalTaskNavigation, useAiPanelStore, useFocusStore, useAppStore, agentTerminalLeaseState } = window.runtime;
        useAppStore.setState({ activeSection: 'terminal' });
        useFocusStore.setState({ enabled: false });
        useAiPanelStore.getState().setOpen(true, 'terminal');
        useTerminalTaskNavigation.getState().setDisplayedSession('terminal', agentTerminalLeaseState.get(window.identity.sessionId).agentSessionId);
      });
      await taskButton.waitFor({ state: 'detached' });
      assert.equal(await bar.getByRole('button').count(), 1, 'The displayed task must only retain takeover');
      if (locale === 'zh-CN' && width === 760) {
        const readBarStyle = () => bar.evaluate(element => {
          const { backgroundColor, borderBottomWidth } = getComputedStyle(element);
          return { backgroundColor, borderBottomWidth };
        });
        assert.deepEqual(await readBarStyle(), { backgroundColor: 'rgb(255, 255, 255)', borderBottomWidth: '0px' });
        await bar.screenshot({ animations: 'disabled', path: `${root}artifacts/tests/terminal-lease/zh-CN-wide.png` });
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
        assert.deepEqual(await readBarStyle(), { backgroundColor: 'rgb(32, 33, 34)', borderBottomWidth: '0px' });
        await bar.screenshot({ animations: 'disabled', path: `${root}artifacts/tests/terminal-lease/zh-CN-dark.png` });
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      }
      await page.evaluate(() => window.runtime.useAiPanelStore.getState().setOpen(false, 'terminal'));
      await taskButton.waitFor();
      await page.evaluate(() => {
        window.runtime.useAiPanelStore.getState().setOpen(true, 'terminal');
        window.runtime.useTerminalTaskNavigation.getState().setDisplayedSession('terminal', null);
      });
      await taskButton.waitFor();
      await page.evaluate(() => {
        window.runtime.useFocusStore.setState({ enabled: true });
        window.runtime.useTerminalTaskNavigation.getState().setDisplayedSession('focus',
          window.runtime.agentTerminalLeaseState.get(window.identity.sessionId).agentSessionId);
      });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.equal(await taskButton.count(), 1, 'A task in another workspace must retain its navigation entry');
      await page.evaluate(() => {
        const { agentTerminalLeaseState, useAiPanelStore } = window.runtime;
        const lease = agentTerminalLeaseState.get(window.identity.sessionId);
        agentTerminalLeaseState.update(lease.sessionId, lease.operationId, current => ({ ...current, workspace: 'focus' }));
        useAiPanelStore.getState().setOpen(false, 'terminal');
      });
      await taskButton.waitFor({ state: 'detached' });
      await page.evaluate(() => {
        const { agentTerminalLeaseState, useFocusStore, useTerminalTaskNavigation } = window.runtime;
        const lease = agentTerminalLeaseState.get(window.identity.sessionId);
        agentTerminalLeaseState.update(lease.sessionId, lease.operationId, current => ({ ...current, workspace: 'terminal' }));
        useFocusStore.setState({ enabled: false });
        useTerminalTaskNavigation.getState().setDisplayedSession('focus', null);
      });
      await taskButton.waitFor();
    }
  }
  await leaseBar.getByRole('button', { name: '停止并接管', exact: true }).click();
  await inputAvailable.waitFor();
  assert.equal(await leaseBar.getByRole('button').count(), 0);
  assert.deepEqual(await terminalBounds(), idleTerminalBounds.get(320), 'Releasing the terminal must preserve its viewport');

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const { React, AiPanel, TerminalPane, useTerminalStore, useAiPanelStore, useAgentPermissionStore } = window.runtime;
    const terminalSessionId = window.identity.sessionId;
    const prepareTerminal = (integrationState, integrationReason, promptReady) => useTerminalStore.setState(state => ({
      sessions: state.sessions.map(session => session.sessionId === terminalSessionId
        ? { ...session, status: 'connected', integrationState, integrationReason, promptReady }
        : session),
    }));
    prepareTerminal('ready', undefined, true);
    useTerminalStore.getState().setActiveSession(terminalSessionId);
    useAgentPermissionStore.getState().setExecutionSurface(terminalSessionId, 'direct');
    useAiPanelStore.getState().setOpen(true, 'terminal');
    const Surface = () => {
      const session = useTerminalStore(state => state.sessions.find(item => item.sessionId === terminalSessionId));
      return React.createElement('div', { style: { display: 'flex', height: '100%' } },
        React.createElement('div', { style: { flex: 1, minWidth: 0 } }, React.createElement(TerminalPane, { activeSession: session })),
        React.createElement(AiPanel),
      );
    };
    window.dialogRoot.render(React.createElement(Surface));
    window.reportReadyTerminal = () => prepareTerminal('ready', undefined, true);
    window.reportUnsupportedGlibc = () => prepareTerminal('unavailable', 'remoteGlibcTooOld:2.27:2.28', false);
  });
  const executionSelector = page.locator('.ai-execution-surface-trigger');
  const closePanel = page.getByRole('button', { name: '关闭 AI 助手', exact: true });
  const terminalHost = page.locator('#dialog [data-terminal-measure-session]');
  const terminalTop = () => terminalHost.evaluate(element => element.getBoundingClientRect().top);
  const openPanel = () => page.evaluate(() => window.runtime.useAiPanelStore.getState().setOpen(true, 'terminal'));
  await executionSelector.click();
  await page.getByRole('menuitemradio', { name: '可视命令', exact: true }).click();
  await inputAvailable.waitFor();
  const visibleTop = await terminalTop();
  await closePanel.click();
  await executionSelector.waitFor({ state: 'detached' });
  await inputAvailable.waitFor();
  assert.equal(await terminalTop(), visibleTop, 'Closing the Agent panel must preserve the selected visible command bar');
  await page.evaluate(() => window.runtime.useTerminalStore.getState().setReconnecting(window.identity.sessionId, true));
  await inputAvailable.waitFor({ state: 'detached' });
  await leaseBar.locator('.agent-terminal-lease-status').getByText('可视命令', { exact: true }).waitFor();
  assert.equal(await terminalTop(), visibleTop, 'Reconnecting must preserve the visible command bar height');
  await page.evaluate(() => window.runtime.useTerminalStore.getState().setReconnecting(window.identity.sessionId, false));
  await inputAvailable.waitFor();

  await page.evaluate(() => window.reportUnsupportedGlibc());
  await leaseBar.waitFor({ state: 'detached' });
  const directTop = await terminalTop();
  await openPanel();
  await executionSelector.and(page.locator('[data-execution-surface="direct"]')).waitFor();
  await leaseBar.waitFor({ state: 'detached' });
  assert.equal(await terminalTop(), directTop, 'Opening the panel must preserve the Direct fallback');
  await closePanel.click();
  await executionSelector.waitFor({ state: 'detached' });
  await leaseBar.waitFor({ state: 'detached' });
  assert.equal(await terminalTop(), directTop, 'Closing the panel must preserve the Direct fallback');
  const capture = JSON.parse(readFileSync(`${root}src/tests/fixtures/terminal-command-presentation-native.json`, 'utf8'));
  const retainedLease = capture.leaseEvents.find(event => event.state === 'acquired');
  const restoring = await page.evaluate(agentSessionId => {
    const { flushSync, useAgentPermissionStore, useAiPanelStore } = window.runtime;
    const terminalSessionId = window.identity.sessionId;
    const permissions = useAgentPermissionStore.getState();
    flushSync(() => {
      window.reportReadyTerminal();
      permissions.setExecutionSurface(terminalSessionId, 'direct');
      permissions.setConversationSurface(terminalSessionId, { agentSessionId, surface: 'boundTerminal' });
      useAiPanelStore.getState().setOpen(true, 'terminal');
    });
    const selector = document.querySelector('.ai-execution-surface-trigger');
    return { surface: selector.getAttribute('data-execution-surface'), disabled: selector.disabled };
  }, retainedLease.agentSessionId);
  assert.deepEqual(restoring, { surface: 'boundTerminal', disabled: true },
    'Reopening a retained conversation must lock the composer until the selected mode is verified');
  // The browser has no Tauri session to load. Failure must release the retained
  // selection and restore the new-conversation controls using the saved mode.
  await executionSelector.and(page.locator('[data-execution-surface="direct"]:enabled')).waitFor();
  await leaseBar.waitFor({ state: 'detached' });
  await closePanel.click();
  await page.evaluate(() => {
    window.dialogRoot.render(null);
    window.runtime.useAgentPermissionStore.getState().setExecutionSurface(window.identity.sessionId, 'direct');
  });
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
      await window.observeReboundOutput(controller);
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
      const { React, createRoot, flushSync, TerminalPane, terminalRegistry, useTerminalStore,
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
        const activeSession = useTerminalStore((state) => state.sessions.find((session) => session.sessionId === state.activeSessionId) ?? null);
        return React.createElement(TerminalPane, {
          key: activeSession?.sessionId, activeSession,
          isActive: section === 'terminal', isVisible: section === 'terminal',
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
        await new Promise(requestAnimationFrame);
        const editorFocusPreserved = document.activeElement === input
          && useAppStore.getState().activeSection === 'workbench'
          && useTerminalStore.getState().activeSessionId === otherId;
        await coordinator.handle(lease);
        await coordinator.handle({ ...lease, operationId: crypto.randomUUID(), state: 'activity', commandPhase: 'typing' });
        const duplicatePreservedFocus = document.activeElement === input;
        coordinator.handleSession({ type: 'turn/end', sessionId: lease.agentSessionId });
        input.blur();
        const visibleLease = { ...lease, operationId: crypto.randomUUID() };
        await coordinator.handle(visibleLease);
        await new Promise(requestAnimationFrame);
        const revealPreservedFocus = document.activeElement === document.body;
        input.focus();
        await new Promise((resolve) => controller.terminal.write(terminalOutput.replace(/\n/g, '\r\n'), resolve));
        const cursor = () => controller.terminal.element.querySelector('.xterm-cursor');
        const paint = async () => {
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        };
        await paint();
        const idleCursorUnfilled = !cursor()?.classList.contains('xterm-cursor-block');
        await coordinator.handle({ ...visibleLease, state: 'activity', commandPhase: 'typing' });
        await paint();
        const typingCursor = cursor();
        const typingCursorSolid = !!typingCursor?.classList.contains('xterm-cursor-block')
          && getComputedStyle(typingCursor).backgroundColor !== 'rgba(0, 0, 0, 0)';
        const typingPreservedFocus = document.activeElement === input;
        const typingInputLocked = !(await controller.writeUserInput('blocked'));
        await coordinator.handle({ ...visibleLease, state: 'activity', commandPhase: 'running' });
        await paint();
        const runningCursorOutlined = cursor()?.classList.contains('xterm-cursor-outline') ?? false;
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
          otherInitiallyFocused, editorFocusPreserved, revealPreservedFocus, duplicatePreservedFocus,
          idleCursorUnfilled, typingCursorSolid, typingPreservedFocus, typingInputLocked, runningCursorOutlined,
          runningPreservedFocus: document.activeElement === input,
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
        const reboundOutput = window.observeReboundOutput(controller);
        await pending;
        await reboundOutput;
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
      otherInitiallyFocused: true, editorFocusPreserved: true, revealPreservedFocus: true, duplicatePreservedFocus: true,
      idleCursorUnfilled: true, typingCursorSolid: true, typingPreservedFocus: true, typingInputLocked: true, runningCursorOutlined: true,
      runningPreservedFocus: true, selected: true, visible: true, rebindPreservedFocus: true,
    });
  }
  for (const width of [1200, 400]) {
    await page.setViewportSize({ width, height: 700 });
    const splitFocus = await page.evaluate(async () => {
      const { React, createRoot, flushSync, TerminalWorkspace, terminalRegistry,
        useTerminalStore, useFocusStore, useAppStore, createAgentTerminalLeaseCoordinator } = window.runtime;
      const previousSessions = useTerminalStore.getState().sessions;
      const ids = [crypto.randomUUID(), crypto.randomUUID()];
      const unavailableSessionId = crypto.randomUUID();
      useTerminalStore.setState({ sessions: [], activeSessionId: null, restoredLayout: null });
      useTerminalStore.getState().addRestoredSessions(ids.map((sessionId) => ({ ...window.identity, sessionId })), {
        kind: 'split', orientation: 'horizontal',
        first: {
          kind: 'split', orientation: 'horizontal', split: 0.5,
          first: { kind: 'group', id: 'first', sessionIds: [ids[0]], activeSessionId: ids[0] },
          second: { kind: 'group', id: 'second', sessionIds: [ids[1]], activeSessionId: ids[1] },
        },
        second: { kind: 'group', id: 'unavailable', sessionIds: [unavailableSessionId], activeSessionId: unavailableSessionId },
      });
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
        const restoredPanes = Array.from(surface.querySelectorAll('[data-terminal-group]'), group => group.dataset.terminalGroup);
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
        const activePane = surface.querySelector(`[data-terminal-pane-session="${ids[1]}"]`);
        const content = surface.querySelector('[data-terminal-content]');
        const activePaneAligned = activePane && content
          && Math.abs(activePane.getBoundingClientRect().left - content.getBoundingClientRect().left) <= 1;
        flushSync(() => {
          useFocusStore.getState().enter();
          useFocusStore.getState().leave();
        });
        await new Promise(requestAnimationFrame);
        document.activeElement?.blur();
        await coordinator.handle({
          sessionId: ids[1], agentSessionId: `focus-agent-${crypto.randomUUID()}`, taskId: crypto.randomUUID(),
          operationId: crypto.randomUUID(), acquiredAtUnixMs: Date.now(), state: 'acquired',
        });
        const focusCommandRouted = !useFocusStore.getState().enabled
          && useTerminalStore.getState().workspace === 'terminal'
          && useTerminalStore.getState().activeSessionId === ids[1]
          && document.activeElement === document.body;
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
        coordinator.handleSession({ type: 'turn/end', sessionId: terminalLease.agentSessionId });
        flushSync(() => useFocusStore.getState().leave());
        input.blur();
        await coordinator.handle({
          ...terminalLease, operationId: crypto.randomUUID(),
        });
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return {
          restoredPanes,
          workspaceIsolation: Boolean(focusStartsUnsplit && terminalRestored && focusRestored && controllersRetained && activePaneAligned),
          commandWorkspaceRouting: focusCommandRouted && focusSelectionPreserved
            && !useFocusStore.getState().enabled && useTerminalStore.getState().workspace === 'terminal'
            && useTerminalStore.getState().workspaceViews.focus.activeSessionId === ids[0],
          sourceInitiallyFocused,
          backgroundPreservedFocus, releasePreservedFocus,
          revealPreservedFocus: document.activeElement === document.body,
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
      restoredPanes: ['first', 'second'],
      workspaceIsolation: true,
      commandWorkspaceRouting: true,
      sourceInitiallyFocused: true, revealPreservedFocus: true, focusedOtherTerminal: false,
      backgroundPreservedFocus: true, releasePreservedFocus: true,
      targetFocusObserved: false, targetGroupSelected: true,
    });
  }
  const workspaceResize = await page.evaluate(async ({ output, identity }) => {
    const { React, createRoot, flushSync, AppShell, TerminalWorkspace, terminalRegistry, useAppStore, useTerminalStore } = window.runtime;
    const store = useTerminalStore.getState();
    const { sessions, activeSessionId, restoredLayout } = store;
    useTerminalStore.setState({ sessions: [], activeSessionId: null, restoredLayout: null });
    const ids = Array.from({ length: 2 }, () => {
      const sessionId = crypto.randomUUID();
      store.addSession({ ...identity, sessionId });
      store.setStatus(sessionId, { sessionId, status: 'disconnected' });
      return sessionId;
    });
    useAppStore.setState({ activeSection: 'terminal', restoreWorkspace: false });
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:700px;height:500px;background:var(--background)';
    host.dataset.terminalWheelCheck = '';
    document.body.appendChild(host);
    const root = createRoot(host);
    window.disposeWheelCheck = () => {
      root.unmount();
      for (const id of ids) { terminalRegistry.dispose(id); store.removeSession(id); }
      useTerminalStore.setState({ sessions, activeSessionId, restoredLayout });
      host.remove();
    };
    flushSync(() => root.render(React.createElement(AppShell, null,
      React.createElement('div', { className: 'min-h-0 flex-1' }, React.createElement(TerminalWorkspace)),
    )));
    const frame = () => new Promise(requestAnimationFrame);
    for (let i = 0; i < 10; i++) await frame();
    await new Promise((resolve) => terminalRegistry.get(ids[1]).terminal.write(output.replace(/\n/g, '\r\n'), resolve));
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
    const content = host.querySelector('[data-terminal-content]');
    const activePane = content.querySelector(`[data-terminal-pane-session="${ids[1]}"]`);
    const aligned = Math.abs(activePane.getBoundingClientRect().left - content.getBoundingClientRect().left) < 1;
    return { ids, activeId: useTerminalStore.getState().activeSessionId, terminalMounts, aligned };
  }, { output, identity });
  try {
    const [neighbor, active] = workspaceResize.ids;
    assert.equal(workspaceResize.activeId, active);
    assert.equal(workspaceResize.terminalMounts, 0);
    assert.equal(workspaceResize.aligned, true);
    const host = page.locator('[data-terminal-wheel-check]');
    const terminal = host.locator(`[data-terminal-pane-session="${active}"] .xterm-screen`);
    for (const width of [1200, 400]) {
      await page.setViewportSize({ width, height: 700 });
      await host.evaluate((element, width) => { element.style.width = `${width}px`; }, width);
      await terminal.hover();
      await page.mouse.wheel(-1200, 0);
      const content = host.locator('[data-terminal-content]');
      assert.equal(await content.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
      assert.equal(await host.locator(`[data-session-tab="${active}"]`).getAttribute('aria-selected'), 'true');
      assert.equal(await content.locator('[data-terminal-pane-session]').count(), 1);
      await page.evaluate((id) => window.runtime.terminalRegistry.get(id).terminal.scrollToBottom(), active);
      await page.mouse.wheel(0, -480);
      await page.waitForFunction((id) => {
        const buffer = window.runtime.terminalRegistry.get(id).terminal.buffer.active;
        return buffer.viewportY < buffer.baseY;
      }, active);
    }

    const tabBar = host.locator('[data-terminal-tab-bar]');
    const actions = tabBar.getByRole('button', { name: '终端页签操作', exact: true });
    const tabViewport = tabBar.locator('[data-slot="scroll-area-viewport"]');
    const actionsMenu = page.getByRole('menu', { name: '终端页签操作', exact: true });
    const newSessionDialog = page.getByRole('dialog', { name: '新建会话', exact: true });

    const wideBar = await tabBar.boundingBox();
    const wideButton = await actions.boundingBox();
    assert.equal(wideBar.x + wideBar.width - wideButton.x - wideButton.width, 4,
      'The actions menu should sit at the right edge even when the tabs fit');
    assert.equal(await tabViewport.evaluate(element => element.scrollWidth === element.clientWidth), true);
    await actions.press('Enter');
    await actionsMenu.getByRole('menuitem', { name: '新建会话', exact: true }).press('Enter');
    await newSessionDialog.waitFor();
    await page.keyboard.press('Escape');
    await newSessionDialog.waitFor({ state: 'hidden' });
    await actions.blur();

    await host.evaluate(element => { element.style.width = '320px'; });
    await tabBar.locator('[data-slot="scroll-area-thumb"]').waitFor();
    const barBox = await tabBar.boundingBox();
    const fixedButton = await actions.boundingBox();
    assert.equal(barBox.x + barBox.width - fixedButton.x - fixedButton.width, 4,
      'The actions menu should stay at the right edge when tabs overflow');
    const scrollRange = await tabViewport.evaluate(element => {
      element.scrollLeft = 0;
      const start = element.scrollLeft;
      element.scrollLeft = element.scrollWidth;
      return element.scrollLeft - start;
    });
    assert.ok(scrollRange > 0, 'The tabs should remain horizontally scrollable');
    assert.deepEqual(await actions.boundingBox(), fixedButton, 'Scrolling tabs must not move the actions menu');
    const selectedTab = tabBar.getByRole('tab', { selected: true });
    const selectedTitle = selectedTab.getByText(await selectedTab.getAttribute('aria-label'), { exact: true });
    const tabTypography = await selectedTitle.evaluate(element => {
      const { fontFamily, fontSize, fontWeight } = getComputedStyle(element);
      return { fontFamily, fontSize, fontWeight };
    });
    assert.equal(tabTypography.fontWeight, '400', 'Terminal tab titles use regular weight');
    const inactiveTab = tabBar.getByRole('tab', { selected: false });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
      await actions.blur();
      await page.mouse.move(0, barBox.y + 50);
      await tabBar.screenshot({ animations: 'disabled',
        path: `${root}artifacts/tests/terminal-tab-actions/icon-${theme}.png` });
      const iconColor = await actions.locator('svg').evaluate(icon => getComputedStyle(icon).color);
      assert.equal(iconColor, await inactiveTab.evaluate(tab => getComputedStyle(tab).color),
        `The actions icon should use the same subdued color as inactive tabs in ${theme} mode`);
      await actions.hover();
      await tabBar.screenshot({ animations: 'disabled',
        path: `${root}artifacts/tests/terminal-tab-actions/overflow-hover-${theme}.png` });
      const hoverStyle = await actions.evaluate(element => {
        const reference = document.createElement('span');
        reference.style.backgroundColor = 'var(--accent)';
        element.append(reference);
        const actual = getComputedStyle(element).backgroundColor;
        const expected = getComputedStyle(reference).backgroundColor;
        reference.remove();
        return { actual, expected };
      });
      assert.equal(hoverStyle.actual, hoverStyle.expected, `The actions button should use the tab highlight in ${theme} mode`);
      assert.deepEqual(await actions.boundingBox(), fixedButton, 'Hover must not move the actions button');
      assert.equal(await tabViewport.evaluate(element => element.scrollLeft), scrollRange,
        'Hovering the actions button must preserve the tab bar scroll position');

      await actions.click();
      await actionsMenu.waitFor();
      await page.mouse.move(0, barBox.y + 50);
      await page.screenshot({ animations: 'disabled', clip: { x: 0, y: 0, width: 320, height: 224 },
        path: `${root}artifacts/tests/terminal-tab-actions/menu-${theme}.png` });
      const openStyle = await actions.evaluate(element => ({
        hovered: element.matches(':hover'),
        fill: getComputedStyle(element).backgroundColor,
      }));
      assert.deepEqual(openStyle, { hovered: false, fill: hoverStyle.actual },
        `The open actions button must keep the hover fill in ${theme} mode`);
      const menuTypography = await actionsMenu.getByRole('menuitem').evaluateAll(items => items.map(item => {
        const { fontFamily, fontSize, fontWeight } = getComputedStyle(item.querySelector('[data-slot="menu-item-label"]'));
        return { fontFamily, fontSize, fontWeight };
      }));
      for (const itemTypography of menuTypography) assert.deepEqual(itemTypography, tabTypography);
      await page.keyboard.press('Escape');
      await actionsMenu.waitFor({ state: 'hidden' });
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await actions.click();
    await actionsMenu.waitFor();
    await page.screenshot({ animations: 'disabled', clip: { x: 0, y: 0, width: 320, height: 224 },
      path: `${root}artifacts/tests/terminal-tab-actions/menu.png` });
    const switcher = page.getByRole('dialog', { name: '切换终端页签', exact: true });
    await actionsMenu.getByRole('menuitem', { name: '切换终端页签', exact: true }).click();
    await switcher.waitFor();
    await page.keyboard.press('Escape');
    await switcher.waitFor({ state: 'hidden' });

    await actions.click();
    await actionsMenu.getByRole('menuitem', { name: '关闭当前终端', exact: true }).click();
    const closeDialog = page.getByRole('alertdialog', { name: '关闭页签', exact: true });
    await closeDialog.waitFor();
    await closeDialog.getByRole('button', { name: '取消', exact: true }).click();
    await closeDialog.waitFor({ state: 'hidden' });
    assert.equal(await tabBar.getByRole('tab').count(), 2, 'Dismissing confirmation must preserve both terminals');

    await host.evaluate(element => { element.style.width = '220px'; });
    await actions.click();
    const splitRight = actionsMenu.getByRole('menuitem', { name: '向右分屏', exact: true });
    assert.equal(await splitRight.isDisabled(), true, 'Side-by-side panes require enough width');
    await page.keyboard.press('Escape');
    await actionsMenu.waitFor({ state: 'hidden' });

    const titleBar = host.locator('[data-tauri-drag-region]');
    // The translucent title bar is composited separately and can round a color channel by one unit.
    const titleBarColorTolerance = 1;
    const assertMatchingTabBorders = async (bar, separator, name, colorTolerance = 0) => {
      const [barBox, separatorBox, samples] = await Promise.all([
        bar.boundingBox(),
        separator.boundingBox(),
        bar.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          const viewport = element.querySelector('[data-slot="scroll-area-viewport"]').getBoundingClientRect();
          const actions = element.querySelector('[data-terminal-tab-actions]')?.getBoundingClientRect();
          const tabs = [...element.querySelectorAll('[role="tab"]')].map(tab => {
            const rect = tab.getBoundingClientRect();
            return {
              active: tab.getAttribute('aria-selected') === 'true',
              left: Math.max(viewport.left, rect.left),
              right: Math.min(viewport.right, rect.right),
              rawRight: rect.right,
            };
          });
          const active = tabs.find(tab => tab.active && tab.right - tab.left > 6);
          const lastTab = tabs[tabs.length - 1];
          const tailLeft = lastTab ? Math.max(viewport.left, lastTab.rawRight) : viewport.left;
          return {
            activeCenter: active ? Math.floor((active.left + active.right) / 2 - bounds.left) : null,
            activeInnerLeft: active && active.right - active.left > 12
              ? Math.floor(active.left + 2 - bounds.left)
              : null,
            activeInnerRight: active && active.right - active.left > 12
              ? Math.floor(active.right - 3 - bounds.left)
              : null,
            inactives: tabs
              .filter(tab => !tab.active && tab.right - tab.left > 6)
              .map(tab => Math.floor((tab.left + tab.right) / 2 - bounds.left)),
            tail: viewport.right - tailLeft > 12
              ? Math.floor((tailLeft + viewport.right) / 2 - bounds.left)
              : null,
            actionsLeading: actions ? Math.floor(actions.left + 1 - bounds.left) : null,
          };
        }),
      ]);
      assert.equal(barBox.y, separatorBox.y + separatorBox.height, `${name}: the tab bar touches the separator`);
      assert.equal(barBox.height, 32, `${name}: the border fits within the tab bar height`);
      const image = await loadImage(await page.screenshot({
        animations: 'disabled',
        clip: { x: Math.round(barBox.x), y: Math.round(barBox.y) - 2, width: Math.round(barBox.width), height: barBox.height + 4 },
        path: `${root}artifacts/tests/terminal-tab-actions/${name}.png`,
      }));
      const context = createCanvas(image.width, image.height).getContext('2d');
      context.drawImage(image, 0, 0);
      const pixel = (x, y) => [...context.getImageData(x, y, 1, 1).data];
      const topSamples = [
        samples.activeCenter,
        ...samples.inactives,
        samples.tail,
        samples.actionsLeading,
        image.width - 2,
      ].filter(x => x !== null);
      for (const x of topSamples) {
        const top = pixel(x, 1);
        assert.notDeepEqual(pixel(x, 0), top, `${name}: the separator is one pixel high at x=${x}`);
        assert.deepEqual(pixel(x, 2), pixel(x, 5), `${name}: the tab bar starts directly below the separator at x=${x}`);
      }
      for (const x of [samples.activeInnerLeft, samples.activeCenter, samples.activeInnerRight].filter(x => x !== null)) {
        const top = pixel(x, 1);
        const fill = pixel(x, barBox.height - 3);
        assert.notDeepEqual(fill, top, `${name}: active fill differs from top separator at x=${x}`);
        assert.deepEqual(pixel(x, barBox.height + 1), fill,
          `${name}: the bottom border breaks cleanly under the selected tab at x=${x}`);
      }
      const nonSelectedSamples = [
        ...samples.inactives,
        samples.tail,
        samples.actionsLeading,
        image.width - 2,
      ].filter(x => x !== null);
      assert.ok(nonSelectedSamples.length > 0, `${name}: expected non-selected samples`);
      for (const x of nonSelectedSamples) {
        const top = pixel(x, 1);
        const bottom = pixel(x, barBox.height + 1);
        assert.ok(bottom.every((channel, index) => Math.abs(channel - top[index]) <= colorTolerance),
          `${name}: the bottom border (${bottom}) matches the top (${top}) at x=${x}`);
        assert.deepEqual(pixel(x, barBox.height), pixel(x, barBox.height - 3),
          `${name}: the bottom border is one pixel high at x=${x}`);
      }
    };

    await host.evaluate(element => { element.style.width = '400px'; });
    await actions.click();
    await splitRight.click();
    const groups = host.locator('[data-terminal-group]');
    await groups.nth(1).waitFor();
    const rightTab = groups.nth(1).getByRole('tab', { selected: true });
    const divider = host.locator('[data-slot="split-pane-divider"]');
    const leftSplitBar = groups.nth(0).locator('[data-terminal-tab-bar]');
    const rightSplitBar = groups.nth(1).locator('[data-terminal-tab-bar]');
    for (const width of [401, 901]) {
      await page.setViewportSize({ width, height: 700 });
      await host.evaluate((element, width) => { element.style.width = `${width}px`; }, width);
      const tabBox = await rightTab.boundingBox();
      const dividerBox = await divider.boundingBox();
      const contentBox = await groups.nth(1).locator('[data-terminal-content]').boundingBox();
      assert.equal(tabBox.x, dividerBox.x + dividerBox.width, 'The right tab starts at the split divider');
      assert.equal(tabBox.x, contentBox.x, 'The right tab and its content share the same left edge');
      const leftContextWidth = 40;
      const clip = { x: Math.round(tabBox.x) - leftContextWidth, y: Math.round(tabBox.y),
        width: leftContextWidth + tabBox.width + 8, height: tabBox.height + 20 };
      for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        const image = await loadImage(await page.screenshot({
          animations: 'disabled',
          clip,
          path: `${root}artifacts/tests/terminal-tab-actions/split-edge-${theme}-${width}.png`,
        }));
        const context = createCanvas(image.width, image.height).getContext('2d');
        context.drawImage(image, 0, 0);
        // Compare the leading edge with the adjacent fill, below the top stroke.
        const column = (x) => context.getImageData(x, 1, 1, tabBox.height - 1).data;
        assert.deepEqual(column(leftContextWidth), column(leftContextWidth + 3),
          `${width}px/${theme}: the tab must not paint a second line next to the split divider`);
        await assertMatchingTabBorders(leftSplitBar, titleBar, `horizontal-split-left-${theme}-${width}`, titleBarColorTolerance);
        await assertMatchingTabBorders(rightSplitBar, titleBar, `horizontal-split-right-${theme}-${width}`, titleBarColorTolerance);
      }
    }
    await page.setViewportSize({ width: 400, height: 700 });
    await host.evaluate(element => { element.style.width = '400px'; });
    const splitActions = groups.nth(1).getByRole('button', { name: '终端页签操作', exact: true });
    await splitActions.click();
    assert.equal(await splitRight.isDisabled(), true, 'A pane narrower than 240 px cannot split horizontally');
    await actionsMenu.getByRole('menuitem', { name: /最大化窗格/ }).click();
    const restore = host.getByRole('button', { name: '还原窗格', exact: true });
    await restore.waitFor();
    assert.equal(await groups.count(), 1);
    const zoomedBar = groups.first().locator('[data-terminal-tab-bar]');
    const [zoomedBarBox, restoreBox, zoomedActionsBox] = await Promise.all([
      zoomedBar.boundingBox(),
      restore.boundingBox(),
      groups.first().getByRole('button', { name: '终端页签操作', exact: true }).boundingBox(),
    ]);
    assert.equal(zoomedBarBox.height, 32, 'Zooming a pane must not increase tab bar height');
    assert.equal(restoreBox.height, zoomedActionsBox.height, 'Restore control matches tab actions button height');
    await restore.click();
    await groups.nth(1).waitFor();
    await splitActions.click();
    await actionsMenu.getByRole('menuitem', { name: '退出分屏', exact: true }).click();
    await groups.first().waitFor({ state: 'detached' });

    await page.evaluate(() => window.runtime.useAppStore.getState().setTerminalColorScheme('app'));
    for (const [tabIndex, tabId] of [neighbor, active].entries()) {
      await host.locator(`[data-session-tab="${tabId}"]`).click();
      await tabBar.locator(`[data-session-tab="${tabId}"][aria-selected="true"]`).waitFor();
      for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await assertMatchingTabBorders(tabBar, titleBar, `titlebar-tab-borders-${theme}-tab-${tabIndex}`, titleBarColorTolerance);
      }
    }
    await actions.click();
    await actionsMenu.getByRole('menuitem', { name: '向下分屏', exact: true }).click();
    const upperBar = groups.nth(0).locator('[data-terminal-tab-bar]');
    const lowerBar = groups.nth(1).locator('[data-terminal-tab-bar]');
    await lowerBar.getByRole('tab', { selected: true }).waitFor();
    await upperBar.getByRole('tab', { selected: true }).click();
    for (const width of [400, 900]) {
      await page.setViewportSize({ width, height: 700 });
      await host.evaluate((element, width) => { element.style.width = `${width}px`; }, width);
      for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await assertMatchingTabBorders(upperBar, titleBar, `vertical-split-upper-tab-borders-${theme}-${width}`, titleBarColorTolerance);
        await assertMatchingTabBorders(lowerBar, divider, `vertical-split-tab-borders-${theme}-${width}`);
      }
    }
    await lowerBar.getByRole('tab', { selected: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-terminal-group="second"], [data-terminal-group]:nth-of-type(2)'));
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await assertMatchingTabBorders(upperBar, titleBar, `vertical-split-upper-unfocused-${theme}`, titleBarColorTolerance);
      await assertMatchingTabBorders(lowerBar, divider, `vertical-split-lower-focused-${theme}`);
    }
    await upperBar.getByRole('tab', { selected: true }).click();
    const extraSessionId = await page.evaluate(() => {
      const store = window.runtime.useTerminalStore.getState();
      const sessionId = crypto.randomUUID();
      store.addSession({ ...window.identity, sessionId });
      store.setStatus(sessionId, { sessionId, status: 'disconnected' });
      return sessionId;
    });
    try {
      await upperBar.getByRole('tab').nth(1).waitFor();
      for (const tabIndex of [0, 1, 0]) {
        await upperBar.getByRole('tab').nth(tabIndex).click();
        await page.waitForFunction((idx) => {
          const tabs = document.querySelectorAll('[data-terminal-group]')[0]?.querySelectorAll('[role="tab"]');
          return tabs?.[idx]?.getAttribute('aria-selected') === 'true';
        }, tabIndex);
        for (const theme of ['dark', 'light']) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          await assertMatchingTabBorders(upperBar, titleBar, `vertical-split-upper-switch-${tabIndex}-${theme}`, titleBarColorTolerance);
          await assertMatchingTabBorders(lowerBar, divider, `vertical-split-lower-during-switch-${tabIndex}-${theme}`);
        }
      }
    } finally {
      await page.evaluate((id) => {
        window.runtime.terminalRegistry.dispose(id);
        window.runtime.useTerminalStore.getState().removeSession(id);
      }, extraSessionId);
      await page.waitForFunction(() => document.querySelectorAll('[data-terminal-group]')[0]?.querySelectorAll('[role="tab"]').length === 1);
    }
    await splitActions.click();
    await actionsMenu.getByRole('menuitem', { name: '退出分屏', exact: true }).click();
    await groups.first().waitFor({ state: 'detached' });

    await host.locator(`[data-session-tab="${neighbor}"]`).click();
    await host.locator(`[data-terminal-pane-session="${neighbor}"] .xterm-helper-textarea:focus`).waitFor({ state: 'attached' });
    await host.locator(`[data-session-tab="${neighbor}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '锁定终端输入', exact: true }).click();
    const unlock = host.getByRole('button', { name: '解除只读', exact: true });
    await unlock.waitFor();
    await host.locator(`[data-session-tab="${neighbor}"] [data-terminal-input-lock]`).waitFor();
    await unlock.click();
    await unlock.waitFor({ state: 'detached' });

    await page.evaluate(() => {
      const store = window.runtime.useTerminalStore.getState();
      for (const { sessionId } of store.sessions) store.setStatus(sessionId, { sessionId, status: 'connected' });
      document.dispatchEvent(new Event('shellspan:configure-terminal-broadcast'));
    });
    const broadcast = page.getByRole('dialog', { name: '广播输入', exact: true });
    await broadcast.getByRole('checkbox').first().click();
    await broadcast.getByRole('checkbox').last().click();
    await broadcast.getByRole('button', { name: '向所选终端广播', exact: true }).click();
    const broadcastAlert = host.getByRole('alert').filter({ hasText: '正在广播至' });
    await broadcastAlert.waitFor();
    for (const width of [700, 120]) {
      await host.evaluate((element, width) => { element.style.width = width + 'px'; }, width);
      const alignment = await broadcastAlert.evaluate((element) => {
        const icon = element.querySelector('svg').getBoundingClientRect();
        const description = element.querySelector('[data-slot="alert-description"]');
        const message = document.createTreeWalker(description, NodeFilter.SHOW_TEXT).nextNode();
        const range = document.createRange();
        range.selectNodeContents(message);
        const lines = range.getClientRects();
        const lineHeight = parseFloat(getComputedStyle(message.parentElement).lineHeight);
        const textCenter = message.parentElement.getBoundingClientRect().top + lineHeight / 2;
        const buttonHeights = [...element.querySelectorAll('button')].map((button) => button.getBoundingClientRect().height);
        return {
          centerOffset: icon.top + icon.height / 2 - textCenter,
          gap: lines[0].left - icon.right,
          wrapped: lines[lines.length - 1].top > lines[0].top,
          buttonHeights,
        };
      });
      assert.equal(alignment.wrapped, width === 120, JSON.stringify(alignment));
      assert.ok(Math.abs(alignment.centerOffset) <= 0.5 && Math.abs(alignment.gap - 4) <= 0.5,
        'The broadcast icon must align to the first line with a 4px gap: ' + JSON.stringify(alignment));
      assert.ok(alignment.buttonHeights.length === 2 && alignment.buttonHeights[0] === alignment.buttonHeights[1],
        'Broadcast banner action buttons must have equal height: ' + JSON.stringify(alignment.buttonHeights));
      if (width === 700) {
        await broadcastAlert.screenshot({ animations: 'disabled', path: `${root}artifacts/tests/terminal-broadcast/light-700.png` });
        await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
        await broadcastAlert.screenshot({ animations: 'disabled', path: `${root}artifacts/tests/terminal-broadcast/dark-700.png` });
        await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      }
    }
    await broadcastAlert.getByRole('button', { name: '停止', exact: true }).click();
  } finally {
    await page.evaluate(() => window.disposeWheelCheck());
  }
  assert.deepEqual(errors, []);
  process.stdout.write(`Terminal experience regressions passed with real xterm and ${browser.browserType().name()} at wide and narrow sizes.\n`);
} finally {
  await browser?.close();
  await server.close();
}
