import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { createCanvas, loadImage } from 'canvas';

const artifacts = resolve('artifacts/tests/terminal-colors');
await mkdir(artifacts, { recursive: true });
const server = await createServer({
  configFile: false, logLevel: 'error', appType: 'custom',
  resolve: { alias: { '@': resolve('src') } },
  plugins: [tailwindcss(), {
    name: 'terminal-colors-verification',
    resolveId(id) { if (id === '/color-runtime') return id; },
    load(id) {
      if (id === '/color-runtime') return `
        export { default as React } from 'react';
        export { createRoot } from 'react-dom/client';
        export { SettingsPanel } from '/src/components/workbench/settings-panel.tsx';
        export { useAppStore } from '/src/stores/appStore.ts';
        export { initI18n } from '/src/locales/index.ts';
        export { applyTheme } from '/src/lib/theme.ts';
        import '/src/styles/base.css';
      `;
    },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><div id="root" style="height:100dvh"></div></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
});
try {
  await server.listen();
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch();
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      for (const [locale, labels] of [
        ['zh-CN', { customize: '自定义', title: '自定义终端颜色', background: '背景', picker: '选择背景颜色', red: '红色', resetRed: '恢复红色默认颜色', reset: '恢复默认', close: '关闭', match: '普通匹配背景', activeMatch: '当前匹配背景', invalid: '请输入 #RRGGBB 或 #RRGGBBAA 格式的颜色。' }],
        ['en-US', { customize: 'Customize', title: 'Customize terminal colors', background: 'Background', picker: 'Choose Background color', red: 'Red', resetRed: 'Restore default Red color', reset: 'Restore defaults', close: 'Close', match: 'Match background', activeMatch: 'Current match background', invalid: 'Enter a color in #RRGGBB or #RRGGBBAA format.' }],
      ]) {
        for (const theme of ['light', 'dark']) {
          for (const width of [1100, 380]) {
            const context = `${engine}/${locale}/${theme}/${width}`;
            await page.setViewportSize({ width, height: width === 380 ? 620 : 850 });
            await page.goto(server.resolvedUrls.local[0]);
            await page.evaluate(async ({ locale, theme }) => {
              const { React, createRoot, SettingsPanel, useAppStore, initI18n, applyTheme } = await import('/color-runtime');
              await initI18n(locale);
              applyTheme(theme);
              useAppStore.setState({ locale, theme, activeSettingsSection: 'terminal', terminalColorScheme: 'oneDark', terminalColorOverrides: {} });
              createRoot(document.getElementById('root')).render(React.createElement(SettingsPanel));
            }, { locale, theme });
            const customize = page.getByRole('button', { name: labels.customize, exact: true });
            await customize.waitFor();
            assert.equal(await page.locator('html').getAttribute('data-theme'), theme, `${context}: actual app theme`);
            const scheme = page.getByRole('combobox').filter({ hasText: 'One Dark' });
            assert.equal(await scheme.count(), 1, `${context}: preset label`);
            const buttonBounds = await customize.boundingBox();
            const selectBounds = await scheme.boundingBox();
            assert.equal(buttonBounds.height, selectBounds.height, `${context}: controls must have equal heights`);
            assert.equal(buttonBounds.y, selectBounds.y, `${context}: customize stays beside preset`);
            await customize.click();
            const dialog = page.getByRole('dialog', { name: labels.title });
            await dialog.waitFor();
            await dialog.locator('[data-terminal-color-preview] .xterm-screen').waitFor();
            const preview = dialog.getByRole('region', { name: locale === 'zh-CN' ? '终端颜色实时预览' : 'Live terminal color preview' });
            assert.equal(await preview.getByText(locale === 'zh-CN' ? '实时预览' : 'Live preview', { exact: true }).count(), 1, `${context}: readable preview title`);
            assert.ok((await preview.locator('[data-slot="card-description"]').textContent()).includes('One Dark'), `${context}: preview identifies its base preset`);
            await page.waitForFunction(locale => {
              const text = document.querySelector('[data-terminal-color-preview] .xterm-rows')?.textContent ?? '';
              return text.includes(locale === 'zh-CN' ? '光标' : 'Cursor');
            }, locale);
            const previewContent = await preview.textContent();
            for (const text of locale === 'zh-CN' ? ['你好，ShellSpan！', '标准', '明亮', '选中文字预览', '搜索匹配', '光标'] : ['Hello, ShellSpan!', 'Normal', 'Bright', 'Selected text preview', 'Search match', 'Cursor']) {
              assert.ok(previewContent.includes(text), `${context}: visible preview sample ${text}`);
            }
            const previewBounds = await preview.locator('[data-terminal-color-preview]').evaluate(element => {
              const screen = element.querySelector('.xterm-screen').getBoundingClientRect();
              const host = element.getBoundingClientRect();
              return { screen: { right: screen.right, bottom: screen.bottom, width: screen.width, height: screen.height }, host: { right: host.right, bottom: host.bottom, width: host.width, height: host.height } };
            });
            assert.ok(previewBounds.screen.right <= previewBounds.host.right && previewBounds.screen.bottom <= previewBounds.host.bottom, `${context}: all preview rows fit without clipping: ${JSON.stringify(previewBounds)}`);
            assert.equal(await dialog.locator('input[type="color"]').count(), 25, `${context}: all individual colors`);
            const background = dialog.getByRole('textbox', { name: labels.background, exact: true });
            assert.equal(await background.inputValue(), '#282c34', `${context}: inherited colors are editable hex values`);
            assert.equal(await background.locator('../..').getByText(locale === 'zh-CN' ? '沿用方案' : 'Follow preset', { exact: true }).count(), 1, `${context}: inherited colors have an explicit status`);
            const inheritedMatch = dialog.getByRole('textbox', { name: labels.match, exact: true });
            assert.equal(await inheritedMatch.inputValue(), '', `${context}: absent search backgrounds do not invent a color`);
            assert.equal(await inheritedMatch.getAttribute('placeholder'), locale === 'zh-CN' ? '无背景' : 'No background');
            assert.equal(await inheritedMatch.locator('..').locator('[data-swatch-color]').evaluate(element => element.style.backgroundColor), 'transparent', `${context}: inherited search swatches show transparency instead of black`);
            assert.equal(await preview.locator('[data-ansi-palette="normal"] > span').count(), 8);
            assert.equal(await preview.locator('[data-ansi-palette="bright"] > span').count(), 8);
            await background.fill('#123456');
            await page.waitForFunction(() => document.querySelector('[data-terminal-color-preview]').style.backgroundColor === 'rgb(18, 52, 86)');
            assert.equal(await preview.locator('.xterm').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(18, 52, 86)', `${context}: terminal padding uses the preview background`);
            assert.equal(await preview.locator('.xterm-viewport').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(18, 52, 86)', `${context}: terminal viewport uses the preview background`);
            await background.fill('#12');
            assert.equal(await background.getAttribute('aria-invalid'), 'true', `${context}: incomplete colors are marked invalid`);
            assert.equal(await dialog.getByRole('alert').textContent(), labels.invalid);
            assert.equal(await page.evaluate(async () => (await import('/color-runtime')).useAppStore.getState().terminalColorOverrides.background), '#123456', `${context}: invalid input must not apply`);
            assert.equal(await dialog.getByRole('button', { name: labels.picker, exact: true }).count(), 1, `${context}: readable color picker label`);
            await dialog.locator('input[type="color"]').first().fill('#203040');
            assert.equal(await background.inputValue(), '#203040');
            const red = dialog.getByRole('textbox', { name: labels.red, exact: true });
            await red.fill('#aabbcc');
            const resetRed = dialog.getByRole('button', { name: labels.resetRed, exact: true });
            await red.press('Tab');
            assert.ok(await page.evaluate(() => document.activeElement?.hasAttribute('data-color-swatch')), `${context}: color picker remains keyboard accessible inside the input`);
            await page.keyboard.press('Tab');
            assert.ok(await resetRed.evaluate(element => element === document.activeElement), `${context}: reset follows color picker in keyboard order`);
            await resetRed.press('Enter');
            assert.equal(await red.inputValue(), '#e06c75', `${context}: reset restores the readable inherited color`);
            assert.ok(await resetRed.isDisabled(), `${context}: inherited colors have no override to reset`);
            const selection = dialog.getByRole('textbox', { name: locale === 'zh-CN' ? '选区背景' : 'Selection background', exact: true });
            await dialog.getByRole('textbox', { name: locale === 'zh-CN' ? '非活动选区背景' : 'Inactive selection background', exact: true }).fill('#44556680');
            await selection.fill('#ff000080');
            await dialog.locator('input[type="color"]').nth(4).fill('#4f8cff');
            assert.equal(await selection.inputValue(), '#4f8cff80', `${context}: native color edits preserve alpha`);
            const selectionPreview = preview.locator('[data-selection-preview="selectionBackground"]');
            const alphaColor = await page.evaluate(() => { const probe = document.createElement('span'); probe.style.backgroundColor = '#4f8cff80'; return probe.style.backgroundColor; });
            assert.equal(await selectionPreview.evaluate(element => element.style.backgroundColor), alphaColor, `${context}: active selection updates while editing an input`);
            assert.notEqual(await preview.locator('[data-selection-preview="selectionInactiveBackground"]').evaluate(element => element.style.backgroundColor), await selectionPreview.evaluate(element => element.style.backgroundColor), `${context}: active and inactive selection samples are independent`);
            const swatch = selection.locator('..').locator('[data-swatch-color]');
            assert.equal(await swatch.evaluate(element => element.style.backgroundColor), alphaColor, `${context}: swatches render their actual alpha`);
            const layout = await dialog.evaluate(element => {
              const bounds = element.getBoundingClientRect();
              const viewport = element.querySelector('[data-slot="scroll-area-viewport"]');
              const footer = element.querySelector('[data-slot="dialog-footer"]');
              const scrollbar = element.querySelector('[data-slot="scroll-area-scrollbar"][data-orientation="vertical"]').getBoundingClientRect();
              const border = parseFloat(getComputedStyle(element).borderRightWidth);
              return {
                inside: bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight,
                overflow: element.scrollWidth > element.clientWidth,
                scrolls: viewport.scrollHeight > viewport.clientHeight,
                footerInside: footer.getBoundingClientRect().bottom <= bounds.bottom,
                footerBorder: getComputedStyle(footer).borderTopWidth,
                scrollbarEdge: Math.abs(scrollbar.right - (bounds.right - border)) < 0.5,
                scrollbarInside: scrollbar.left >= bounds.left && scrollbar.right <= bounds.right,
                rows: [...element.querySelectorAll('[data-slot="field"]')].map(field => {
                  const pickerElement = field.querySelector('[data-color-swatch]');
                  const picker = pickerElement.getBoundingClientRect();
                  const group = field.querySelector('[data-slot="input-group"]').getBoundingClientRect();
                  const input = field.querySelector('[data-slot="input-group-control"]').getBoundingClientRect();
                  const button = field.querySelector('[data-align="inline-end"] button').getBoundingClientRect();
                  const swatch = pickerElement.querySelector('span').getBoundingClientRect();
                  const icon = field.querySelector('[data-align="inline-end"] svg').getBoundingClientRect();
                  const centerY = group.top + group.height / 2;
                  return {
                    height: group.height,
                    pickerInside: picker.left >= group.left && picker.right <= group.right && picker.top >= group.top && picker.bottom <= group.bottom,
                    sharedBorder: pickerElement.closest('[data-slot="input-group"]') === field.querySelector('[data-slot="input-group"]') && getComputedStyle(pickerElement).borderWidth === '0px',
                    resetInside: button.left >= group.left && button.right <= group.right && button.top >= group.top && button.bottom <= group.bottom,
                    noOverlap: picker.right <= input.left && input.right <= button.left,
                    centerOffsets: [swatch, input, icon].map(rect => rect.top + rect.height / 2 - centerY),
                  };
                }),
              };
            });
            assert.ok(layout.inside && !layout.overflow && layout.scrolls && layout.footerInside, `${context}: ${JSON.stringify(layout)}`);
            assert.equal(layout.footerBorder, '0px', `${context}: no footer separator`);
            assert.ok(layout.scrollbarEdge && layout.scrollbarInside, `${context}: scrollbar must touch the dialog edge and remain unclipped: ${JSON.stringify(layout)}`);
            assert.ok(layout.rows.every(row => row.height === 36 && row.pickerInside && row.sharedBorder && row.resetInside && row.noOverlap), `${context}: swatch, text and reset share one control without overlapping: ${JSON.stringify(layout.rows)}`);
            assert.ok(layout.rows.every(row => row.centerOffsets.every(offset => Math.abs(offset) <= 0.5)), `${context}: swatch, value and reset icon must be vertically centered: ${JSON.stringify(layout.rows.map(row => row.centerOffsets))}`);
            await background.scrollIntoViewIfNeeded();
            const textRegion = await background.evaluate(element => {
              const bounds = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              const canvas = document.createElement('canvas');
              const ctx = canvas.getContext('2d');
              ctx.font = style.font;
              const width = Math.ceil(ctx.measureText(element.value).width);
              ctx.fillStyle = style.color;
              ctx.fillRect(0, 0, 1, 1);
              return {
                clip: { x: Math.ceil(bounds.left + parseFloat(style.paddingLeft)), y: Math.ceil(bounds.top), width, height: Math.floor(bounds.height) },
                color: [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3),
              };
            });
            const glyphCenter = async () => {
              const textImage = await loadImage(await page.screenshot({ clip: textRegion.clip, scale: 'css' }));
              const textCanvas = createCanvas(textImage.width, textImage.height);
              const textContext = textCanvas.getContext('2d');
              textContext.drawImage(textImage, 0, 0);
              const pixels = textContext.getImageData(0, 0, textImage.width, textImage.height).data;
              const backgroundColor = [...pixels.slice(0, 3)];
              let top = textImage.height;
              let bottom = -1;
              for (let y = 0; y < textImage.height; y++) {
                for (let x = 0; x < textImage.width; x++) {
                  const offset = (y * textImage.width + x) * 4;
                  const distance = color => color.reduce((sum, channel, index) => sum + (channel - pixels[offset + index]) ** 2, 0);
                  if (distance(textRegion.color) < distance(backgroundColor)) {
                    top = Math.min(top, y);
                    bottom = Math.max(bottom, y);
                  }
                }
              }
              assert.ok(bottom >= top, `${context}: actual color value glyphs are visible`);
              return (top + bottom + 1) / 2;
            };
            // Compare actual glyph pixels with the standard symmetric input padding.
            const adjustedCenter = await glyphCenter();
            const previousPadding = await background.evaluate(element => {
              const previous = element.style.paddingTop;
              element.style.paddingTop = getComputedStyle(element).paddingBottom;
              return previous;
            });
            try {
              const shift = adjustedCenter - await glyphCenter();
              assert.ok(shift >= 0.5 && shift <= 1.5, `${context}: color value glyphs must shift down by 1px (actual ${shift}px)`);
            } finally {
              await background.evaluate((element, previous) => { element.style.paddingTop = previous; }, previousPadding);
            }
            await dialog.locator('[data-slot="scroll-area-viewport"]').evaluate(element => { element.scrollTop = element.scrollHeight; });
            await dialog.getByRole('textbox', { name: labels.activeMatch, exact: true }).fill('#ff000080');
            await preview.scrollIntoViewIfNeeded();
            await page.waitForFunction(() => [...document.querySelectorAll('[data-terminal-color-preview] .xterm-rows span')].some(element => getComputedStyle(element).backgroundColor === 'rgb(144, 24, 32)'));
            await background.fill('#102030');
            await preview.scrollIntoViewIfNeeded();
            await page.waitForFunction(() => [...document.querySelectorAll('[data-terminal-color-preview] .xterm-rows span')].some(element => getComputedStyle(element).backgroundColor === 'rgb(136, 16, 24)'));
            await background.fill('#203040');
            await dialog.getByRole('textbox', { name: labels.match, exact: true }).fill('#778899');
            await dialog.getByRole('textbox', { name: labels.activeMatch, exact: true }).fill('#aabbcc');
            await preview.scrollIntoViewIfNeeded();
            await page.waitForFunction(() => [...document.querySelectorAll('[data-terminal-color-preview] .xterm-rows span')].some(element => getComputedStyle(element).backgroundColor === 'rgb(170, 187, 204)'));
            await page.screenshot({ path: `${artifacts}/${engine}-${locale}-${theme}-${width}-search.png` });
            await dialog.locator('[data-slot="scroll-area-viewport"]').evaluate(element => { element.scrollTop = 0; });
            await page.screenshot({ path: `${artifacts}/${engine}-${locale}-${theme}-${width}.png` });
            await dialog.getByRole('button', { name: labels.reset, exact: true }).click();
            assert.deepEqual(await page.evaluate(async () => (await import('/color-runtime')).useAppStore.getState().terminalColorOverrides), {});
            await background.fill('#112233');
            await page.keyboard.press('Escape');
            await dialog.waitFor({ state: 'hidden' });
            await page.waitForFunction(label => document.activeElement?.textContent === label, labels.customize);
            await customize.click();
            await dialog.waitFor();
            assert.equal(await dialog.getByRole('textbox', { name: labels.background, exact: true }).inputValue(), '#112233', `${context}: close retains edits`);
            await dialog.getByRole('button', { name: labels.close, exact: true }).last().click();
          }
        }
      }
      assert.deepEqual(errors, [], `${engine}: browser exceptions`);
    } finally { await browser.close(); }
  }
  console.log('Terminal color settings passed in Chromium and WebKit: bilingual light/dark layouts, individual edits, validation, search, reset, focus and reopen.');
} finally { await server.close(); }
