import assert from 'node:assert/strict';
import { webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const server = await createServer({
  configFile: false,
  logLevel: 'error',
  resolve: { alias: { '@': fileURLToPath(new URL('../../../', import.meta.url)) } },
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
  await page.exposeFunction('captureTerminalEdges', async () => {
    if (process.env.TERMINAL_EDGE_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.TERMINAL_EDGE_SCREENSHOT_DIR}/terminal-edges-${page.viewportSize().width}.png` });
    }
  });
  const address = server.httpServer.address();
  await page.goto(`http://127.0.0.1:${address.port}/geometry`);
  await page.waitForFunction(() => getComputedStyle(document.body).margin === '0px');
  for (const width of [1982, 1280, 640]) {
    await page.setViewportSize({ width, height: 800 });
    const edgeResult = await page.evaluate(async () => {
      const { TERMINAL_CONTAINER_CLASS } = await import('/src/components/terminal/registry/terminal-geometry.ts');
      const { installTerminalEdgeBackground } = await import('/src/components/terminal/registry/terminal-edge-background.ts');
      const { Terminal } = await import('/node_modules/@xterm/xterm/lib/xterm.mjs');
      const { FitAddon } = await import('/node_modules/@xterm/addon-fit/lib/addon-fit.mjs');
      const pane = document.getElementById('pane');
      const container = document.createElement('div');
      container.className = TERMINAL_CONTAINER_CLASS;
      pane.appendChild(container);
      const terminal = new Terminal({ theme: { background: '#ffffff', foreground: '#112233', red: '#884422' } });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(container);
      fit.fit();
      const edges = installTerminalEdgeBackground(terminal);
      const settle = async () => {
        for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
      };
      const write = async (data) => {
        await new Promise((resolve) => terminal.write(data, resolve));
        await settle();
      };
      const edge = (side) => container.querySelector(`[data-terminal-edge="${side}"]`);
      const color = (side) => getComputedStyle(edge(side)).backgroundColor;
      const result = {};
      try {
        result.compatibility = container.querySelectorAll('[data-terminal-edge]').length === 4;
        await write('Shell prompt');
        result.normalHidden = [...container.querySelectorAll('[data-terminal-edge]')].every((node) => getComputedStyle(node).display === 'none');
        // Exercise real xterm parsing/rendering: RGB, indexed palette, inverse,
        // OSC palette updates and alternate-screen exit, with no terminal mocks.
        await write('\x1b[?1049h\x1b[48;2;30;30;46m\x1b[2J');
        result.rgb = ['top', 'bottom', 'left', 'right'].every((side) => color(side) === 'rgb(30, 30, 46)');
        const screen = container.querySelector('.xterm-screen').getBoundingClientRect();
        const outer = terminal.element.getBoundingClientRect();
        const top = edge('top').getBoundingClientRect();
        const bottom = edge('bottom').getBoundingClientRect();
        const right = edge('right').getBoundingClientRect();
        result.geometry = Math.abs(top.bottom - screen.top) < 0.1
          && Math.abs(bottom.top - screen.bottom) < 0.1
          && Math.abs(bottom.bottom - outer.bottom) < 0.1
          && Math.abs(right.left - screen.right) < 0.1
          && Math.abs(right.right - outer.right) < 0.1;
        result.pointerPassthrough = getComputedStyle(edge('left')).pointerEvents === 'none';
        await write(`\x1b[${terminal.rows};1H\x1b[41m\x1b[2K`);
        result.palette = color('bottom') === 'rgb(136, 68, 34)'
          && edge('left').style.background.includes('linear-gradient');
        await window.captureTerminalEdges();
        await write('\x1b]4;1;rgb:22/66/88\x07');
        result.osc = color('bottom') === 'rgb(34, 102, 136)';
        await write(`\x1b[0;7m${' '.repeat(terminal.cols)}`);
        result.inverse = color('bottom') === 'rgb(17, 34, 51)';
        terminal.options.theme = { background: '#ffffff', foreground: '#445566' };
        await settle();
        result.theme = color('bottom') === 'rgb(68, 85, 102)';
        const half = Math.floor(terminal.cols / 2);
        await write(`\x1b[1;1H\x1b[0;48;5;22m${' '.repeat(half)}\x1b[48;2;30;30;46m${' '.repeat(terminal.cols - half)}`);
        result.split = edge('top').style.background.includes('linear-gradient')
          && edge('top').style.background.includes('rgb(0, 95, 0)')
          && edge('top').style.background.includes('rgb(30, 30, 46)');
        await write('\x1b[1;1H\x1b[0;2;48;2;30;30;46m\x1b[2KX');
        const dimCell = container.querySelector('.xterm-rows > div:first-child > span:first-child');
        result.dim = terminal.buffer.active.getLine(0).getCell(0).isDim()
          && getComputedStyle(dimCell).backgroundColor === 'rgb(30, 30, 46)'
          && color('top') === getComputedStyle(dimCell).backgroundColor;
        container.style.display = 'none';
        await settle();
        result.hidden = getComputedStyle(edge('top')).display === 'none';
        container.style.display = '';
        await settle();
        result.reshown = getComputedStyle(edge('top')).display === 'block';
        pane.style.height = '437px';
        fit.fit();
        await write('\x1b[0;48;2;30;30;46m\x1b[2J');
        result.resized = Math.abs(edge('bottom').getBoundingClientRect().bottom - terminal.element.getBoundingClientRect().bottom) < 0.1;
        await write('\x1b[0m\x1b[?1049l');
        result.restored = terminal.buffer.active.type === 'normal'
          && terminal.buffer.active.getLine(0).translateToString(true) === 'Shell prompt'
          && [...container.querySelectorAll('[data-terminal-edge]')].every((node) => getComputedStyle(node).display === 'none');
        edges.dispose();
        result.disposed = container.querySelector('[data-terminal-edge]') === null;
        return result;
      } finally {
        edges.dispose();
        terminal.dispose();
        container.remove();
        pane.style.height = '600px';
      }
    });
    for (const [scenario, passed] of Object.entries(edgeResult)) {
      assert.ok(passed, `${width}px terminal edge background: ${scenario}`);
    }
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
      const resizeResult = await page.evaluate(async ({ fontSize }) => {
        const { createTerminalResizeHandler, TERMINAL_CONTAINER_CLASS } = await import('/src/components/terminal/registry/terminal-geometry.ts');
        const { Terminal } = await import('/node_modules/@xterm/xterm/lib/xterm.mjs');
        const { FitAddon } = await import('/node_modules/@xterm/addon-fit/lib/addon-fit.mjs');
        const pane = document.getElementById('pane');
        const container = document.createElement('div');
        container.className = TERMINAL_CONTAINER_CLASS;
        pane.appendChild(container);
        const terminal = new Terminal({ fontSize, lineHeight: 1.2 });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(container);
        fit.fit();
        const initialRows = terminal.rows;
        const sent = [];
        const handler = createTerminalResizeHandler(terminal, fit, container, (cols, rows) => sent.push({ cols, rows }));
        const settle = () => new Promise((resolve) => setTimeout(resolve, 160));
        const write = (data) => new Promise((resolve) => terminal.write(data, resolve));
        const scrollbarVisible = () => {
          const bar = container.querySelector('.scrollbar.vertical');
          return getComputedStyle(bar).opacity !== '0' && bar.getBoundingClientRect().height > 0;
        };
        try {
          await write('Terminal resize regression\r\n');
          pane.style.height = '200px';
          handler.schedule();
          pane.style.height = '600px';
          handler.schedule();
          await settle();
          const restored = terminal.rows === initialRows && sent.length === 0 && !scrollbarVisible();

          pane.style.height = '200px';
          handler.schedule();
          // The timer must measure current layout even before another observer delivery.
          pane.style.height = '420px';
          await settle();
          const remeasured = terminal.rows === fit.proposeDimensions().rows && sent.length === 1;

          pane.style.height = '200px';
          handler.schedule();
          pane.style.display = 'none';
          await settle();
          const hiddenSkipped = sent.length === 1;
          pane.style.display = '';
          pane.style.height = '600px';
          handler.schedule();
          await settle();
          const shown = terminal.rows === initialRows;

          pane.style.height = '200px';
          handler.schedule();
          handler.cancel();
          await settle();
          const cancelled = terminal.rows === initialRows;
          pane.style.height = '600px';
          await write('\r\n'.repeat(initialRows + 10));
          await settle();
          const historyLength = terminal.buffer.active.length;
          const historyVisible = terminal.buffer.active.baseY > 0 && scrollbarVisible();
          pane.style.height = '420px';
          handler.schedule();
          await settle();
          pane.style.height = '600px';
          handler.schedule();
          await settle();
          terminal.scrollToTop();
          await settle();
          const historyPreserved = terminal.buffer.active.length === historyLength
            && terminal.buffer.active.viewportY === 0
            && terminal.buffer.active.getLine(0).translateToString(true) === 'Terminal resize regression';
          return { restored, remeasured, hiddenSkipped, shown, cancelled, historyVisible, historyPreserved };
        } finally {
          handler.cancel();
          terminal.dispose();
          container.remove();
          pane.style.display = '';
          pane.style.height = '600px';
        }
      }, { fontSize });
      for (const [scenario, passed] of Object.entries(resizeResult)) {
        assert.ok(passed, `${width}px / ${fontSize}px font: ${scenario}: ${JSON.stringify(resizeResult)}`);
      }
    }
  }
  process.stdout.write('Terminal geometry, edge background and resize regressions passed at wide and narrow widths.\n');
} finally {
  await browser?.close();
  await server.close();
}
