import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const artifacts = join(root, 'artifacts/tests');
await mkdir(artifacts, { recursive: true });
const output = await mkdtemp(join(artifacts, 'queue-image-edit-'));
const readyFile = join(output, 'runtime-url');
const fixture = '/src/components/ai/__tests__/queue-edit-recovery.browser.tsx';
const native = spawn('cargo', [
  'test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', 'queue_image_edit_browser_bridge', '--', '--ignored',
], {
  cwd: root, env: { ...process.env, SHELLSPAN_QUEUE_EDIT_BRIDGE: readyFile }, stdio: 'inherit',
});
const exited = new Promise((resolve, reject) => {
  native.on('error', reject);
  native.on('exit', resolve);
});

let server;
let runtime;
async function rpc(command, input) {
  const response = await fetch(runtime, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, args: { input } }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error);
  return payload.value;
}

try {
  for (let attempt = 0; attempt < 1200 && !runtime; attempt++) {
    assert.equal(native.exitCode, null, 'Runtime bridge exited before listening');
    try { runtime = await readFile(readyFile, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await delay(250);
    }
  }
  assert.ok(runtime, 'Runtime bridge did not become ready');
  server = await createServer({
    configFile: false, root, appType: 'custom', logLevel: 'error',
    cacheDir: join(output, 'vite-cache'),
    resolve: { alias: { '@': join(root, 'src') } },
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { entries: [fixture.slice(1)], include: ['react', 'react-dom', 'react-dom/client'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/__queue_rpc': runtime } },
    plugins: [tailwindcss()],
  });
  server.middlewares.use((request, response, next) => {
    if (!request.url?.startsWith('/?session=')) return next();
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html><body class="m-0"><main id="root" class="ai-panel-shell @container/ai-workspace flex h-dvh flex-col justify-end" data-ai-scope="workbench"></main><script type="module" src="${fixture}"></script></body></html>`);
  });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const [width, locale] of [[360, 'zh-CN'], [900, 'en-US']]) {
        const sessionId = `edit-${engine.name()}-${width}`;
        await rpc('open_fixture', { sessionId });
        const page = await browser.newPage({ viewport: { width, height: 700 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${url}/?session=${sessionId}&locale=${locale}`);
        const zh = locale === 'zh-CN';
        const edit = page.getByRole('button', { name: zh ? '编辑排队输入' : 'Edit queued input', exact: true }).first();
        const draft = page.getByTestId('ai-workspace-composer');
        await edit.waitFor();
        const queue = page.locator('[data-slot="ai-queue-dock"]');
        const row = queue.locator('li').first();
        await row.locator('img').first().evaluate(image => image.decode());
        await draft.fill('Keep this new message');
        await page.locator('input[type=file][accept*="image/png"]').setInputFiles(join(root, 'src-tauri/icons/128x128@2x.png'));
        const draftImage = page.getByRole('img', { name: '128x128@2x.png' });
        try {
          await draftImage.waitFor({ timeout: 8000 });
        } catch (error) {
          const toasts = await page.evaluate(async () => {
            const { useToastStore } = await import('/src/stores/toastStore.ts');
            return useToastStore.getState().toasts.map(toast => toast.message);
          });
          throw new Error(`Draft image was not attached. Browser errors: ${errors.join(', ')}. Toasts: ${toasts.join(', ')}`, { cause: error });
        }
        const original = await rpc('read_fixture', { sessionId });
        await edit.click();

        const editor = page.locator('[data-queue-edit-composer]');
        const text = editor.getByRole('textbox');
        const save = editor.getByRole('button', { name: zh ? '保存' : 'Save', exact: true });
        const preview = name => editor.getByRole('button', { name: `${zh ? '预览图片' : 'Preview image'} ${name}`, exact: true });
        const remove = name => editor.getByRole('button', { name: `${zh ? '删除图片' : 'Remove image'} ${name}`, exact: true });
        await text.waitFor();
        assert.equal(await text.inputValue(), '');
        assert.equal(await text.evaluate(element => element === document.activeElement), true);
        assert.equal(await draft.isVisible(), false);
        assert.ok(await row.getAttribute('data-editing'));
        assert.ok(await save.isEnabled(), 'An image-only message can be saved without a caption');
        await preview('32x32.png').click();
        const dialog = page.getByRole('dialog');
        await dialog.locator('img').evaluate(image => image.decode());
        await dialog.getByRole('button', { name: zh ? '关闭' : 'Close', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });

        await remove('32x32.png').click();
        await remove('64x64.png').click();
        assert.ok(await save.isDisabled(), 'Removing all images from a blank message disables save');
        await text.press('Escape');
        await draftImage.waitFor();
        assert.equal(await draft.textContent(), 'Keep this new message');
        assert.equal(await edit.evaluate(element => element === document.activeElement), true);
        assert.deepEqual((await rpc('read_fixture', { sessionId })).snapshot.inbox, original.snapshot.inbox);

        await edit.click();
        await remove('32x32.png').click();
        await text.fill('Updated queue caption');
        await editor.locator('input[type=file]').setInputFiles(join(root, 'src-tauri/icons/icon.png'));
        await preview('icon.png').waitFor();
        await page.waitForFunction(() => document.querySelector('[data-queue-edit-composer]')?.getAttribute('aria-busy') === null);
        const dimensions = await page.evaluate(() => {
          const queue = document.querySelector('[data-slot="ai-queue-dock"]').getBoundingClientRect();
          const editor = document.querySelector('[data-queue-edit-composer]').getBoundingClientRect();
          return { queue: queue.bottom, top: editor.top, bottom: editor.bottom, height: innerHeight,
            overflow: document.documentElement.scrollWidth > innerWidth };
        });
        assert.ok(dimensions.queue < dimensions.top && dimensions.bottom <= dimensions.height && !dimensions.overflow);
        await page.screenshot({ path: join(output, `${engine.name()}-${width}-editing.png`) });
        await rpc('agent_runtime_mutate_inbox', {
          sessionId, clientOperationId: 'concurrent-revision', expectedRevision: original.snapshot.eventCount,
          mutation: { type: 'reorder', lane: 'nextTurn', orderedItemIds: ['first', 'second'] },
        });
        await save.click();
        await page.getByRole('alert').getByText(zh ? '队列已在别处发生变化' : 'Queue changed elsewhere').waitFor();
        assert.equal(await text.inputValue(), 'Updated queue caption');
        assert.ok(await preview('64x64.png').isVisible());
        assert.ok(await preview('icon.png').isVisible());
        await save.click();
        await editor.waitFor({ state: 'detached' });
        await draftImage.waitFor();
        assert.equal(await draft.textContent(), 'Keep this new message');
        const saved = await rpc('read_fixture', { sessionId });
        assert.deepEqual(saved.snapshot.inbox.nextTurn.map(item => item.messageId), ['first', 'second']);
        assert.equal(saved.snapshot.inbox.nextTurn[0].content, 'Updated queue caption');
        assert.deepEqual(saved.snapshot.inbox.nextTurn[0].images.map(image => image.name), ['64x64.png', 'icon.png']);
        assert.equal(saved.events.filter(event => event.type === 'agent/inbox/item_updated').length, 1);
        await edit.click();
        await preview('icon.png').click();
        await dialog.locator('img').evaluate(image => image.decode());
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
  await rpc('finish');
  assert.equal(await exited, 0);
  console.log(`Queue edit passed in Chromium and WebKit. Screenshots: ${output}`);
} finally {
  await server?.close();
  if (runtime && native.exitCode === null) await rpc('finish').catch(() => undefined);
  if (native.exitCode === null) native.kill();
}
