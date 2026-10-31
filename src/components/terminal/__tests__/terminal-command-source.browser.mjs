import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const supplied = process.env.SHELLSPAN_COMMAND_PRESENTATION_DIR;
const directory = supplied ?? mkdtempSync(join(tmpdir(), 'shellspan-command-source-'));
const renderer = process.env.SHELLSPAN_SOURCE_RENDERER ?? 'dom';
assert.ok(renderer === 'dom' || renderer === 'webgl', 'SHELLSPAN_SOURCE_RENDERER must be dom or webgl');
if (!supplied) {
  const bash = process.env.SHELLSPAN_TEST_MODERN_BASH ?? '/opt/homebrew/bin/bash';
  assert.ok(existsSync(bash), 'Set SHELLSPAN_TEST_MODERN_BASH to a real Bash 4.1+ executable');
  execFileSync('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib',
    'native_bash_multiline_typing_renders_progress_before_single_submission', '--', '--ignored', '--test-threads=1'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, SHELLSPAN_TEST_MODERN_BASH: bash, SHELLSPAN_COMMAND_PRESENTATION_DIR: directory },
  });
}
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error', resolve: { alias: { '@': `${root}src` } },
  cacheDir: join(directory, 'source-vite-cache'), plugins: [tailwindcss()],
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
});
server.middlewares.use('/__command-source', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<html><body style="margin:0"><main id="terminal"></main><main id="native" style="display:none"></main></body></html>');
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium && renderer === 'webgl' ? {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    } : {});
    try {
      for (const columns of [40, 100]) {
        for (const variant of ['', '-long']) {
          const metadata = JSON.parse(readFileSync(join(directory, `native-typing-bash${variant}-${columns}.bin.json`), 'utf8'));
          assert.equal(metadata.leaseEvent.commandSubmission, metadata.source, 'Regenerate the capture using the production submission metadata');
          for (const kind of ['foreground', 'background']) {
            const page = await browser.newPage({ viewport: { width: columns === 40 ? 440 : 1280, height: 650 } });
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__command-source`);
            await page.evaluate(async ({ metadata, kind, renderer }) => {
              await import('/src/styles/base.css');
              await import('/node_modules/@xterm/xterm/css/xterm.css');
              const { Terminal } = await import('/node_modules/@xterm/xterm/lib/xterm.mjs');
              const { installTerminalCommandDecorations } = await import('/src/components/terminal/registry/terminal-command-decorations.ts');
              const { readNativeTerminalLine } = await import('/src/components/terminal/registry/terminal-command-source.ts');
              const { agentTerminalLeaseState: leases } = await import('/src/components/terminal/agent-terminal-lease-state.ts');
              const { invokeTakeoverAgentTerminal } = await import('/src/lib/ipc/tauri.ts');
              const options = { cols: metadata.columns, rows: metadata.rows, scrollback: 10000,
                fontSize: 14, allowProposedApi: true, cursorBlink: false };
              const terminal = new Terminal(options);
              const baseline = new Terminal(options);
              const operationId = kind === 'foreground' ? metadata.result.operationId : metadata.background.job.operationId;
              const acquired = metadata.leaseEvents.find(event => event.operationId === operationId && event.state === 'acquired');
              const decorations = installTerminalCommandDecorations(terminal, acquired.sessionId);
              terminal.open(document.getElementById('terminal'));
              if (renderer === 'webgl') {
                const { WebglAddon } = await import('/node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs');
                terminal.loadAddon(new WebglAddon());
              }
              baseline.open(document.getElementById('native'));
              const inputs = [];
              terminal.onData(data => inputs.push(data));
              const write = async data => {
                const chunk = typeof data === 'string' || data instanceof Uint8Array ? data : Uint8Array.from(data);
                await Promise.all([terminal, baseline].map(item => new Promise(resolve => item.write(chunk, resolve))));
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              };
              const handle = async event => {
                if (event.state === 'acquired') leases.set({ ...event, terminalOwned: true, inputBlocked: false,
                  takeoverRequested: false, takeoverFailed: false,
                  requestTakeover: () => { void invokeTakeoverAgentTerminal({ sessionId: event.sessionId,
                    agentSessionId: event.agentSessionId, operationId: event.operationId }); } });
                else if (event.state === 'activity') leases.update(event.sessionId, event.operationId,
                  current => ({ ...current, commandPhase: event.commandPhase }));
                else leases.clear(event.sessionId, event.operationId);
                await new Promise(resolve => terminal.write('', resolve));
              };
              const previous = metadata.leaseEvents.slice(0, metadata.leaseEvents.indexOf(acquired));
              for (const event of previous) await handle(event);
              await write(kind === 'foreground' ? metadata.startup : metadata.backgroundStartup);
              await handle(acquired);
              for (const event of metadata.leaseEvents.filter(event => event.operationId === operationId && event.state === 'activity')) {
                await handle(event);
              }
              const marker = terminal.registerMarker(0);
              const source = acquired.commandDisplay;
              const submission = acquired.commandSubmission;
              if (!submission || source === submission) throw new Error('The native test must include an actual execution envelope');
              window.sourceProjection = { terminal, baseline, decorations, inputs, write, handle, acquired,
                source, submission, marker, readNativeTerminalLine, leases, installTerminalCommandDecorations };
            }, { metadata, kind, renderer });
            const frames = kind === 'foreground' ? metadata.frames.map(frame => frame.bytes) : [metadata.backgroundDisplay];
            for (const bytes of frames) {
              await page.evaluate(async bytes => {
                const state = window.sourceProjection;
                await state.write(Uint8Array.from(bytes));
                const normal = state.baseline.buffer.normal;
                for (let row = 0; row < normal.length; row++) {
                  if (state.readNativeTerminalLine(state.terminal, row) !== normal.getLine(row).translateToString(true)) {
                    throw new Error(`Display projection changed native terminal cells at row ${row}`);
                  }
                }
                if (!state.terminal._core.coreService.decPrivateModes.synchronizedOutput) {
                  const display = Array.from({ length: state.terminal.buffer.normal.length }, (_, row) =>
                    state.terminal.buffer.normal.getLine(row).translateToString(true)).join('\n');
                  if (display.replace(/\s/gu, '').includes('(exit"$?");builtineval--')) {
                    throw new Error(`A painted input frame exposed the internal envelope:\n${display}`);
                  }
                  const painted = Array.from(state.terminal.element.querySelectorAll('.xterm-rows > div'), row => row.textContent).join('\n');
                  if (painted.replace(/\s/gu, '').includes('(exit"$?");builtineval--')) {
                    throw new Error(`The DOM renderer painted the internal envelope:\n${painted}`);
                  }
                }
              }, bytes);
            }
            await page.evaluate(async () => {
              const state = window.sourceProjection;
              state.leases.clear(state.acquired.sessionId, state.acquired.operationId);
              await new Promise(resolve => state.terminal.write('', resolve));
              state.decorations.rebind();
              state.decorations = state.installTerminalCommandDecorations(state.terminal, state.acquired.sessionId);
            });
            for (const columnsAfter of [columns, 32, 100]) {
              const evidence = await page.evaluate(async columnsAfter => {
                const state = window.sourceProjection;
                state.terminal.resize(columnsAfter, 30);
                state.baseline.resize(columnsAfter, 30);
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const text = item => Array.from({ length: item.buffer.normal.length }, (_, row) => item.buffer.normal.getLine(row).translateToString(true)).join('\n');
                state.terminal.selectAll();
                const selection = state.terminal.getSelection();
                const copy = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
                state.terminal.element.dispatchEvent(copy);
                const clipboard = copy.clipboardData.getData('text/plain');
                state.terminal.clearSelection();
                return { display: text(state.terminal), raw: text(state.baseline), source: state.source,
                  submission: state.submission, selection, clipboard, inputs: state.inputs,
                  original: Array.from({ length: state.baseline.buffer.normal.length }, (_, row) =>
                    state.readNativeTerminalLine(state.terminal, row)).join('\n') };
              }, columnsAfter);
              const label = `${engine.name()}-${renderer}-${kind}${variant}-${columns}-${columnsAfter}`;
              const compact = value => value.replace(/\s/gu, '');
              assert.equal(evidence.original, evidence.raw, `${label}: raw terminal must remain unchanged`);
              assert.ok(compact(evidence.display).includes(compact(evidence.source)), `${label}: original source missing\nDisplay:\n${evidence.display}\nNative:\n${evidence.raw}`);
              assert.ok(!compact(evidence.display).includes(compact(evidence.submission)), `${label}: internal envelope is still displayed`);
              assert.ok(!compact(evidence.display).includes(compact('(exit "$?"); builtin eval --')), `${label}: an earlier input prefix exposed internal code`);
              assert.ok(compact(evidence.selection).includes(compact(evidence.source)), `${label}: selection must copy the displayed source`);
              assert.ok(!compact(evidence.selection).includes(compact(evidence.submission)), `${label}: selection exposed internal code`);
              assert.equal(evidence.clipboard, evidence.selection, `${label}: native clipboard must copy the displayed source`);
              assert.deepEqual(evidence.inputs, [], `${label}: projection must never write input`);
              await page.evaluate(async () => {
                const terminal = window.sourceProjection.terminal;
                for (let row = 0; row < terminal.buffer.normal.length; row++) {
                  if (!terminal.buffer.normal.getLine(row).translateToString(true).includes('SHELLSPAN_END')) continue;
                  terminal.scrollToLine(Math.max(0, row - 4));
                  break;
                }
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              });
              await page.screenshot({ path: join(directory, `${label}.png`) });
            }
            await page.evaluate(() => {
              const state = window.sourceProjection;
              state.leases.clear(state.acquired.sessionId, state.acquired.operationId);
              state.decorations.dispose(); state.marker.dispose(); state.terminal.dispose(); state.baseline.dispose();
            });
            assert.deepEqual(errors, []);
            await page.close();
          }
        }
      }
    } finally { await browser.close(); }
  }
  console.log(`Original command display and selection preserve native Bash cells and input across foreground/background execution and reflow. Artifacts: ${directory}`);
} finally { await server.close(); }
