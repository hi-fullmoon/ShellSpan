import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

// Replay a real session with a long task plan; no model or tool calls are made.
assert.ok(process.argv[2], 'Pass a real session JSONL path containing a long task plan');
const events = (await readFile(process.argv[2], 'utf8')).trim().split('\n').map(JSON.parse);
assert.ok(events.some(event => event.type === 'task/plan' && event.data.steps.length >= 8));
assert.ok(events.find(event => event.type === 'session/created')?.data.subagent,
  'Use a real child session to cover both supplemental input and read-only task panels');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src/` } },
  server: { host: '127.0.0.1', port: 0 } });
server.middlewares.use(async (request, response, next) => {
  if (request.url !== '/') return next();
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/', '<!doctype html><html><body><div id="root"></div></body></html>'));
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const cases = [360, 1000].flatMap(width => [false, true].map(readOnlySession => ({ width, readOnlySession })));
      for (const { width, readOnlySession } of cases) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(server.resolvedUrls.local[0]);
        await page.evaluate(async ({ events, readOnlySession }) => {
          await import('/src/styles/base.css');
          await import('/src/components/ai/styles/styles.css');
          const { default: React } = await import('/node_modules/.vite/deps/react.js');
          const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
          const { AiWorkspaceRoot } = await import('/src/components/ai/workspace/ai-workspace-root.tsx');
          const { agentSessionView } = await import('/src/lib/ai/agent-session-adapter.ts');
          const { projectAgentActivity } = await import('/src/lib/ai/agent-session-projection.ts');
          const { initI18n } = await import('/src/locales/index.ts');
          await initI18n('zh-CN');
          const created = events.find(event => event.type === 'session/created');
          const activity = projectAgentActivity(events);
          const ended = events.some(event => event.type === 'session/ended');
          const view = agentSessionView({ events, lastCommittedSeq: events.at(-1).seq,
            hasTerminalEvent: ended, snapshot: {
              header: { ...created.data, sessionId: created.sessionId, createdAtUnixMs: created.timeUnixMs },
              status: activity.status, ended, archived: false, eventCount: events.length,
              surface: { generation: activity.context.surfaceGeneration, messages: [] },
              inbox: { nextTurn: [], nextStep: [] }, task: { plan: activity.plan, evidence: [] },
              recovery: activity.recovery ?? { kind: 'idle', status: 'none', summary: '', lastCommittedSeq: events.at(-1).seq },
            } });
          const host = document.getElementById('root');
          host.className = 'ai-panel-shell';
          host.style.cssText = 'height:100dvh;display:flex;flex-direction:column';
          ReactDOM.createRoot(host).render(React.createElement(AiWorkspaceRoot, {
            view, readOnlySession, mode: 'agent', scope: 'workbench',
          }));
        }, { events, readOnlySession });
        await page.locator('.ai-task-strip-trigger').click();
        await page.waitForFunction(() => {
          const list = document.querySelector('.ai-task-strip-list');
          return list && list.clientHeight > 0;
        });
        const metrics = await page.evaluate(() => {
          const list = document.querySelector('.ai-task-strip-list');
          const composer = document.querySelector('[data-slot="ai-composer-seat"]');
          const workspace = document.querySelector('[data-slot="ai-workspace-root"]');
          return [list, composer, workspace, document.documentElement].map(element => ({
            slot: element.dataset.slot ?? element.tagName, height: element.clientHeight,
            scrollHeight: element.scrollHeight, overflow: getComputedStyle(element).overflowY,
          }));
        });
        assert.ok(metrics[0].scrollHeight > metrics[0].height, 'Long task list must remain scrollable');
        for (const metric of metrics.slice(1)) {
          assert.ok(metric.scrollHeight <= metric.height + 1, `Extra outer scrollbar: ${JSON.stringify(metrics)}`);
        }
        const list = page.locator('.ai-task-strip-list');
        await list.hover();
        await page.mouse.wheel(0, 2000);
        await page.waitForFunction(() => {
          const list = document.querySelector('.ai-task-strip-list');
          return Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop) <= 1;
        });
        assert.equal(await page.locator('[data-slot="ai-composer-seat"]').evaluate(element => element.scrollTop), 0,
          'Scrolling tasks must not scroll their outer composer');
        await page.screenshot({ path: `/tmp/shellspan-task-scroll-${engine.name()}-${width}-${readOnlySession ? 'readonly' : 'supplement'}.png` });
        await page.locator('.ai-task-strip-trigger').focus();
        await page.keyboard.press('Enter');
        await list.waitFor({ state: 'hidden' });
        assert.ok(await page.locator('[data-slot="ai-composer-seat"]').evaluate(element =>
          element.scrollHeight <= element.clientHeight + 1), 'Folded tasks must not introduce an outer scrollbar');
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  }
  console.log('Task scroll layout passed in Chromium and WebKit at 360px and 1000px');
} finally { await server.close(); }
