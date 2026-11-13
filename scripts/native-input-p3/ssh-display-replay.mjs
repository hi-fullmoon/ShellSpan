// Replays what the actual signed App fed to xterm. Raw SSH PTY bytes and
// controller resize/rebind events remain in the independent App evidence.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { installedRuntimeManifest, displayModuleJavaScript } from '../native-input-p0/formal-runtime.mjs';
import { artifactWorkspace } from '../artifact-paths.mjs';

const input = resolve(process.argv[2]);
const focusComparison = process.argv[3] === '--focus-comparison';
assert(process.argv.length === (focusComparison ? 4 : 3));
const root = artifactWorkspace(input);
assert.equal(resolve(process.cwd()), root, 'Replay must use the capture’s frozen work directory');
assert(input.startsWith(`${root}/.artifacts/tests/native-input-p2/ssh-recovery/`), 'Use this sealed root’s actual App evidence');
const stage = JSON.parse(await readFile(resolve(root, '.artifacts/tests/native-input-p3/candidate-stage.json'), 'utf8'));
assert(stage.sealed && stage.root === root);
const bytes = await readFile(input);
const hash = value => createHash('sha256').update(value).digest('hex');
const evidence = JSON.parse(bytes);
assert(evidence.case === 'display-geometry' && evidence.modelCalls === 0 && evidence.sessions.length === 2);
assert(evidence.records.selection.length === 3 && evidence.records.narrow.cols < evidence.records.wide.cols);
const historyStages = ['history-selection-parked', 'history-background-checked', 'history-bottom-checked'];
const events = evidence.timeline.filter(row => ['parsed', 'render-resize', 'rebound', 'transport-closed', ...historyStages].includes(row.stage));
assert(events.some(row => row.stage === 'rebound') && events.filter(row => row.stage === 'render-resize').length === 2);
assert(events.filter(row => row.stage === 'parsed').every(row => row.matchesWrite && typeof row.data === 'string'));
const wire = evidence.trace.filter(row => row.event === 'ssh-pty-read');
assert(wire.length && new Set(wire.map(row => row.details.sessionId)).size === 2);
const wireBytes = Buffer.concat(wire.map(row => Buffer.from(row.details.hex, 'hex')));
assert(wireBytes.includes(Buffer.from('SSH_BACKGROUND_END')) && wireBytes.includes(Buffer.from('SSH_DISPLAY_SUCCESSOR')));
if (evidence.records.wideText !== undefined) {
  assert(evidence.records.wide.rows > evidence.records.narrow.rows);
  assert(wireBytes.includes(Buffer.from(evidence.records.wideText)));
}
const retainedSelection = evidence.records.parkedAfterOutput !== undefined;
if (retainedSelection) assert.deepEqual(events.filter(row => historyStages.includes(row.stage)).map(row => row.stage), historyStages);
const runtime = await installedRuntimeManifest();
const output = resolve(root, '.artifacts/tests/native-input-p3/ssh-display-replay', randomUUID());
await mkdir(output, { recursive: true, mode: 0o700 });
const scripts = {
  '/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/search.js': 'node_modules/@xterm/addon-search/lib/addon-search.js',
  '/webgl.js': 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js',
};
const assets = Object.fromEntries(await Promise.all(Object.entries(scripts).map(async ([url, file]) => [url, await readFile(resolve(root, file))])));
assets['/display.js'] = Buffer.from(await displayModuleJavaScript());
const css = await readFile(resolve(root, 'node_modules/@xterm/xterm/css/xterm.css'));
const server = createServer((request, response) => {
  if (request.url === '/') return response.writeHead(200, { 'Content-Type': 'text/html' }).end(
    '<!doctype html><link rel="stylesheet" href="/xterm.css"><div id="surface"></div><script src="/xterm.js"></script><script src="/search.js"></script><script src="/webgl.js"></script>');
  if (request.url === '/xterm.css') return response.writeHead(200, { 'Content-Type': 'text/css' }).end(css);
  const asset = assets[request.url];
  return asset ? response.writeHead(200, { 'Content-Type': 'application/javascript' }).end(asset) : response.writeHead(404).end();
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const results = [];
try {
  for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]]) {
    let browser;
    try { browser = await type.launch({ headless: true }); }
    catch (error) {
      for (const renderer of ['dom', 'webgl']) results.push({ engine, renderer, status: 'unavailable', error: String(error) });
      continue;
    }
    try {
      for (const renderer of ['dom', 'webgl']) {
        const page = await browser.newPage({ viewport: { width: 1400, height: 750 } });
        try {
          await page.goto(`http://127.0.0.1:${server.address().port}`);
          const observed = await page.evaluate(async ({ events, renderer, records, retainedSelection, focusComparison }) => {
            const { attachNativeInputDisplay, NATIVE_INPUT_DISPLAY } = await import('/display.js');
            const terminal = new Terminal({ cols: 100, rows: 30, scrollback: 2000, reflowCursorLine: false });
            terminal.open(document.querySelector('#surface'));
            if (renderer === 'webgl') terminal.loadAddon(new WebglAddon.WebglAddon());
            const canvases = terminal.element.querySelectorAll('canvas').length;
            if ((canvases > 0) !== (renderer === 'webgl')) throw new Error(`Unexpected renderer; canvas count ${canvases}`);
            const search = new SearchAddon.SearchAddon();
            terminal.loadAddon(search);
            const original = { get: terminal.getSelection, open: terminal.open, line: terminal.buffer.normal.getLine };
            const emitted = [], geometry = [];
            terminal.onData(value => emitted.push(value));
            let display = attachNativeInputDisplay(terminal, NATIVE_INPUT_DISPLAY);
            let parked = false, wrapped = false, parkedWide, backgroundStayedParked = false, followedBottom = false;
            const copy = () => { terminal.selectAll(); const value = terminal.getSelection().replaceAll('\r\n', '\n'); terminal.clearSelection(); return value; };
            for (const row of events) {
              if (row.stage === 'parsed') await new Promise(done => terminal.write(row.data, done));
              else if (row.stage === 'rebound') { display.dispose(); display = attachNativeInputDisplay(terminal, NATIVE_INPUT_DISPLAY); }
              else if (row.stage === 'transport-closed') await display.closeAfterPendingOutput();
              else if (row.stage === 'history-selection-parked') {
                const buffer = terminal.buffer.normal;
                wrapped = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)).some(line => line?.isWrapped);
                terminal.scrollToTop();
                if (!search.findNext(records.soft) || terminal.getSelection() !== records.soft || buffer.viewportY >= buffer.baseY) {
                  throw new Error('Actual SSH capture did not establish the parked selection in the browser');
                }
              } else if (row.stage === 'history-background-checked') {
                const buffer = terminal.buffer.normal;
                backgroundStayedParked = buffer.viewportY === parkedWide?.viewportY && buffer.viewportY < buffer.baseY
                  && terminal.getSelection() === records.soft
                  && JSON.stringify(terminal.getSelectionPosition()) === parkedWide?.selection;
                terminal.clearSelection();
                terminal.scrollToBottom();
              } else if (row.stage === 'history-bottom-checked') {
                followedBottom = terminal.buffer.normal.viewportY === terminal.buffer.normal.baseY;
              } else if (row.stage === 'render-resize') {
                if (row.label === 'wide-parked') {
                  if (!retainedSelection) {
                    const buffer = terminal.buffer.normal;
                    wrapped = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)).some(line => line?.isWrapped);
                    if (!copy().includes(records.soft)) throw new Error('Actual SSH narrow soft line did not copy as one logical line');
                    terminal.scrollToTop();
                  }
                }
                terminal.resize(row.cols, row.rows);
                if (row.label === 'wide-parked') {
                  parked = terminal.buffer.normal.viewportY < terminal.buffer.normal.baseY;
                  if (retainedSelection) {
                    const anchors = terminal.getSelectionPosition();
                    if (!anchors || terminal.getSelection() !== records.soft) throw new Error('Browser reflow changed the selected SSH logical line');
                    parkedWide = { viewportY: terminal.buffer.normal.viewportY, selection: JSON.stringify(anchors) };
                  } else terminal.scrollToBottom();
                }
                geometry.push([terminal.cols, terminal.rows]);
              }
            }
            const final = copy();
            const found = search.findNext(records.soft) && terminal.getSelection() === records.soft;
            terminal.clearSelection();
            const restored = terminal.options.reflowCursorLine === false;
            const preservedApis = terminal.getSelection === original.get && terminal.open === original.open && terminal.buffer.normal.getLine === original.line;
            terminal.scrollToBottom();
            const mark = 'SSH_DISPLAY_SUCCESSOR', buffer = terminal.buffer.normal;
            let target;
            const rect = terminal.element.querySelector('.xterm-screen').getBoundingClientRect();
            for (let row = buffer.viewportY; row < Math.min(buffer.length, buffer.viewportY + terminal.rows); row++) {
              const column = buffer.getLine(row)?.translateToString(true).indexOf(mark) ?? -1;
              if (column >= 0) {
                const width = rect.width / terminal.cols, height = rect.height / terminal.rows;
                target = { start: rect.left + (column + 0.1) * width, end: rect.left + (column + mark.length - 0.1) * width,
                  y: rect.top + (row - buffer.viewportY + 0.5) * height, expected: mark };
              }
            }
            if (!target) throw new Error('Actual successor line is not visible for pointer selection');
            window.sshReplayTerminal = terminal;
            if (focusComparison) {
              window.parkSshFocusComparison = () => {
                terminal.scrollToTop();
                if (!search.findNext(records.soft) || terminal.getSelection() !== records.soft) throw new Error('Retained SSH line missing');
                terminal.focus();
              };
              window.readSshFocusComparison = () => ({ selection: terminal.getSelectionPosition(), text: terminal.getSelection(),
                viewportY: terminal.buffer.normal.viewportY, baseY: terminal.buffer.normal.baseY,
                focused: document.activeElement === terminal.textarea, emitted: emitted.length });
            }
            const facts = { canvases, geometry, wrapped, parked, found, restored, preservedApis, emitted: emitted.length, target,
              backgroundStayedParked, followedBottom, softCopy: final.includes(records.soft), hardCopy: final.includes(records.hard),
              wideCopy: records.wideText === undefined ? null : final.includes(records.wideText),
              background: final.includes('SSH_BACKGROUND_END'), successor: final.includes('SSH_DISPLAY_SUCCESSOR') };
            display.dispose();
            return facts;
          }, { events, renderer, records: evidence.records, retainedSelection, focusComparison });
          const { start, end, y, expected } = observed.target;
          const selections = [];
          for (const [from, to] of [[start, end], [end, start]]) {
            await page.evaluate(() => window.sshReplayTerminal.clearSelection());
            await page.mouse.move(from, y);
            await page.mouse.down();
            await page.mouse.move(to, y, { steps: 8 });
            await page.mouse.up();
            selections.push(await page.evaluate(() => window.sshReplayTerminal.getSelection()));
          }
          observed.pointerSelection = { forward: selections[0], reverse: selections[1], expected };
          if (focusComparison) {
            const before = await page.evaluate(() => {
              const button = document.createElement('button');
              button.textContent = 'Outside terminal';
              document.body.prepend(button);
              window.parkSshFocusComparison();
              return window.readSshFocusComparison();
            });
            await page.getByRole('button', { name: 'Outside terminal' }).click();
            const blurred = await page.evaluate(() => window.readSshFocusComparison());
            const refocused = await page.evaluate(() => {
              window.sshReplayTerminal.focus();
              return window.readSshFocusComparison();
            });
            const point = await page.locator('.xterm-screen').boundingBox();
            assert(point && point.width > 8 && point.height > 8);
            await page.mouse.click(point.x + 8, point.y + 8);
            const afterTerminalClick = await page.evaluate(() => window.readSshFocusComparison());
            observed.focusComparison = { before, blurred, refocused, afterTerminalClick };
            assert(before.focused && before.viewportY < before.baseY && before.selection && before.emitted === 0);
            assert.deepEqual(blurred, { ...before, focused: false });
            assert.deepEqual(refocused, before);
            assert(afterTerminalClick.focused && afterTerminalClick.text === '' && afterTerminalClick.viewportY === before.viewportY
              && afterTerminalClick.emitted === 0);
          }
          const ok = observed.wrapped && observed.parked && observed.found && observed.restored && observed.preservedApis
            && observed.softCopy && observed.hardCopy && observed.background && observed.successor && observed.emitted === 0
            && (evidence.records.wideText === undefined || observed.wideCopy)
            && (!retainedSelection || observed.backgroundStayedParked && observed.followedBottom)
            && selections.every(text => text === expected);
          await page.screenshot({ path: resolve(output, `${engine}-${renderer}.png`) });
          results.push({ engine, renderer, browserVersion: browser.version(), status: ok ? 'pass' : 'fail', observed });
        } catch (error) { results.push({ engine, renderer, browserVersion: browser.version(), status: 'fail', error: String(error) }); }
        finally { await page.close(); }
      }
    } finally { await browser.close(); }
  }
} finally {
  await new Promise(done => server.close(done));
  assert.deepEqual(await installedRuntimeManifest(), runtime);
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ input, inputSha256: hash(bytes), wireSha256: hash(wireBytes),
    runtime, assets: Object.fromEntries(Object.entries(assets).map(([url, data]) => [url, hash(data)])), selected: 4, results }, null, 2));
}
console.log(JSON.stringify({ output, selected: 4, passed: results.filter(row => row.status === 'pass').length }));
assert(results.length === 4 && results.every(row => row.status === 'pass'), 'SSH browser display matrix incomplete');
