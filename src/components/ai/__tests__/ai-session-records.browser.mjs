// Uses real local session headers; never writes to the session store.
// SHELLSPAN_SESSION_ARCHIVES=/path/to/archives-v5 node src/components/ai/__tests__/ai-session-records.browser.mjs
// With fewer records, use SHELLSPAN_SESSION_DIRECTORY=/path/to/sessions-v5 and --delete-all-only.
import assert from 'node:assert/strict';
import { open, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = path.resolve(import.meta.dirname, '../../../..');
const deleteAllOnly = process.argv.includes('--delete-all-only');
const archives = process.env.SHELLSPAN_SESSION_DIRECTORY ?? process.env.SHELLSPAN_SESSION_ARCHIVES
  ?? path.join(os.homedir(), 'Library/Application Support/com.shellspan/agent-runtime/archives-v5');
const records = [];
for (const name of await readdir(archives)) {
  if (!name.endsWith('.jsonl')) continue;
  const file = await open(path.join(archives, name));
  try {
    for await (const line of file.readLines()) {
      const event = JSON.parse(line);
      if (event.type !== 'session/created') continue;
      records.push({
        header: { ...event.data, sessionId: event.sessionId, createdAtUnixMs: event.timeUnixMs },
        archived: path.basename(archives) === 'archives-v5',
      });
      break;
    }
  } finally {
    await file.close();
  }
}
assert.ok(records.length > 0, 'Supply real session logs using SHELLSPAN_SESSION_DIRECTORY');
if (!deleteAllOnly) assert.ok(records.length > 20, 'Supply at least 21 real archives using SHELLSPAN_SESSION_ARCHIVES');
records.sort((a, b) => b.header.createdAtUnixMs - a.header.createdAtUnixMs);

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  resolve: { alias: { '@': path.join(root, 'src') } },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  plugins: [tailwindcss(), {
    name: 'session-records-browser-test',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/records-test') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<html><head><script type="module" src="/src/components/ai/__tests__/ai-session-records.browser-entry.tsx"></script></head><body><div id="root"></div></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await webkit.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const address = server.httpServer.address();
  await page.goto(`http://127.0.0.1:${address.port}/records-test`);
  await page.waitForFunction(() => typeof window.renderRecords === 'function');
  async function verifyVirtualList() {
  await page.evaluate((records) => window.renderRecords(records), records);
  const viewport = page.locator('[data-slot="scroll-area-viewport"]');
  const rows = page.locator('[data-index]');
  await rows.first().waitFor();

  for (const width of [1280, 400]) {
    await page.setViewportSize({ width, height: 800 });
    await viewport.evaluate((element) => { element.scrollTop = 0; });
    await page.waitForFunction(() => document.querySelector('[data-index="0"]'));
    assert.ok(await rows.count() < records.length, 'Only the visible range and overscan should mount');
    const geometry = await viewport.evaluate((element) => {
      const rows = [...element.querySelectorAll('[data-index]')].map((row) => row.getBoundingClientRect());
      return {
        overflow: element.scrollWidth > element.clientWidth,
        gap: rows[1].top - rows[0].bottom,
        left: rows[0].left - element.getBoundingClientRect().left,
      };
    });
    assert.equal(geometry.overflow, false);
    assert.ok(Math.abs(geometry.gap - 8) < 1);
    assert.equal(geometry.left, 16);
    await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.waitForFunction((last) => document.querySelector(`[data-index="${last}"]`), records.length - 1);
    await rows.last().getByRole('button').first().click();
    assert.equal(await page.locator('output').textContent(), records.at(-1).header.sessionId);
    await page.screenshot({ path: `/tmp/shellspan-session-records-${width}.png` });
  }

  // Tab must traverse beyond the initially mounted range, in both directions.
  await viewport.evaluate((element) => { element.scrollTop = 0; });
  await page.locator('[data-index="0"] button').first().focus();
  const tabRows = Math.min(records.length - 1, 30);
  for (let index = 0; index < tabRows; index++) {
    assert.equal(await page.evaluate(() => document.activeElement.closest('[data-index]')?.dataset.index), String(index));
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
  }
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.closest('[data-index]')?.dataset.index), String(tabRows - 1));

  // Filtering remounts the keyed list at the top; clearing restores virtualization.
  await page.evaluate((records) => window.renderRecords(records, 'filtered'), records.slice(-2));
  await page.waitForFunction(() => document.querySelectorAll('[data-slot="scroll-area-content"] button').length === 4);
  assert.equal(await viewport.evaluate((element) => element.scrollTop), 0);
  await page.evaluate((records) => window.renderRecords(records), records);
  await rows.first().waitFor();
  assert.equal(await rows.first().getAttribute('data-index'), '0');

  // Removing a row preserves the next record's measured position and identity.
  await page.evaluate((records) => window.renderRecords(records), records.slice(1));
  const nextTitle = records[1].header.goal || records[1].header.sessionId;
  await page.waitForFunction((title) => document.querySelector('[data-index="0"]')?.textContent.includes(title), nextTitle);
  await rows.first().getByRole('button').last().click();
  assert.equal(await page.locator('output').textContent(), records[1].header.sessionId);

  // A notice participates in measurement, rather than shifting the virtual
  // offsets outside the scroll viewport. Also exercise real English labels.
  await page.evaluate((records) => window.renderRecords(records, 'error', 'en-US', 'settings.ai.records.loadFailed'), records);
  await viewport.getByRole('status').waitFor();
  await page.getByRole('button', { name: 'View', exact: true }).first().waitFor();
  const noticeGap = await page.evaluate(() => {
    const first = document.querySelector('[data-index="0"]').getBoundingClientRect();
    const second = document.querySelector('[data-index="1"]').getBoundingClientRect();
    return second.top - first.bottom;
  });
  assert.ok(Math.abs(noticeGap - 8) < 1);
  for (const notice of ['common.loading', 'settings.ai.records.empty']) {
    await page.evaluate((notice) => window.renderRecords([], notice, 'zh-CN', notice), notice);
    await viewport.getByRole('status').waitFor();
    assert.equal(await rows.count(), 0);
    assert.equal(await viewport.evaluate((element) => element.scrollTop), 0);
  }
  }
  if (!deleteAllOnly) await verifyVirtualList();

  // Check compact row geometry with a real session header in both widths.
  await page.evaluate((records) => window.renderRecords(records), records.slice(0, 1));
  await page.locator('[data-slot="scroll-area-content"] button').first().waitFor();
  for (const width of [1280, 400]) {
    await page.setViewportSize({ width, height: 800 });
    const row = await page.locator('[data-slot="scroll-area-content"] button').first().evaluate((button) => {
      const row = button.parentElement;
      const style = getComputedStyle(row);
      return {
        height: row.getBoundingClientRect().height,
        padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
        overflow: row.scrollWidth > row.clientWidth,
        buttons: [...row.querySelectorAll('button')].map((button) => button.getBoundingClientRect().height),
        iconButtons: [...row.querySelectorAll('button')].map((button) => ({
          width: button.getBoundingClientRect().width,
          text: button.textContent,
          icon: Boolean(button.querySelector('svg')),
          label: Boolean(button.getAttribute('aria-label')),
          border: getComputedStyle(button).borderWidth,
          background: getComputedStyle(button).backgroundColor,
        })),
      };
    });
    assert.equal(row.height, 54);
    assert.deepEqual(row.padding, ['6px', '8px', '6px', '8px']);
    assert.equal(row.overflow, false);
    assert.deepEqual(row.buttons, [32, 32]);
    assert.deepEqual(row.iconButtons, Array.from({ length: 2 }, () => ({ width: 32, text: '', icon: true, label: true, border: '0px', background: 'rgba(0, 0, 0, 0)' })));
    const view = page.getByRole('button', { name: '查看', exact: true });
    for (const action of await page.locator('[data-slot="scroll-area-content"] button').all()) {
      await action.hover();
      await action.evaluate(async button => {
        await Promise.all(button.getAnimations().map(animation => animation.finished));
      });
      const hover = await action.evaluate(button => ({
        background: getComputedStyle(button).backgroundColor,
        border: getComputedStyle(button).borderWidth,
      }));
      assert.notEqual(hover.background, 'rgba(0, 0, 0, 0)', 'Each action should have a hover background');
      assert.equal(hover.border, '0px');
    }
    await page.screenshot({ path: `/tmp/shellspan-record-icons-hover-${width}.png`, animations: 'disabled' });
    await view.hover();
    await page.locator('[data-slot="tooltip-content"]').filter({ hasText: '查看' }).waitFor();
    await page.mouse.move(0, 0);
    await view.focus();
    assert.equal(await view.evaluate(button => button === document.activeElement), true);
    await view.blur();
    await page.screenshot({ path: `/tmp/shellspan-record-icons-${width}.png`, animations: 'disabled' });
  }

  const order = await page.evaluate(async (records) => {
    const { orderSessionRecordsForDeletion } = await import('/src/lib/ai/session-records.ts');
    return orderSessionRecordsForDeletion([...records].reverse()).map((record) => record.header.sessionId);
  }, records);
  assert.equal(new Set(order).size, records.length);
  for (const record of records) {
    const parent = record.header.continuedFromSessionId;
    if (parent && order.includes(parent)) {
      assert.ok(order.indexOf(record.header.sessionId) < order.indexOf(parent), 'Delete continuations before their sources');
    }
  }

  // Opening/cancelling the real confirmation must never invoke deletion.
  // Do not confirm: these are the user's actual records.
  for (const width of [1280, 400]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate((records) => window.renderDeleteAll(records), records);
    const deleteAll = page.getByRole('button', { name: '删除全部', exact: true });
    await deleteAll.waitFor();
    assert.equal((await deleteAll.boundingBox()).height, 32);
    await deleteAll.click();
    const confirmation = page.getByRole('alertdialog');
    await confirmation.waitFor();
    assert.ok((await confirmation.textContent()).includes(String(records.length)));
    assert.ok((await confirmation.textContent()).includes('不受搜索或筛选条件影响'));
    assert.ok((await confirmation.textContent()).includes('正在运行的任务会先停止'));
    await confirmation.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    const bounds = await confirmation.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 800);
    await page.screenshot({ path: `/tmp/shellspan-delete-all-${width}.png`, animations: 'disabled' });
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    await confirmation.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('output').textContent(), '');
    assert.equal(await page.evaluate(() => document.body.dataset.busy), undefined);
    await page.evaluate((records) => window.renderDeleteAll(records, true), records);
    await page.waitForFunction(() => document.querySelector('button')?.disabled);
    await page.evaluate(() => window.renderDeleteAll([]));
    await page.waitForFunction(() => document.querySelector('button')?.disabled);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
