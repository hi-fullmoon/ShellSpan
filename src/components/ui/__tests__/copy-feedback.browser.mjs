import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = join(root, 'artifacts/tests/shared-copy-feedback');
await mkdir(output, { recursive: true });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error', cacheDir: join(output, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } },
  optimizeDeps: { entries: ['src/components/workbench/known-hosts-panel.tsx', 'src/components/workbench/keychain-panel.tsx', 'src/components/workbench/log-panel.tsx', 'src/components/sftp/sftp-file-context-menu.tsx', 'src/components/terminal/terminal-context-menu.tsx'], include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  plugins: [tailwindcss(), {
    name: 'shared-copy-feedback-review',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body style="margin:0"><main id="root" style="height:100vh;display:flex;flex-direction:column;min-width:0"></main></body></html>');
      });
    },
  }],
});
let browser;
let checks = 0;
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.SHELLSPAN_BROWSER_CHANNEL || 'chromium' });
  for (const locale of ['zh-CN', 'en-US']) {
    for (const [width, theme] of [[320, 'dark'], [960, 'light']]) {
      const page = await browser.newPage({ viewport: { width, height: 720 }, permissions: ['clipboard-read', 'clipboard-write'], reducedMotion: 'reduce' });
      page.setDefaultTimeout(15_000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
      await page.evaluate(async ({ locale, theme, width }) => {
        const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
        await import('/src/styles/base.css');
        const { initI18n, t } = await import('/src/locales/index.ts');
        const { useAppStore } = await import('/src/stores/appStore.ts');
        const { TooltipProvider } = await import('/src/components/ui/tooltip.tsx');
        const { Toaster } = await import('/src/components/ui/sonner.tsx');
        const { KnownHostsPanel } = await import('/src/components/workbench/known-hosts-panel.tsx');
        const { KeychainPanel } = await import('/src/components/workbench/keychain-panel.tsx');
        const { LogPanel } = await import('/src/components/workbench/log-panel.tsx');
        const { TerminalContextMenu } = await import('/src/components/terminal/terminal-context-menu.tsx');
        const { SftpFileContextMenu } = await import('/src/components/sftp/sftp-file-context-menu.tsx');
        const { SftpBlankContextMenu } = await import('/src/components/sftp/sftp-blank-context-menu.tsx');
        const { SftpPreviewDialog } = await import('/src/components/sftp/sftp-preview-dialog.tsx');
        const { useSftpPaneActions } = await import('/src/hooks/useSftpPaneActions.ts');
        const { useKnownHostsStore } = await import('/src/stores/knownHostsStore.ts');
        const { useKeychainStore } = await import('/src/stores/keychainStore.ts');
        const { useLogStore } = await import('/src/stores/logStore.ts');
        const { useTerminalStore } = await import('/src/stores/terminalStore.ts');
        const { useSftpStore } = await import('/src/stores/sftpStore.ts');
        await initI18n(locale);
        useAppStore.setState({ locale, theme, activeSection: 'workbench' });
        useKnownHostsStore.setState({ hosts: [{ host: 'example.com', port: 22, keyType: 'ED25519', fingerprint: 'ED25519 SHA256:PUBLIC_TEST_FINGERPRINT' }], loading: false, error: undefined, loadHosts: async () => {} });
        useKeychainStore.setState({ keys: [], initialized: true, loadError: undefined, hydrate: async () => {} });
        const date = new Date();
        const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        const log = `[${day}][12:34:56][INFO][shellspan] Copy regression log entry`;
        useLogStore.setState({ files: [], content: log, loading: false, error: undefined, activeFileName: undefined, activeSource: 'frontend', loadFiles: async () => {}, refreshActiveFile: async () => {} });
        const session = { sessionId: 'copy-review', host: 'example.com', username: 'example', port: 22, title: 'Copy review', status: 'connected' };
        useTerminalStore.setState({ sessions: [session] });
        useSftpStore.getState().addConnection(session, { host: 'example.com', username: 'example', port: 22, authMethod: 'password' });
        const connectionId = useSftpStore.getState().connections[0].id;
        useSftpStore.getState().setPath(connectionId, 'remote', '/home/example');
        useSftpStore.getState().setPath(connectionId, 'local', 'C:/Users/example');
        const entry = { name: 'report.txt', path: '/home/example/report.txt', kind: 'file', size: 10 };
        const localEntry = { ...entry, path: 'C:/Users/example/report.txt' };
        function SftpMenu({ blank, local }) {
          const connection = useSftpStore(state => state.connections.find(item => item.id === connectionId));
          const actions = useSftpPaneActions(connection, local ? 'local' : 'remote');
          const [open, setOpen] = React.useState(true);
          const props = { open, x: width - 8, y: 30, side: local ? 'local' : 'remote', isBookmarked: false, batchMode: false, onClose: () => setOpen(false) };
          const selected = local ? localEntry : entry;
          return blank ? React.createElement(SftpBlankContextMenu, { ...props, currentPath: '/home/example', hasClipboard: false, onAction: () => actions.onCopyCurrentDirectoryPath() })
            : React.createElement(SftpFileContextMenu, { ...props, selectedEntries: [selected], onAction: action => ({
              copy: () => actions.onCopy(selected), copyName: () => actions.onCopyName(selected), copyPath: () => actions.onCopyPath(selected), copyContainingDirectory: () => actions.onCopyContainingDirectory(selected),
            })[action]?.() });
        }
        const view = createRoot(document.getElementById('root'));
        let mountCount = 0;
        window.mountCopyScene = scene => {
          let node;
          if (scene === 'known') node = React.createElement(KnownHostsPanel);
          if (scene === 'key') node = React.createElement(KeychainPanel);
          if (scene === 'log') node = React.createElement(LogPanel);
          if (scene === 'terminal') node = React.createElement(TerminalContextMenu, { open: true, session, x: 10, y: 10, onClose: () => {} });
          if (scene.startsWith('sftp')) node = React.createElement(SftpMenu, { blank: scene === 'sftp-blank', local: scene === 'sftp-local' });
          if (scene === 'preview') node = React.createElement(SftpPreviewDialog, { open: true, onClose: () => {}, content: { path: entry.path, name: entry.name, content: 'Complete preview\n第二行', size: 25, isText: true, contentEncoding: 'utf8', truncated: false } });
          view.render(React.createElement(TooltipProvider, null, React.createElement(React.Fragment, { key: ++mountCount }, node), React.createElement(Toaster)));
        };
        window.copyReview = { log, t, useSftpStore };
      }, { locale, theme, width });
      const labels = await page.evaluate(() => Object.fromEntries(['common.copied', 'common.create', 'common.publicKey', 'workbench.knownHosts.copyFingerprint', 'workbench.keychain.copyPublicKey', 'workbench.logs.inspector.copy', 'terminal.tab.copyInfo', 'sftp.contextMenu.copy', 'sftp.contextMenu.copyName', 'sftp.contextMenu.copyPath', 'sftp.contextMenu.copyContainingDirectory', 'sftp.contextMenu.copyCurrentDirectoryPath', 'sftp.preview.copyContent'].map(key => [key, window.copyReview.t(key, { keyType: 'ED25519' })])));
      for (const scene of ['known', 'key', 'log', 'terminal', 'sftp-remote', 'sftp-local', 'sftp-blank', 'preview']) {
        if (scene.startsWith('sftp')) {
          const local = scene === 'sftp-local';
          const directory = local ? 'C:/Users/example' : '/home/example';
          const filePath = `${directory}/report.txt`;
          const textActions = scene === 'sftp-blank'
            ? [['copyCurrentDirectoryPath', directory]]
            : [['copyName', 'report.txt'], ['copyPath', filePath], ['copyContainingDirectory', directory]];
          const menu = page.getByRole('menu');
          for (const [action, text] of textActions) {
            await page.evaluate(scene => window.mountCopyScene(scene), scene);
            if (action === textActions[0][0]) await menu.screenshot({ path: join(output, `${locale}-${width}-${scene}.png`) });
            const item = menu.getByRole('menuitem', { name: labels[`sftp.contextMenu.${action}`], exact: true });
            if (width === 320) {
              await menu.locator(':focus').waitFor();
              await item.focus();
              await page.keyboard.press('Enter');
            } else {
              await item.click();
            }
            await menu.waitFor({ state: 'hidden' });
            await page.waitForFunction(async text => await navigator.clipboard.readText() === text, text);
          }
          if (scene !== 'sftp-blank') {
            await page.evaluate(scene => window.mountCopyScene(scene), scene);
            await menu.getByRole('menuitem', { name: labels['sftp.contextMenu.copy'], exact: true }).click();
            await menu.waitFor({ state: 'hidden' });
            const clip = await page.evaluate(local => {
              const store = window.copyReview.useSftpStore.getState();
              return local ? store.localClipboard[0]?.path : store.connections[0].remoteClipboard?.sourcePath;
            }, local);
            assert.equal(clip, filePath);
          }
          assert.equal(await page.locator('[data-sonner-toast]').count(), 0);
          checks++;
          continue;
        }
        await page.evaluate(scene => window.mountCopyScene(scene), scene);
        const copied = page.getByRole(scene === 'terminal' ? 'menuitem' : 'button', { name: labels['common.copied'], exact: true });
        let item;
        let expected;
        if (scene === 'known') { item = page.getByRole('button', { name: labels['workbench.knownHosts.copyFingerprint'], exact: true }); expected = 'SHA256:PUBLIC_TEST_FINGERPRINT'; }
        if (scene === 'key') {
          await page.getByRole('button', { name: labels['common.create'], exact: true }).click();
          await page.getByLabel(labels['common.publicKey'], { exact: true }).fill('ssh-ed25519 PUBLIC_TEST_KEY example');
          item = page.getByRole('button', { name: labels['workbench.keychain.copyPublicKey'], exact: true }); expected = 'ssh-ed25519 PUBLIC_TEST_KEY example';
        }
        if (scene === 'log') {
          const row = page.getByText('Copy regression log entry', { exact: true });
          if (width >= 760) {
            await row.dblclick();
            await page.getByRole('status').filter({ hasText: labels['common.copied'] }).waitFor();
          } else {
            await row.click();
            item = page.getByRole('button', { name: labels['workbench.logs.inspector.copy'], exact: true });
          }
          expected = await page.evaluate(() => window.copyReview.log);
        }
        if (scene === 'terminal') {
          const menu = page.getByRole('menu');
          await menu.locator(':focus').waitFor();
          item = menu.getByRole('menuitem', { name: labels['terminal.tab.copyInfo'], exact: true });
          expected = 'example@example.com:22';
        }
        if (scene === 'preview') { item = page.getByRole('button', { name: labels['sftp.preview.copyContent'], exact: true }); expected = 'Complete preview\n第二行'; }
        if (item) {
          await item.focus();
          const before = await item.boundingBox();
          await page.keyboard.press('Enter');
          await copied.waitFor();
          assert.equal(await copied.locator('.lucide-check').count(), 1);
          assert.equal(await copied.evaluate(element => element === document.activeElement), true, `${scene}: copy must retain keyboard focus.`);
          const after = await copied.boundingBox();
          assert.ok(Math.abs(before.width - after.width) <= 0.5 && Math.abs(before.height - after.height) <= 0.5,
            `${scene}: copy feedback must preserve the action dimensions.`);
          const gap = await copied.evaluate(element => {
            const icon = element.querySelector('svg');
            const spans = [...element.querySelectorAll('span')];
            const label = spans.find(span => span.childElementCount === 0 && span.textContent?.trim() === element.getAttribute('aria-label') && getComputedStyle(span).visibility !== 'hidden')
              ?? element.lastElementChild;
            const text = document.createRange();
            text.selectNodeContents(label);
            return icon && label && icon !== label ? text.getBoundingClientRect().left - icon.getBoundingClientRect().right : null;
          });
          if (gap !== null && !(scene === 'known' || scene === 'preview')) assert.ok(Math.abs(gap - 4) <= 0.5, `${scene}: icon/text gap must be 4px, got ${gap}.`);
        }
        assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), expected, scene);
        assert.equal(await page.locator('[data-sonner-toast]').count(), 0, `${scene}: success must stay on the action.`);
        await page.screenshot({ path: join(output, `${locale}-${width}-${scene}.png`) });
        checks++;
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
  console.log(`Workbench, terminal and SFTP copy feedback passed ${checks} scene/locale/width checks. Screenshots: ${output}`);
} finally { await browser?.close(); await server.close(); }
