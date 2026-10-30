import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const guide = await readFile(join(root, 'AGENTS.md'), 'utf8');
const screenshots = join(tmpdir(), 'shellspan-agent-content-focus');
await mkdir(screenshots, { recursive: true });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(screenshots, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' },
  plugins: [tailwindcss()], server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__focus', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell" style="padding:16px;display:grid;align-content:start;gap:12px;min-width:0"></main></body></html>');
});

async function expectNoFrame(locator, label) {
  await locator.focus();
  const style = await locator.evaluate(element => ({
    focused: document.activeElement === element,
    outline: getComputedStyle(element).outlineStyle,
    shadow: getComputedStyle(element).boxShadow,
  }));
  assert.equal(style.focused, true, `${label}: keyboard focus remains available`);
  assert.equal(style.outline, 'none', `${label}: no focus outline`);
  assert.equal(style.shadow, 'none', `${label}: no focus ring`);
}

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [380, 760]) {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__focus`);
        await page.evaluate(async guide => {
          const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
          await import('/src/styles/base.css');
          await import('/src/components/ai/styles/styles.css');
          const { AiTaskStrip } = await import('/src/components/ai/workspace/ai-task-strip.tsx');
          const { AiContentTitle } = await import('/src/components/ai/workspace/ai-content-title.tsx');
          const { AiQueueDock } = await import('/src/components/ai/workspace/ai-queue-dock.tsx');
          const { inboxTimelineEvidence, inboxTimelineView } = await import('/src/test/fixtures/agent-inbox-timeline.ts');
          const { AiConversationNodeList } = await import('/src/components/ai/workspace/ai-conversation-node-seat.tsx');
          const { projectAgentChatNodes } = await import('/src/lib/ai/conversation-projection.ts');
          const { conversationFoldRecording } = await import('/src/test/fixtures/conversation-fold-runtime.ts');
          const { Button } = await import('/src/components/ui/button.tsx');
          const { Input } = await import('/src/components/ui/input.tsx');
          const { initI18n } = await import('/src/locales/index.ts');
          await initI18n('en-US');
          const recording = conversationFoldRecording.completed;
          const plan = recording.events.find(event => event.type === 'tool/call' && event.data.call.name === 'update_plan');
          const inbox = inboxTimelineEvidence.events.reduce((largest, _event, index) => {
            const items = inboxTimelineView(index + 1).inbox;
            return items.length > largest.length ? items : largest;
          }, []);
          createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
            React.createElement(AiTaskStrip, { steps: plan.data.call.arguments.steps }),
            React.createElement(AiQueueDock, { items: inbox }),
            React.createElement(AiContentTitle, { collapsible: true }, guide),
            React.createElement(Button, { id: 'action' }, 'Continue'),
            React.createElement(Input, { id: 'input', 'aria-label': 'Message' }),
            React.createElement(AiConversationNodeList, { nodes: projectAgentChatNodes(recording.events) }),
          ));
        }, guide);
        const trigger = page.locator('.ai-task-strip-trigger');
        await trigger.waitFor();
        await page.keyboard.press('Tab');
        await expectNoFrame(trigger, 'Task strip');
        await trigger.press('Enter');
        await page.locator('.ai-task-strip-list').waitFor();
        assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
        await expectNoFrame(page.locator('.ai-task-strip-list'), 'Task list');
        await trigger.press('Space');
        assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
        const queue = page.locator('.ai-queue-header');
        await expectNoFrame(queue, 'Queue header');
        const queueExpanded = await queue.getAttribute('aria-expanded');
        await queue.press('Enter');
        assert.notEqual(await queue.getAttribute('aria-expanded'), queueExpanded);
        const title = page.locator('#root > .ai-content-title > button');
        await expectNoFrame(title, 'Long content title');
        await title.press('Enter');
        assert.equal(await title.getAttribute('aria-expanded'), 'true');
        for (const row of await page.locator('.ai-disclosure-row, .ai-tool-row').all()) {
          if (!(await row.isVisible())) continue;
          await expectNoFrame(row, 'Transcript disclosure');
          const before = await row.getAttribute('aria-expanded');
          if (before !== null) {
            await row.press('Enter');
            assert.notEqual(await row.getAttribute('aria-expanded'), before);
          }
        }
        for (const selector of ['#action', '#input']) {
          const control = page.locator(selector);
          await control.focus();
          assert.ok(await control.evaluate(element => {
            const style = getComputedStyle(element);
            return element.matches(':focus-visible') && (style.outlineStyle !== 'none' || style.boxShadow !== 'none');
          }), `${selector}: action and input focus indicators remain visible`);
        }
        await title.press('Enter');
        await expectNoFrame(trigger, 'Task strip before capture');
        await page.screenshot({ path: join(screenshots, `${engine.name()}-${width}.png`) });
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
  console.log(`Agent content focus checks passed in Chromium/WebKit at 380px/760px. Screenshots: ${screenshots}`);
} finally {
  await server.close();
}
