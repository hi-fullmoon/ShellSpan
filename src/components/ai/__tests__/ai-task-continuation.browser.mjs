import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

// Replay committed events from a real session; never call the model or execute tools.
assert.ok(process.argv[2], 'Pass a real session JSONL with completed and unfinished continuation turns');
const events = (await readFile(process.argv[2], 'utf8')).trim().split('\n').map(JSON.parse);
let plan;
let activeTurn;
const cases = [];
for (const [index, event] of events.entries()) {
  if (event.type === 'task/plan') plan = event.data;
  if (event.type === 'turn/start') activeTurn = event.turnId;
  if (event.type === 'turn/end' || event.type === 'session/ended') activeTurn = undefined;
  if (!activeTurn && plan?.steps.length && event.type === 'agent/inbox/spliced'
    && event.data.operation === 'enqueued' && event.data.lane === 'nextTurn'
    && event.data.messages.some(message => message.source.kind === 'user')) {
    cases.push({ index, completed: plan.steps.every(step => step.status === 'completed'), count: plan.steps.length });
  }
}
assert.ok(cases.some(test => test.completed), 'Session must contain a completed plan followed by a user submission');
assert.ok(cases.some(test => !test.completed), 'Session must contain unfinished work followed by a user submission');

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `/tmp/shellspan-task-continuation-${process.pid}`,
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__tasks', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__tasks', '<!doctype html><html><body><main id="root"></main></body></html>'));
});
try {
  await server.listen();
  const browserChannel = process.env.SHELLSPAN_TEST_BROWSER_CHANNEL;
  for (const engine of browserChannel ? [chromium] : [chromium, webkit]) {
    const browser = await engine.launch(browserChannel ? { channel: browserChannel } : {});
    try {
      for (const width of [360, 1000]) {
        const page = await browser.newPage({ viewport: { width, height: 500 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__tasks`);
        await page.evaluate(async events => {
          const { mountTaskContinuation } = await import('/src/components/ai/__tests__/ai-task-continuation.browser.tsx');
          window.replayTasks = await mountTaskContinuation(document.getElementById('root'), events);
        }, events);
        for (const test of cases) {
          const before = await page.evaluate(index => window.replayTasks(index), test.index - 1);
          assert.equal(before.plan?.steps.length, test.count);
          const strip = page.locator('[data-slot="ai-task-strip"]');
          await strip.waitFor({ state: 'visible' });
          const toggle = page.locator('.ai-task-strip-trigger');
          if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
          assert.equal(await strip.locator('li').count(), test.count);
          assert.equal(await strip.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
          const after = await page.evaluate(index => window.replayTasks(index), test.index);
          assert.equal(after.recordedPlans, before.recordedPlans, 'Retiring the strip must preserve recorded plans');
          assert.equal(after.historyPlans, before.historyPlans, 'Retiring the strip must preserve task history');
          if (test.completed) {
            assert.equal(after.plan, null, 'Completed plan must retire before the next turn starts');
            assert.equal(await strip.count(), 0);
            const nextPlan = events.findIndex((event, index) => index > test.index && event.type === 'task/plan');
            if (nextPlan >= 0) {
              await page.evaluate(index => window.replayTasks(index), nextPlan);
              await strip.waitFor({ state: 'visible' });
              assert.equal(await strip.locator('li').count(), events[nextPlan].data.steps.length);
            }
          } else {
            assert.deepEqual(after.plan, before.plan, 'Unfinished work must remain available');
            assert.equal(after.active, false);
            assert.equal(await strip.locator('li').count(), test.count);
            assert.equal(await strip.locator('li[data-status="inProgress"]').count(), 0);
          }
        }
        await page.screenshot({ path: `/tmp/shellspan-task-continuation-${engine.name()}-${width}.png` });
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  }
  console.log(`Recorded task continuation: completed plans retire on submission, unfinished plans and history survive, and new plans render in ${browserChannel ?? 'Chromium/WebKit'} at 360px/1000px.`);
} finally { await server.close(); }
