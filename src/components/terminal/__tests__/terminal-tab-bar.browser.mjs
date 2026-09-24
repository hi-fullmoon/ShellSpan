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
        };
      }, selector);
      assert.deepEqual(sizes, {
        bar: 40, viewport: 40, slot: 40, tab: 32, tabWidth: 168,
        margins: ['0px', '0px'], barPadding: ['0px', '0px'],
        slotPadding: ['4px', '4px'], inset: 4,
        leadingInset: 4, tabPaddingX: ['6px', '6px'],
      });
    }
  }
  {
    // Regression: the leading drop indicator (insert index 0) used to sit left
    // of the scroll viewport's clip origin and was never painted. Render the
    // bar in that drop state and require the indicator to stay inside the
    // viewport's content box.
    const leading = await page.evaluate(async () => {
      const { React, createRoot, TerminalTabBar } = await import('/tab-runtime.js');
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
  console.log('terminal and sftp tab bars: 40px bar, tab 168×32px, leading inset 4px, tab padding 6px');
} finally {
  await browser?.close();
  await server.close();
}
