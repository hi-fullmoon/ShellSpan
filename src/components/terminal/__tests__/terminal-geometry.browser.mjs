import assert from 'node:assert/strict';
import { webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const server = await createServer({
  configFile: false,
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  plugins: [tailwindcss(), {
    name: 'terminal-geometry-test',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/geometry') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<html><head><script type="module">import "/src/styles/base.css";</script></head><body><div id="pane" style="height:600px"></div></body></html>');
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
  const address = server.httpServer.address();
  await page.goto(`http://127.0.0.1:${address.port}/geometry`);
  await page.waitForFunction(() => getComputedStyle(document.body).margin === '0px');
  for (const width of [1982, 1280, 640]) {
    await page.setViewportSize({ width, height: 800 });
    for (const fontSize of [14, 18]) {
      const result = await page.evaluate(async ({ fontSize }) => {
        const { measureTerminalGeometry, TERMINAL_CONTAINER_CLASS } = await import('/src/components/terminal/registry/terminal-geometry.ts');
        const { Terminal } = await import('/node_modules/@xterm/xterm/lib/xterm.mjs');
        const pane = document.getElementById('pane');
        const options = { fontFamily: 'Menlo, monospace', fontSize, lineHeight: 1.2, letterSpacing: 1 };
        await document.fonts.ready;
        const dimensions = measureTerminalGeometry(pane, options);
        if (!dimensions) throw new Error('Visible terminal was not measured');
        const cleaned = pane.childElementCount === 0;
        const container = document.createElement('div');
        container.className = TERMINAL_CONTAINER_CLASS;
        pane.appendChild(container);
        // Open at the measured size, with no subsequent fit/resize.
        const terminal = new Terminal({ ...options, ...dimensions });
        terminal.open(container);
        const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
        await new Promise((resolve) => terminal.write(`\x1b[1;${dimensions.cols - time.length + 1}H${time}`, resolve));
        await new Promise(requestAnimationFrame);
        const screen = container.querySelector('.xterm-screen').getBoundingClientRect();
        const host = pane.getBoundingClientRect();
        const lastCells = terminal.buffer.active.getLine(0).translateToString().slice(-time.length);
        const result = { dimensions, cleaned, gap: host.right - screen.right, cellWidth: screen.width / terminal.cols, lastCells, time };
        terminal.dispose();
        container.remove();
        pane.style.display = 'none';
        result.hidden = measureTerminalGeometry(pane, options) === undefined;
        pane.style.display = '';
        return result;
      }, { fontSize });
      assert.ok(result.cleaned, 'Measurement must release its terminal and DOM');
      assert.ok(result.hidden, 'Hidden panes must not produce a false measurement');
      assert.equal(result.lastCells, result.time);
      assert.ok(result.gap >= 0 && result.gap < 20 + result.cellWidth, JSON.stringify(result));
      if (width === 1982) assert.ok(result.dimensions.cols > 120);
      process.stdout.write(`${width}px / ${fontSize}px font: ${result.dimensions.cols} columns, right gap ${result.gap}px\n`);
    }
  }
} finally {
  await browser?.close();
  await server.close();
}
