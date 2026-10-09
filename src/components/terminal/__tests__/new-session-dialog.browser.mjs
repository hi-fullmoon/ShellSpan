import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { webkit } from 'playwright';

// Read only actual saved connection metadata; never read credentials or connect.
const database = new DatabaseSync(
  process.env.SHELLSPAN_LAYOUT_DATABASE ?? join(homedir(), '.shellspan/shellspan-v1.db'),
  { readOnly: true },
);
const profiles = database.prepare(`
  SELECT id, name, host, port, username, auth_method AS authMethod,
    created_at AS createdAt, updated_at AS updatedAt FROM profiles
`).all();
const recentIds = database.prepare('SELECT profile_id FROM recent_profiles ORDER BY sort_order')
  .all().map((row) => row.profile_id);
database.close();
assert.ok(profiles.length > 5, 'Long-list verification requires at least six actual saved connections');

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  plugins: [tailwindcss(), {
    name: 'new-session-layout',
    resolveId(id) {
      if (id === '/session-runtime.js') return id;
    },
    load(id) {
      if (id === '/session-runtime.js') return `
        export { default as React } from 'react';
        export { createRoot } from 'react-dom/client';
        export { NewSessionDialog } from '/src/components/terminal/new-session-dialog.tsx';
        export { useProfileStore } from '/src/stores/profileStore.ts';
        export { useRecentProfilesStore } from '/src/stores/recentProfilesStore.ts';
        export { useAppStore } from '/src/stores/appStore.ts';
      `;
    },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><div id="root"></div></body></html>');
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
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.evaluate(async ({ profiles, recentIds }) => {
    await import('/src/styles/base.css');
    const { React, createRoot, NewSessionDialog, useProfileStore, useRecentProfilesStore, useAppStore }
      = await import('/session-runtime.js');
    useProfileStore.setState({ profiles });
    useRecentProfilesStore.setState({ recentIds });
    useAppStore.setState({ locale: 'zh-CN' });
    createRoot(document.getElementById('root')).render(React.createElement(NewSessionDialog, {
      open: true,
      onClose: () => {},
      onConnect: async () => { throw new Error('Layout verification must never connect'); },
      onOpenLocal: async () => { throw new Error('Layout verification must never open a terminal'); },
    }));
  }, { profiles, recentIds });
  await page.getByRole('heading', { name: '新建会话', exact: true }).waitFor();
  const search = page.getByRole('searchbox');
  for (const dimensions of [{ width: 1280, height: 800 }, { width: 400, height: 600 }]) {
    await page.setViewportSize(dimensions);
    await search.fill('');
    await search.focus();
    await search.press('ArrowDown');
    await page.locator('[data-command-index="1"] [data-slot="kbd"]').waitFor();
    await search.press('ArrowUp');
    await page.locator('[data-command-index="0"] [data-slot="kbd"]').waitFor();
    await page.waitForTimeout(150);
    const geometry = () => page.evaluate(() => {
      const dialog = document.querySelector('[data-slot="dialog-content"]');
      const viewport = dialog.querySelector('[data-slot="scroll-area-viewport"]');
      const footer = dialog.querySelector('[data-slot="dialog-footer"]');
      const header = dialog.querySelector('[data-slot="dialog-header"]');
      const rect = (element) => {
        const { top, bottom, height } = element.getBoundingClientRect();
        return { top, bottom, height };
      };
      return {
        dialog: rect(dialog), viewport: rect(viewport), footer: rect(footer), header: rect(header),
        scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight,
        scrollTop: viewport.scrollTop,
      };
    });
    const before = await geometry();
    assert.ok(before.scrollHeight > before.clientHeight, 'Actual connections must overflow the viewport');
    assert.ok(before.viewport.bottom <= before.footer.top + 1, 'List must not overlap footer');
    assert.ok(before.dialog.bottom <= dimensions.height, 'Dialog must remain inside window');
    await page.locator('[data-slot="scroll-area-scrollbar"]').waitFor({ state: 'visible' });
    await search.press('ArrowUp');
    await page.waitForFunction(() => {
      const viewport = document.querySelector('[data-slot="scroll-area-viewport"]');
      return viewport.scrollTop > 0;
    });
    const after = await geometry();
    assert.deepEqual(after.footer, before.footer, 'Footer must stay fixed while navigating');
    assert.deepEqual(after.header, before.header, 'Header must stay fixed while navigating');
    const last = await page.locator('[data-command-index]').last().boundingBox();
    assert.ok(last.y + last.height <= after.viewport.bottom + 1, 'Keyboard navigation must reveal last row');
    await page.screenshot({ path: join(tmpdir(), `shellspan-new-session-${dimensions.width}.png`) });
    await search.fill(profiles[0].name);
    assert.ok(await page.locator('[data-command-index]').count() > 0, 'Search must retain matching connection');
    await search.fill(`${profiles.map((profile) => profile.name).join(' ')} no-match`);
    await page.getByText('没有匹配的会话目标', { exact: true }).waitFor();
    assert.deepEqual((await geometry()).footer, before.footer, 'Empty search must keep footer fixed');
  }
  console.log('New session dialog: long list, visible scrollbar, fixed header/footer, keyboard navigation and search passed at 1280×800 and 400×600');
} finally {
  await browser?.close();
  await server.close();
}
