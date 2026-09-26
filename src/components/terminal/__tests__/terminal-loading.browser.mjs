import assert from 'node:assert/strict';
import { webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

const server = await createServer({
  configFile: false,
  logLevel: 'error',
  resolve: { alias: { '@': resolve('src') } },
  plugins: [tailwindcss(), {
    name: 'terminal-loading-regression',
    resolveId(id) {
      if (id === '/loading-deps') return '\0loading-deps';
    },
    load(id) {
      if (id === '\0loading-deps') return 'export { default as React } from "react"; export { createRoot } from "react-dom/client";';
    },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/loading') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<html><head><script type="module">import "/src/styles/base.css";</script></head><body><div id="root" style="height:100vh"></div></body></html>');
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
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/loading`);
  await page.evaluate(async () => {
    const { React, createRoot } = await import('/loading-deps');
    const { TerminalPane } = await import('/src/components/terminal/terminal-pane.tsx');
    const { useAppStore } = await import('/src/stores/appStore.ts');
    window.setScheme = (terminalColorScheme) => useAppStore.setState({ terminalColorScheme });
    window.renderPane = (status) => window.root.render(React.createElement(TerminalPane, {
      activeSession: { sessionId: 'loading-theme', status },
    }));
    window.root = createRoot(document.getElementById('root'));
    window.renderPane('connecting');
  });
  const overlay = page.locator('div.absolute.inset-0.z-10').filter({ has: page.locator('svg.animate-spin') });
  await overlay.waitFor();
  for (const width of [1280, 640]) {
    await page.setViewportSize({ width, height: 800 });
    for (const scheme of ['solarizedDark', 'light', 'app']) {
      for (const appTheme of ['light', 'dark']) {
        await page.evaluate(({ scheme, appTheme }) => {
          document.documentElement.dataset.theme = appTheme;
          window.setScheme(scheme);
        }, { scheme, appTheme });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const result = await overlay.evaluate(async (element, scheme) => {
          const { resolveTerminalTheme } = await import('/src/components/terminal/registry/terminal-registry.ts');
          const theme = resolveTerminalTheme(scheme);
          const probe = document.createElement('div');
          probe.style.backgroundColor = theme.background;
          probe.style.color = theme.foreground;
          document.body.appendChild(probe);
          const expected = getComputedStyle(probe);
          const actual = getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          const result = {
            background: actual.backgroundColor === expected.backgroundColor,
            foreground: getComputedStyle(element.querySelector('span')).color === expected.color,
            spinner: getComputedStyle(element.querySelector('svg')).color === expected.color,
            surface: getComputedStyle(element.parentElement).backgroundColor === actual.backgroundColor,
            fillsPane: bounds.width === innerWidth && bounds.height === innerHeight,
          };
          probe.remove();
          return result;
        }, scheme);
        for (const [check, passed] of Object.entries(result)) {
          assert.ok(passed, `${width}px ${scheme}/${appTheme}: ${check}`);
        }
        if (scheme === 'solarizedDark' && appTheme === 'light') {
          await page.screenshot({ path: `/tmp/shellspan-loading-${width}.png` });
        }
      }
    }
  }
  await page.evaluate(() => window.renderPane('connected'));
  await overlay.waitFor({ state: 'detached' });
  process.stdout.write('Terminal loading theme regression passed at wide and narrow widths.\n');
} finally {
  await browser?.close();
  await server.close();
}
