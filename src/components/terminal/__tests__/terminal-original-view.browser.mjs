import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const native = JSON.parse(readFileSync(new URL('../../../test/fixtures/terminal-command-presentation-native.json', import.meta.url), 'utf8'));
const events = native.leaseEvents.filter(event => event.operationId === native.result.operationId);
const directory = mkdtempSync(join(tmpdir(), 'shellspan-terminal-original-'));
const identity = { host: hostname(), username: userInfo().username };
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error', cacheDir: join(directory, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] }, plugins: [tailwindcss()],
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
});
server.middlewares.use('/__terminal-original', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body style="margin:0"><main id="root" style="height:600px"></main></body></html>');
});

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const locale of ['zh-CN', 'en-US']) {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__terminal-original`);
        await page.evaluate(async ({ native, identity, locale }) => {
          const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
          await import('/src/styles/base.css');
          const { terminalRegistry } = await import('/src/components/terminal/registry/terminal-registry.ts');
          const { TerminalPane } = await import('/src/components/terminal/terminal-pane.tsx');
          const { createAgentTerminalLeaseCoordinator } = await import('/src/components/terminal/terminal-controller-layer.tsx');
          const { useTerminalStore } = await import('/src/stores/terminalStore.ts');
          const { useAppStore } = await import('/src/stores/appStore.ts');
          const { useReconnectSession } = await import('/src/hooks/useReconnectSession.ts');
          const { initI18n } = await import('/src/locales/index.ts');
          useAppStore.setState({ locale, activeSection: 'terminal' });
          await initI18n(locale);
          const acquired = native.leaseEvents.find(event => event.operationId === native.result.operationId && event.state === 'acquired');
          const session = { ...identity, sessionId: acquired.sessionId, title: native.result.cwd,
            status: 'connected', terminalSessionId: native.result.terminalSessionId, terminalGeneration: native.result.terminalGeneration };
          const store = useTerminalStore.getState();
          useTerminalStore.setState({ sessions: [session], activeSessionId: session.sessionId });
          // Exercise the production controller and its browser fallback. This
          // checks presentation only; no native readiness acknowledgement is claimed.
          const coordinator = createAgentTerminalLeaseCoordinator();
          const reactRoot = createRoot(document.getElementById('root'));
          window.originalTerminal = { coordinator, reactRoot,
            write: text => new Promise(resolve => window.originalTerminal.controller.terminal.write(text, resolve)) };
          function Host() {
            const reconnectSession = useReconnectSession();
            React.useLayoutEffect(() => {
              const controller = terminalRegistry.create(session.sessionId, store.setStatus, store.setClosed,
                id => useTerminalStore.getState().sessions.find(item => item.sessionId === id)?.status ?? 'connecting',
                reconnectSession);
              window.originalTerminal.controller = controller;
              return () => terminalRegistry.dispose(session.sessionId);
            }, [reconnectSession]);
            return React.createElement(TerminalPane, { activeSession: session });
          }
          reactRoot.render(React.createElement(Host));
        }, { native, identity, locale });
        const pane = page.locator('[data-terminal-pane-session]');
        await pane.locator('.xterm-screen').waitFor();
        await page.evaluate(() => { window.originalTerminal.element = window.originalTerminal.controller.terminal.element; });
        for (const event of events) {
          await page.evaluate(async ({ event, native }) => {
            const runtime = window.originalTerminal;
            await runtime.coordinator.handle(event);
            if (event.state === 'activity' && event.commandPhase === 'running') {
              await runtime.write(native.result.combinedOutput.replace(/\r?\n/g, '\r\n'));
            }
          }, { event, native });
          for (const width of [1100, 380]) {
            await page.setViewportSize({ width, height: 640 });
            await page.waitForTimeout(100);
            const label = `${engine.name()}-${locale}-${event.state}-${width}`;
            assert.equal(await pane.locator('[data-terminal-command-view], [data-terminal-command-presentation]').count(), 0, label);
            assert.equal(await pane.getByRole('button', { name: /^(查看原始终端|查看命令|View original terminal|View commands)$/ }).count(), 0, label);
            assert.ok(await pane.locator('.xterm-screen').isVisible(), label);
            const geometry = await page.evaluate(() => {
              const { controller, element } = window.originalTerminal;
              const screen = controller.terminal.element.querySelector('.xterm-screen').getBoundingClientRect();
              const host = controller.host.getBoundingClientRect();
              const parent = controller.host.parentElement.getBoundingClientRect();
              controller.focus();
              return { same: element === controller.terminal.element,
                focused: document.activeElement === controller.terminal.textarea,
                hidden: Boolean(controller.host.closest('[inert], [aria-hidden="true"]')),
                fits: screen.width > 0 && screen.width <= host.width + 1 && Math.abs(host.height - parent.height) <= 1 };
            });
            assert.deepEqual(geometry, { same: true, focused: true, hidden: false, fits: true }, label);
            await page.screenshot({ path: join(directory, `${label}.png`) });
          }
        }
        assert.ok(await page.evaluate(() => {
          const buffer = window.originalTerminal.controller.terminal.buffer.active;
          return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index).translateToString(true)).join('').includes('quoted');
        }), 'The original buffer must retain the actual captured command output');
        assert.deepEqual(errors, []);
        await page.evaluate(() => {
          const { coordinator, reactRoot, controller } = window.originalTerminal;
          coordinator.dispose();
          reactRoot.unmount();
          controller.dispose();
        });
        await page.close();
      }
    } finally { await browser.close(); }
  }
  console.log(`Original terminal visibility, focus and wide/narrow layouts passed in Chromium/WebKit. Artifacts: ${directory}`);
} finally { await server.close(); }
