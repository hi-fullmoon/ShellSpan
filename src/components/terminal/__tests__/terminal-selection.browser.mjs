import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { webkit } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({
  configFile: false,
  logLevel: 'error',
  resolve: { alias: { '@': resolve('src') } },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'terminal-selection-test',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/selection') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<html><body><div id="terminal"></div><button id="blur">Focus outside terminal</button></body></html>');
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await webkit.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/selection`);
  await page.evaluate(async () => {
    const { resolveTerminalTheme } = await import('/src/components/terminal/registry/terminal-registry.ts');
    const { Terminal } = await import('/node_modules/@xterm/xterm/lib/xterm.mjs');
    const terminal = new Terminal({ cols: 40, rows: 5, theme: resolveTerminalTheme('light') });
    terminal.open(document.getElementById('terminal'));
    await new Promise(resolve => terminal.write('Light theme selection', resolve));
    window.terminal = terminal;
  });
  for (const width of [1280, 640]) {
    await page.setViewportSize({ width, height: 600 });
    const screen = await page.locator('.xterm-screen').boundingBox();
    const cellWidth = screen.width / 40;
    await page.mouse.move(screen.x + cellWidth / 2, screen.y + screen.height / 10);
    await page.mouse.down();
    await page.mouse.move(screen.x + cellWidth * 10, screen.y + screen.height / 10, { steps: 10 });
    await page.mouse.up();
    assert.ok(await page.evaluate(() => window.terminal.getSelection().length > 0));
    for (const focused of [true, false]) {
      if (!focused) await page.locator('#blur').click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const colors = await page.locator('.xterm-selection div').first().evaluate(element => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, 1, 1);
        context.fillStyle = getComputedStyle(element).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      });
      assert.ok(colors.slice(0, 3).every(channel => channel < 235),
        `Selection must remain visible on white at width ${width}, focused=${focused}: ${colors}`);
      await page.screenshot({ path: `/tmp/shellspan-selection-${width}-${focused ? 'focused' : 'inactive'}.png` });
    }
    await page.evaluate(() => window.terminal.clearSelection());
  }
} finally {
  await browser?.close();
  await server.close();
}
