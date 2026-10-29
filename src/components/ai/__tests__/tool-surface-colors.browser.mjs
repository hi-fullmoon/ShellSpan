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
const presentationRevision = execFileSync('git', ['log', '-1', '--format=%H', '--', 'src/components/ai/workspace/ai-tool-presentation.tsx'], { cwd: root, encoding: 'utf8' }).trim();
const commandArgs = ['show', '--format=', '--unified=20', presentationRevision, '--', 'src/components/ai/workspace/ai-tool-presentation.tsx', 'src/components/ai/styles/tool-results.css', 'src/components/ai/__tests__/ai-tool-presentation.test.tsx', 'src/components/ai/__tests__/ai-details-layout.test.tsx'];
const commandText = `git ${commandArgs.join(' ')}`;
const commandOutput = execFileSync('git', commandArgs, { cwd: root, encoding: 'utf8' });
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
  browser = await chromium.launch({ channel: 'chromium' });
  const page = await browser.newPage({ permissions: ['clipboard-read', 'clipboard-write'] });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.evaluate(async ({ path, commandText, commandOutput, fileOutput }) => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    await import('/src/styles/base.css');
    await import('/src/components/ai/styles/styles.css');
    const { AiToolRow } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
    const { initI18n } = await import('/src/locales/index.ts');
    await initI18n('zh-CN');
    const shared = { kind: 'tool', nativeName: null, state: 'succeeded', error: null, target: null };
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
      React.createElement(AiToolRow, { onInspect: () => {}, node: { ...shared, name: 'exec_command', input: { command: commandText, cwd: '~' }, output: commandOutput } }),
      React.createElement(AiToolRow, { onInspect: () => {}, node: { ...shared, name: 'read_file', input: { path }, output: fileOutput } }),
    ));
  }, { path, commandText, commandOutput, fileOutput });
  await page.locator('.ai-tool-row').first().click();
  await page.locator('.ai-tool-row').nth(1).click();
  await page.locator('.ai-read-block').waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [380, 529, 720]) {
      await page.setViewportSize({ width, height: 720 });
      const commandToggle = page.locator('.ai-terminal-command');
      const collapsed = await commandToggle.evaluate(element => ({
        height: element.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(element).lineHeight),
        clamp: getComputedStyle(element).webkitLineClamp, whiteSpace: getComputedStyle(element).whiteSpace,
      }));
      assert.equal(collapsed.clamp, '2', 'Command input must default to two visual lines');
      assert.equal(collapsed.whiteSpace, 'pre-wrap', 'Command input must preserve explicit line breaks');
      assert.ok(Math.abs(collapsed.height - collapsed.lineHeight * 2) <= 1, 'Long command input must occupy exactly two lines before expansion');
      await commandToggle.click();
      assert.equal(await commandToggle.getAttribute('aria-expanded'), 'true');
      assert.ok((await commandToggle.boundingBox()).height > collapsed.height, 'One click must reveal every wrapped command line');
      const styles = await page.evaluate(() => {
        const get = selector => getComputedStyle(document.querySelector(selector));
        const surface = selector => {
          const style = get(selector);
          return [style.backgroundColor, style.borderRadius];
        };
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        context.fillStyle = get('.ai-terminal-block').backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return {
          terminal: surface('.ai-terminal-block'), read: surface('.ai-read-block'),
          terminalChannels: [...context.getImageData(0, 0, 1, 1).data].slice(0, 3),
          text: ['.ai-terminal-header', '.ai-terminal-command', '.ai-terminal-output'].map(selector => get(selector).color),
          divider: get('.ai-terminal-header').borderBottomWidth,
          font: get('.ai-terminal-output').fontFamily,
          headerFont: get('.ai-terminal-header').fontFamily,
        };
      });
      assert.equal(styles.terminal[1], styles.read[1], `${theme}/${width}: card corners`);
      assert.equal(styles.terminal[0], styles.read[0], 'Shell and file results must share the neutral background');
      assert.ok(Math.max(...styles.terminalChannels) - Math.min(...styles.terminalChannels) <= 2,
        `${theme}/${width}: Shell background must stay neutral gray`);
      assert.equal(new Set(styles.text).size, 1, `${theme}/${width}: shell text colors`);
      assert.equal(styles.divider, '0px', 'Shell title and transcript must share one uninterrupted surface');
      assert.notEqual(styles.font, styles.headerFont, 'Shell transcript must use the code font');
      const layout = await page.locator('.ai-terminal-block').evaluate(element => {
        const rect = selector => element.querySelector(selector).getBoundingClientRect();
        return { header: rect('.ai-terminal-header').bottom, command: rect('.ai-terminal-command').top,
          output: rect('[data-ai-terminal-output]').top, right: element.getBoundingClientRect().right,
          clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
      });
      assert.ok(layout.header <= layout.command && layout.command < layout.output, 'Shell, command and output must stack vertically');
      assert.ok(layout.right <= width && layout.scrollWidth <= layout.clientWidth, 'Shell must fit narrow panels');
      const transcript = page.locator('.ai-terminal-transcript');
      const scrolling = await transcript.evaluate(element => {
        const style = getComputedStyle(element);
        return { height: element.getBoundingClientRect().height, maxHeight: style.maxHeight,
          clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
          overflow: style.overflowY };
      });
      assert.equal(scrolling.maxHeight, '260px', 'Command content must have a fixed maximum height');
      assert.ok(scrolling.height <= 260 && scrolling.scrollHeight > scrolling.clientHeight, 'Long command output must scroll within the height limit');
      assert.equal(scrolling.overflow, 'auto');
      assert.equal(await page.locator('.ai-terminal-block .ai-block-fold').count(), 0, 'Scrolling must expose all output without a hidden-line control');
      const headerBeforeScroll = await page.locator('.ai-terminal-header').boundingBox();
      await transcript.evaluate(element => element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }));
      assert.ok(await transcript.evaluate(element => element.scrollTop > 0), 'Output must scroll to the final lines');
      assert.deepEqual(await page.locator('.ai-terminal-header').boundingBox(), headerBeforeScroll, 'Shell title must stay fixed while output scrolls');
      await transcript.evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
      for (const selector of ['.ai-terminal-block', '.ai-read-block']) {
        const surface = page.locator(selector);
        const details = surface.locator('..').locator('.ai-tool-inspect');
        assert.equal((await details.boundingBox()).x, (await surface.boundingBox()).x,
          `${theme}/${width}: details action must align with the card's left edge`);
        const copy = surface.getByRole('button', { name: selector === '.ai-terminal-block' ? '复制命令' : '复制输出', exact: true });
        assert.equal(await copy.count(), 1);
        const command = surface.locator('.ai-terminal-command');
        if (await command.count() && await command.getAttribute('aria-expanded') !== 'true') {
          await command.click();
        }
        await page.mouse.move(width - 1, 719);
        await page.evaluate(() => document.activeElement?.blur());
        assert.equal(await copy.evaluate(element => getComputedStyle(element).opacity), '0');
        const title = surface.locator('.ai-terminal-command, .ai-block-banner > span');
        const idleTitle = await title.boundingBox();
        const idleHeader = await surface.locator('.ai-terminal-command-row, .ai-block-banner').boundingBox();
        if (selector === '.ai-read-block') assert.ok(idleHeader.x + idleHeader.width - idleTitle.x - idleTitle.width <= 5,
          `${theme}/${width}: hidden copy must not reserve read title space`);
        await surface.screenshot({ path: join(screenshots, `${theme}-${width}-${selector.slice(1)}-idle.png`) });
        await surface.hover();
        assert.equal(await copy.evaluate(element => getComputedStyle(element).opacity), '1');
        const header = await surface.locator('.ai-terminal-command-row, .ai-block-banner').boundingBox();
        const button = await copy.boundingBox();
        const hoverTitle = await title.boundingBox();
        if (selector === '.ai-read-block') assert.ok(idleTitle.width - hoverTitle.width >= button.width,
          `${theme}/${width}: title reclaims hidden button width`);
        else assert.deepEqual(hoverTitle, idleTitle, 'Expanded command geometry must remain stable on hover');
        assert.equal(header.height, idleHeader.height, 'Hover must not change header height');
        if (selector === '.ai-read-block') assert.ok(hoverTitle.x + hoverTitle.width <= button.x, 'Copy must not overlap title');
        assert.ok(button.x + button.width <= header.x + header.width && button.y >= header.y);
        if (selector === '.ai-terminal-block') {
          assert.ok(Math.abs(button.y - header.y) <= 1,
            'Command copy icon must align with the first command line');
        } else {
          assert.ok(Math.abs(button.y + button.height / 2 - hoverTitle.y - hoverTitle.height / 2) <= 1,
            'Read path and copy button must share the same vertical center');
          assert.ok(Math.abs(hoverTitle.y + hoverTitle.height / 2 - header.y - header.height / 2) <= 1,
            'Read path must be vertically centered in its header');
        }
        await surface.screenshot({ path: join(screenshots, `${theme}-${width}-${selector.slice(1)}-hover.png`) });
        await page.mouse.move(width - 1, 719);
        await page.keyboard.press('Tab');
        await copy.focus();
        assert.equal(await copy.evaluate(element => getComputedStyle(element).opacity), '1');
        if (selector === '.ai-terminal-block') {
          assert.deepEqual(await title.boundingBox(), idleTitle, 'Keyboard focus must not reflow the command');
          assert.deepEqual(await surface.locator('.ai-terminal-command-row').boundingBox(), idleHeader);
        }
        await copy.press('Enter');
        await page.waitForFunction(() => document.querySelector('button[aria-label="已复制"]'));
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), selector === '.ai-terminal-block' ? commandText : fileOutput);
        await page.waitForFunction(() => !document.querySelector('button[aria-label="已复制"]'));
        if (selector === '.ai-terminal-block') {
          await command.click();
          await page.mouse.move(width - 1, 719);
          await command.blur();
          const collapsedTitle = await title.boundingBox();
          const collapsedSurface = await surface.boundingBox();
          assert.ok(collapsedTitle.width > width / 2, 'Collapsed command must retain the transcript width');
          await surface.hover();
          assert.deepEqual(await title.boundingBox(), collapsedTitle);
          assert.deepEqual(await surface.boundingBox(), collapsedSurface);
          const collapsedHeader = await surface.locator('.ai-terminal-command-row').boundingBox();
          const collapsedButton = await copy.boundingBox();
          assert.ok(Math.abs(collapsedButton.y - collapsedHeader.y) <= 1,
            'Copy button must align with the first line of collapsed command input');
          await surface.screenshot({ path: join(screenshots, `${theme}-${width}-ai-terminal-block-collapsed.png`) });
          const outputCopy = surface.getByRole('button', { name: '复制输出', exact: true });
          await outputCopy.focus();
          await outputCopy.press('Enter');
          await page.waitForFunction(() => document.querySelector('button[aria-label="已复制"]'));
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), commandOutput);
          await page.waitForFunction(() => !document.querySelector('button[aria-label="已复制"]'));
        }
      }
      await page.screenshot({ path: join(screenshots, `${theme}-${width}.png`) });
    }
  }
  console.log(`Tool surface colors and hover geometry passed in light/dark themes at 380px, 529px and 720px. Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await server.close();
}
