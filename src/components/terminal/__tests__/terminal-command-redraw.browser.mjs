import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const supplied = process.env.SHELLSPAN_COMMAND_PRESENTATION_DIR;
const directory = supplied ?? mkdtempSync(join(tmpdir(), 'shellspan-redraw-'));
let server;
let browser;
try {
  if (!supplied) {
    const bash = process.env.SHELLSPAN_TEST_MODERN_BASH ??
      ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/bin/bash'].find(existsSync);
    assert.ok(bash, 'A real Bash 4.1+ is required');
    execFileSync('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib',
      'native_bash_multiline_typing_renders_progress_before_single_submission', '--', '--ignored', '--test-threads=1'], {
      cwd: root, stdio: 'inherit', env: { ...process.env, SHELLSPAN_TEST_MODERN_BASH: bash,
        SHELLSPAN_COMMAND_PRESENTATION_DIR: directory },
    });
  }
  server = await createServer({ root, configFile: false, logLevel: 'error',
    resolve: { alias: { '@': `${root}src` } }, plugins: [tailwindcss(), {
      name: 'native-command-redraw', configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url !== '/') return next();
          response.setHeader('Content-Type', 'text/html');
          response.end('<html><body style="margin:0"><main id="terminal"></main></body></html>');
        });
      },
    }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } });
  await server.listen();
  const engine = process.env.SHELLSPAN_REDRAW_BROWSER ?? 'webkit';
  assert.ok(engine === 'webkit' || engine === 'chromium', 'SHELLSPAN_REDRAW_BROWSER must be webkit or chromium');
  browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.evaluate(async () => {
    await import('/src/styles/base.css');
    await import('/node_modules/@xterm/xterm/css/xterm.css');
    const { Terminal } = await import('/node_modules/@xterm/xterm/lib/xterm.mjs');
    const { WebglAddon } = await import('/node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs');
    const { installTerminalCommandDecorations } = await import('/src/components/terminal/registry/terminal-command-decorations.ts');
    const { readNativeTerminalLine } = await import('/src/components/terminal/registry/terminal-command-source.ts');
    const { agentTerminalLeaseState } = await import('/src/components/terminal/agent-terminal-lease-state.ts');
    window.runtime = { Terminal, WebglAddon, installTerminalCommandDecorations, readNativeTerminalLine, agentTerminalLeaseState };
  });
  const cases = ['', '-long'].flatMap(variant => [100, 40].flatMap(columns =>
    [...(!variant ? ['timeout'] : []), 'normal', 'running', 'released'].map(scenario => ({ variant, columns, scenario }))));
  for (const { variant, columns, scenario } of cases) {
    const metadata = JSON.parse(readFileSync(join(directory, `native-typing-bash${variant}-${columns}.bin.json`), 'utf8'));
    for (const renderer of ['dom', 'webgl']) {
      await page.setViewportSize({ width: columns === 40 ? 440 : 1280, height: 650 });
      await page.evaluate(async ({ metadata, renderer }) => {
        const { Terminal, WebglAddon, installTerminalCommandDecorations, agentTerminalLeaseState: leases } = window.runtime;
        const terminal = new Terminal({ cols: metadata.columns, rows: metadata.rows, fontSize: 14,
          cursorBlink: true, allowProposedApi: true, theme: { background: '#ffffff', foreground: '#000000' } });
        terminal.open(document.getElementById('terminal'));
        if (renderer === 'webgl') terminal.loadAddon(new WebglAddon());
        if (metadata.startup) await new Promise(resolve => terminal.write(metadata.startup, resolve));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const commandStart = terminal.registerMarker(0);
        const decorations = installTerminalCommandDecorations(terminal, metadata.leaseEvent.sessionId);
        leases.set({ ...metadata.leaseEvent, terminalOwned: true, commandPhase: 'typing', inputBlocked: false,
          takeoverRequested: false, takeoverFailed: false, requestTakeover() {} });
        const inputs = [];
        terminal.onData(data => inputs.push(data));
        window.redraw = { terminal, decorations, metadata, commandStart, inputs, raw: '', decoder: new TextDecoder(), boundary: false };
      }, { metadata, renderer });
      await page.evaluate(() => new Promise(resolve => window.redraw.terminal.write('', resolve)));
      let seenInput = false;
      let blankBufferFrames = 0;
      let firstHeldFrame;
      let timeouts = 0;
      let paintedCommand;
      const visibleInputs = new Set();
      const scrolledInputs = new Set();
      let scrolled = false;
      let initialBaseY;
      for (const [index, frame] of metadata.frames.entries()) {
        const state = await page.evaluate(async frame => {
          const state = window.redraw;
          const data = state.decoder.decode(new Uint8Array(frame.bytes), { stream: true });
          state.raw += data;
          state.boundary ||= state.raw.includes('\x1b]133;C\x07');
          await new Promise(resolve => state.terminal.write(data, resolve));
          // Deliberately expose each real PTY read across paint boundaries,
          // including clear-only reads delayed by the SSH receiver handshake.
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const buffer = state.terminal.buffer.active;
          const first = Math.max(buffer.viewportY, state.commandStart.line);
          const text = Array.from({ length: Math.max(0, buffer.viewportY + state.terminal.rows - first) }, (_, row) =>
            window.runtime.readNativeTerminalLine(state.terminal, first + row)).join('\n');
          return { boundary: state.boundary, text, parsed: state.raw,
            baseY: buffer.baseY,
            synchronized: state.terminal._core.coreService.decPrivateModes.synchronizedOutput,
            decorationHeight: document.querySelector('.terminal-agent-command')?.getBoundingClientRect().height ?? 0 };
        }, frame);
        if (state.boundary) continue;
        initialBaseY ??= state.baseY;
        scrolled ||= state.baseY > initialBaseY;
        if (state.text.replace(/\s/gu, '').includes(metadata.approvedSource.slice(0, 24).replace(/\s/gu, ''))) {
          seenInput = true;
        }
        if (seenInput && state.text.trim() && !state.synchronized) {
          visibleInputs.add(state.text);
          if (scrolled) scrolledInputs.add(state.text);
          if (scenario === 'timeout') paintedCommand = await page.locator('.terminal-agent-command').screenshot();
        }
        if (!seenInput || state.text.trim()) continue;
        blankBufferFrames++;
        firstHeldFrame ??= index;
        assert.equal(state.synchronized, true, `${variant}/${scenario}/${renderer}/${columns} frame ${index}: clearing must hold rendering`);
        const screenshot = await page.locator('.xterm-screen').screenshot({
          path: join(directory, `held${variant}-${scenario}-${renderer}-${columns}.png`),
        });
        const ink = await page.evaluate(async base64 => {
          const data = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([data], { type: 'image/png' }));
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width; canvas.height = bitmap.height;
          const context = canvas.getContext('2d');
          context.drawImage(bitmap, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let ink = 0;
          for (let offset = 0; offset < pixels.length; offset += 4) {
            if (pixels[offset] < 150 && pixels[offset + 1] < 150 && pixels[offset + 2] < 150) ink++;
          }
          bitmap.close();
          return ink;
        }, screenshot.toString('base64'));
        assert.ok(ink > 300, `${renderer}/${columns} frame ${index}: native input disappeared (${ink} ink pixels)`);
        assert.ok(state.decorationHeight > 0, `${variant}/${scenario}/${renderer}/${columns} frame ${index}: command background must survive intermediate clearing`);
        if (scenario === 'timeout') {
          assert.ok(paintedCommand, 'The real command must paint before a clear can be protected');
          const heldCommand = await page.locator('.terminal-agent-command').screenshot();
          assert.ok(heldCommand.equals(paintedCommand),
            `${renderer}/${columns} frame ${index}: clearing after ${timeouts} timeouts changed the painted command or background`);
        }
        if (scenario === 'timeout' && (blankBufferFrames === 1 || blankBufferFrames === 5)) {
          // Delay actual captured PTY bytes beyond the bounded render hold,
          // twice within one operation. Every later native clear must regain
          // protection and retain both painted text and its command background.
          const heldAfterTimeout = await page.evaluate(async () => {
            await new Promise(resolve => setTimeout(resolve, 850));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return window.redraw.terminal._core.coreService.decPrivateModes.synchronizedOutput;
          });
          assert.equal(heldAfterTimeout, false, 'A stalled redraw must still release its bounded hold');
          timeouts++;
        }
        if (index === firstHeldFrame && (scenario === 'running' || scenario === 'released')) await page.evaluate(scenario => {
          const { sessionId, operationId } = window.redraw.metadata.leaseEvent;
          const leases = window.runtime.agentTerminalLeaseState;
          leases.update(sessionId, operationId, current => ({ ...current, commandPhase: 'running' }));
          if (scenario === 'released') leases.clear(sessionId, operationId);
        }, scenario);
      }
      assert.ok(blankBufferFrames > 5, 'The real Bash trace must exercise repeated clear-only frames');
      if (scenario === 'timeout') assert.equal(timeouts, 2, 'The same command must recover after two redraw timeouts');
      assert.ok(visibleInputs.size > 5, 'Native input must continue to advance visibly');
      if (variant && columns === 40) {
        assert.ok(scrolled, 'Long native input must exercise scrolling before submission');
        assert.ok(scrolledInputs.size > 2, 'Long input must keep advancing visibly after native scrolling');
      }
      const completed = await page.evaluate(() => {
        const { terminal } = window.redraw;
        return { synchronized: terminal._core.coreService.decPrivateModes.synchronizedOutput,
          raw: window.redraw.raw, inputs: window.redraw.inputs,
          text: Array.from({ length: terminal.buffer.active.length }, (_, index) =>
            terminal.buffer.active.getLine(index).translateToString(true)).join('\n') };
      });
      assert.equal(completed.synchronized, false, 'Submission must release presentation buffering');
      assert.equal(completed.raw, Buffer.concat(metadata.frames.map(frame => Buffer.from(frame.bytes))).toString(),
        'Display buffering must preserve the entire real PTY stream');
      assert.deepEqual(completed.inputs, [], 'Display buffering must never send terminal input or acknowledgements');
      assert.ok(completed.text.includes('literal Tab'), 'The real command output must remain present');
      await page.screenshot({ path: join(directory, `redraw${variant}-${scenario}-${renderer}-${columns}.png`) });
      await page.evaluate(() => {
        const { terminal, decorations, metadata } = window.redraw;
        window.runtime.agentTerminalLeaseState.clear(metadata.leaseEvent.sessionId, metadata.leaseEvent.operationId);
        decorations.dispose(); window.redraw.commandStart.dispose(); terminal.dispose();
      });
      if (variant && scenario === 'normal') {
        const retained = await page.evaluate(async ({ metadata, renderer }) => {
          const { Terminal, WebglAddon, installTerminalCommandDecorations, agentTerminalLeaseState: leases } = window.runtime;
          const terminal = new Terminal({ cols: metadata.columns, rows: metadata.rows, allowProposedApi: true });
          terminal.open(document.getElementById('terminal'));
          if (renderer === 'webgl') terminal.loadAddon(new WebglAddon());
          const write = data => new Promise(resolve => terminal.write(data, resolve));
          if (metadata.startup) await write(metadata.startup);
          const decorations = installTerminalCommandDecorations(terminal, metadata.leaseEvent.sessionId);
          leases.set({ ...metadata.leaseEvent, terminalOwned: true, commandPhase: 'typing', inputBlocked: false,
            takeoverRequested: false, takeoverFailed: false, requestTakeover() {} });
          await write('');
          const decoder = new TextDecoder();
          const bytes = metadata.frames.flatMap(frame => frame.bytes);
          // Real reads can be coalesced so ED2 and the final C arrive in one
          // parser batch, without an intervening paint or write-parsed event.
          await write(decoder.decode(new Uint8Array(bytes)));
          const buffer = terminal.buffer.active;
          let row = -1;
          for (let index = 0; index < buffer.length; index++) {
            if (buffer.getLine(index).translateToString(true).includes('import os')) row = index;
          }
          if (row < 0) throw new Error('The real long input must be present in terminal history');
          terminal.scrollToLine(row);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const count = document.querySelectorAll('.terminal-agent-command').length;
          leases.clear(metadata.leaseEvent.sessionId, metadata.leaseEvent.operationId);
          decorations.dispose(); terminal.dispose();
          return count;
        }, { metadata, renderer });
        assert.equal(retained, 1, `${renderer}/${columns}: a coalesced long-input redraw must retain its command background`);
      }
      if (!variant && scenario === 'normal' && columns === 40 && renderer === 'webgl') {
        for (const action of ['cancel', 'takeover', 'timeout', 'resize', 'reset', 'dispose', 'boundary', 'running-release', 'application-sync']) {
          const result = await page.evaluate(async ({ metadata, firstHeldFrame, action }) => {
            const { Terminal, WebglAddon, installTerminalCommandDecorations, agentTerminalLeaseState: leases } = window.runtime;
            const terminal = new Terminal({ cols: metadata.columns, rows: metadata.rows,
              cursorBlink: true, allowProposedApi: true });
            terminal.open(document.getElementById('terminal'));
            terminal.loadAddon(new WebglAddon());
            const { sessionId, operationId } = metadata.leaseEvent;
            const decorations = installTerminalCommandDecorations(terminal, sessionId);
            leases.set({ ...metadata.leaseEvent, terminalOwned: true, commandPhase: 'typing', inputBlocked: false,
              takeoverRequested: false, takeoverFailed: false, requestTakeover() {} });
            const write = data => new Promise(resolve => terminal.write(data, resolve));
            const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const modes = terminal._core.coreService.decPrivateModes;
            const decoder = new TextDecoder();
            await write('');
            for (const frame of metadata.frames.slice(0, firstHeldFrame + 1)) {
              await write(decoder.decode(new Uint8Array(frame.bytes), { stream: true }));
              await paint();
            }
            if (!modes.synchronizedOutput) throw new Error(`${action}: native clear did not hold the picture`);
            let keptUntilBoundary;
            if (action === 'cancel') leases.clear(sessionId, operationId);
            if (action === 'takeover') leases.update(sessionId, operationId, current => ({ ...current, takeoverRequested: true }));
            if (action === 'timeout') await new Promise(resolve => setTimeout(resolve, 850));
            if (action === 'resize') terminal.resize(60, 25);
            if (action === 'reset') {
              terminal.reset();
              await write('');
            }
            if (action === 'dispose') decorations.dispose();
            if (action === 'boundary') await write(metadata.privateDisplay);
            if (action === 'running-release') {
              leases.update(sessionId, operationId, current => ({ ...current, commandPhase: 'running' }));
              leases.clear(sessionId, operationId);
              await write('');
              await paint();
              keptUntilBoundary = modes.synchronizedOutput;
              await write(metadata.privateDisplay);
            }
            if (action === 'application-sync') {
              // Exercise xterm's real DEC 2026 ownership, independently of
              // the presentation transaction used by native input.
              await write('\x1b[?2026h');
              decorations.dispose();
              if (!modes.synchronizedOutput) throw new Error('Disposal ended application-owned synchronized output');
              await write('\x1b[?2026l');
            }
            await paint();
            const result = { held: terminal._core.coreService.decPrivateModes.synchronizedOutput, keptUntilBoundary };
            leases.clear(sessionId, operationId);
            decorations.dispose(); terminal.dispose();
            return result;
          }, { metadata, firstHeldFrame, action });
          assert.equal(result.held, false, `${action}: native presentation must be released`);
          if (action === 'running-release') assert.equal(result.keptUntilBoundary, true,
            'An early running/released lease must not expose a delayed PTY clear');
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS: short/long Bash input stays visible in DOM/WebGL at 40/100 columns, including recovery after repeated 850ms redraw delays, early running/release, native scrolling and coalesced redraws; cancellation and cleanup release rendering');
} finally {
  await browser?.close();
  await server?.close();
  if (!supplied) rmSync(directory, { recursive: true, force: true });
}
