import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const [ledger, artifactRoot] = process.argv.slice(2);
assert.ok(ledger && artifactRoot, 'Pass a recorded session JSONL ledger and the corresponding artifact directory.');
const events = (await readFile(ledger, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const turn = events.find(event => event.type === 'tool/result' && event.data.name === 'run_terminal_command'
  && event.data.data?.readWith === 'read_tool_result')?.turnId;
const results = events.filter(event => event.turnId === turn && event.type === 'tool/result'
  && event.data.name === 'run_terminal_command' && event.data.data?.readWith === 'read_tool_result');
assert.ok(turn && results.length, 'The ledger must contain terminal commands with saved output.');
const outputs = new Map();
for (const result of results) {
  const { artifactRef } = result.data.data;
  const event = events.find(event => event.type === 'context/artifact' && event.data.artifactId === artifactRef);
  assert.ok(event && /^[a-zA-Z0-9_-]+$/u.test(event.sessionId) && /^artifact-[0-9a-f]{32}$/u.test(artifactRef));
  const body = await readFile(join(artifactRoot, event.sessionId, `${artifactRef}.bin`));
  assert.equal(createHash('sha256').update(body).digest('hex'), event.data.sha256);
  const expected = JSON.stringify(JSON.parse(body.toString('utf8')), null, 2);
  outputs.set(artifactRef, {
    event,
    previewHash: createHash('sha256').update(expected).digest('hex'),
    response: { metadata: { ...event.data, createdAtUnixMs: event.timeUnixMs },
      bodyBase64: body.toString('base64'), truncated: false },
  });
}
// Keep unrelated commands and messages out of the browser capture.
const evidence = events.filter(event => (event.type === 'turn/start' || event.type === 'turn/end') && event.turnId === turn
  || results.some(result => event === result || event.type === 'tool/call' && event.data.call.callId === result.data.callId)
  || [...outputs.values()].some(output => output.event === event))
  .map((event, seq) => ({ ...event, seq, sourceSeq: event.seq }));

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = '/src/components/ai/__tests__/ai-runtime-artifacts.browser.tsx';
const cacheDir = await mkdtemp(join(tmpdir(), 'shellspan-saved-output-'));
const server = await createServer({ root, cacheDir, configFile: false, appType: 'custom', logLevel: 'error',
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src/` } },
  optimizeDeps: { entries: [entry.slice(1)], include: ['react', 'react-dom/client', 'react/jsx-runtime'] },
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, fs: { allow: [root, cacheDir] } } });
const reads = [];
server.middlewares.use(async (request, response, next) => {
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end(await server.transformIndexHtml('/', '<!doctype html><html><body><div id="root"></div></body></html>'));
  } else if (request.url === '/evidence') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(evidence));
  } else if (request.url?.startsWith('/saved-output/')) {
    const [sessionId, id] = request.url.slice('/saved-output/'.length).split('/');
    const output = outputs.get(id);
    if (!output || sessionId !== output.event.sessionId) {
      response.writeHead(404).end();
      return;
    }
    reads.push(id);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(output.response));
  } else next();
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  for (const [locale, labels] of [
    ['zh-CN', { records: '运行记录', output: '查看已保存的输出', back: '返回' }],
    ['en-US', { records: 'Run records', output: 'View saved output', back: 'Back' }],
  ]) {
    for (const width of [1000, 320]) {
      await page.setViewportSize({ width, height: 650 });
      await page.evaluate(async ({ entry, locale, width }) => (await import(entry)).show(locale, width), { entry, locale, width });
      const process = page.locator('.ai-turn-process-trigger');
      await process.waitFor();
      if (await process.getAttribute('aria-expanded') === 'false') await process.press('Enter');
      const tools = page.locator('[data-tool-variant="terminal"]');
      assert.equal(await tools.count(), results.length);
      assert.equal(await page.getByRole('button', { name: labels.records, exact: true }).count(), 0);
      assert.equal(await page.locator('[data-ai-node-kind="runtimeArtifacts"]').count(), 0);
      for (const [index, result] of results.entries()) {
        const row = tools.nth(index);
        const trigger = row.locator('[data-ai-node-action]');
        if (await trigger.getAttribute('aria-expanded') === 'false') await trigger.press('Enter');
        const before = reads.length;
        await row.locator('.ai-tool-inspect').press('Enter');
        const savedOutput = page.getByRole('button', { name: labels.output, exact: true });
        await savedOutput.waitFor();
        const bounds = await savedOutput.boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width
          && bounds.y >= 0 && bounds.y + bounds.height <= 650, 'Saved output action fits in the viewport');
        assert.equal(reads.length, before, 'Opening tool details is lazy');
        await savedOutput.press('Enter');
        const preview = page.locator('[data-slot="ai-artifact-details"] pre');
        await preview.waitFor();
        const id = result.data.data.artifactRef;
        assert.deepEqual(reads.slice(before), [id]);
        const digest = createHash('sha256').update(await preview.textContent()).digest('hex');
        assert.equal(digest, outputs.get(id).previewHash);
        const back = page.getByRole('button', { name: labels.back, exact: true });
        await back.press('Enter');
        await savedOutput.waitFor();
        await back.press('Enter');
        await tools.nth(index).waitFor();
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(`Saved output verified for ${results.length} recorded commands in both languages at 320px and 1000px.`);
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
