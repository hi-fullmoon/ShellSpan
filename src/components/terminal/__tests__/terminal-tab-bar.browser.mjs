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
        };
      }, selector);
      assert.deepEqual(sizes, {
        bar: 34, viewport: 34, slot: 34, tab: 30, tabWidth: 168,
        margins: ['0px', '0px'], barPadding: ['0px', '0px'],
        slotPadding: ['2px', '2px'], inset: 2,
      });
      console.log(`${selector} ${width}px: tab bar 34px, visible tab 168×30px, vertical inset 2px`);
    }
  }
} finally {
  await browser?.close();
  await server.close();
}
