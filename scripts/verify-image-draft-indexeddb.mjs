import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
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
  const result = await page.evaluate(async () => {
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
        images: [{ name: 'fixture.png', mediaType: 'image/png', data: 'aGVsbG8=' }],
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
  });

  assert.equal(result.before.text, 'preserved');
  assert.equal(result.after?.text, 'updated');
  assert.equal(result.schema.version, 4);
  assert.deepEqual(result.schema.stores, ['drafts', 'operations']);

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
