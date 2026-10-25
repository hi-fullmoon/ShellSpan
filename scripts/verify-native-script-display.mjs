import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { webkit } from 'playwright';

// Render only a recorded real PTY stream. This does not synthesize command
// echo, execute a script, or stand in for native desktop/model acceptance.
const trace = process.argv[2];
assert(trace, 'Pass SHELLSPAN_NATIVE_SCRIPT_TRACE_PATH from real shell acceptance');
const bytes = [...await readFile(trace)];
const metadata = JSON.parse(await readFile(`${trace}.json`, 'utf8'));
const root = path.resolve(import.meta.dirname, '..');
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': path.join(root, 'src') } },
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  plugins: [{ name: 'real-native-script-display', configureServer(vite) {
    vite.middlewares.use((request, response, next) => {
      if (request.url !== '/') return next();
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><body style="margin:0;background:#111"><div id="terminal"></div></body></html>');
    });
  } }],
});
let browser;
try {
  await server.listen();
  browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: metadata.columns * 10 + 40, height: metadata.rows * 20 + 40 } });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.addStyleTag({ url: '/node_modules/@xterm/xterm/css/xterm.css' });
  const visible = await page.evaluate(async ({ bytes, metadata }) => {
    const { Terminal } = await import('/node_modules/@xterm/xterm/lib/xterm.mjs');
    const terminal = new Terminal({ cols: metadata.columns, rows: metadata.rows,
      scrollback: 20000, fontSize: 14, convertEol: false });
    terminal.open(document.getElementById('terminal'));
    await new Promise(resolve => terminal.write(new Uint8Array(bytes), resolve));
    const lines = [];
    for (let index = 0; index < terminal.buffer.active.length; index += 1) {
      const line = terminal.buffer.active.getLine(index);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += line.translateToString(true);
      else lines.push(line.translateToString(true));
    }
    terminal.scrollToTop();
    return lines.join('\n');
  }, { bytes, metadata });
  for (const text of ['export SHELLSPAN_NATIVE_SCRIPT=kept', 'cat <<', 'SHELLSPAN_END', 'literal Tab']) {
    assert(visible.includes(text), `Real source line is absent from xterm: ${text}`);
  }
  if (metadata.submittedCommandLine) {
    assert(visible.includes('__shellspan_validate_native'), 'Actual Bash envelope is absent');
    assert(visible.includes('builtin eval --'), 'Actual Bash native evaluation is absent');
  }
  await writeFile(`${trace}.rendered.txt`, visible);
  await page.screenshot({ path: `${trace}.png`, fullPage: true });
  process.stdout.write('Real PTY script source and native submission rendered in xterm.\n');
} finally {
  await browser?.close();
  await server.close();
}
