import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  plugins: [react(), tailwindcss(), {
    name: 'composer-stop-browser',
    resolveId: id => id === '/stop-entry.tsx' ? id : undefined,
    load(id) {
      if (id !== '/stop-entry.tsx') return;
      return `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { AiComposerSeat } from '/src/components/ai/workspace/ai-composer-seat';
        import { initI18n } from '/src/locales';
        import { useAppStore } from '/src/stores/appStore';
        import '/src/styles/base.css';
        import '/src/components/ai/styles/styles.css';
        useAppStore.setState({ locale: 'en-US' });
        await initI18n('en-US');
        function App() {
          const [draft, setDraft] = useState('');
          const [status, setStatus] = useState('running');
          return <main className="ai-panel-shell @container/ai-workspace" data-slot="ai-workspace-root">
            <AiComposerSeat phase="active" status={status} draft={draft}
              onDraftChange={setDraft} onSubmit={() => setDraft('')}
              onStop={() => setStatus('idle')} />
          </main>;
        }
        createRoot(document.getElementById('root')).render(<App />);
      `;
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
});
server.middlewares.use('/', async (request, response, next) => {
  if (request.url !== '/') return next();
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/', '<html><body><div id="root"></div><script type="module" src="/stop-entry.tsx"></script></body></html>'));
});
try {
  await server.listen();
  const browser = await chromium.launch();
  try {
    for (const width of [380, 1000]) {
      const page = await browser.newPage({ viewport: { width, height: 720 } });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
      const primary = page.locator('.ai-composer-primary');
      await page.getByRole('button', { name: 'Stop this turn' }).waitFor();
      const before = await primary.boundingBox();
      const editor = page.getByRole('textbox');
      await editor.fill('Keep this draft');
      await page.getByRole('button', { name: 'Queue for next turn' }).waitFor();
      assert.equal(await primary.count(), 1);
      const after = await primary.boundingBox();
      assert.deepEqual([after.x, after.width, after.height], [before.x, before.width, before.height], 'Switching actions must preserve horizontal position and size');
      await primary.click();
      await page.getByRole('button', { name: 'Stop this turn' }).waitFor();
      await editor.fill('Keep this draft');
      await page.screenshot({ path: `/tmp/shellspan-composer-stop-${width}.png` });
      await editor.press('Escape');
      await editor.press('Escape');
      await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
      assert.equal(await editor.textContent(), 'Keep this draft');
      await page.close();
    }
  } finally { await browser.close(); }
  console.log('Composer action switching and Esc Esc passed at 380px and 1000px');
} finally { await server.close(); }
