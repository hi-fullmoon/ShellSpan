import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
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
  server: { host: '127.0.0.1', port: 0 },
});

let browser;
try {
  await server.listen();
  browser = await webkit.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.evaluate(async (localUser) => {
    await import('/src/styles/base.css');
    const { React, createRoot, TerminalTabBar, useTerminalStore, SftpTabBar, useSftpStore } = await import('/tab-runtime.js');
    // Exercise the real pending-connection state without replacing IPC or browser geometry.
    useTerminalStore.getState().beginConnectionAttempt({
      title: localUser.shell, host: 'localhost', port: 22, username: localUser.username,
    });
    useSftpStore.getState().addLocalConnection();
    createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
      React.createElement(TerminalTabBar), React.createElement(SftpTabBar)));
  }, { username: userInfo().username, shell: basename(userInfo().shell || process.env.SHELL) });
  await page.locator('[data-terminal-tab-bar] [role="tab"]').waitFor();
  await page.locator('[data-sftp-tab-bar] [role="tab"]').waitFor();
  await page.evaluate(async () => {
    const { useAppStore } = await import('/tab-runtime.js');
    useAppStore.getState().setTerminalTabTitleTemplate('${user}@${host} #${index}');
  });
  const terminalTab = page.locator('[data-terminal-tab-bar] [role="tab"]');
  await terminalTab.getByText(`${userInfo().username}@localhost #1`, { exact: true }).waitFor();
  assert.equal(await terminalTab.getAttribute('aria-label'), `${userInfo().username}@localhost #1`);
  assert.ok((await terminalTab.getAttribute('title')).includes(`${userInfo().username}@localhost:22`));
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
      const terminal = selector === '[data-terminal-tab-bar]';
      assert.deepEqual(sizes, {
        bar: terminal ? 32 : 40, viewport: terminal ? 32 : 40, slot: terminal ? 32 : 40, tab: 32, tabWidth: 168,
        margins: ['0px', '0px'], barPadding: ['0px', '0px'],
        slotPadding: terminal ? ['0px', '0px'] : ['4px', '4px'], inset: terminal ? 0 : 4,
        leadingInset: terminal ? 0 : 4, tabPaddingX: ['6px', '6px'],
        borderTop: terminal ? '0px' : '1px',
        borderLeft: '1px',
        borderBottom: terminal ? '0px' : '1px',
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
  const appearances = ['light', 'dark'].flatMap((theme) => [400, 1280].map((width) => ({ theme, width })));
  for (const { theme, width } of appearances) {
    await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), theme);
    await page.setViewportSize({ width, height: 720 });
    const tabs = page.locator('[data-terminal-tab-bar] [role="tab"]');
    for (let index = 0; index < 3; index++) {
      // Pending tabs disable sorting via aria-disabled on their wrapper, but
      // remain selectable. Use the pointer as a user would, without treating
      // the sortable wrapper's state as a disabled tab action.
      await tabs.nth(index).scrollIntoViewIfNeeded();
      const tabBox = await tabs.nth(index).boundingBox();
      assert.ok(tabBox);
      await page.mouse.click(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
      await page.waitForFunction((index) => document.querySelectorAll('[data-terminal-tab-bar] [role="tab"]')[index].getAttribute('aria-selected') === 'true', index);
      const geometry = await tabs.evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { left: rect.left, right: rect.right, topBorder: style.borderTopWidth, bottomBorder: style.borderBottomWidth };
      }));
      assert.equal(geometry[0].right, geometry[1].left);
      assert.equal(geometry[1].right, geometry[2].left);
      assert.equal(geometry[index].topBorder, '0px');
      assert.equal(geometry[index].bottomBorder, '0px');
      await page.waitForFunction(() => {
        const bar = document.querySelector('[data-terminal-tab-bar]');
        return getComputedStyle(bar, '::after').backgroundColor === getComputedStyle(bar.querySelector('[role="tab"][aria-selected="true"]')).backgroundColor;
      });
      const boundary = await page.evaluate(() => {
        const bar = document.querySelector('[data-terminal-tab-bar]');
        const line = getComputedStyle(bar, '::after');
        const active = getComputedStyle(bar.querySelector('[role="tab"][aria-selected="true"]'));
        return { lineColor: line.borderBottomColor, sideColor: active.borderRightColor,
          topColor: active.borderTopColor, leftColor: active.borderLeftColor,
          leftWidth: active.borderLeftWidth, rightWidth: active.borderRightWidth,
          lineBackground: line.backgroundColor, tabBackground: active.backgroundColor };
      });
      assert.equal(boundary.lineColor, boundary.sideColor);
      assert.equal(boundary.topColor, boundary.sideColor);
      assert.equal(boundary.leftColor, boundary.sideColor);
      assert.equal(boundary.leftWidth, '1px');
      assert.equal(boundary.rightWidth, '1px');
      assert.equal(boundary.lineBackground, boundary.tabBackground);
      if (process.env.TAB_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.TAB_SCREENSHOT_DIR}/terminal-tabs-${theme}-${width}-selected-${index}.png` });
    }
    if (process.env.TAB_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.TAB_SCREENSHOT_DIR}/terminal-tabs-multiple-${width}.png` });
  }
  {
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
      };
      host.remove();
      return geometry;
    });
    assert.ok(
      leading.left >= leading.viewportLeft && leading.right <= leading.viewportRight,
      `leading indicator ${leading.left}..${leading.right} outside viewport ${leading.viewportLeft}..${leading.viewportRight}`,
    );
  }
  console.log('Terminal and SFTP tab layout and visible drag indicators verified.');
} finally {
  await browser?.close();
  await server.close();
}
