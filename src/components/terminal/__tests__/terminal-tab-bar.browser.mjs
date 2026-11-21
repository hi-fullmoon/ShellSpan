import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { webkit } from 'playwright';
import { createCanvas, loadImage } from 'canvas';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  cacheDir: `${root}artifacts/tests/terminal-tab-bar/vite-cache`,
  optimizeDeps: {
    entries: ['src/components/terminal/terminal-tab-bar.tsx', 'src/components/sftp/sftp-tab-bar.tsx',
      'src/components/terminal/registry/terminal-registry.ts'],
    include: ['react', 'react-dom/client'],
  },
  resolve: { alias: { '@': `${root}src` } },
  plugins: [tailwindcss(), {
    name: 'terminal-tab-bar-layout',
    resolveId(id) {
      if (id === '/tab-runtime.js') return id;
    },
    load(id) {
      if (id === '/tab-runtime.js') return `
        export { default as React } from 'react';
        export { createRoot } from 'react-dom/client';
        export { TerminalTabBar } from '/src/components/terminal/terminal-tab-bar.tsx';
        export { useTerminalStore } from '/src/stores/terminalStore.ts';
        export { useAppStore } from '/src/stores/appStore.ts';
        export { useFocusStore } from '/src/stores/focusStore.ts';
        export { resolveTerminalTheme } from '/src/components/terminal/registry/terminal-registry.ts';
        export { SftpTabBar } from '/src/components/sftp/sftp-tab-bar.tsx';
        export { useSftpStore } from '/src/stores/sftpStore.ts';
      `;
    },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><div id="root"></div></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});

let browser;
async function assertTabSeparators(tabs) {
  const states = await tabs.evaluateAll(elements => elements.map((tab, index) => {
    const style = getComputedStyle(tab, '::after');
    return {
      visible: style.content !== 'none' && style.content !== 'normal' && style.display !== 'none',
      expected: index < elements.length - 1 && tab.getAttribute('aria-selected') === 'false'
        && elements[index + 1].getAttribute('aria-selected') === 'false',
    };
  }));
  for (const [index, state] of states.entries()) {
    assert.equal(state.visible, state.expected, `Tab ${index}: separators only appear between adjacent inactive tabs`);
  }
}

try {
  await server.listen();
  browser = await webkit.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.evaluate(async (localUser) => {
    await import('/src/styles/base.css');
    const { React, createRoot, TerminalTabBar, useTerminalStore, SftpTabBar, useSftpStore } = await import('/tab-runtime.js');
    // Exercise the real pending-connection state without replacing IPC or browser geometry.
    const startConnection = () => useTerminalStore.getState().beginConnectionAttempt({
      title: localUser.shell, host: 'localhost', port: 22, username: localUser.username,
    });
    startConnection();
    useSftpStore.getState().addLocalConnection();
    createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
      React.createElement(TerminalTabBar, { onNewTabClick: startConnection }), React.createElement(SftpTabBar)));
  }, { username: userInfo().username, shell: basename(userInfo().shell || process.env.SHELL) });
  await page.locator('[data-terminal-tab-bar] [role="tab"]').waitFor();
  const sftpBar = page.locator('[data-sftp-tab-bar]');
  await sftpBar.getByRole('button', { name: /^关闭页签 / }).waitFor();
  assert.equal(await page.locator('[data-sftp-tab-bar][title], [data-sftp-tab-bar] [title]').count(), 0);
  await page.evaluate(async () => {
    const { useAppStore } = await import('/tab-runtime.js');
    useAppStore.getState().setTerminalTabTitleTemplate('${user}@${host} #${index}');
  });
  const terminalTab = page.locator('[data-terminal-tab-bar] [role="tab"]');
  await terminalTab.getByText(`${userInfo().username}@localhost #1`, { exact: true }).waitFor();
  assert.equal(await terminalTab.getAttribute('aria-label'), `${userInfo().username}@localhost #1`);
  assert.equal(await terminalTab.getAttribute('title'), null);
  for (const width of [400, 1280]) {
    await page.setViewportSize({ width, height: 720 });
    for (const selector of ['[data-terminal-tab-bar]', '[data-sftp-tab-bar]']) {
      const sizes = await page.evaluate((selector) => {
        const bar = document.querySelector(selector);
        const tab = bar.querySelector('[role="tab"]');
        const slot = tab.parentElement;
        const barStyle = getComputedStyle(bar);
        const slotStyle = getComputedStyle(slot);
        const tabStyle = getComputedStyle(tab);
        return {
          bar: bar.getBoundingClientRect().height,
          viewport: bar.querySelector('[data-slot="scroll-area-viewport"]').getBoundingClientRect().height,
          slot: slot.getBoundingClientRect().height,
          tab: tab.getBoundingClientRect().height,
          tabWidth: tab.getBoundingClientRect().width,
          margins: [barStyle.marginTop, barStyle.marginBottom],
          barPadding: [barStyle.paddingTop, barStyle.paddingBottom],
          slotPadding: [slotStyle.paddingTop, slotStyle.paddingBottom],
          inset: tab.getBoundingClientRect().top - bar.getBoundingClientRect().top,
          leadingInset: tab.getBoundingClientRect().left - bar.getBoundingClientRect().left,
          tabPaddingX: [tabStyle.paddingLeft, tabStyle.paddingRight],
          borderTop: tabStyle.borderTopWidth,
          borderLeft: tabStyle.borderLeftWidth,
          borderBottom: tabStyle.borderBottomWidth,
        };
      }, selector);
      await assertTabSeparators(page.locator(`${selector} [role="tab"]`));
      assert.deepEqual(sizes, {
        bar: 32, viewport: 32, slot: 32, tab: 32, tabWidth: 168,
        margins: ['0px', '0px'], barPadding: ['0px', '0px'],
        slotPadding: ['0px', '0px'], inset: 0,
        leadingInset: 0, tabPaddingX: ['6px', '6px'],
        borderTop: selector === '[data-terminal-tab-bar]' ? '1px' : '0px',
        borderLeft: '1px',
        borderBottom: '0px',
      });
    }
    if (process.env.TAB_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.TAB_SCREENSHOT_DIR}/terminal-tabs-${width}.png` });
    }
  }
  await page.evaluate(async (localUser) => {
    const { useTerminalStore } = await import('/tab-runtime.js');
    for (let i = 0; i < 2; i++) {
      useTerminalStore.getState().beginConnectionAttempt({
        title: localUser.shell, host: 'localhost', port: 22, username: localUser.username,
      });
    }
  }, { username: userInfo().username, shell: basename(userInfo().shell || process.env.SHELL) });
  await page.locator('[data-terminal-tab-bar] [role="tab"]').nth(2).waitFor();
  await page.evaluate(async () => {
    const { useSftpStore } = await import('/tab-runtime.js');
    useSftpStore.getState().addLocalConnection();
    useSftpStore.getState().addLocalConnection();
  });
  const appearances = ['light', 'dark'].flatMap((theme) => [400, 1280].map((width) => ({ theme, width })));
  for (const { theme, width } of appearances) {
    await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), theme);
    await page.setViewportSize({ width, height: 720 });
    const sftpTabs = page.locator('[data-sftp-tab-bar] [role="tab"]');
    for (let index = 0; index < 3; index++) {
      await sftpTabs.nth(index).click();
      await assertTabSeparators(sftpTabs);
      await page.waitForFunction(() => {
        const bar = document.querySelector('[data-sftp-tab-bar]');
        const probe = document.createElement('div');
        probe.style.backgroundColor = 'var(--app-surface)';
        document.body.append(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return expected === getComputedStyle(bar.querySelector('[role="tab"][aria-selected="true"]')).backgroundColor;
      });
      const borders = await page.evaluate(() => {
        const bar = document.querySelector('[data-sftp-tab-bar]');
        const tab = bar.querySelector('[role="tab"][aria-selected="true"]');
        const style = getComputedStyle(tab);
        return { top: style.borderTopWidth, bottom: style.borderBottomWidth,
          left: style.borderLeftWidth, right: style.borderRightWidth,
          color: style.borderRightColor, line: getComputedStyle(bar, '::after').borderBottomColor,
          shadow: style.boxShadow,
          height: tab.getBoundingClientRect().height };
      });
      assert.equal(borders.height, 32);
      assert.equal(borders.top, '0px');
      assert.equal(borders.bottom, '0px');
      assert.equal(borders.left, '1px');
      assert.equal(borders.right, '1px');
      assert.equal(borders.color, borders.line);
      assert.equal(borders.shadow, 'none');
      const before = await sftpTabs.nth(index).locator('span').first().boundingBox();
      await sftpTabs.nth((index + 1) % 3).hover();
      const after = await sftpTabs.nth(index).locator('span').first().boundingBox();
      assert.ok(before && after);
      assert.equal(before.width, after.width);
      assert.equal(before.height, after.height);
    }
    const tabs = page.locator('[data-terminal-tab-bar] [role="tab"]');
    for (let index = 0; index < 3; index++) {
      // Pending tabs disable sorting and remain selectable.
      await tabs.nth(index).scrollIntoViewIfNeeded();
      const tabBox = await tabs.nth(index).boundingBox();
      assert.ok(tabBox);
      await page.mouse.click(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
      await page.waitForFunction((index) => document.querySelectorAll('[data-terminal-tab-bar] [role="tab"]')[index].getAttribute('aria-selected') === 'true', index);
      await assertTabSeparators(tabs);
      const geometry = await tabs.evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const title = element.querySelector('span.truncate').getBoundingClientRect();
        const style = getComputedStyle(element);
        return { left: rect.left, right: rect.right, topBorder: style.borderTopWidth, bottomBorder: style.borderBottomWidth,
          titleCenter: title.top + title.height / 2 - rect.top };
      }));
      assert.equal(geometry[0].right, geometry[1].left);
      assert.equal(geometry[1].right, geometry[2].left);
      assert.equal(geometry[index].topBorder, theme === 'light' ? '1px' : '0px');
      assert.equal(geometry[index].bottomBorder, '0px');
      assert.ok(geometry.every(tab => tab.titleCenter === 16), 'Tab titles stay vertically centered');
      await page.waitForFunction(() => {
        const bar = document.querySelector('[data-terminal-tab-bar]');
        const surface = getComputedStyle(document.documentElement).getPropertyValue('--app-surface').trim();
        const probe = document.createElement('div');
        probe.style.backgroundColor = surface;
        document.body.append(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return expected === getComputedStyle(bar.querySelector('[role="tab"][aria-selected="true"]')).backgroundColor;
      });
      const boundary = await page.evaluate(() => {
        const bar = document.querySelector('[data-terminal-tab-bar]');
        const topLine = getComputedStyle(bar, '::before');
        const line = getComputedStyle(bar, '::after');
        const active = getComputedStyle(bar.querySelector('[role="tab"][aria-selected="true"]'));
        return { lineColor: line.borderBottomColor, sideColor: active.borderRightColor,
          topColor: topLine.borderTopColor, topWidth: topLine.borderTopWidth, leftColor: active.borderLeftColor,
          leftWidth: active.borderLeftWidth, rightWidth: active.borderRightWidth, lineWidth: line.borderBottomWidth };
      });
      assert.equal(boundary.topColor, boundary.lineColor);
      assert.equal(boundary.topWidth, '1px');
      assert.equal(boundary.leftColor, boundary.sideColor);
      assert.equal(boundary.leftWidth, '1px');
      assert.equal(boundary.rightWidth, '1px');
      assert.equal(boundary.lineWidth, '1px');
      await page.mouse.move(width / 2, 400);
      await page.waitForTimeout(250);
      const strip = page.locator('[data-terminal-tab-bar]');
      const samples = await strip.evaluate(bar => {
        const bounds = bar.getBoundingClientRect();
        const visibleBounds = bar.querySelector('[data-slot="scroll-area-viewport"]').getBoundingClientRect();
        const tabs = [...bar.querySelectorAll('[role="tab"]')].map(tab => ({
          active: tab.getAttribute('aria-selected') === 'true', bounds: tab.getBoundingClientRect(),
        })).map(tab => ({ ...tab,
          left: Math.max(visibleBounds.left, tab.bounds.left), right: Math.min(visibleBounds.right, tab.bounds.right) }));
        const active = tabs.find(tab => tab.active);
        const inactive = tabs.find(tab => !tab.active && tab.right - tab.left > 12);
        return { active: Math.floor((active.left + active.right) / 2 - bounds.left),
          inactive: inactive ? Math.floor((inactive.left + inactive.right) / 2 - bounds.left) : null,
        };
      });
      const image = await loadImage(await strip.screenshot({ animations: 'disabled' }));
      const canvas = createCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const pixel = (x, y) => [...context.getImageData(x, y, 1, 1).data];
      const top = pixel(samples.active, 0);
      const fill = pixel(samples.active, 4);
      assert.notDeepEqual(top, fill, `The top border crosses the active tab (${theme}, ${width}px, tab ${index})`);
      assert.deepEqual(pixel(samples.active, 1), fill, `The top border occupies one pixel (${theme}, ${width}px)`);
      assert.deepEqual(pixel(samples.active, image.height - 2), fill,
        `The bottom border occupies one pixel (${theme}, ${width}px)`);
      for (const x of [samples.active, samples.inactive, image.width - 2].filter(x => x !== null)) {
        assert.deepEqual(pixel(x, 0), top, `The top border is continuous (${theme}, ${width}px, x=${x})`);
        assert.deepEqual(pixel(x, image.height - 1), top,
          `The bottom border matches the top across the bar (${theme}, ${width}px, x=${x})`);
      }
      if (process.env.TAB_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.TAB_SCREENSHOT_DIR}/terminal-tabs-${theme}-${width}-selected-${index}.png` });
    }
    const appearance = await page.evaluate((theme) => {
      const properties = ['height', 'width', 'backgroundColor', 'borderBottomWidth', 'borderLeftWidth', 'borderRightWidth',
        'borderTopLeftRadius', 'borderTopRightRadius', 'paddingLeft', 'paddingRight'];
      if (theme === 'dark') properties.push('borderTopWidth', 'borderLeftColor', 'borderRightColor');
      return ['[data-terminal-tab-bar]', '[data-sftp-tab-bar]'].map((selector) => {
        const bar = document.querySelector(selector);
        const tab = bar.querySelector('[role="tab"][aria-selected="true"]');
        const style = getComputedStyle(tab);
        return { tab: properties.map((property) => style[property]),
          strip: getComputedStyle(bar).backgroundColor,
          line: theme === 'dark' ? getComputedStyle(bar, '::after').borderBottomColor : undefined };
      });
    }, theme);
    assert.deepEqual(appearance[0], appearance[1], `${theme} ${width}px terminal/SFTP appearance differs`);
    if (process.env.TAB_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.TAB_SCREENSHOT_DIR}/terminal-tabs-multiple-${width}.png` });
  }
  for (const { theme, width } of appearances) {
    await page.setViewportSize({ width, height: 720 });
    await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), theme);
    // Regression: the leading drop indicator (insert index 0) used to sit left
    // of the scroll viewport's clip origin and was never painted. Render the
    // bar in that drop state and require the indicator to stay inside the
    // viewport's content box.
    const leading = await page.evaluate(async () => {
      const { React, createRoot, TerminalTabBar, useTerminalStore } = await import('/tab-runtime.js');
      useTerminalStore.getState().setActiveSession(useTerminalStore.getState().sessions[0].sessionId);
      const host = document.createElement('div');
      document.getElementById('root').append(host);
      createRoot(host).render(React.createElement(TerminalTabBar, { externalInsertIndex: 0 }));
      for (let i = 0; i < 50 && !host.querySelector('[data-drop-indicator="left"]'); i++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      const bar = host.querySelector('[data-terminal-tab-bar]');
      const viewport = bar.querySelector('[data-slot="scroll-area-viewport"]');
      const indicator = bar.querySelector('[data-drop-indicator="left"]');
      const vRect = viewport.getBoundingClientRect();
      const iRect = indicator.getBoundingClientRect();
      const geometry = {
        left: iRect.x,
        right: iRect.x + iRect.width,
        viewportLeft: vRect.x,
        viewportRight: vRect.x + vRect.width,
        width: iRect.width,
      };
      host.remove();
      return geometry;
    });
    assert.ok(
      leading.left >= leading.viewportLeft && leading.right <= leading.viewportRight,
      `leading indicator ${leading.left}..${leading.right} outside viewport ${leading.viewportLeft}..${leading.viewportRight}`,
    );
    assert.equal(leading.left, leading.viewportLeft, 'terminal leading indicator must be flush with the viewport');
    assert.equal(leading.width, 2);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  const sftpTabs = page.locator('[data-sftp-tab-bar] [role="tab"]');
  await sftpTabs.first().focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await sftpTabs.nth(1).evaluate((tab) => tab === document.activeElement), true);
  await page.keyboard.press('Enter');
  assert.equal(await sftpTabs.nth(1).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Space');
  assert.equal(await sftpTabs.first().getAttribute('aria-selected'), 'true');
  await page.evaluate(async () => {
    const { useSftpStore } = await import('/tab-runtime.js');
    useSftpStore.getState().togglePin(useSftpStore.getState().connections[0].id);
  });
  const unpin = sftpBar.getByRole('button', { name: /^取消固定页签 / });
  await unpin.waitFor();
  await sftpTabs.first().focus();
  await page.keyboard.press('Alt+Tab');
  assert.ok(await unpin.evaluate(button => button === document.activeElement), 'SFTP unpin is the next keyboard stop');
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(async () => {
    const { useSftpStore } = await import('/tab-runtime.js');
    return useSftpStore.getState().connections.some((connection) => connection.pinned);
  }), false);
  const sftpClose = sftpTabs.first().locator('xpath=following-sibling::button');
  await sftpTabs.first().focus();
  await page.keyboard.press('Alt+Tab');
  assert.ok(await sftpClose.evaluate(button => button === document.activeElement), 'SFTP close is the next keyboard stop');
  await page.keyboard.press('Enter');
  await page.getByRole('alertdialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
  for (const { theme, width } of appearances) {
    await page.setViewportSize({ width, height: 720 });
    await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), theme);
    const orderBefore = await sftpTabs.evaluateAll((tabs) => tabs.map((tab) => tab.dataset.sftpTab));
    await sftpTabs.nth(1).scrollIntoViewIfNeeded();
    const dragBox = await sftpTabs.nth(1).boundingBox();
    assert.ok(dragBox);
    await page.mouse.move(dragBox.x + 60, dragBox.y + 16);
    await page.mouse.down();
    await page.mouse.move(dragBox.x + 80, dragBox.y + 16);
    await page.waitForFunction(() => document.body.classList.contains('tab-dragging'));
    await page.mouse.move(2, dragBox.y + 16, { steps: 8 });
    const indicator = page.locator('[data-sftp-tab-bar] [data-drop-indicator="left"]').first();
    await indicator.waitFor();
    const indicatorBox = await indicator.boundingBox();
    const viewportBox = await page.locator('[data-sftp-tab-bar] [data-slot="scroll-area-viewport"]').boundingBox();
    assert.ok(indicatorBox && viewportBox);
    assert.equal(indicatorBox.x, viewportBox.x, 'SFTP leading indicator must be flush with the viewport');
    assert.equal(indicatorBox.width, 2);
    assert.ok(indicatorBox.y >= viewportBox.y && indicatorBox.y + indicatorBox.height <= viewportBox.y + viewportBox.height);
    if (process.env.TAB_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.TAB_SCREENSHOT_DIR}/sftp-leading-indicator-${theme}-${width}.png` });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.equal(await page.locator('[data-sftp-tab-bar] [data-drop-indicator]').count(), 0);
    assert.deepEqual(await sftpTabs.evaluateAll((tabs) => tabs.map((tab) => tab.dataset.sftpTab)), orderBefore);
  }
  for (const { theme, width } of appearances) {
    await page.setViewportSize({ width, height: 720 });
    await page.evaluate(async (theme) => {
      document.documentElement.setAttribute('data-theme', theme);
      const { useTerminalStore } = await import('/tab-runtime.js');
      const first = useTerminalStore.getState().sessions[0].sessionId;
      useTerminalStore.getState().setTabColor(first, '#f97316');
      useTerminalStore.getState().setActiveSession(first);
    }, theme);
    const colored = page.locator('[data-terminal-tab-bar] [role="tab"]').first();
    await page.waitForFunction(() => document.querySelector('[data-terminal-tab-bar] [role="tab"]').style.backgroundColor.includes('25%'));
    const activeFill = await colored.evaluate((tab) => tab.style.backgroundColor);
    assert.ok(activeFill.includes('var(--app-bg)'));
    assert.equal(await colored.locator('[data-tab-color]').count(), 0);
    // Wait for the actual background transition before capturing the result.
    await colored.evaluate(async (tab) => { await Promise.all(tab.getAnimations().map((animation) => animation.finished)); });
    const selectedBackground = await colored.evaluate((tab) => getComputedStyle(tab).backgroundColor);
    assert.notEqual(selectedBackground, 'rgba(0, 0, 0, 0)');
    if (process.env.TAB_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.TAB_SCREENSHOT_DIR}/terminal-tab-color-${theme}-${width}.png` });
    await page.evaluate(async () => {
      const { useTerminalStore } = await import('/tab-runtime.js');
      useTerminalStore.getState().setActiveSession(useTerminalStore.getState().sessions[1].sessionId);
    });
    await page.waitForFunction(() => document.querySelector('[data-terminal-tab-bar] [role="tab"]').style.backgroundColor.includes('8%'));
    assert.ok((await colored.evaluate((tab) => tab.style.backgroundColor)).includes('var(--app-surface-muted)'));
    await colored.evaluate(async (tab) => { await Promise.all(tab.getAnimations().map((animation) => animation.finished)); });
    const inactiveBackground = await colored.evaluate((tab) => getComputedStyle(tab).backgroundColor);
    assert.notEqual(inactiveBackground, selectedBackground);
    await colored.hover();
    await colored.evaluate(async (tab) => { await Promise.all(tab.getAnimations().map((animation) => animation.finished)); });
    assert.equal(await colored.evaluate((tab) => getComputedStyle(tab).backgroundColor), inactiveBackground);
    if (process.env.TAB_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.TAB_SCREENSHOT_DIR}/terminal-tab-color-inactive-${theme}-${width}.png` });
    await page.evaluate(async () => {
      const { useTerminalStore } = await import('/tab-runtime.js');
      useTerminalStore.getState().setTabColor(useTerminalStore.getState().sessions[0].sessionId, undefined);
    });
    await page.waitForFunction(() => document.querySelector('[data-terminal-tab-bar] [role="tab"]').style.backgroundColor === '');
    await colored.evaluate(async (tab) => { await Promise.all(tab.getAnimations().map((animation) => animation.finished)); });
    const neutralBackground = await colored.evaluate((tab) => getComputedStyle(tab).backgroundColor);
    assert.notEqual(neutralBackground, inactiveBackground);
  }
  const schemes = ['oneDark', 'solarizedDark', 'dracula', 'nord', 'gruvboxDark', 'tokyoNight', 'catppuccinMocha', 'light', 'app'];
  for (const { theme, scheme } of ['light', 'dark'].flatMap((theme) => schemes.map((scheme) => ({ theme, scheme })))) {
    await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), theme);
    const expectedBackground = await page.evaluate(async (scheme) => {
      const { useAppStore, useTerminalStore, resolveTerminalTheme } = await import('/tab-runtime.js');
      useAppStore.getState().setTerminalColorScheme(scheme);
      useTerminalStore.getState().setActiveSession(useTerminalStore.getState().sessions[0].sessionId);
      const probe = document.createElement('div');
      probe.style.backgroundColor = resolveTerminalTheme(scheme).background;
      document.body.append(probe);
      const background = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return background;
    }, scheme);
    await page.waitForFunction((background) => {
      const tab = document.querySelector('[data-terminal-tab-bar] [role="tab"][aria-selected="true"]');
      return getComputedStyle(tab).backgroundColor === background;
    }, expectedBackground);
    if (process.env.TAB_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.TAB_SCREENSHOT_DIR}/terminal-tab-surface-${theme}-${scheme}.png` });
  }
  await page.evaluate(async () => {
    const { useSftpStore } = await import('/tab-runtime.js');
    const { connections, setActiveConnection } = useSftpStore.getState();
    setActiveConnection(connections[0].id);
  });
  for (const width of [400, 1280]) {
    await page.setViewportSize({ width, height: 720 });
    for (const section of ['terminal', 'sftp']) {
      const context = `${section} at ${width}px`;
      const bar = page.locator(`[data-${section}-tab-bar]`);
      await bar.evaluate(element => { element.style.maxWidth = '320px'; });
      const viewport = bar.locator('[data-slot="scroll-area-viewport"]');
      await viewport.evaluate(element => { element.scrollLeft = 0; });
      const thumb = bar.locator('[data-slot="scroll-area-thumb"]');
      await thumb.waitFor();
      const thumbBox = await thumb.boundingBox();
      assert.ok(thumbBox && thumbBox.width > 0 && thumbBox.height > 0, `${context}: the scrollbar thumb must be visible`);
      assert.equal(thumbBox.y, (await bar.boundingBox()).y, `${context}: the scrollbar must sit flush with the top of the tab bar`);
      const x = thumbBox.x + thumbBox.width / 2;
      const y = thumbBox.y + thumbBox.height / 2;
      assert.equal(await thumb.evaluate((element, { x, y }) => document.elementFromPoint(x, y) === element, { x, y }), true,
        `${context}: the scrollbar thumb must receive pointer input above the selected tab`);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 40, y, { steps: 5 });
      await page.mouse.up();
      assert.ok(await viewport.evaluate(element => element.scrollLeft > 0), `${context}: the scrollbar must remain draggable`);
      await bar.evaluate(element => { element.style.maxWidth = ''; });
    }
  }
  await page.evaluate(async () => {
    const { useTerminalStore } = await import('/tab-runtime.js');
    const store = useTerminalStore.getState();
    const { sessionId } = store.sessions[0];
    store.setStatus(sessionId, { sessionId, status: 'error', message: 'Connection ended' });
  });
  for (const { theme, width } of appearances) {
    await page.setViewportSize({ width, height: 720 });
    await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), theme);
    const previewAppearances = [];
    for (const [section, tabAttribute] of [['terminal', 'data-session-tab'], ['sftp', 'data-sftp-tab']]) {
      const context = `${section}, ${theme}, ${width}px`;
      const barSelector = `[data-${section}-tab-bar]`;
      const sourceTab = page.locator(`${barSelector} [${tabAttribute}]`).first();
      const dragPreview = page.locator(`[${tabAttribute}]:not(${barSelector} *)`);
      await sourceTab.scrollIntoViewIfNeeded();
      const sourceBox = await sourceTab.boundingBox();
      assert.ok(sourceBox);
      const x = sourceBox.x + 60;
      const y = sourceBox.y + sourceBox.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 20, y);
      await dragPreview.waitFor();
      await page.mouse.move(140, 120);
      const appearance = await dragPreview.evaluate((tab) => {
        const style = getComputedStyle(tab);
        return {
          opacity: style.opacity,
          background: style.backgroundColor,
          color: style.color,
          canvas: getComputedStyle(document.body).backgroundColor,
          shadow: style.boxShadow,
        };
      });
      assert.equal(appearance.opacity, '1', `${context}: the preview must be fully opaque`);
      assert.notEqual(appearance.background, appearance.canvas);
      assert.notEqual(appearance.shadow, 'none');
      assert.equal(await dragPreview.getAttribute('aria-label'), await sourceTab.getAttribute('aria-label'));
      const previewBox = await dragPreview.boundingBox();
      assert.deepEqual(previewBox, { x: 142, y: 122, width: sourceBox.width, height: sourceBox.height }, context);
      previewAppearances.push(appearance);
      if (process.env.TAB_SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.TAB_SCREENSHOT_DIR}/${section}-drag-preview-${theme}-${width}.png` });
      }
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await dragPreview.waitFor({ state: 'hidden' });
    }
    assert.deepEqual(previewAppearances[1], previewAppearances[0], `Drag preview styles at ${theme}, ${width}px`);
  }
  // A target remains marked after a connection error and while another tab is active.
  await page.evaluate(async () => {
    const { useTerminalStore, useFocusStore } = await import('/tab-runtime.js');
    const sessionId = useTerminalStore.getState().sessions[0].sessionId;
    useFocusStore.setState({ enabled: true, targetSessionId: sessionId });
  });
  const targetTab = page.locator('[data-terminal-tab-bar] [role="tab"]').first();
  const closeTarget = targetTab.locator('xpath=following-sibling::button');
  const targetIcon = closeTarget.locator('[data-slot="focus-tab-target"]');
  const closeIcon = closeTarget.locator('svg.lucide-x');
  const more = page.getByRole('button', { name: '终端页签操作' });
  const sftpInactiveClose = sftpTabs.nth(1).locator('xpath=following-sibling::button');
  const background = (control) => control.evaluate(async (element) => {
    getComputedStyle(element).backgroundColor;
    await Promise.all(element.getAnimations().map(animation => animation.finished));
    return getComputedStyle(element).backgroundColor;
  });
  const backgroundPixel = async (control) => {
    const image = await loadImage(await control.screenshot({ animations: 'disabled' }));
    const context = createCanvas(image.width, image.height).getContext('2d');
    context.drawImage(image, 0, 0);
    return [...context.getImageData(3, Math.floor(image.height / 2), 1, 1).data];
  };
  for (const { theme, width } of appearances) {
    await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), theme);
    await page.setViewportSize({ width, height: 720 });
    for (const active of [true, false]) {
      await page.evaluate(async (active) => {
        const { useTerminalStore } = await import('/tab-runtime.js');
        useTerminalStore.getState().setActiveSession(useTerminalStore.getState().sessions[active ? 0 : 1].sessionId);
      }, active);
      await targetTab.scrollIntoViewIfNeeded();
      await page.mouse.click(width - 10, 300);
      await targetIcon.waitFor({ state: 'visible' });
      assert.equal(await targetIcon.getAttribute('aria-label'), 'Agent 目标');
      const { width: iconWidth, height: iconHeight } = await targetIcon.locator('svg').boundingBox();
      assert.equal(iconWidth, 12, 'Target icon must fit the compact tab');
      assert.equal(iconHeight, 12);
      assert.equal(await targetIcon.evaluate(el => {
        const reference = document.createElement('span');
        reference.style.color = 'var(--app-success)';
        el.append(reference);
        const matches = getComputedStyle(el.querySelector('svg')).color === getComputedStyle(reference).color;
        reference.remove();
        return matches;
      }), true, 'Target icon uses the theme success color');
      if (process.env.TAB_SCREENSHOT_DIR) {
        await page.locator('[data-terminal-tab-bar]').screenshot({ path: `${process.env.TAB_SCREENSHOT_DIR}/terminal-target-${theme}-${width}-${active}.png` });
      }
      assert.equal(await closeIcon.isVisible(), false);
      assert.equal(await closeTarget.locator('[data-slot="focus-tab-target"]').count(), 1);
      const before = await closeTarget.boundingBox();
      assert.equal(before.width, 20);
      assert.equal(before.height, 20);
      await targetTab.hover({ position: { x: 30, y: 16 } });
      await closeIcon.waitFor({ state: 'visible' });
      assert.equal(await targetIcon.isVisible(), false);
      assert.deepEqual(await closeTarget.boundingBox(), before);
      await closeTarget.hover();
      const closeFill = await background(closeTarget);
      assert.notEqual(closeFill, 'rgba(0, 0, 0, 0)');
      if (!active) {
        const closePixel = await backgroundPixel(closeTarget);
        await sftpTabs.nth(1).hover({ position: { x: 30, y: 16 } });
        await sftpInactiveClose.hover();
        assert.equal(await background(sftpInactiveClose), closeFill);
        assert.deepEqual(await backgroundPixel(sftpInactiveClose), closePixel);

        await more.hover();
        assert.equal(await background(more), closeFill);
        assert.deepEqual(await backgroundPixel(more), closePixel,
          `${theme}/${width}: inactive close and more buttons paint the same hover over the tab strip`);
        if (process.env.TAB_SCREENSHOT_DIR) {
          await page.screenshot({ path: `${process.env.TAB_SCREENSHOT_DIR}/terminal-actions-hover-${theme}-${width}.png` });
        }
        await more.click();
        const menu = page.getByRole('menu');
        await menu.waitFor();
        await page.mouse.move(width - 10, 300);
        assert.equal(await background(more), closeFill, 'The expanded menu keeps the same highlight');
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'hidden' });
        assert.equal(await background(more), 'rgba(0, 0, 0, 0)', 'Closing the menu clears the highlight');
      }
      await page.mouse.move(width - 10, 300);
      await closeTarget.focus();
      await closeIcon.waitFor({ state: 'visible' });
      assert.equal(await targetIcon.isVisible(), false);
    }
  }
  await page.evaluate(async () => {
    const { useAppStore } = await import('/tab-runtime.js');
    useAppStore.getState().setLocale('en-US');
  });
  await page.mouse.click(300, 300);
  await closeTarget.getByRole('img', { name: 'Agent target', exact: true }).waitFor({ state: 'visible' });
  assert.equal(await closeTarget.getAttribute('title'), null);
  await targetTab.focus();
  await page.keyboard.press('Alt+Tab');
  assert.ok(await closeTarget.evaluate(button => button === document.activeElement), 'Terminal close is the next keyboard stop');
  await page.keyboard.press('Enter');
  await page.getByRole('alertdialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
  await page.evaluate(async () => {
    const { useTerminalStore, useFocusStore } = await import('/tab-runtime.js');
    useTerminalStore.getState().togglePin(useFocusStore.getState().targetSessionId);
  });
  await closeTarget.and(page.getByRole('button', { name: /^Unpin tab / })).waitFor();
  const pinnedTargetIcon = targetTab.getByRole('img', { name: 'Agent target', exact: true });
  await pinnedTargetIcon.waitFor();
  assert.equal(await pinnedTargetIcon.getAttribute('title'), null);
  await targetTab.focus();
  await page.keyboard.press('Alt+Tab');
  assert.ok(await closeTarget.evaluate(button => button === document.activeElement), 'Terminal unpin is the next keyboard stop');
  await page.keyboard.press('Space');
  await closeTarget.and(page.getByRole('button', { name: /^Close tab / })).waitFor();
  console.log('Terminal and SFTP appearance, keyboard actions, pinning, target icon hover, tab colors and terminal surfaces verified.');
} finally {
  await browser?.close();
  await server.close();
}
