import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { webkit } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configFile: false, logLevel: 'error', plugins: [react()],
  resolve: { alias: { '@': path.join(root, 'src') } }, server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  browser = await webkit.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/src/components/ai/__tests__/submission-recovery.html`, { waitUntil: 'networkidle' });

  for (const boundary of ['binding', 'stop-binding', 'persisting']) {
    await page.evaluate(async boundary => {
      const drafts = await import('/src/lib/ai/image-drafts.ts');
      const bytes = new Uint8Array(await (await fetch('/src-tauri/icons/32x32.png')).arrayBuffer());
      const data = btoa(String.fromCharCode(...bytes));
      const owner = `agent:cancel-${boundary}`;
      await drafts.writeImageDraft({ owner, revision: 1, text: 'Inspect the attached image',
        images: [{ name: '32x32.png', mediaType: 'image/png', data }] }, 0);
      window.imageOwner = owner;
      window.imageView = await window.recoveryProbe.mountImagePreparation(document.querySelector('#probe'), owner);
    }, boundary);
    await page.waitForFunction(() => window.imageView.api.current?.draft?.images.length === 1 && !window.imageView.api.current.busy);
    await page.evaluate(async boundary => {
      let release;
      const binding = new Promise(resolve => { release = resolve; });
      window.releaseImageBinding = release;
      if (boundary === 'persisting') {
        const database = await new Promise((resolve, reject) => {
          const open = indexedDB.open('shellspan-image-drafts-v1');
          open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
        });
        window.holdImageWrite = true;
        const tx = database.transaction('drafts', 'readwrite');
        const store = tx.objectStore('drafts');
        const keepOpen = () => { const read = store.get(window.imageOwner); read.onsuccess = () => { if (window.holdImageWrite) keepOpen(); }; };
        keepOpen();
        tx.oncomplete = () => database.close();
        release();
      }
      window.imageResult = window.imageView.api.current.detach(async () => {
        await binding;
        window.imageBound = true;
        return { id: `cancel-${boundary}`, sessionId: `cancel-${boundary}`, mode: 'nextTurn' };
      });
    }, boundary);
    if (boundary === 'persisting') await page.waitForFunction(() => window.imageBound === true);
    const cancelled = await page.evaluate(async boundary => {
      await window.imageView.api.current.cancel(boundary === 'stop-binding');
      window.holdImageWrite = false;
      const result = await window.imageResult;
      window.releaseImageBinding();
      await Promise.resolve();
      const drafts = await import('/src/lib/ai/image-drafts.ts');
      const restored = await drafts.readImageDraft(window.imageOwner);
      window.imageView.unmount();
      window.imageBound = false;
      return { result, images: restored?.images.length, operation: restored?.operation };
    }, boundary);
    assert.equal(cancelled.result, null, `${boundary}: cancelled preparation must never reach native submission`);
    assert.equal(cancelled.images, 1, `${boundary}: cancellation must preserve the editable image`);
    assert.equal(cancelled.operation, undefined, `${boundary}: a cancelled preparation must not leave a locked operation`);
  }

  await page.evaluate(async () => {
    window.controllerView = await window.recoveryProbe.mountDisconnectedController(document.querySelector('#probe'));
  });
  await page.waitForFunction(() => Boolean(window.controllerView.api.current));
  await page.evaluate(() => {
    const controller = window.controllerView.api.current;
    for (const content of ['A', 'B', 'C']) { controller.setDraft(content); controller.submit('keyboard'); }
  });
  await page.waitForFunction(() => window.controllerView.api.current.composer.failedDrafts.length === 1);
  const original = await page.evaluate(() => {
    const state = window.controllerView.api.current.composer;
    const ids = [state.failedDrafts[0].id, ...state.pendingSubmissions.map(item => item.clientOperationId)];
    window.controllerView.unmount();
    return ids;
  });
  await page.evaluate(async () => {
    window.controllerView = await window.recoveryProbe.mountDisconnectedController(document.querySelector('#probe'));
  });
  await page.waitForFunction(() => window.controllerView.api.current?.composer.failedDrafts.length === 1);
  const recovered = await page.evaluate(() => {
    const state = window.controllerView.api.current.composer;
    return { ids: [state.failedDrafts[0].id, ...state.pendingSubmissions.map(item => item.clientOperationId)],
      contents: [state.failedDrafts[0].content, ...state.pendingSubmissions.map(item => item.content)] };
  });
  assert.deepEqual(recovered.ids, original);
  assert.deepEqual(recovered.contents, ['A', 'B', 'C']);
  await page.evaluate(() => window.controllerView.unmount());
  assert.deepEqual(errors, [], 'no unhandled browser errors');
} finally { await browser?.close(); await server.close(); }
