import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = path.resolve(import.meta.dirname, '../../../..');
const entry = '/src/components/ai/__tests__/ai-session-records-width.browser-entry.tsx';
// Pass an idle session's JSONL log to also check its real history actions.
const sessionLog = process.argv[2];
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: path.join(root, 'artifacts/tests/session-records-width/vite-cache'),
  resolve: { alias: { '@': path.join(root, 'src') } },
  optimizeDeps: { entries: [entry.slice(1)], include: ['react', 'react-dom/client'] },
  plugins: [tailwindcss(), {
    name: 'records-width-test',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/width-test') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end(`<html><head><script type="module" src="${entry}"></script></head><body><div id="root"></div></body></html>`);
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
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/width-test`);
  await page.locator('.ai-session-records-detail .ai-conversation-content').waitFor({ timeout: 10000 }).catch((error) => {
    throw new Error(`Browser test failed to mount: ${errors.join('; ') || error.message}`, { cause: error });
  });
  for (const width of [1024, 400]) {
    await page.setViewportSize({ width, height: 800 });
    const sizes = await page.evaluate(() => [...document.querySelectorAll('.ai-workspace-root:not([data-testid])')].map((shell) => {
      const content = shell.querySelector('.ai-conversation-content').getBoundingClientRect();
      const box = shell.getBoundingClientRect();
      const style = getComputedStyle(shell);
      return {
        shell: box.width, content: content.width, left: content.left - box.left,
        inset: parseFloat(style.getPropertyValue('--ai-shell-clearance')) + parseFloat(style.getPropertyValue('--ai-transcript-extra-inset')),
        overflow: shell.scrollWidth > shell.clientWidth,
      };
    }));
    const [detail, standard] = sizes;
    assert.ok(Math.abs(detail.content - (detail.shell - 2 * detail.inset)) < 1);
    assert.ok(Math.abs(detail.left - detail.inset) < 1);
    assert.equal(detail.overflow, false);
    assert.ok(Math.abs(standard.content - Math.min(640, standard.shell - 2 * standard.inset)) < 1);
    const loading = await page.locator('[data-testid="loading-body"]').evaluate((shell) => {
      const body = shell.getBoundingClientRect();
      const status = shell.querySelector('[role="status"]');
      const hint = status.firstElementChild.getBoundingClientRect();
      const spinner = status.querySelector('svg').getBoundingClientRect();
      const text = status.querySelector('span > span').getBoundingClientRect();
      return {
        centerX: hint.x + hint.width / 2 - (body.x + body.width / 2),
        centerY: hint.y + hint.height / 2 - (body.y + body.height / 2),
        gap: text.left - spinner.right,
        label: status.textContent,
      };
    });
    assert.ok(Math.abs(loading.centerX) < 1 && Math.abs(loading.centerY) < 1, 'Loading hint is centered in the entire body');
    assert.equal(loading.gap, 4);
    assert.ok(loading.label.includes('加载'));
  }
  await page.evaluate(async (entry) => (await import(entry)).showRecordsDialog(), entry);
  const searchbox = page.getByRole('searchbox', { name: '搜索会话标题或终端', exact: true });
  await searchbox.waitFor();
  for (const width of [1280, 400]) {
    await page.setViewportSize({ width, height: 800 });
    const toolbar = await searchbox.evaluate((input) => {
      const toolbar = input.parentElement.parentElement;
      const controls = [...toolbar.querySelectorAll('input[type="search"], button')].map((control) => control.getBoundingClientRect());
      const icon = input.parentElement.querySelector('svg').getBoundingClientRect();
      const box = input.getBoundingClientRect();
      return {
        searchBackground: getComputedStyle(input).backgroundColor,
        heights: controls.map((control) => control.height),
        height: toolbar.getBoundingClientRect().height,
        overflow: toolbar.scrollWidth > toolbar.clientWidth,
        iconOffset: icon.y + icon.height / 2 - (box.y + box.height / 2),
      };
    });
    assert.equal(toolbar.searchBackground, 'rgba(0, 0, 0, 0)', 'The search field must show the dialog surface');
    assert.deepEqual(toolbar.heights, [32, 32, 32, 32]);
    if (width === 1280) assert.equal(toolbar.height, 49);
    assert.equal(toolbar.overflow, false);
    assert.ok(Math.abs(toolbar.iconOffset) < 1);
    await page.screenshot({ path: `/tmp/shellspan-records-toolbar-${width}.png`, animations: 'disabled' });
  }
  {
    const events = sessionLog ? (await readFile(sessionLog, 'utf8')).trim().split('\n').map(JSON.parse) : [];
    for (const [locale, searchLabel, rename, archive] of [
      ['en-US', 'Search sessions', 'Rename session', 'Archive'],
      ['zh-CN', '搜索会话', '重命名会话', '归档'],
    ]) {
      await page.evaluate(async ({ entry, events, locale }) => (await import(entry)).showHistory(events, locale),
        { entry, events, locale });
      const row = page.getByRole('treeitem');
      const trigger = row.getByRole('button', { name: locale === 'en-US' ? /More actions for/ : /更多操作/ });
      const menu = page.getByRole('menu');
      const history = page.locator('.ai-session-history-popover');
      const search = history.getByRole('searchbox', { name: searchLabel, exact: true });
      for (const width of [1280, 320]) {
        await page.setViewportSize({ width, height: 800 });
        await search.press('x');
        assert.equal(await search.inputValue(), 'x');
        const focusedSearch = await search.evaluate((input) => {
          const group = getComputedStyle(input.closest('[data-slot="input-group"]'));
          return {
            focused: input.matches(':focus-visible'),
            inputOutline: getComputedStyle(input).outlineStyle,
            groupOutline: group.outlineStyle,
            divider: group.borderBottomStyle,
          };
        });
        assert.deepEqual(focusedSearch, { focused: true, inputOutline: 'none', groupOutline: 'none', divider: 'solid' });
        if (!sessionLog) {
          const noResults = locale === 'en-US' ? /^No matching results/ : /^没有匹配的搜索结果/;
          await history.getByText(noResults).waitFor();
        }
        await search.fill('');
        if (!sessionLog) {
          await history.screenshot({ path: path.join(root, `artifacts/tests/session-records-width/history-search-${locale}-${width}.png`), animations: 'disabled' });
          continue;
        }
        await row.hover();
        await trigger.press('Enter');
        await menu.getByRole('menuitem', { name: rename, exact: true }).waitFor();
        await menu.getByRole('menuitem', { name: archive, exact: true }).waitFor();
        await menu.evaluate(async (element) => {
          await document.fonts.ready;
          await Promise.all(element.getAnimations().map((animation) => animation.finished));
        });
        const bounds = await menu.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'The history menu stays inside the viewport');
        for (const label of await menu.locator('[data-slot="menu-item-label"]').all()) {
          const fits = await label.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const text = range.getBoundingClientRect();
            return range.getClientRects().length === 1 && text.right <= element.closest('[role="menuitem"]').getBoundingClientRect().right;
          });
          assert.ok(fits, `History action wraps or clips at ${width}px (${locale})`);
        }
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'hidden' });
      }
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
