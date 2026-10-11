import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { webkit } from 'playwright';

const root = path.resolve(import.meta.dirname, '../../../..');
const server = await createServer({
  root, configFile: false, logLevel: 'error',
  resolve: { alias: { '@': path.join(root, 'src') } },
  plugins: [tailwindcss(), {
    name: 'new-session-scroll-review',
    resolveId(id) { if (id === '/scroll-entry') return id; },
    load(id) {
      if (id !== '/scroll-entry') return;
      return `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { NewSessionDialog } from '/src/components/terminal/new-session-dialog.tsx';
        import { SftpNewConnectionMenu } from '/src/components/sftp/sftp-new-connection-menu.tsx';
        import { initI18n } from '/src/locales/index.ts';
        import { useAppStore } from '/src/stores/appStore.ts';
        import { useProfileStore } from '/src/stores/profileStore.ts';
        import { useRecentProfilesStore } from '/src/stores/recentProfilesStore.ts';
        import '/src/styles/base.css';
        const kind = new URLSearchParams(location.search).get('kind');
        useAppStore.setState({ locale: 'zh-CN' });
        await initI18n('zh-CN');
        const profiles = Array.from({ length: 40 }, (_, i) => ({
          id: 'p' + i,
          name: 'Server-' + String(i).padStart(2, '0'),
          host: '192.168.1.' + i,
          port: 22,
          username: 'deploy',
          authMethod: 'password',
          createdAt: 0,
          updatedAt: 0,
        }));
        useProfileStore.setState({ profiles });
        useRecentProfilesStore.setState({ recentIds: ['p0', 'p1', 'p2'] });
        const props = {
          open: true,
          onClose: () => {},
          onConnect: async () => {},
          onOpenLocal: async () => {},
        };
        const dialog = kind === 'sftp'
          ? React.createElement(SftpNewConnectionMenu, props)
          : React.createElement(NewSessionDialog, props);
        createRoot(document.getElementById('root')).render(dialog);
      `;
    },
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/scroll-review')) return next();
        res.setHeader('Content-Type', 'text/html');
        res.end('<html data-theme="light"><body><div id="root"></div><script type="module" src="/scroll-entry"></script></body></html>');
      });
    },
  }], server: { host: '127.0.0.1', port: 0 },
});

const measure = () => {
  const content = document.querySelector('[data-slot="dialog-content"]');
  const scrollRoot = content.querySelector('[data-slot="scroll-area"]');
  const viewport = content.querySelector('[data-slot="scroll-area-viewport"]');
  const footer = content.querySelector('[data-slot="dialog-footer"]');
  const thumb = content.querySelector('[data-slot="scroll-area-thumb"]');
  const rect = (el) => el.getBoundingClientRect();
  return {
    contentBottom: rect(content).bottom,
    windowHeight: window.innerHeight,
    fitsInWindow: rect(content).bottom <= window.innerHeight + 0.5,
    footerInside: rect(footer).bottom <= rect(content).bottom + 0.5,
    rootHeight: rect(scrollRoot).height,
    viewportHeight: rect(viewport).height,
    scrollHeight: viewport.scrollHeight,
    clientHeight: viewport.clientHeight,
    scrollable: viewport.scrollHeight > viewport.clientHeight,
    viewportConstrained: viewport.clientHeight <= rect(scrollRoot).height + 1,
    thumbHeight: thumb ? rect(thumb).height : 0,
  };
};

let browser;
try {
  await server.listen();
  browser = await webkit.launch();
  const page = await browser.newPage();
  for (const kind of ['terminal', 'sftp']) {
    for (const viewportSize of [{ width: 1280, height: 800 }, { width: 900, height: 500 }]) {
      await page.setViewportSize(viewportSize);
      await page.goto(`${server.resolvedUrls.local[0]}scroll-review?kind=${kind}`);
      await page.getByRole('dialog').waitFor();
      const geometry = await page.evaluate(measure);
      assert.equal(
        geometry.scrollable,
        true,
        `${kind} list must overflow its viewport (${geometry.scrollHeight} > ${geometry.clientHeight}) at ${viewportSize.width}x${viewportSize.height}`,
      );
      assert.equal(geometry.viewportConstrained, true, `${kind} viewport must be constrained by the scroll root`);
      assert.equal(geometry.fitsInWindow, true, `${kind} dialog must fit inside the window`);
      assert.equal(geometry.footerInside, true, `${kind} footer must stay inside the dialog`);
      assert.ok(geometry.thumbHeight > 1, `${kind} scrollbar thumb must be rendered`);
    }
  }
  console.log('New session and SFTP quick-open lists scroll with a visible scrollbar at tall and short window sizes.');
} finally {
  await browser?.close();
  await server.close();
}
