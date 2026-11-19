import assert from 'node:assert/strict';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createCanvas, loadImage } from 'canvas';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const artifacts = join(root, 'artifacts/tests/sftp-row-hover');
await mkdir(artifacts, { recursive: true });
// Read real repository entries; the browser renders the production list and selection logic.
const entries = await Promise.all(['src', 'AGENTS.md', 'package.json'].map(async name => {
  const path = join(root, name);
  const metadata = await stat(path);
  return {
    path, name, kind: metadata.isDirectory() ? 'directory' : 'file',
    size: metadata.size, modifiedAt: Math.floor(metadata.mtimeMs / 1000),
  };
}));
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(artifacts, 'vite-cache'),
  resolve: { alias: { '@': join(root, 'src') } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { entries: ['src/components/sftp/__tests__/sftp-row-hover.browser.tsx'], include: ['react', 'react-dom/client'] },
  plugins: [tailwindcss()], server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__sftp_row_hover', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body><main id="root" style="height:320px;background:var(--app-surface)"></main></body></html>');
});
const colors = row => row.locator('[data-sftp-file-cell]').evaluateAll(async cells => {
  const styles = cells.map(cell => getComputedStyle(cell));
  styles.forEach(style => { void style.backgroundColor; });
  await Promise.all(cells.flatMap(cell => cell.getAnimations().map(animation => animation.finished)));
  return styles.map(style => style.backgroundColor);
});
const assertSelectedBorders = async (page, rows, context) => {
  const screenshot = await loadImage(await page.screenshot({ path: join(artifacts, 'selected-borders.png') }));
  const canvas = createCanvas(screenshot.width, screenshot.height);
  const pixels = canvas.getContext('2d');
  pixels.drawImage(screenshot, 0, 0);
  for (const row of rows) {
    const bounds = await row.boundingBox();
    assert.ok(bounds, `${context}: selected row is visible`);
    const x = Math.round(bounds.x + 250);
    const top = Array.from(pixels.getImageData(x, Math.round(bounds.y - 1), 1, 1).data);
    const bottom = Array.from(pixels.getImageData(x, Math.round(bounds.y + bounds.height - 1), 1, 1).data);
    // Opaque color-mix and background alpha compositing can round one channel
    // differently in the rasterizer; a full extra divider is much darker.
    assert.ok(top.every((channel, index) => Math.abs(channel - bottom[index]) <= 1),
      `${context}: selected dividers differ: top=${top}, bottom=${bottom}`);
  }
};
const waitForColor = async (row, alpha) => {
  await row.locator('[data-sftp-file-cell]').first().evaluate((cell, alpha) => new Promise((resolve, reject) => {
    const deadline = performance.now() + 3000;
    const check = () => {
      const color = getComputedStyle(cell).backgroundColor;
      if (color.endsWith(`/ ${alpha})`)) resolve();
      else if (performance.now() > deadline) reject(new Error(`Unexpected row color: ${color}`));
      else requestAnimationFrame(check);
    };
    check();
  }), alpha);
};

function tabKey(engineName) {
  // macOS WebKit uses Option+Tab to include buttons in keyboard traversal by default.
  return engineName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
}

async function assertFocusOutline(target, theme, description) {
  const expectedColor = theme === 'dark' ? 'rgb(179, 179, 184)' : 'rgb(40, 40, 40)';
  const outline = await target.evaluate(async (element) => {
    getComputedStyle(element).outlineWidth;
    await Promise.allSettled(element.getAnimations().map(animation => animation.finished));
    const { outlineStyle, outlineWidth, outlineOffset, outlineColor } = getComputedStyle(element);
    return [outlineStyle, outlineWidth, outlineOffset, outlineColor];
  });
  assert.deepEqual(outline, ['solid', '1px', '-1px', expectedColor], description);
}

async function assertTabFocusColors(page, engineName, locale, width) {
  await page.setViewportSize({ width, height: 480 });
  const navigation = page.getByRole('navigation').getByRole('button');
  const headerViewport = page.getByTestId('sftp-file-list-header-viewport');
  const headers = headerViewport.getByRole('button');
  const list = page.getByRole('listbox');
  const focusableButtons = [...await navigation.all(), ...await headers.all()];
  const tab = tabKey(engineName);

  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await list.evaluate(element => { element.scrollLeft = 0; });
    await focusableButtons[1].focus();
    await page.keyboard.press(`Shift+${tab}`);
    for (const button of focusableButtons) {
      assert.ok(await button.evaluate(element => element.matches(':focus-visible')), 'Tab visits each navigation and sort button');
      await assertFocusOutline(button, theme, `${theme}: ${await button.innerText()} uses the shared thin outline`);
      await page.keyboard.press(tab);
    }
    assert.ok(await list.evaluate(element => element === document.activeElement), 'The scroll viewport is the next keyboard stop');
    await assertFocusOutline(list, theme, 'The file list uses the shared thin outline');
    const headerOffset = await headerViewport.evaluate(element => element.scrollLeft);
    if (width === 380) assert.ok(headerOffset > 0, 'Tab brings offscreen sort columns into view');
    await page.waitForFunction(offset => document.querySelector('[role="listbox"]').scrollLeft === offset, headerOffset);
    await page.screenshot({ path: join(artifacts, `${engineName}-${locale}-${theme}-${width}-keyboard-focus.png`) });
    await page.keyboard.press(tab);
    assert.ok(await list.getByRole('checkbox').first().evaluate(element => element === document.activeElement),
      'Tab advances directly from the scroll viewport to the first actionable checkbox');
  }
}

async function assertFileListFocus(page, row, selected, locale) {
  await page.setViewportSize({ width: 960, height: 480 });
  const nav = page.getByRole('navigation');
  const list = page.getByRole('listbox');
  const terminalTab = nav.getByRole('button', { name: locale === 'en-US' ? 'Terminal' : '终端' });
  const sftpTab = nav.getByRole('button', { name: 'SFTP' });
  const dragHandle = row.getByRole('button');
  const lastColumn = page.getByTestId('sftp-file-list-header-viewport').getByRole('button').last();

  await lastColumn.focus();
  await page.keyboard.press('Tab');
  assert.ok(await list.evaluate(element => element === document.activeElement), 'Tab focuses the file list');
  assert.equal(await dragHandle.evaluate(element => element.tabIndex), -1, 'Pointer-only draggable rows are skipped by Tab');

  await page.keyboard.press('ArrowDown');
  assert.equal(await list.getAttribute('aria-activedescendant'), await page.getByRole('option').first().getAttribute('id'), 'Keyboard navigation announces the parent row');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert.equal(await list.getAttribute('aria-activedescendant'), await selected.getAttribute('id'), 'Keyboard navigation announces the focused file');
  assert.notEqual(await selected.evaluate(element => getComputedStyle(element).boxShadow), 'none', 'Arrow navigation highlights the focused row');

  await terminalTab.click();
  await list.waitFor({ state: 'hidden' });
  await sftpTab.click();
  await list.waitFor();
  assert.equal(await list.getAttribute('aria-activedescendant'), null, 'Changing sections clears the active option');
  assert.equal(await selected.evaluate(element => getComputedStyle(element).boxShadow), 'none', 'Returning to SFTP leaves no stale row focus ring');
  assert.equal(await selected.getAttribute('aria-selected'), 'true', 'Switching sections preserves selection');
  await assertSelectedBorders(page, [selected, row], 'After switching sections');

  await row.click({ position: { x: 80, y: 16 } });
  assert.ok(await list.evaluate(element => element === document.activeElement), 'A click leaves keyboard focus on the listbox');
  await page.keyboard.press('ArrowDown');
  assert.equal(await list.getAttribute('aria-activedescendant'), await page.getByRole('option').first().getAttribute('id'),
    'Keyboard navigation announces the active option after a pointer click');
}

async function assertFilterBorders(page, width, locale) {
  await page.setViewportSize({ width, height: 480 });
  const frame = page.locator('[data-slot="sftp-filter"]');
  await frame.waitFor();
  const samples = await frame.evaluate(async element => {
    const button = element.querySelector('button');
    const measure = () => {
      const { left, right } = element.getBoundingClientRect();
      return { left, right, iconOffset: button.getBoundingClientRect().left - left };
    };
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
    await Promise.all(element.getAnimations().map(animation => animation.finished));
    const samples = [measure()];
    button.click();
    await nextFrame();
    samples.push(measure());
    const transition = element.getAnimations().find(animation => animation.transitionProperty === 'width');
    if (!transition) throw new Error('The filter did not animate its width');
    while (transition.playState === 'running') {
      await nextFrame();
      samples.push(measure());
    }
    return samples;
  });
  assert.ok(samples.at(-1).left < samples[0].left, 'The filter grows to the left');
  for (const [index, sample] of samples.entries()) {
    assert.ok(Math.abs(sample.right - samples[0].right) < 0.25, 'The right edge stays fixed throughout expansion');
    assert.ok(Math.abs(sample.iconOffset) < 0.25, 'Input focus does not scroll the search icon out of the frame');
    if (index > 0) {
      assert.ok(sample.left <= samples[index - 1].left + 0.25, 'The left edge moves only left while expanding');
    }
  }
  const input = page.getByRole('textbox', { name: locale === 'en-US' ? 'Filter' : '筛选' });
  const icon = page.getByRole('button', { name: locale === 'en-US' ? 'Hide Filter' : '隐藏筛选' });
  await icon.hover();
  assert.ok(await input.evaluate(element => element === document.activeElement), 'Opening the filter focuses its input');
  const screenshot = await loadImage(await frame.screenshot({ animations: 'disabled' }));
  const pixels = createCanvas(screenshot.width, screenshot.height).getContext('2d');
  pixels.drawImage(screenshot, 0, 0);
  const edge = Math.floor(screenshot.height / 2);
  const rgba = (x, y) => Array.from(pixels.getImageData(x, y, 1, 1).data);
  const border = rgba(screenshot.width - 1, edge);
  assert.notDeepEqual(border, rgba(screenshot.width - 3, edge), 'The focused frame has a visible border');
  for (const y of [edge - 5, edge, edge + 5]) {
    assert.deepEqual(rgba(0, y), border, 'The search button hover must leave the left border visible');
  }
  await input.press('Escape');
  await page.getByRole('button', { name: locale === 'en-US' ? 'Show Filter' : '显示筛选' }).waitFor();
}

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const locale of ['zh-CN', 'en-US']) {
        const page = await browser.newPage({ viewport: { width: 960, height: 480 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__sftp_row_hover`);
        await page.evaluate(async ({ entries, locale, root }) => {
          const { mountList } = await import('/src/components/sftp/__tests__/sftp-row-hover.browser.tsx');
          await mountList(entries, locale, root);
        }, { entries, locale, root });
        const row = page.getByTestId('sftp-row').filter({ hasText: 'package.json' });
        const selected = page.getByTestId('sftp-row').filter({ hasText: 'AGENTS.md' });
        const parent = page.getByTestId('sftp-parent-row').last();
        const sortByName = page.getByTestId('sftp-file-list-header-viewport').getByRole('button').first();
        const inactiveNav = page.getByRole('navigation').locator('button:not([aria-current])').first();
        await row.waitFor();
        for (const theme of ['light', 'dark']) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          await page.locator('[data-sftp-file-cell]').first().evaluate(cell => {
            getComputedStyle(cell).backgroundColor;
            return Promise.allSettled(document.getAnimations().map(animation => animation.finished));
          });
          for (const width of [960, 380]) {
            await page.setViewportSize({ width, height: 480 });
            await sortByName.hover();
            assert.equal(await sortByName.evaluate(element => getComputedStyle(element).cursor), 'default', 'Sortable column uses the default cursor');
            await inactiveNav.hover();
            const navHover = await inactiveNav.evaluate(async element => {
              getComputedStyle(element).backgroundColor;
              await Promise.all(element.getAnimations().map(animation => animation.finished));
              return getComputedStyle(element).backgroundColor;
            });
            await page.mouse.move(width - 1, 450);
            const initial = await colors(row);
            const selectedColor = await colors(selected);
            assert.equal(new Set(selectedColor).size, 1, 'Selection covers every column');
            await row.hover({ position: { x: 80, y: 16 } });
            const hovered = await colors(row);
            assert.equal(new Set(hovered).size, 1, 'Hover covers every column');
            assert.equal(hovered[0], navHover, 'File rows and navigation use the same hover color');
            assert.notEqual(hovered[0], initial[0], 'Hover changes the row background');
            assert.notEqual(hovered[0], selectedColor[0], 'Hover remains distinct from selection');
            await assertSelectedBorders(page, [selected], `${engine.name()}/${locale}/${theme}/${width}`);
            await page.screenshot({ path: join(artifacts, `${engine.name()}-${locale}-${theme}-${width}.png`) });
            await selected.hover({ position: { x: 80, y: 16 } });
            assert.deepEqual(await colors(selected), selectedColor, 'Hover preserves selection');
            await parent.hover({ position: { x: 80, y: 16 } });
            assert.deepEqual(await colors(parent), hovered, 'Parent navigation uses the same hover');
            await page.mouse.move(width - 1, 450);
            assert.deepEqual(await colors(row), initial, 'Leaving restores the background');
          }
        }
        await row.click({ position: { x: 80, y: 16 } });
        await waitForColor(row, '0.1');
        for (const theme of ['light', 'dark']) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          await row.locator('[data-sftp-file-cell]').first().evaluate(cell => {
            getComputedStyle(cell).backgroundColor;
            return Promise.allSettled(document.getAnimations().map(animation => animation.finished));
          });
          await assertSelectedBorders(page, [selected, row], `${theme}: adjacent selected rows share one divider`);
        }
        for (const width of [960, 380]) await assertTabFocusColors(page, engine.name(), locale, width);
        await assertFileListFocus(page, row, selected, locale);
        await page.evaluate(async (root) => {
          document.documentElement.dataset.theme = 'light';
          const { mountLocalPane } = await import('/src/components/sftp/__tests__/sftp-row-hover.browser.tsx');
          mountLocalPane(root);
        }, root);
        for (const width of [960, 380]) await assertFilterBorders(page, width, locale);
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
  console.log(`SFTP hover checks passed in Chromium/WebKit, both themes and languages, at 380px/960px. Screenshots: ${artifacts}`);
} finally {
  await server.close();
}
