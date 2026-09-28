import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { webkit } from 'playwright';
import { createServer } from 'vite';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  appType: 'custom',
  configFile: false,
  root: repositoryRoot,
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  plugins: [{
    name: 'image-draft-indexeddb-fixture',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') { next(); return; }
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
});
let browser;

try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not expose a loopback port');

  browser = await webkit.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const imageData = (await readFile(path.join(repositoryRoot, 'src-tauri/icons/32x32.png'))).toString('base64');
  const result = await page.evaluate(async imageData => {
    const databaseName = 'shellspan-image-drafts-v1';
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 4);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('drafts', { keyPath: 'owner' });
        store.createIndex('session', 'operation.sessionId');
        request.result.createObjectStore('operations', { keyPath: 'owner' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('drafts', 'readwrite');
      transaction.objectStore('drafts').put({
        owner: 'agent:existing-session',
        revision: 1,
        text: 'preserved',
        images: [{ name: '32x32.png', mediaType: 'image/png', data: imageData }],
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    const drafts = await import('/src/lib/ai/image-drafts.ts');
    const before = await drafts.readImageDraft('agent:existing-session');
    if (!before) throw new Error('Existing image draft was not restored');
    await drafts.writeImageDraft({ ...before, revision: 2, text: 'updated' }, 1);
    const after = await drafts.readImageDraft('agent:existing-session');
    const schema = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => {
        const value = { version: request.result.version, stores: [...request.result.objectStoreNames] };
        request.result.close();
        resolve(value);
      };
      request.onerror = () => reject(request.error);
    });
    return { before, after, schema };
  }, imageData);

  assert.equal(result.before.text, 'preserved');
  assert.equal(result.after?.text, 'updated');
  assert.equal(result.schema.version, 4);
  assert.deepEqual(result.schema.stores, ['drafts', 'operations']);

  const detached = await page.evaluate(async () => {
    const drafts = await import('/src/lib/ai/image-drafts.ts');
    const current = await drafts.readImageDraft('agent:existing-session', true);
    const value = { ...current, revision: current.revision + 1,
      operation: { id: 'continuous-image', sessionId: 'existing-session', mode: 'nextTurn' } };
    await drafts.writeImageDraft(value, current.revision);
    const message = await drafts.detachImageDraft(value);
    const editor = await drafts.readImageDraft('agent:existing-session', true);
    await drafts.writeImageDraft({ ...editor, revision: editor.revision + 1, text: 'next draft' }, editor.revision);
    const stored = await drafts.readImageDraft(message.owner, true);
    const releaseFirst = drafts.holdDetachedImageDraft(value.operation.id);
    const releaseSecond = drafts.holdDetachedImageDraft(value.operation.id);
    const hidden = await drafts.readImageDraft('agent:existing-session');
    releaseFirst();
    const stillHeld = await drafts.readImageDraft('agent:existing-session');
    releaseSecond();
    const recovered = await drafts.readImageDraft('agent:existing-session');
    await drafts.acknowledgeDetachedImageDraft(value.operation.id);
    return { stored, editor, hidden, stillHeld, recovered, after: await drafts.readImageDraft('agent:existing-session', true),
      removed: await drafts.readImageDraft(message.owner, true) };
  });
  assert.equal(detached.stored.text, 'updated');
  assert.equal(detached.stored.operation.id, 'continuous-image');
  assert.equal(detached.editor.images.length, 0);
  assert.equal(detached.hidden.images.length, 0);
  assert.equal(detached.stillHeld.images.length, 0);
  assert.equal(detached.recovered.images.length, 1, 'failed or abandoned consumers must release recovery exclusion');
  assert.equal(detached.recovered.operation.id, 'continuous-image');
  assert.equal(detached.after.text, 'next draft');
  assert.equal(detached.removed, null);

  const retryCancellation = await page.evaluate(async imageData => {
    const drafts = await import('/src/lib/ai/image-drafts.ts');
    const original = { owner: 'new:retry-origin', revision: 1, text: 'retained input',
      images: [{ name: '32x32.png', mediaType: 'image/png', data: imageData }],
      operation: { id: 'retry-original-id', sessionId: 'retry-session', mode: 'nextTurn' } };
    await drafts.writeImageDraft(original, 0);
    const detached = await drafts.detachImageDraft(original);
    const bound = { ...detached, revision: detached.revision + 1 };
    await drafts.writeImageDraft(bound, detached.revision);
    const restored = await drafts.restoreCancelledImageDraft(bound, { editorOwner: 'agent:retry-session', keepOperation: true });
    const newer = { ...restored, revision: restored.revision + 1, text: 'newer draft' };
    await drafts.writeImageDraft(newer, restored.revision);
    const staleRestore = await drafts.restoreCancelledImageDraft(restored, { editorOwner: restored.owner, keepOperation: true });
    return { restored, staleRestore, latest: await drafts.readImageDraft(restored.owner, true) };
  }, imageData);
  assert.equal(retryCancellation.restored.owner, 'agent:retry-session');
  assert.equal(retryCancellation.restored.operation.id, 'retry-original-id', 'cancelling a retry must retain its original idempotency identity');
  assert.equal(retryCancellation.staleRestore, null, 'stale cancellation must not overwrite a newer revision');
  assert.equal(retryCancellation.latest.text, 'newer draft');

  const migrationContext = await browser.newContext();
  const migrationPage = await migrationContext.newPage();
  await migrationPage.goto(`http://127.0.0.1:${address.port}/`);
  const migration = await migrationPage.evaluate(async () => {
    const databaseName = 'shellspan-image-drafts-v1';
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 4);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('operations', { keyPath: 'owner' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();

    const drafts = await import('/src/lib/ai/image-drafts.ts');
    const restored = await drafts.readImageDraft('agent:missing-session');
    const schema = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => {
        const store = request.result.transaction('drafts').objectStore('drafts');
        const value = {
          version: request.result.version,
          stores: [...request.result.objectStoreNames],
          indexes: [...store.indexNames],
        };
        request.result.close();
        resolve(value);
      };
      request.onerror = () => reject(request.error);
    });
    return { restored, schema };
  });
  await migrationContext.close();

  assert.equal(migration.restored, null);
  assert.equal(migration.schema.version, 5);
  assert.deepEqual(migration.schema.stores, ['drafts', 'operations']);
  assert.deepEqual(migration.schema.indexes, ['session']);
} finally {
  await browser?.close();
  await server.close();
}
