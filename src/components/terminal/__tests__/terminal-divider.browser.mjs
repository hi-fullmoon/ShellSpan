import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const text = readFileSync(`${root}src/components/ui/split-pane.tsx`, 'utf8');
const server = await createServer({
  root, configFile: false, logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  plugins: [tailwindcss(), {
    name: 'terminal-divider-regression',
    resolveId(id) { if (id === '/divider-runtime.js') return id; },
    load(id) {
      if (id !== '/divider-runtime.js') return;
      return `
        export { default as React } from 'react';
        export { createRoot } from 'react-dom/client';
        export { SplitPane } from '/src/components/ui/split-pane.tsx';
        export { FocusDivider } from '/src/components/focus/focus-workspace.tsx';
        export { initI18n } from '/src/locales/index.ts';
        export { Terminal } from '@xterm/xterm';
        export { FitAddon } from '@xterm/addon-fit';
        export { resolveTerminalTheme } from '/src/components/terminal/registry/terminal-registry.ts';
        export { TERMINAL_CONTAINER_CLASS, installTerminalScrollbarVisibility } from '/src/components/terminal/registry/terminal-geometry.ts';
        import '/src/styles/base.css';
      `;
    },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/divider') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<html data-theme="dark"><body style="background:var(--app-surface)"><div id="root" style="height:600px"></div><script type="module">window.runtime = await import("/divider-runtime.js");</script></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await webkit.launch();
  for (const width of [1400, 640]) {
    const page = await browser.newPage({ viewport: { width, height: 700 } });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/divider`);
    await page.waitForFunction(() => window.runtime);
    await page.evaluate(async () => {
      const { React, createRoot, SplitPane, FocusDivider, initI18n } = window.runtime;
      await initI18n('zh-CN');
      createRoot(document.getElementById('root')).render(React.createElement(SplitPane, {
        left: React.createElement('div', { style: { height: '100%', background: 'var(--app-surface)' } },
          React.createElement('div', { style: { height: '100%', display: 'flex' } }, React.createElement(FocusDivider))),
        right: React.createElement('div', { id: 'terminal', style: { height: '100%' } }),
      }));
    });
    await page.locator('#terminal').waitFor();
    const divider = page.locator('[data-slot="split-pane-divider"]');
    const systemBorder = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.borderLeft = '1px solid var(--border)';
      document.body.append(probe);
      const color = getComputedStyle(probe).borderLeftColor;
      probe.remove();
      return color;
    });
    assert.equal(await divider.evaluate(el => getComputedStyle(el).backgroundColor), systemBorder);
    const focusDivider = page.locator('[data-slot="focus-divider"]');
    assert.equal(await focusDivider.evaluate(el => getComputedStyle(el).backgroundColor), systemBorder,
      'Focus mode must use the standard system border without additional opacity');
    assert.equal((await focusDivider.boundingBox()).width, 1);
    const before = await divider.boundingBox();
    assert.equal(before.width, 1);
    await divider.focus();
    await page.keyboard.press('ArrowRight');
    const after = await divider.boundingBox();
    assert.ok(after.x > before.x, 'Keyboard resizing remains available');
    await divider.evaluate(el => el.blur());
    await page.mouse.move(0, 650);
    for (const scheme of ['app', 'light', 'catppuccinMocha']) {
      const result = await page.evaluate(async ({ scheme, text }) => {
        const { Terminal, FitAddon, resolveTerminalTheme, TERMINAL_CONTAINER_CLASS, installTerminalScrollbarVisibility } = window.runtime;
        const host = document.getElementById('terminal');
        host.className = TERMINAL_CONTAINER_CLASS;
        const terminal = new Terminal({ theme: resolveTerminalTheme(scheme), overviewRuler: { width: 10 }, allowProposedApi: true });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(host);
        fit.fit();
        const visibility = installTerminalScrollbarVisibility(terminal);
        await new Promise(resolve => terminal.write(text.replaceAll('\n', '\r\n'), resolve));
        await new Promise(resolve => setTimeout(resolve, 150));
        const canvas = host.querySelector('.xterm-decoration-overview-ruler');
        const pixels = canvas.getContext('2d').getImageData(0, 0, 1, canvas.height).data;
        const borderTransparent = pixels.every((value, index) => index % 4 !== 3 || value === 0);
        terminal.scrollToTop();
        const scrollable = terminal.buffer.active.baseY > 0 && terminal.buffer.active.viewportY === 0;
        terminal.scrollToBottom();
        window.terminal = terminal;
        window.visibility = visibility;
        return { borderTransparent, scrollable };
      }, { scheme, text });
      assert.ok(result.borderTransparent, `${width}/${scheme}: overview ruler must have no visible border`);
      assert.ok(result.scrollable, `${width}/${scheme}: scrollback remains usable`);
      if (scheme === 'app') await page.screenshot({ path: `/tmp/shellspan-terminal-divider-${width}.png` });
      await page.evaluate(() => { window.visibility.dispose(); window.terminal.dispose(); });
    }
    await page.close();
  }
  process.stdout.write('Dark split divider, keyboard resizing, ruler pixels and scrollback passed at wide and narrow widths.\n');
} finally {
  await browser?.close();
  await server.close();
}
