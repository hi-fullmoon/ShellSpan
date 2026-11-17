import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// Replay a real queue edit. No runtime command, model, or service replacement is used.
// Supply an existing journal containing agent/inbox/item_updated.
const journal = process.env.SHELLSPAN_AGENT_SESSION_FILE;
assert.ok(journal, 'Set SHELLSPAN_AGENT_SESSION_FILE to a recorded Agent session journal');
const events = (await readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse);
const index = events.findIndex(event => event.type === 'agent/inbox/item_updated');
assert.ok(index > 0, 'A recorded queue edit is required');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = join(tmpdir(), 'shellspan-queue-edit-recovery');
await mkdir(output, { recursive: true });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(output, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: {
    entries: [
      'src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts',
      'src/components/ai/workspace/ai-queue-dock.tsx',
      'src/lib/ai/agent-session-adapter.ts',
      'src/locales/index.ts',
    ],
    include: ['react', 'react-dom', 'react-dom/client'],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [tailwindcss()],
});
server.middlewares.use('/__queue_review', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell" style="padding:12px"></main></body></html>');
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium ? { channel: 'chromium' } : {});
    try {
      for (const locale of ['zh-CN', 'en-US']) for (const width of [360, 900]) for (const keepNewerDraft of [true, false]) {
        const page = await browser.newPage({ viewport: { width, height: 600 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__queue_review`);
        await page.evaluate(async ({ events, index, locale }) => {
          const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
          const { AiQueueDock } = await import('/src/components/ai/workspace/ai-queue-dock.tsx');
          const { projectAgentInbox } = await import('/src/lib/ai/agent-session-adapter.ts');
          const { decodeDocumentMessage } = await import('/src/lib/ai/document-message.ts');
          const { initI18n } = await import('/src/locales/index.ts');
          const { useAppStore } = await import('/src/stores/appStore.ts');
          await import('/src/styles/base.css');
          await import('/src/components/ai/styles/styles.css');
          await initI18n(locale);
          useAppStore.setState({ locale });
          const event = events[index];
          const before = projectAgentInbox(events.slice(0, index)).filter(item => item.state === 'queued');
          const after = projectAgentInbox(events.slice(0, index + 1)).filter(item => item.state === 'queued');
          const item = before.find(item => item.id === event.data.itemId);
          if (!item || item.source !== 'user') throw new Error('Recorded edit must target a queued user message');
          const root = createRoot(document.getElementById('root'));
          const intent = { type: 'update', itemId: item.id, content: event.data.content };
          window.queueReview = {
            itemId: item.id, text: decodeDocumentMessage(event.data.content).text,
            requests: [], retries: 0,
            render(stage) {
              root.render(React.createElement(AiQueueDock, {
                items: stage === 'committed' ? after.filter(candidate => candidate.id === item.id) : [item],
                mutation: stage === 'initial' || stage === 'committed' ? null
                  : { intent, status: stage, error: null, conflict: false },
                // Observe UI intent only. Outcomes below are explicit recorded-state replay.
                onUpdate: (item, content) => window.queueReview.requests.push({ id: item.id, content }),
                onRetry: () => { window.queueReview.retries++; },
              }));
            },
          };
          window.queueReview.render('initial');
        }, { events, index, locale });
        const chinese = locale === 'zh-CN';
        const dock = page.locator('[data-slot="ai-queue-dock"]');
        const edit = page.getByRole('button', { name: chinese ? '编辑排队输入' : 'Edit queued input' });
        await edit.first().waitFor();
        const dockBeforeEdit = await dock.boundingBox();
        const message = await dock.locator('.ai-queue-row-content > span').first().boundingBox();
        const messageCenter = message.y + message.height / 2;
        assert.equal(messageCenter, dockBeforeEdit.y + dockBeforeEdit.height / 2,
          'The single queued message must be vertically centered in the dock');
        const editButton = await edit.boundingBox();
        assert.equal(messageCenter, editButton.y + editButton.height / 2,
          'The queued message must align with the row actions');
        if (!keepNewerDraft) await dock.screenshot({ path: join(output, `${engine.name()}-${locale}-${width}-queued.png`) });
        await edit.click();
        const input = page.getByRole('textbox');
        await input.waitFor();
        const { topGap, bottomGap } = await input.evaluate(element => {
          const input = element.getBoundingClientRect();
          const dock = element.closest('[data-slot="ai-queue-dock"]').getBoundingClientRect();
          return { topGap: input.top - dock.top, bottomGap: dock.bottom - input.bottom };
        });
        assert.equal(topGap, bottomGap, 'The single queued item input must be vertically centered in the dock');
        assert.equal((await dock.boundingBox()).height, dockBeforeEdit.height, 'Editing must preserve the dock height');
        if (!keepNewerDraft) await dock.screenshot({ path: join(output, `${engine.name()}-${locale}-${width}-editing.png`) });
        const text = await page.evaluate(() => window.queueReview.text);
        await input.fill(text);
        await input.press('Enter');
        assert.equal(await page.evaluate(() => window.queueReview.requests.length), 1);
        await page.evaluate(() => window.queueReview.render('pending'));
        await page.waitForFunction(() => document.querySelector('input')?.disabled === true);
        assert.equal(await input.isDisabled(), true);
        await page.evaluate(() => window.queueReview.render('failed'));
        await page.getByRole('alert').waitFor();
        assert.equal(await input.inputValue(), text, 'Failed edit must retain its exact text');
        await page.getByRole('button', { name: chinese ? '重试' : 'Retry', exact: true }).click();
        assert.equal(await page.evaluate(() => window.queueReview.retries), 1);
        assert.equal(await page.evaluate(() => window.queueReview.requests.length), 1, 'Retry must use the original intent');
        await input.press('Escape');
        await edit.click();
        assert.equal(await input.inputValue(), text, 'Reopening a failed edit must restore the retained intent');
        await input.press('Enter');
        assert.equal(await page.evaluate(() => window.queueReview.retries), 2);
        assert.equal(await page.evaluate(() => window.queueReview.requests.length), 1, 'Saving unchanged failed text must retry the same intent');
        const newerDraft = `${text} — review follow-up`;
        if (keepNewerDraft) {
          await input.fill(newerDraft);
          await page.getByRole('button', { name: chinese ? '重试' : 'Retry', exact: true }).click();
          assert.equal(await page.evaluate(() => window.queueReview.requests.length), 1, 'Retry must not submit the newer unsaved draft');
        }
        assert.equal(await dock.evaluate(element => element.scrollWidth > element.clientWidth), false);
        await page.screenshot({ path: join(output, `${engine.name()}-${locale}-${width}-${keepNewerDraft}.png`) });
        await page.evaluate(() => window.queueReview.render('pending'));
        await page.waitForFunction(() => document.querySelector('input')?.disabled === true);
        await page.evaluate(() => window.queueReview.render('committed'));
        if (keepNewerDraft) {
          await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
          assert.equal(await input.count(), 1, 'Acknowledging an older save must preserve the newer editor');
          assert.equal(await input.inputValue(), newerDraft);
          assert.equal(await input.isEnabled(), true);
          assert.equal(await input.evaluate(element => element === document.activeElement), true, 'A retained draft must keep keyboard focus after the retry action disappears');
          await input.press('Enter');
          assert.equal(await page.evaluate(() => window.queueReview.requests.length), 2, 'The newer draft remains available for an explicit save');
        } else {
          await input.waitFor({ state: 'detached' });
        }
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  }
  console.log('Recorded queue edit recovery passed in Chromium/WebKit, both locales, at 360/900px.');
} finally { await server.close(); }
