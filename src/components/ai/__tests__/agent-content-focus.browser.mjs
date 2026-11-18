import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const guide = await readFile(join(root, 'AGENTS.md'), 'utf8');
const screenshots = join(root, 'artifacts/tests/agent-content-focus');
await mkdir(screenshots, { recursive: true });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(screenshots, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` }, dedupe: ['react', 'react-dom'] }, esbuild: { jsx: 'automatic' },
  optimizeDeps: {
    entries: [
      'src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts',
      'src/components/ai/workspace/{ai-conversation-node-seat,ai-content-title,ai-queue-dock,ai-task-strip}.tsx',
      'src/components/ui/{button,checkbox,input,input-group,select,switch,tabs,toggle}.tsx',
    ],
    include: ['react', 'react-dom/client'],
  },
  plugins: [tailwindcss()], server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__focus', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell" style="padding:16px;display:grid;align-content:start;gap:12px;min-width:0"></main></body></html>');
});

async function expectThinFrame(locator, label, frame = locator, offset = '-1px') {
  await locator.focus();
  assert.ok(await locator.evaluate(element => document.activeElement === element && element.matches(':focus-visible')),
    `${label}: keyboard focus remains available`);
  const outline = await frame.evaluate(async element => {
    getComputedStyle(element).outlineWidth;
    await Promise.allSettled(element.getAnimations().map(animation => animation.finished));
    const { outlineStyle, outlineWidth, outlineOffset, outlineColor } = getComputedStyle(element);
    return [outlineStyle, outlineWidth, outlineOffset, outlineColor];
  });
  const theme = await frame.evaluate(element => element.ownerDocument.documentElement.dataset.theme);
  assert.deepEqual(outline, ['solid', '1px', offset, theme === 'dark' ? 'rgb(179, 179, 184)' : 'rgb(40, 40, 40)'],
    `${label}: use the shared one-pixel focus outline`);
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
          const { inboxTimelineEvidence, inboxTimelineView } = await import('/src/tests/fixtures/agent-inbox-timeline.ts');
          const { AiConversationNodeList } = await import('/src/components/ai/workspace/ai-conversation-node-seat.tsx');
          const { projectAgentChatNodes } = await import('/src/lib/ai/conversation-projection.ts');
          const { conversationFoldRecording } = await import('/src/tests/fixtures/conversation-fold-runtime.ts');
          const { Button } = await import('/src/components/ui/button.tsx');
          const { Input } = await import('/src/components/ui/input.tsx');
          const { InputGroup, InputGroupInput } = await import('/src/components/ui/input-group.tsx');
          const { Checkbox } = await import('/src/components/ui/checkbox.tsx');
          const { Switch } = await import('/src/components/ui/switch.tsx');
          const { Toggle } = await import('/src/components/ui/toggle.tsx');
          const { Select, SelectTrigger, SelectValue } = await import('/src/components/ui/select.tsx');
          const { Tabs, TabsList, TabsTrigger } = await import('/src/components/ui/tabs.tsx');
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
            React.createElement(InputGroup, { id: 'search-frame' }, React.createElement(InputGroupInput, { id: 'search', 'aria-label': 'Search' })),
            React.createElement(Checkbox, { id: 'selection', 'aria-label': 'Select all' }),
            React.createElement(Switch, { id: 'setting', 'aria-label': 'Notifications' }),
            React.createElement(Toggle, { id: 'format' }, 'Bold'),
            React.createElement(Select, { defaultValue: 'local', items: [{ value: 'local', label: 'Local' }] },
              React.createElement(SelectTrigger, { id: 'source', 'aria-label': 'Source' }, React.createElement(SelectValue))),
            React.createElement(Tabs, { defaultValue: 'general' }, React.createElement(TabsList, null,
              React.createElement(TabsTrigger, { id: 'tab', value: 'general' }, 'General'))),
            React.createElement(AiConversationNodeList, { nodes: projectAgentChatNodes(recording.events) }),
          ));
        }, guide);
        const trigger = page.locator('.ai-task-strip-trigger');
        await trigger.waitFor();
        await page.keyboard.press('Tab');
        await expectThinFrame(trigger, 'Task strip');
        await trigger.press('Enter');
        await page.locator('.ai-task-strip-list').waitFor();
        assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
        await expectThinFrame(page.locator('.ai-task-strip-list'), 'Task list');
        await trigger.press('Space');
        assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
        const queue = page.locator('.ai-queue-header');
        await expectThinFrame(queue, 'Queue header');
        const queueExpanded = await queue.getAttribute('aria-expanded');
        await queue.press('Enter');
        assert.notEqual(await queue.getAttribute('aria-expanded'), queueExpanded);
        const title = page.locator('#root > .ai-content-title > button');
        await expectThinFrame(title, 'Long content title');
        await title.press('Enter');
        assert.equal(await title.getAttribute('aria-expanded'), 'true');
        for (const row of await page.locator('.ai-disclosure-row, .ai-tool-row').all()) {
          if (!(await row.isVisible())) continue;
          await expectThinFrame(row, 'Transcript disclosure');
          const before = await row.getAttribute('aria-expanded');
          if (before !== null) {
            await row.press('Enter');
            assert.notEqual(await row.getAttribute('aria-expanded'), before);
          }
        }
        for (const theme of ['light', 'dark']) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          for (const selector of ['#input', '#format', '#source', '#tab']) {
            await expectThinFrame(page.locator(selector), selector);
          }
          for (const control of [page.locator('#action'), page.getByRole('checkbox', { name: 'Select all', exact: true }), page.getByRole('switch', { name: 'Notifications' })]) {
            await expectThinFrame(control, 'Filled control', control, '1px');
          }
          const search = page.locator('#search');
          await expectThinFrame(search, 'Search', page.locator('#search-frame'));
          assert.equal(await search.evaluate(element => getComputedStyle(element).outlineStyle), 'none',
            'The grouped field paints just one outline around its frame');
          await page.screenshot({ path: join(screenshots, `${engine.name()}-${theme}-${width}.png`) });
        }
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
