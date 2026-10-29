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
const capture = JSON.parse(await readFile(join(root, 'src/test/fixtures/tool-result-read-recovery.json'), 'utf8'));
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(screenshots, 'vite-cache'),
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
  await page.evaluate(async ({ path, commandText, commandOutput, fileOutput, capture }) => {
    const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
    await import('/src/styles/base.css');
    await import('/src/components/ai/styles/styles.css');
    const { AiToolRow, AiToolExpandedContent } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
    const { projectAgentChatNodes } = await import('/src/lib/ai/conversation-projection.ts');
    const { initI18n } = await import('/src/locales/index.ts');
    await initI18n('zh-CN');
    const shared = { kind: 'tool', nativeName: null, state: 'succeeded', error: null, target: null };
    const failure = projectAgentChatNodes(capture.slice(0, 2))
      .flatMap(node => node.kind === 'turnProcess' ? node.children : []).find(node => node.kind === 'tool');
    if (!failure) throw new Error('Recorded tool failure is missing');
    createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
      React.createElement(AiToolRow, { onInspect: () => {}, node: { ...shared, name: 'exec_command', input: { command: commandText, cwd: '~' }, output: commandOutput } }),
      React.createElement(AiToolRow, { onInspect: () => {}, node: { ...shared, name: 'read_file', input: { path }, output: fileOutput } }),
      React.createElement(AiToolExpandedContent, { node: failure }),
      React.createElement(AiToolExpandedContent, { node: { ...shared, name: 'git', input: { command: commandText }, output: commandOutput } }),
    ));
  }, { path, commandText, commandOutput, fileOutput, capture });
  await page.locator('.ai-tool-row').first().click();
  await page.locator('.ai-tool-row').nth(1).click();
  await page.locator('[data-ai-tool-view="read"]').waitFor();
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
        const surface = page.locator(selector === '.ai-read-block' ? '[data-ai-tool-view="read"]' : selector);
        const details = surface.locator('..').locator('.ai-tool-inspect');
        assert.equal((await details.boundingBox()).x, (await surface.boundingBox()).x,
          `${theme}/${width}: details action must align with the card's left edge`);
        const copy = surface.getByRole('button', { name: selector === '.ai-terminal-block' ? '复制命令' : '复制输入', exact: true });
        assert.equal(await copy.count(), 1);
        const command = surface.locator('.ai-terminal-command');
        if (await command.count() && await command.getAttribute('aria-expanded') !== 'true') {
          await command.click();
        }
        await page.evaluate(() => {
          document.activeElement?.blur();
          window.scrollTo({ top: 0, behavior: 'instant' });
        });
        await page.mouse.move(0, 0);
        assert.equal(await copy.evaluate(element => getComputedStyle(element).opacity), '0',
          `${theme}/${width}/${selector}: ${JSON.stringify(await copy.evaluate(element => ({
            focused: element.matches(':focus-visible'), cardHovered: element.closest('[data-ai-tool-view]').matches(':hover'),
            regionHovered: element.parentElement.matches(':hover'), pointer: [...document.querySelectorAll(':hover')].map(item => item.className),
          })))}`);
        const headerRow = copy.locator('..');
        const title = headerRow.locator(':scope > span').first();
        const titleGeometry = () => title.evaluate(element => {
          const box = element.getBoundingClientRect();
          const parent = element.parentElement.getBoundingClientRect();
          return { x: box.x - parent.x, y: box.y - parent.y, width: box.width, height: box.height };
        });
        const idleTitle = await titleGeometry();
        const idleHeader = await headerRow.boundingBox();
        await surface.screenshot({ path: join(screenshots, `${theme}-${width}-${selector.slice(1)}-idle.png`) });
        await headerRow.hover();
        assert.equal(await copy.evaluate(element => getComputedStyle(element).opacity), '1');
        const header = await headerRow.boundingBox();
        const button = await copy.boundingBox();
        const hoverTitle = await title.boundingBox();
        assert.deepEqual(await titleGeometry(), idleTitle, 'Heading geometry must remain stable on hover');
        assert.equal(header.height, idleHeader.height, 'Hover must not change header height');
        assert.ok(hoverTitle.x + hoverTitle.width <= button.x, 'Copy must not overlap title');
        assert.ok(button.x + button.width <= header.x + header.width && button.y >= header.y);
        assert.ok(Math.abs(button.y + button.height / 2 - hoverTitle.y - hoverTitle.height / 2) <= 1,
          'Heading and copy button must share the same vertical center');
        assert.ok(Math.abs(hoverTitle.y + hoverTitle.height / 2 - header.y - header.height / 2) <= 1,
          'Heading must be vertically centered');
        await surface.screenshot({ path: join(screenshots, `${theme}-${width}-${selector.slice(1)}-hover.png`) });
        await page.mouse.move(0, 0);
        await page.keyboard.press('Tab');
        await copy.focus();
        assert.equal(await copy.evaluate(element => getComputedStyle(element).opacity), '1');
        if (selector === '.ai-terminal-block') {
          assert.deepEqual(await titleGeometry(), idleTitle, 'Keyboard focus must not reflow the heading');
          assert.equal((await headerRow.boundingBox()).height, idleHeader.height);
        }
        await copy.press('Enter');
        await page.waitForFunction(() => document.querySelector('button[aria-label="已复制"]'));
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), selector === '.ai-terminal-block' ? commandText : path);
        await page.waitForFunction(() => !document.querySelector('button[aria-label="已复制"]'));
        if (selector === '.ai-terminal-block') {
          await command.click();
          await page.mouse.move(0, 0);
          await command.blur();
          const collapsedTitle = await titleGeometry();
          const collapsedSurface = await surface.boundingBox();
          assert.ok((await command.boundingBox()).width > width / 2, 'Collapsed command must retain the transcript width');
          await headerRow.hover();
          assert.deepEqual(await titleGeometry(), collapsedTitle);
          assert.equal((await surface.boundingBox()).height, collapsedSurface.height);
          const collapsedHeader = await headerRow.boundingBox();
          const collapsedButton = await copy.boundingBox();
          assert.ok(Math.abs(collapsedButton.y + collapsedButton.height / 2 - collapsedHeader.y - collapsedHeader.height / 2) <= 1,
            'Command copy button must remain centered in the Shell heading');
          await surface.screenshot({ path: join(screenshots, `${theme}-${width}-ai-terminal-block-collapsed.png`) });
          const outputCopy = surface.getByRole('button', { name: '复制输出', exact: true });
          await outputCopy.focus();
          await outputCopy.press('Enter');
          await page.waitForFunction(() => document.querySelector('button[aria-label="已复制"]'));
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), commandOutput);
          await page.waitForFunction(() => !document.querySelector('button[aria-label="已复制"]'));
        }
      }
      const geometry = await page.locator('.ai-tool-surface-header').evaluateAll(headers => headers.map(header => {
        const box = header.getBoundingClientRect();
        const button = header.querySelector('.ai-tool-copy-button');
        const copy = button.getBoundingClientRect();
        const label = header.firstElementChild.getBoundingClientRect();
        const style = getComputedStyle(header);
        return { height: box.height, rightInset: box.right - copy.right, size: [copy.width, copy.height],
          centerOffset: (copy.top + copy.bottom - box.top - box.bottom) / 2,
          font: style.font, color: style.color, labelRight: label.right, copyLeft: copy.left,
          right: box.right };
      }));
      assert.ok(geometry.length >= 6, 'Shell, file, error and input/output headings must all be measured');
      for (const heading of geometry) {
        assert.equal(heading.height, geometry[0].height, 'All tool headings must have equal heights');
        assert.equal(heading.rightInset, geometry[0].rightInset, 'Copy actions must share the same right inset');
        assert.equal(heading.font, geometry[0].font, 'Heading typography must match');
        assert.equal(heading.color, geometry[0].color, 'Heading colors must match');
        assert.deepEqual(heading.size, [24, 24], 'Copy actions must use the shared icon button size');
        assert.ok(Math.abs(heading.centerOffset) < 1 && heading.labelRight <= heading.copyLeft && heading.right <= width,
          'Copy actions must align with headings without clipping or overlapping text');
      }
      for (const selector of ['[data-ai-tool-view="error"]', '[data-ai-tool-view="generic"]']) {
        await page.locator(selector).screenshot({ path: join(screenshots, `${theme}-${width}-${selector.includes('error') ? 'error' : 'generic'}.png`) });
      }
      await page.screenshot({ path: join(screenshots, `${theme}-${width}.png`) });
    }
  }
  console.log(`Tool surface colors and hover geometry passed in light/dark themes at 380px, 529px and 720px. Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await server.close();
}
