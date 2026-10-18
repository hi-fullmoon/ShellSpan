import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto('http://localhost:1420');
  for (const kind of ['file', 'blank']) {
    await page.evaluate(async kind => {
      const { default: React } = await import('/node_modules/.vite/deps/react.js');
      const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { SftpFileContextMenu } = await import('/src/components/sftp/sftp-file-context-menu.tsx');
      const { SftpBlankContextMenu } = await import('/src/components/sftp/sftp-blank-context-menu.tsx');
      const host = document.createElement('div');
      document.body.append(host);
      window.sftpAlignmentRoot?.unmount();
      window.sftpAlignmentRoot = ReactDOM.createRoot(host);
      window.sftpAlignmentRoot.render(React.createElement(kind === 'file' ? SftpFileContextMenu : SftpBlankContextMenu, {
        open: true, x: 16, y: 16, side: 'local', selectedEntries: [],
        hasClipboard: false, isBookmarked: false, batchMode: false,
        onClose: () => {}, onAction: () => {},
      }));
    }, kind);
    await page.getByRole('menu').waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('[role="menuitem"]')].every(item => item.textContent.trim()));
    await page.evaluate(() => document.fonts.ready);
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 900 });
      const rows = await page.getByRole('menuitem').evaluateAll(items => items.map(item => {
        const icon = item.querySelector('svg').getBoundingClientRect();
        const label = item.lastElementChild.getBoundingClientRect();
        return { gap: label.left - icon.right, offset: label.y + label.height / 2 - icon.y - icon.height / 2 };
      }));
      assert.ok(rows.length > 0);
      for (const row of rows) {
        assert.equal(row.gap, 4);
        assert.equal(row.offset, 1);
      }
      await page.screenshot({ path: `/tmp/shellspan-sftp-${kind}-menu-${width}.png` });
      await page.getByRole('menu').screenshot({ path: `/tmp/shellspan-sftp-${kind}-menu-detail-${width}.png` });
    }
  }
} finally {
  await browser.close();
}
