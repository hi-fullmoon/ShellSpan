import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const screenshots = join(tmpdir(), 'shellspan-tool-surface-colors');
await mkdir(screenshots, { recursive: true });
const path = join(root, 'package.json');
const commandOutput = execFileSync('cat', [path], { encoding: 'utf8' });
const fileOutput = await readFile(path, 'utf8');
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'tool-surface-colors',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><main id="root" class="ai-panel-shell"></main></body></html>');
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage({ permissions: ['clipboard-read', 'clipboard-write'] });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.evaluate(async ({ path, commandOutput, fileOutput }) => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    await import('/src/styles/base.css');
    await import('/src/components/ai/styles/styles.css');
    const { AiToolExpandedContent } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
    const { initI18n } = await import('/src/locales/index.ts');
    await initI18n('zh-CN');
    const shared = { kind: 'tool', nativeName: null, state: 'succeeded', error: null, target: null };
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
      React.createElement(AiToolExpandedContent, { compact: true, node: { ...shared, name: 'exec_command', input: { command: `cat ${path}`, cwd: '~' }, output: commandOutput } }),
      React.createElement(AiToolExpandedContent, { compact: true, node: { ...shared, name: 'read_file', input: { path }, output: fileOutput } }),
    ));
  }, { path, commandOutput, fileOutput });
  await page.locator('.ai-read-block').waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [380, 720]) {
      await page.setViewportSize({ width, height: 720 });
      const styles = await page.evaluate(() => {
        const get = selector => getComputedStyle(document.querySelector(selector));
        const surface = selector => {
          const style = get(selector);
          return [style.backgroundColor, style.borderColor, style.borderRadius];
        };
        return {
          terminal: surface('.ai-terminal-block'), read: surface('.ai-read-block'),
          headers: ['.ai-terminal-cwd', '.ai-terminal-command', '.ai-read-block .ai-block-banner'].map(selector => get(selector).color),
          body: ['.ai-terminal-output', '.ai-read-lines'].map(selector => get(selector).color),
          dividers: ['.ai-terminal-header', '.ai-read-block .ai-block-banner'].map(selector => get(selector).borderBottomColor),
        };
      });
      assert.deepEqual(styles.terminal, styles.read, `${theme}/${width}: card surfaces`);
      assert.equal(new Set(styles.headers).size, 1, `${theme}/${width}: header colors`);
      assert.equal(new Set(styles.body).size, 1, `${theme}/${width}: output colors`);
      assert.equal(new Set(styles.dividers).size, 1, `${theme}/${width}: divider colors`);
      for (const selector of ['.ai-terminal-block', '.ai-read-block']) {
        const surface = page.locator(selector);
        const copy = surface.locator('.ai-tool-copy-button');
        assert.equal(await copy.count(), 1);
        await page.mouse.move(width - 1, 719);
        await page.evaluate(() => document.activeElement?.blur());
        assert.equal(await copy.evaluate(element => getComputedStyle(element).opacity), '0');
        const title = surface.locator('.ai-terminal-command, .ai-block-banner > span');
        const idleTitle = await title.boundingBox();
        const idleHeader = await surface.locator('.ai-terminal-header, .ai-block-banner').boundingBox();
        assert.ok(idleHeader.x + idleHeader.width - idleTitle.x - idleTitle.width <= 5,
          `${theme}/${width}: hidden copy must not reserve title space`);
        await surface.screenshot({ path: join(screenshots, `${theme}-${width}-${selector.slice(1)}-idle.png`) });
        await surface.hover();
        assert.equal(await copy.evaluate(element => getComputedStyle(element).opacity), '1');
        const header = await surface.locator('.ai-terminal-header, .ai-block-banner').boundingBox();
        const button = await copy.boundingBox();
        const hoverTitle = await title.boundingBox();
        assert.ok(idleTitle.width - hoverTitle.width >= button.width,
          `${theme}/${width}: title reclaims hidden button width`);
        assert.equal(header.height, idleHeader.height, 'Hover must not change header height');
        assert.ok(hoverTitle.x + hoverTitle.width <= button.x, 'Copy must not overlap title');
        assert.ok(button.x + button.width <= header.x + header.width && button.y >= header.y);
        await page.mouse.move(width - 1, 719);
        await copy.focus();
        assert.equal(await copy.evaluate(element => getComputedStyle(element).opacity), '1');
        await copy.press('Enter');
        await page.waitForFunction(() => document.querySelector('button[aria-label="已复制"]'));
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), fileOutput);
        await page.waitForFunction(() => !document.querySelector('button[aria-label="已复制"]'));
      }
      await page.screenshot({ path: join(screenshots, `${theme}-${width}.png`) });
    }
  }
  console.log(`Tool surface colors passed in light/dark themes at 380px and 720px. Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await server.close();
}
