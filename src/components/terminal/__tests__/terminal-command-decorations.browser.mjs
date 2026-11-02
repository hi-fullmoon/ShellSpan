import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { webkit } from 'playwright';

// Always render real integrated PTY traces. An explicit directory can reuse a
// capture from the native test; otherwise generate one in isolated temp storage.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const suppliedDirectory = process.env.SHELLSPAN_COMMAND_PRESENTATION_DIR;
const directory = suppliedDirectory ?? mkdtempSync(join(tmpdir(), 'shellspan-command-presentation-'));
if (!suppliedDirectory) {
  try {
    const filter = 'command_presentation_boundary_precedes_real_output';
    execFileSync('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', filter, '--', '--test-threads=1'], {
      cwd: root, env: { ...process.env, SHELLSPAN_COMMAND_PRESENTATION_DIR: directory }, stdio: 'inherit',
    });
  } catch (error) {
    if (!suppliedDirectory) rmSync(directory, { recursive: true });
    throw error;
  }
}
const history = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
const server = await createServer({
  root, configFile: false, logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  plugins: [tailwindcss(), {
    name: 'terminal-command-presentation',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<html><body><main id="terminal" style="height:560px;padding:12px"></main></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
});
let browser;
try {
  await server.listen();
  browser = await webkit.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.evaluate(async () => {
    await import('/src/styles/base.css');
    await import('/node_modules/@xterm/xterm/css/xterm.css');
    const { Terminal } = await import('/node_modules/@xterm/xterm/lib/xterm.mjs');
    const { installTerminalCommandDecorations } = await import('/src/components/terminal/registry/terminal-command-decorations.ts');
    const { agentTerminalLeaseState } = await import('/src/components/terminal/agent-terminal-lease-state.ts');
    const { resolveTerminalTheme } = await import('/src/components/terminal/registry/terminal-registry.ts');
    window.runtime = { Terminal, installTerminalCommandDecorations, agentTerminalLeaseState, resolveTerminalTheme };
  });
  for (const shell of process.platform === 'darwin' ? ['bash', 'zsh'] : ['bash']) {
    for (const [width, columns] of [[1280, 100], [420, 40]]) {
      const trace = JSON.parse(readFileSync(`${directory}/${shell}-${columns}.json`, 'utf8'));
      for (const [theme, scheme] of [['light', 'app'], ['dark', 'app'], ['light', 'oneDark'], ['dark', 'light']]) {
        await page.setViewportSize({ width, height: 600 });
        const evidence = await page.evaluate(async ({ trace, theme, scheme }) => {
          const { Terminal, installTerminalCommandDecorations, agentTerminalLeaseState, resolveTerminalTheme } = window.runtime;
          document.documentElement.dataset.theme = theme;
          const terminal = new Terminal({ cols: trace.columns, rows: trace.rows,
            fontSize: 14, cursorBlink: false, scrollback: 100, allowProposedApi: true,
            theme: resolveTerminalTheme(scheme) });
          terminal.open(document.getElementById('terminal'));
          const decorations = installTerminalCommandDecorations(terminal, 'presentation');
          const write = value => new Promise(resolve => terminal.write(value, resolve));
          const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          window.presentation = { terminal, decorations, write, paint };
          await write(trace.startup);
          const results = [];
          for (const [index, execution] of trace.executions.entries()) {
            const operationId = `presentation-${index}`;
            agentTerminalLeaseState.set({ sessionId: 'presentation', agentSessionId: 'agent',
              taskId: 'task', operationId, acquiredAtUnixMs: Date.now(), state: 'acquired',
              commandExecution: true, commandPhase: 'typing', terminalOwned: true,
              inputBlocked: false, takeoverRequested: false, takeoverFailed: false, requestTakeover() {} });
            await write('');
            let remainder = execution.trace;
            if (index === 1) {
              const boundary = remainder.indexOf('\x1b]133;C\x07');
              await write(remainder.slice(0, boundary));
              remainder = remainder.slice(boundary);
              agentTerminalLeaseState.update('presentation', operationId, current => ({ ...current, commandPhase: 'running' }));
              agentTerminalLeaseState.clear('presentation', operationId);
              await write('');
              await paint();
              if (document.querySelectorAll('.terminal-agent-command').length !== 2) {
                throw new Error('Submitted input must retain command shading until its ordered C boundary');
              }
            }
            // Split every byte, including OSC framing, through xterm's real parser.
            for (const character of remainder) terminal.write(character);
            await write('');
            agentTerminalLeaseState.clear('presentation', operationId);
            await write('');
            await paint();
            results.push(document.querySelectorAll('.terminal-agent-command').length);
          }
          const buffer = terminal.buffer.active;
          const outputLine = Array.from({ length: buffer.length }, (_, index) =>
            buffer.getLine(index).translateToString(true)).findIndex(line => line.startsWith('src/components/terminal/registry/'));
          const screen = terminal.element.querySelector('.xterm-screen');
          const rowHeight = screen.clientHeight / terminal.rows;
          const blocks = [...document.querySelectorAll('.terminal-agent-command')].map(element => ({
            top: parseFloat(element.style.top) / rowHeight,
            bottom: (parseFloat(element.style.top) + parseFloat(element.style.height)) / rowHeight,
            pointerEvents: getComputedStyle(element).pointerEvents,
            background: getComputedStyle(element).backgroundColor,
            borders: ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']
              .map(property => getComputedStyle(element)[property]),
            shadow: getComputedStyle(element).boxShadow,
            left: element.getBoundingClientRect().left,
          }));
          terminal.select(0, outputLine, terminal.cols);
          const selection = terminal.getSelection();
          await paint();
          return { results, blocks, outputLine: outputLine - buffer.viewportY,
            selection, selectionAfter: terminal.getSelection(),
            screenLeft: screen.getBoundingClientRect().left,
            screenWidth: screen.clientWidth, hostWidth: document.getElementById('terminal').clientWidth };
        }, { trace, theme, scheme });
        assert.deepEqual(evidence.results, [1, 2], `${shell} ${theme} ${width}: one retained block per command`);
        assert.ok(evidence.outputLine >= 0, 'Actual git output must be present');
        assert.ok(evidence.blocks[0].bottom <= evidence.outputLine, 'Command shading must end before the first output row');
        assert.ok(evidence.blocks[0].bottom - evidence.blocks[0].top >= (columns === 40 ? 2 : 1));
        assert.ok(evidence.blocks.every(block => block.pointerEvents === 'none'
          && block.background !== 'rgba(0, 0, 0, 0)'), 'Decorations must be visible and preserve text interaction');
        assert.ok(evidence.blocks.every(block => block.borders.every(border => border === '0px')
          && block.shadow === 'none'), 'Command regions must use only background shading, without rails, borders or shadows');
        assert.ok(evidence.screenWidth <= evidence.hostWidth, 'Terminal grid must fit the narrow container');
        assert.equal(evidence.selection, evidence.selectionAfter);
        assert.ok(evidence.blocks.every(block => block.left === evidence.screenLeft), 'Command shading must align with the terminal grid');
        await page.evaluate(async () => {
          window.presentation.terminal.clearSelection();
          await window.presentation.paint();
        });
        await page.screenshot({ path: `/tmp/shellspan-command-${shell}-${theme}-${scheme}-${width}.png` });
        await page.evaluate(async () => {
          const { write, paint } = window.presentation;
          await write('\x1b[?1049h');
          await paint();
        });
        assert.equal(await page.locator('.terminal-agent-command').count(), 0, 'Full-screen applications must not inherit command shading');
        await page.evaluate(async () => {
          const { write, paint } = window.presentation;
          await write('\x1b[?1049l');
          await paint();
        });
        assert.equal(await page.locator('.terminal-agent-command').count(), 2);
        const beforeReflow = await page.evaluate(() => window.presentation.terminal.markers.map(marker => marker.id).sort((a, b) => a - b));
        await page.evaluate(async () => {
          const { terminal, paint } = window.presentation;
          terminal.resize(32, 24);
          await paint();
        });
        // Real git diff output grows when the registry itself changes. Reflow
        // can move a command out of the viewport without losing its range.
        assert.deepEqual(await page.evaluate(() => window.presentation.terminal.markers.map(marker => marker.id).sort((a, b) => a - b)),
          beforeReflow, `${shell}/${width}/${theme}/${scheme}: command markers must survive reflow`);
        await page.evaluate(async () => { window.presentation.terminal.scrollToTop(); await window.presentation.paint(); });
        assert.ok(await page.locator('.terminal-agent-command').count() > 0, 'Earlier command range remains available in scrollback');
        await page.evaluate(async () => { window.presentation.terminal.scrollToBottom(); await window.presentation.paint(); });
        assert.ok(await page.locator('.terminal-agent-command').count() > 0, 'Latest command range remains available at the prompt');
        await page.evaluate(async history => {
          const { terminal, write, paint } = window.presentation;
          await write(history.replaceAll('\n', '\r\n'));
          terminal.scrollToTop();
          await paint();
        }, history);
        assert.equal(await page.locator('.terminal-agent-command').count(), 0, 'Trimmed history must release command decorations');
        await page.evaluate(async () => {
          const { terminal, decorations, write, paint } = window.presentation;
          const state = window.runtime.agentTerminalLeaseState;
          state.set({ sessionId: 'presentation', agentSessionId: 'agent', taskId: 'task',
            operationId: 'cancelled', acquiredAtUnixMs: Date.now(), state: 'acquired',
            commandExecution: true, terminalOwned: true, inputBlocked: false,
            takeoverRequested: false, takeoverFailed: false, requestTakeover() {} });
          await write('');
          state.clear('presentation', 'cancelled');
          await write('');
          terminal.scrollToBottom();
          await paint();
          if (document.querySelector('.terminal-agent-command')) throw new Error('Cancelled input retained uncertain shading');
          decorations.dispose();
          terminal.dispose();
        });
        if (theme === 'light' && scheme === 'app') {
          const delayed = await page.evaluate(async trace => {
            const { Terminal, installTerminalCommandDecorations, agentTerminalLeaseState: state } = window.runtime;
            const terminal = new Terminal({ cols: trace.columns, rows: trace.rows, allowProposedApi: true });
            terminal.open(document.getElementById('terminal'));
            const decorations = installTerminalCommandDecorations(terminal, 'delayed-commands');
            const write = value => new Promise(resolve => terminal.write(value, resolve));
            const acquire = index => state.set({ sessionId: 'delayed-commands', agentSessionId: 'agent',
              taskId: 'task', operationId: `delayed-${index}`, acquiredAtUnixMs: Date.now(), state: 'acquired',
              commandExecution: true, commandPhase: 'typing', terminalOwned: true,
              inputBlocked: false, takeoverRequested: false, takeoverFailed: false, requestTakeover() {} });
            await write(trace.startup);
            acquire(0);
            await write('');
            const boundary = trace.executions[0].trace.indexOf('\x1b]133;C\x07');
            await write(trace.executions[0].trace.slice(0, boundary));
            state.update('delayed-commands', 'delayed-0', current => ({ ...current, commandPhase: 'running' }));
            state.clear('delayed-commands', 'delayed-0');
            acquire(1);
            await write('');
            await write(trace.executions[0].trace.slice(boundary));
            await write(trace.executions[1].trace);
            state.clear('delayed-commands', 'delayed-1');
            await write('');
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const rowHeight = terminal.element.querySelector('.xterm-screen').clientHeight / terminal.rows;
            const blocks = [...document.querySelectorAll('.terminal-agent-command')].map(element => ({
              top: parseFloat(element.style.top) / rowHeight,
              bottom: (parseFloat(element.style.top) + parseFloat(element.style.height)) / rowHeight,
            }));
            const rows = Array.from({ length: terminal.buffer.active.length }, (_, index) =>
              terminal.buffer.active.getLine(index).translateToString(true));
            const viewportY = terminal.buffer.active.viewportY;
            decorations.dispose();
            terminal.dispose();
            return { blocks, rows, viewportY };
          }, trace);
          assert.equal(delayed.blocks.length, 2,
            `${shell} ${width}: a new lease must not consume an older command's delayed output boundary`);
          const secondCommandRow = delayed.rows.findIndex(row => row.startsWith('presentation> git diff'));
          assert.equal(delayed.blocks[1].top, secondCommandRow - delayed.viewportY,
            `The second command must start at its own prompt after delayed output: ${JSON.stringify(delayed)}`);
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS: real Bash/Zsh command boundaries, light/dark, narrow/wide, selection, reflow, alternate screen and cleanup');
} finally {
  await browser?.close();
  await server.close();
  if (!suppliedDirectory) rmSync(directory, { recursive: true });
}

// Native source/animation, output, history and read-only API gates are mandatory.
await import('./terminal-command-stream.browser.mjs');
