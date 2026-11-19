// Display binding checks against genuine Bash/Readline capture packets.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { displayModuleJavaScript, installedRuntimeManifest } from '../../../../scripts/native-input/prototype/formal-runtime.mjs';

const installed = await installedRuntimeManifest();
const output = path.resolve('artifacts/tests/native-input/protocol/evidence/display-binding');
await mkdir(output, { recursive: true });
const captures = {};
for (const name of ['commit', 'stdout-partial-eof']) {
  const bytes = await readFile(`artifacts/tests/native-input/protocol/evidence/${name}/pty.bin`);
  captures[name] = { bytes: [...bytes], sha256: createHash('sha256').update(bytes).digest('hex') };
}
const assets = {
  '/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'application/javascript'],
  '/webgl.js': ['node_modules/@xterm/addon-webgl/lib/addon-webgl.js', 'application/javascript'],
  '/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css'],
};
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/display.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(await displayModuleJavaScript());
      return;
    }
    const asset = assets[req.url];
    res.setHeader('Content-Type', asset ? asset[1] : 'text/html');
    res.end(asset ? await readFile(asset[0]) : '<!doctype html><style>body{background:#18181b;color:#fafafa}</style><link rel="stylesheet" href="/xterm.css"><div id="surface"></div><script src="/xterm.js"></script><script src="/webgl.js"></script>');
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const results = [];
try {
  for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await type.launch({ headless: true });
    try {
      for (const renderer of ['dom', 'webgl']) {
        const page = await browser.newPage({ viewport: { width: 1100, height: 680 } });
        try {
          await page.goto(`http://127.0.0.1:${server.address().port}`);
          const result = await page.evaluate(async ({ captures, renderer }) => {
            const { attachNativeInputDisplay, NATIVE_INPUT_DISPLAY: binding } = await import('/display.js');
            let assertions = 0;
            const check = (value, message) => { assertions++; if (!value) throw Error(message); };
            const term = new Terminal({ cols: 100, rows: 24, allowProposedApi: true, reflowCursorLine: false });
            term.open(document.querySelector('#surface'));
            if (renderer === 'webgl') term.loadAddon(new WebglAddon.WebglAddon());
            const input = [];
            term.onData(value => input.push(value));
            const write = bytes => new Promise(resolve => term.write(Uint8Array.from(bytes), resolve));
            const bytes = captures.commit.bytes;
            const encode = value => [...new TextEncoder().encode(value)];
            const on = encode(`\x1b]${binding.oscIdentifier};${binding.enterPayload}\x07`);
            const off = encode(`\x1b]${binding.oscIdentifier};${binding.exitPayload}\x07`);
            const find = (haystack, needle) => haystack.findIndex((_, index) => needle.every((byte, offset) => haystack[index + offset] === byte));
            const start = find(bytes, on);
            check(start >= 0 && find(bytes, off) >= 0, 'actual producer omitted formal display packets');
            await write(on);
            check(term.options.reflowCursorLine === false, 'raw terminal installed a native handler');
            const first = attachNativeInputDisplay(term, binding);
            await write(bytes.slice(0, start + on.length - 1));
            check(term.options.reflowCursorLine === false, 'fragmented OSC changed display before completion');
            await write(bytes.slice(start + on.length - 1, start + on.length));
            check(term.options.reflowCursorLine === true, 'actual complete packet failed to enter');
            term.resize(32, 24);
            await write(bytes.slice(start + on.length));
            check(term.options.reflowCursorLine === false, 'actual acceptance failed to restore ordinary output mode');
            check(term.buffer.active.type === 'normal', 'input unexpectedly selected the alternate buffer');
            const text = Array.from({ length: term.buffer.active.length }, (_, index) => term.buffer.active.getLine(index)?.translateToString(true) ?? '').join('\n');
            check(text.includes('NIP_OUTPUT') && text.includes('中文'), 'real PTY source/output disappeared');
            check(!text.includes('builtin ss_native_input_begin'), 'internal submission plan leaked into PTY echo');
            await first.closeAfterPendingOutput();
            first.dispose();
            const failed = attachNativeInputDisplay(term, binding);
            // No await between queueing actual failed-stream output and closing.
            let failedOutputParsed = false;
            term.write(Uint8Array.from(captures['stdout-partial-eof'].bytes), () => { failedOutputParsed = true; });
            await failed.closeAfterPendingOutput();
            check(failedOutputParsed, 'close resolved before preceding real PTY output parsed');
            check(term.options.reflowCursorLine === false, 'queued on/partial off survived EOF cleanup');
            const rebound = attachNativeInputDisplay(term, binding);
            // Fresh connection startup supplies the real producer's initial off
            // packet. Its ESC terminates an old incomplete OSC parser sequence.
            await write(bytes.slice(0, start));
            check(term.options.reflowCursorLine === false, 'fresh startup did not restore baseline after partial OSC');
            await write(bytes.slice(start, start + on.length));
            check(term.options.reflowCursorLine === true, 'rebound controller missed the fresh native packet');
            failed.dispose();
            check(term.options.reflowCursorLine === true, 'old-generation disposal changed the current controller');
            await write(off);
            check(term.options.reflowCursorLine === false, 'fresh controller failed to exit');
            check(input.length === 0, 'display packets generated executable terminal input');
            await rebound.closeAfterPendingOutput();
            const disposed = attachNativeInputDisplay(term, binding);
            let disposedOutputParsed = false;
            term.write(Uint8Array.from(on), () => { disposedOutputParsed = true; });
            disposed.dispose();
            await disposed.closeAfterPendingOutput();
            check(disposedOutputParsed, 'disposed handler close resolved before preceding output parsed');
            check(term.options.reflowCursorLine === false, 'disposed handler skipped its queued-output barrier');
            return { assertions };
          }, { captures, renderer });
          assert(result.assertions >= 14);
          await page.screenshot({ path: path.join(output, `${engine}-${renderer}.png`) });
          results.push({ engine, renderer, ...result, result: 'PASS' });
        } finally { await page.close(); }
      }
    } finally { await browser.close(); }
  }
} finally { server.close(); }
await writeFile(path.join(output, 'summary.json'), JSON.stringify({ installed, captures: Object.fromEntries(Object.entries(captures).map(([name, value]) => [name, value.sha256])), results }, null, 2));
console.log(`NIP display: ${results.length}/4 browser/renderer combinations; ${results.reduce((sum, value) => sum + value.assertions, 0)} assertions`);
