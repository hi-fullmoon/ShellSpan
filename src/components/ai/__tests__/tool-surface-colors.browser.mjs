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
const capture = JSON.parse(await readFile(join(root, 'src/tests/fixtures/tool-result-read-recovery.json'), 'utf8'));
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(screenshots, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' },
  optimizeDeps: {
    entries: [
      'src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts',
      'src/components/ai/workspace/ai-tool-presentation.tsx',
      'src/lib/ai/conversation-projection.ts',
    ],
    include: ['react', 'react-dom/client'],
  },
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
    const { default: terminalCapture } = await import('/src/tests/fixtures/terminal-unknown-execution.json');
    const { initI18n } = await import('/src/locales/index.ts');
    await initI18n('zh-CN');
    const shared = { kind: 'tool', nativeName: null, state: 'succeeded', error: null, target: null };
    const failure = projectAgentChatNodes(capture.slice(0, 2))
      .flatMap(node => node.kind === 'turnProcess' ? node.children : []).find(node => node.kind === 'tool');
    if (!failure) throw new Error('Recorded tool failure is missing');
    const running = projectAgentChatNodes(terminalCapture.slice(0, -1))
      .flatMap(node => node.kind === 'turnProcess' ? node.children : []).find(node => node.kind === 'tool');
    if (running?.state !== 'running' || running.output !== null) throw new Error('Recorded running command is missing');
    createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
      React.createElement(AiToolRow, { onInspect: () => {}, node: { ...shared, name: 'exec_command', input: { command: commandText, cwd: '~' }, output: commandOutput } }),
      React.createElement(AiToolRow, { onInspect: () => {}, node: { ...shared, name: 'read_file', input: { path }, output: fileOutput } }),
      React.createElement(AiToolRow, { onInspect: () => {}, node: failure }),
      React.createElement(AiToolExpandedContent, { node: { ...shared, name: 'git', input: { command: commandText }, output: commandOutput } }),
      React.createElement(AiToolRow, { onInspect: () => {}, node: running }),
    ));
  }, { path, commandText, commandOutput, fileOutput, capture });
  await page.locator('.ai-tool-row').first().click();
  await page.locator('.ai-tool-row').nth(1).click();
  await page.locator('.ai-tool-row').nth(2).click();
  await page.locator('[data-ai-tool-view="read"]').waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    // The shared scroll viewport transitions its inherited color on theme changes.
    await page.waitForFunction(() => new Set(['.ai-terminal-header', '.ai-terminal-command', '.ai-terminal-output']
      .map(selector => getComputedStyle(document.querySelector(selector)).color)).size === 1);
    for (const width of [380, 529, 720]) {
      await page.setViewportSize({ width, height: 720 });
      const commandToggle = page.locator('.ai-terminal-command');
      const collapsed = await commandToggle.evaluate(element => ({
        height: element.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(element).lineHeight),
        clamp: getComputedStyle(element.firstElementChild).webkitLineClamp, whiteSpace: getComputedStyle(element).whiteSpace,
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
      const viewport = transcript.locator('[data-slot="scroll-area-viewport"]');
      const scrolling = await transcript.evaluate(element => {
        const style = getComputedStyle(element);
        return { height: element.getBoundingClientRect().height, maxHeight: style.maxHeight,
          clientHeight: element.firstElementChild.clientHeight, scrollHeight: element.firstElementChild.scrollHeight,
          overflow: getComputedStyle(element.firstElementChild).overflowY };
      });
      assert.equal(scrolling.maxHeight, '260px', 'Command content must have a fixed maximum height');
      assert.ok(scrolling.height <= 260 && scrolling.scrollHeight > scrolling.clientHeight, 'Long command output must scroll within the height limit');
      assert.equal(scrolling.overflow, 'scroll');
      assert.equal(await page.locator('.ai-terminal-block .ai-block-fold').count(), 0, 'Scrolling must expose all output without a hidden-line control');
      const headerBeforeScroll = await page.locator('.ai-terminal-header').boundingBox();
      await viewport.evaluate(element => element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }));
      assert.ok(await viewport.evaluate(element => element.scrollTop > 0), 'Output must scroll to the final lines');
      assert.deepEqual(await page.locator('.ai-terminal-header').boundingBox(), headerBeforeScroll, 'Shell title must stay fixed while output scrolls');
      await viewport.evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
      for (const selector of ['.ai-terminal-block', '.ai-read-block']) {
        const surface = page.locator(selector === '.ai-read-block' ? '[data-ai-tool-view="read"]' : selector);
        const body = surface.locator('..');
        assert.equal(await body.getByText('查看详情', { exact: true }).count(), 0,
          `${theme}/${width}/${selector}: visible results must not show a details action`);
        assert.equal((await body.boundingBox()).height, (await surface.boundingBox()).height + 8,
          `${theme}/${width}/${selector}: the result should only retain the card's vertical margins`);
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
        const headerRow = surface.locator('.ai-tool-surface-header').first();
        const copyRegion = copy.locator('..');
        const title = headerRow.locator('.ai-content-title').first();
        const titleGeometry = () => title.evaluate(element => {
          const box = element.getBoundingClientRect();
          const parent = element.parentElement.getBoundingClientRect();
          return { x: box.x - parent.x, y: box.y - parent.y, width: box.width, height: box.height };
        });
        const idleTitle = await titleGeometry();
        const idleHeader = await headerRow.boundingBox();
        await surface.screenshot({ path: join(screenshots, `${theme}-${width}-${selector.slice(1)}-idle.png`) });
        await copyRegion.hover();
        assert.equal(await copy.evaluate(element => getComputedStyle(element).opacity), '1');
        const header = await headerRow.boundingBox();
        const button = await copy.boundingBox();
        const hoverTitle = await title.boundingBox();
        assert.deepEqual(await titleGeometry(), idleTitle, 'Heading geometry must remain stable on hover');
        assert.equal(header.height, idleHeader.height, 'Hover must not change header height');
        assert.ok(button.x + button.width <= header.x + header.width && button.y >= header.y);
        if (selector === '.ai-terminal-block') {
          assert.ok(button.y >= header.y + header.height, 'Command copy must be inside the command content');
        } else {
          assert.ok(hoverTitle.x + hoverTitle.width <= button.x, 'Path copy must not overlap the path');
        }
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
          await copyRegion.hover();
          assert.deepEqual(await titleGeometry(), collapsedTitle);
          assert.equal((await surface.boundingBox()).height, collapsedSurface.height);
          const collapsedHeader = await headerRow.boundingBox();
          const collapsedButton = await copy.boundingBox();
          assert.ok(collapsedButton.y >= collapsedHeader.y + collapsedHeader.height,
            'Command copy button must remain in the command content');
          await surface.screenshot({ path: join(screenshots, `${theme}-${width}-ai-terminal-block-collapsed.png`) });
          const outputCopy = surface.getByRole('button', { name: '复制输出', exact: true });
          await outputCopy.focus();
          await outputCopy.press('Enter');
          await page.waitForFunction(() => document.querySelector('button[aria-label="已复制"]'));
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), commandOutput);
          await page.waitForFunction(() => !document.querySelector('button[aria-label="已复制"]'));
        }
      }
      const error = page.locator('[data-ai-tool-view="error"]');
      const errorDetails = error.locator('..').getByText('查看详情', { exact: true });
      assert.equal(await errorDetails.isVisible(), true, `${theme}/${width}: error-only cards must retain the details action`);
      assert.equal((await errorDetails.boundingBox()).x, (await error.boundingBox()).x,
        `${theme}/${width}: the error details action must align with the card`);
      const geometry = await page.locator('.ai-tool-surface-header').evaluateAll(headers => headers.map(header => {
        const box = header.getBoundingClientRect();
        const label = header.firstElementChild.getBoundingClientRect();
        const style = getComputedStyle(header);
        return { height: box.height, labelHeight: label.height, minHeight: parseFloat(style.minHeight),
          font: style.font, color: style.color, labelRight: label.right,
          right: box.right };
      }));
      assert.equal(geometry.length, 4, 'Measure the Shell, file, input and output headings');
      for (const heading of geometry) {
        assert.equal(heading.minHeight, geometry[0].minHeight, 'Tool headings must share a minimum height');
        assert.equal(heading.height, Math.max(heading.minHeight, heading.labelHeight), 'Headings must fit wrapped labels');
        assert.equal(heading.font, geometry[0].font, 'Heading typography must match');
        assert.equal(heading.color, geometry[0].color, 'Heading colors must match');
        assert.ok(heading.labelRight <= heading.right && heading.right <= width,
          'Headings must remain inside their surfaces');
      }
      for (const selector of ['[data-ai-tool-view="error"]', '[data-ai-tool-view="generic"]']) {
        await page.locator(selector).screenshot({ path: join(screenshots, `${theme}-${width}-${selector.includes('error') ? 'error' : 'generic'}.png`) });
      }
      await page.screenshot({ path: join(screenshots, `${theme}-${width}.png`) });
    }
  }
  const runningRow = page.locator('[data-tool-state="running"][data-tool-variant="terminal"]');
  await runningRow.locator('.ai-tool-row').press('Enter');
  for (const width of [380, 720]) {
    await page.setViewportSize({ width, height: 720 });
    const shell = runningRow.locator('.ai-terminal-block');
    assert.ok(await shell.locator('.ai-terminal-command').isVisible(), `${width}: running command must be visible`);
    assert.equal(await runningRow.getByText('查看详情', { exact: true }).count(), 0, `${width}: running command must not show a details action`);
    assert.equal((await shell.locator('..').boundingBox()).height, (await shell.boundingBox()).height + 8,
      `${width}: the running command should only retain the card's vertical margins`);
  }
  console.log(`Tool surface colors and hover geometry passed in light/dark themes at 380px, 529px and 720px. Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await server.close();
}
