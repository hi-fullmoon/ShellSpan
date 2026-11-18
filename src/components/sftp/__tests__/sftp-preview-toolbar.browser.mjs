import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const artifacts = join(root, 'artifacts/tests/sftp-preview-toolbar');
await mkdir(artifacts, { recursive: true });
// Render actual repository files through the production preview and translations.
const files = await Promise.all(['src/components/ui/button.tsx', 'public/shellspan-icon.svg', 'src/lib/ai/retry-policy.json'].map(async relativePath => {
  const path = join(root, relativePath);
  return {
    path, name: relativePath.split('/').at(-1), content: await readFile(path, 'utf8'),
    size: (await stat(path)).size, isText: true, contentEncoding: 'utf8', truncated: false,
  };
}));
const largeSource = await readFile(join(root, 'src/locales/zh-CN.ts'), 'utf8');
const licenseSource = await readFile(join(root, 'LICENSE'), 'utf8');
let desktopApplication;
if (process.platform === 'darwin') {
  const textEdit = '/System/Applications/TextEdit.app/Contents';
  const pngPath = join(artifacts, 'textedit-app-icon.png');
  execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '32', join(textEdit, 'Resources/AppIcon.icns'), '--out', pngPath]);
  const readBundleField = (key) => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(textEdit, 'Info.plist')], { encoding: 'utf8' }).trim();
  desktopApplication = {
    id: readBundleField('CFBundleIdentifier'),
    name: readBundleField('CFBundleName'),
    icon: `data:image/png;base64,${(await readFile(pngPath)).toString('base64')}`,
  };
}
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: join(artifacts, 'vite-cache'),
  resolve: { alias: { '@': join(root, 'src') } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: {
    entries: ['src/components/sftp/__tests__/sftp-preview-toolbar.browser.tsx'],
    include: ['react', 'react-dom/client', 'react/jsx-dev-runtime'],
  },
  plugins: [tailwindcss()], server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__sftp_preview_toolbar', (request, response) => {
  response.setHeader('Content-Type', 'text/html');
  if (request.url?.includes('?block-icons')) response.setHeader('Content-Security-Policy', "img-src 'none'");
  response.end('<!doctype html><html><body><main id="root"></main></body></html>');
});

const waitForBackground = (button, filled) => button.evaluate((element, filled) => new Promise((resolve, reject) => {
  const deadline = performance.now() + 3000;
  const check = () => {
    const color = getComputedStyle(element).backgroundColor;
    const transparent = color === 'rgba(0, 0, 0, 0)' || color === 'transparent';
    if (transparent !== filled) resolve();
    else if (performance.now() > deadline) reject(new Error(`Unexpected button background: ${color}, filled=${filled}`));
    else requestAnimationFrame(check);
  };
  check();
}), filled);

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const locale of ['zh-CN', 'en-US']) {
        const labels = locale === 'zh-CN'
          ? { open: '打开', options: '打开选项', defaultApp: '默认应用', defaultCopy: '默认应用（打开本地副本）', reveal: '打开所在文件夹', revealRemote: '在远程文件列表中定位', saveAs: '另存为…', wrap: '切换自动换行', copy: '复制内容', zoomIn: '放大', zoomOut: '缩小', reset: '恢复原始比例' }
          : { open: 'Open', options: 'Open options', defaultApp: 'Default app', defaultCopy: 'Default app (open local copy)', reveal: 'Open containing folder', revealRemote: 'Show in remote file list', saveAs: 'Save as…', wrap: 'Toggle line wrapping', copy: 'Copy content', zoomIn: 'Zoom in', zoomOut: 'Zoom out', reset: 'Reset zoom' };
        const page = await browser.newPage();
        let workerCount = 0;
        page.on('worker', () => { workerCount += 1; });
        if (engine.name() === 'chromium') await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        for (const theme of ['light', 'dark']) {
          for (const [width, height] of [[380, 600], [1280, 800], [1600, 1100]]) {
            await page.setViewportSize({ width, height });
            for (const file of files) {
              const image = file.name.endsWith('.svg');
              const json = file.name.endsWith('.json');
              await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__sftp_preview_toolbar`);
              await page.evaluate(async ({ file, locale, theme, json }) => {
                document.documentElement.dataset.theme = theme;
                const { mountPreview } = await import('/src/components/sftp/__tests__/sftp-preview-toolbar.browser.tsx');
                await mountPreview(file, locale, json);
              }, { file, locale, theme, json });
              const dialog = page.getByRole('dialog');
              await dialog.waitFor();
              await dialog.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
              if (!image) {
                const code = dialog.locator('code[data-highlighted="true"]');
                await code.waitFor({ timeout: 15000 });
                assert.equal(await code.textContent(), file.content, 'Highlighting preserves the source exactly');
                assert.equal(await code.locator('script, img, iframe').count(), 0, 'Source markup is never rendered as live elements');
                const token = code.locator(json ? '.hljs-attr' : '.hljs-keyword').first();
                assert.notEqual(await token.evaluate(element => getComputedStyle(element).color), await code.evaluate(element => getComputedStyle(element).color), 'Syntax tokens have a visible theme color');
                assert.equal(await token.evaluate(element => getComputedStyle(element).userSelect), 'text', 'Highlighted tokens remain selectable');
                if (!json) assert.ok(await code.locator('.hljs-tag').count() > 0, 'TSX includes JSX highlighting');
              }
              const dialogBounds = await dialog.boundingBox();
              assert.ok(Math.abs(dialogBounds.width - Math.min(1152, width - 32)) < 1, 'Preview uses the enlarged width within the window');
              assert.ok(Math.abs(dialogBounds.height - height * 0.9) < 1, 'Preview uses 90% of the window height');
              assert.ok(dialogBounds.x >= 16 && dialogBounds.y >= 16, 'Preview keeps space around the window edges');
              const fileMetadata = dialog.locator('[data-slot="sftp-preview-metadata"]');
              const metadataParts = await fileMetadata.locator('[data-slot="sftp-preview-metadata-values"] > span').allTextContents();
              assert.equal(metadataParts.length, 3, 'All file kinds use extension, dot, and size');
              assert.equal(metadataParts[0], image ? 'SVG' : json ? 'JSON' : 'TSX');
              assert.equal(metadataParts[1], '·');
              assert.equal(await fileMetadata.locator('[data-slot="badge"]').count(), 0, 'File kinds share plain metadata without badges');
              const metadataStyles = await fileMetadata.locator('[data-slot="sftp-preview-metadata-values"] > span').evaluateAll(elements => elements.map(element => ({
                color: getComputedStyle(element).color,
                background: getComputedStyle(element).backgroundColor,
                fontSize: getComputedStyle(element).fontSize,
              })));
              assert.equal(new Set(metadataStyles.map(style => style.color)).size, 1, 'File kinds share one muted metadata color');
              assert.ok(metadataStyles.every(style => style.background === 'rgba(0, 0, 0, 0)' && style.fontSize === '12px'));
              const openButton = dialog.getByRole('button', { name: labels.open, exact: true });
              const optionsButton = dialog.getByRole('button', { name: labels.options, exact: true });
              const openBounds = await openButton.boundingBox();
              const optionsBounds = await optionsButton.boundingBox();
              assert.equal(await openButton.textContent(), labels.open, 'The primary open action has a visible label');
              assert.equal(openBounds.height, 32);
              assert.deepEqual(await openButton.locator('[data-icon="inline-start"]').evaluate(element => [element.clientWidth, element.clientHeight]), [14, 14]);
              assert.equal(await openButton.locator('[data-icon="inline-start"] svg').count(), 1, 'An unavailable default application icon uses the generic icon');
              assert.equal(optionsBounds.height, openBounds.height);
              assert.equal(optionsBounds.y, openBounds.y);
              assert.ok(Math.abs(optionsBounds.x - openBounds.x - openBounds.width) <= 1, 'Both sides form one split button');
              assert.ok(optionsBounds.x + optionsBounds.width <= dialogBounds.x + dialogBounds.width);
              if (width === 380) {
                await optionsButton.focus();
                await page.keyboard.press('Enter');
                const menu = page.getByRole('menu');
                const defaultApp = menu.getByRole('menuitem', { name: json ? labels.defaultCopy : labels.defaultApp, exact: true });
                await defaultApp.waitFor();
                await menu.getByRole('menuitem', { name: json ? labels.revealRemote : labels.reveal, exact: true }).waitFor();
                await menu.getByRole('menuitem', { name: labels.saveAs, exact: true }).waitFor();
                const usesSystemPicker = await page.evaluate(() => navigator.platform.toLowerCase().includes('win'));
                const appChoice = usesSystemPicker
                  ? (locale === 'zh-CN' ? '选择其他应用…' : 'Choose another app…')
                  : (locale === 'zh-CN' ? '无法读取应用列表' : 'Could not load apps');
                const choice = menu.getByRole('menuitem', { name: appChoice, exact: true });
                await choice.waitFor();
                await menu.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
                const menuBounds = await menu.boundingBox();
                assert.ok(menuBounds.width >= 224 && menuBounds.width <= 288, 'File options use the shared menu width and can fit longer labels');
                assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= width);
                assert.ok(await menu.evaluate(element => {
                  const probe = document.createElement('span');
                  probe.style.border = '1px solid var(--app-border)';
                  probe.style.boxShadow = 'var(--shadow-dialog)';
                  element.append(probe);
                  const menuStyle = getComputedStyle(element);
                  const expected = getComputedStyle(probe);
                  const matches = menuStyle.border === expected.border && menuStyle.boxShadow === expected.boxShadow;
                  probe.remove();
                  return matches;
                }), 'The options popup uses the shared file menu border and shadow');
                const itemAppearance = await defaultApp.evaluate(item => {
                  const icon = item.querySelector('svg').getBoundingClientRect();
                  const label = item.querySelector('[data-slot="menu-item-label"]').getBoundingClientRect();
                  return {
                    rowHeight: item.getBoundingClientRect().height,
                    fontSize: getComputedStyle(item).fontSize,
                    iconSize: [icon.width, icon.height],
                    iconGap: label.left - icon.right,
                  };
                });
                assert.deepEqual(itemAppearance, { rowHeight: 28, fontSize: '12px', iconSize: [14, 14], iconGap: 4 });
                if (!usesSystemPicker) {
                  assert.ok(await choice.isDisabled());
                  assert.equal(await choice.evaluate(item => getComputedStyle(item).opacity), '0.4', 'Disabled status uses the shared file menu opacity');
                }
                await page.screenshot({ path: join(artifacts, `${engine.name()}-${locale}-${theme}-${json ? 'remote' : 'local'}-menu.png`) });
                await page.keyboard.press('Escape');
                await menu.waitFor({ state: 'hidden' });
                assert.ok(await dialog.isVisible(), 'Escape closes the menu before the preview');
              }
              if (engine.name() === 'chromium' && locale === 'zh-CN' && theme === 'light' && width === 1280 && !image && !json) {
                const [popup] = await Promise.all([page.waitForEvent('popup'), openButton.click()]);
                await popup.waitForLoadState();
                assert.equal(decodeURIComponent(new URL(popup.url()).pathname), `/@fs${file.path}`);
                await popup.close();
              }
              const actions = image ? ['zoomOut', 'reset', 'zoomIn'] : ['wrap', 'copy'];
              for (const action of actions) {
                await page.mouse.move(0, 0);
                const button = dialog.getByRole('button', { name: labels[action], exact: true });
                await waitForBackground(button, false);
                assert.equal(await button.evaluate(element => getComputedStyle(element).borderTopWidth), '0px', `${action} has no persistent border`);
                const bounds = await button.boundingBox();
                assert.equal(bounds.width, 32, `${action} uses the shared icon button width`);
                assert.equal(bounds.height, 32, `${action} uses the shared icon button height`);
                assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, `${action} remains visible at ${width}px`);
                assert.equal(await button.locator('svg').count(), 1);
                assert.ok(await button.evaluate(element => {
                  const label = element.querySelector('.sr-only');
                  const bounds = label?.getBoundingClientRect();
                  return bounds?.width === 1 && bounds.height === 1
                    && getComputedStyle(label).position === 'absolute'
                    && [...element.childNodes].every(node => node.nodeType !== Node.TEXT_NODE || !node.textContent.trim());
                }), `${action} keeps its label visually hidden`);
                if (await button.isEnabled()) {
                  await button.hover();
                  await waitForBackground(button, true);
                  try {
                    await page.locator('[data-slot="tooltip-content"]').filter({ hasText: labels[action] }).waitFor({ timeout: 3000 });
                  } catch (error) {
                    await page.screenshot({ path: join(artifacts, 'tooltip-failure.png') });
                    throw new Error(`${action}: ${await page.locator('body').ariaSnapshot()}`, { cause: error });
                  }
                }
              }
              if (image) {
                const picture = dialog.getByRole('img', { name: file.name });
                await picture.evaluate(image => image.decode());
                const baseline = await picture.boundingBox();
                const reset = dialog.getByRole('button', { name: labels.reset, exact: true });
                assert.ok(await reset.isDisabled());
                await dialog.getByRole('button', { name: labels.zoomIn, exact: true }).click();
                assert.ok((await picture.boundingBox()).width > baseline.width);
                await reset.click();
                assert.equal((await picture.boundingBox()).width, baseline.width);
              } else {
                const toolbar = dialog.locator('[data-slot="sftp-text-toolbar"]');
                assert.equal(await toolbar.count(), 1, 'Text previews have one toolbar');
                const toolbarBounds = await toolbar.boundingBox();
                assert.equal(toolbarBounds.height, 44, 'Metadata and text actions share one compact row');
                assert.ok(await toolbar.getByRole('button', { name: labels.open, exact: true }).isVisible());
                assert.ok(await toolbar.getByRole('button', { name: labels.options, exact: true }).isVisible());
                for (const action of actions) {
                  const bounds = await dialog.getByRole('button', { name: labels[action], exact: true }).boundingBox();
                  assert.ok(Math.abs(bounds.y + bounds.height / 2 - toolbarBounds.y - toolbarBounds.height / 2) < 1, `${action} stays in the combined toolbar`);
                }
                const metadata = toolbar.locator('div').first();
                assert.equal(await metadata.locator('[data-slot="badge"]').count(), 0, 'File extension uses plain text');
                assert.equal(await metadata.getByText(json ? 'JSON' : 'TSX', { exact: true }).count(), 1);
                assert.equal(await metadata.getByText(locale === 'zh-CN' ? '文本' : 'Text', { exact: true }).count(), 0, 'Redundant file kind is omitted');
                assert.equal(await metadata.locator('[aria-hidden="true"]').allTextContents().then(values => values.join('')), '··', 'Dots separate extension, size, and line count');
                const textStyle = await metadata.locator('span:not([aria-hidden])').evaluateAll(elements => elements.map(element => ({
                  color: getComputedStyle(element).color,
                  background: getComputedStyle(element).backgroundColor,
                  fontSize: getComputedStyle(element).fontSize,
                })));
                assert.equal(new Set(textStyle.map(style => style.color)).size, 1, 'Metadata uses one muted text color');
                assert.ok(textStyle.every(style => style.background === 'rgba(0, 0, 0, 0)' && style.fontSize === '12px'), 'Metadata has no background and uses compact text');
                assert.ok(await toolbar.evaluate(element => element.scrollWidth <= element.clientWidth), 'Combined toolbar fits narrow windows');
                assert.ok(await toolbar.locator('div').first().evaluate(element => element.scrollWidth <= element.clientWidth), 'Metadata stays readable in the combined toolbar');
                const wrap = dialog.getByRole('button', { name: labels.wrap, exact: true });
                const highlightedBeforeWrap = await dialog.locator('code').innerHTML();
                const workersBeforeWrap = workerCount;
                if (json) {
                  assert.equal(await dialog.locator('pre').textContent(), file.content, 'JSON preserves the original indentation and content');
                  assert.equal(await dialog.getByRole('table').count(), 0, 'JSON opens as source instead of a table');
                  assert.equal(await dialog.getByRole('tab').count(), 0, 'JSON needs no preview/source tab switch');
                }
                assert.equal(await wrap.getAttribute('aria-pressed'), 'false');
                await wrap.focus();
                await page.keyboard.press('Space');
                assert.equal(await wrap.getAttribute('aria-pressed'), 'true');
                await waitForBackground(wrap, false);
                await wrap.hover();
                await waitForBackground(wrap, true);
                await page.mouse.move(0, 0);
                await waitForBackground(wrap, false);
                assert.ok(await dialog.locator('pre').evaluate(element => getComputedStyle(element).whiteSpace === 'pre-wrap'));
                assert.equal(await dialog.locator('code').innerHTML(), highlightedBeforeWrap, 'Wrapping preserves the highlighted tokens');
                assert.equal(workerCount, workersBeforeWrap, 'Wrapping does not start another highlighting worker');
                const headerBefore = await dialog.locator('[data-slot="dialog-header"]').boundingBox();
                const viewport = dialog.locator('[data-slot="scroll-area-viewport"]');
                const scrollTop = await viewport.evaluate(element => {
                  element.scrollTop = element.scrollHeight;
                  return element.scrollTop;
                });
                if (!json) assert.ok(scrollTop > 0, 'Long text scrolls inside the enlarged preview');
                assert.deepEqual(await dialog.locator('[data-slot="dialog-header"]').boundingBox(), headerBefore);
                await viewport.evaluate(element => { element.scrollTop = 0; });
                if (engine.name() === 'chromium' && locale === 'zh-CN' && theme === 'light' && width === 1280) {
                  await dialog.getByRole('button', { name: labels.copy, exact: true }).click();
                  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), file.content, 'Copying highlighted source returns the original file');
                }
              }
              await page.mouse.move(0, 0);
              await dialog.locator('[data-slot="dialog-header"]').click();
              await Promise.all((await page.locator('[data-slot="tooltip-content"]').all()).map(tooltip => tooltip.waitFor({ state: 'hidden' })));
              await page.screenshot({ path: join(artifacts, `${engine.name()}-${locale}-${theme}-${width}-${image ? 'image' : json ? 'json' : 'text'}.png`) });
              await page.keyboard.press('Escape');
              await dialog.waitFor({ state: 'hidden' });
            }
          }
        }
        const workersBeforeCache = workerCount;
        const cachedHtml = await page.evaluate(async file => {
          const { highlightSftpCode } = await import('/src/lib/sftp/sftp-code-highlight.ts');
          return highlightSftpCode(file.content, file.name);
        }, files[2]);
        assert.ok(cachedHtml?.includes('hljs-attr'), 'Previously highlighted JSON is cached');
        assert.equal(workerCount, workersBeforeCache, 'Reopening cached source does not create another worker');
        const fallback = await page.evaluate(async source => {
          const { highlightSftpCode } = await import('/src/lib/sftp/sftp-code-highlight.ts');
          const unknown = await highlightSftpCode(source, 'notes.txt');
          const controller = new AbortController();
          const pending = highlightSftpCode(source, 'zh-CN.ts', controller.signal);
          controller.abort();
          return { unknown, cancelled: await pending, large: await highlightSftpCode(source, 'zh-CN.ts') };
        }, largeSource);
        assert.equal(fallback.unknown, null, 'Unknown file types retain plain source');
        assert.equal(fallback.cancelled, null, 'Cancelled workers do not apply stale markup');
        assert.ok(fallback.large?.includes('hljs-string'), 'Large real files highlight in a worker');
        await page.setViewportSize({ width: 380, height: 600 });
        for (const file of [
          { path: join(root, 'LICENSE'), name: 'LICENSE', content: licenseSource, size: Buffer.byteLength(licenseSource), truncated: false },
          { path: join(root, 'src/locales/zh-CN.ts'), name: 'zh-CN.ts', content: largeSource.slice(0, largeSource.indexOf('\n', 1000)), size: Buffer.byteLength(largeSource), truncated: true },
        ]) {
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__sftp_preview_toolbar`);
          await page.evaluate(async ({ file, locale }) => {
            const { mountPreview } = await import('/src/components/sftp/__tests__/sftp-preview-toolbar.browser.tsx');
            await mountPreview({ ...file, isText: true, contentEncoding: 'utf8' }, locale);
          }, { file, locale });
          const dialog = page.getByRole('dialog');
          await dialog.waitFor();
          await dialog.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
          const metadata = dialog.locator('[data-slot="sftp-preview-metadata"]');
          assert.equal(await dialog.locator('pre').textContent(), file.content);
          if (file.truncated) {
            const partial = metadata.locator('[data-slot="badge"]');
            const badgeBounds = await partial.boundingBox();
            const metadataBounds = await metadata.boundingBox();
            assert.ok(badgeBounds.x >= metadataBounds.x && badgeBounds.x + badgeBounds.width <= metadataBounds.x + metadataBounds.width + 1, `Partial-preview status stays visible in ${engine.name()} ${locale}, badge width ${badgeBounds.width}px and metadata width ${metadataBounds.width}px`);
            assert.ok((await metadata.locator('[data-slot="sftp-preview-metadata-values"]').getAttribute('title')).includes('TS ·'), 'Clipped metadata remains available in a tooltip');
            await dialog.locator('code[data-highlighted="true"]').waitFor();
          } else {
            assert.equal(await metadata.getByText(locale === 'zh-CN' ? '文本' : 'Text', { exact: true }).count(), 1, 'Extensionless readable files have a readable type label');
          }
          await page.screenshot({ path: join(artifacts, `${engine.name()}-${locale}-${file.truncated ? 'partial' : 'extensionless'}-380.png`) });
        }
        if (desktopApplication && locale === 'zh-CN') {
          const file = {
            path: join(root, 'LICENSE'), name: 'LICENSE', content: licenseSource,
            size: Buffer.byteLength(licenseSource), truncated: false, isText: true, contentEncoding: 'utf8',
          };
          for (const blocked of [false, true]) {
            await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__sftp_preview_toolbar${blocked ? '?block-icons' : ''}`);
            await page.evaluate(async ({ application, file, locale, blocked }) => {
              document.documentElement.dataset.theme = blocked ? 'dark' : 'light';
              const { mountPreview } = await import('/src/components/sftp/__tests__/sftp-preview-toolbar.browser.tsx');
              await mountPreview(file, locale, blocked, [application]);
            }, { application: desktopApplication, file, locale, blocked });
            const dialog = page.getByRole('dialog');
            const openButton = dialog.getByRole('button', { name: labels.open, exact: true });
            const buttonIcon = openButton.locator(blocked ? '[data-icon="inline-start"] svg' : '[data-icon="inline-start"] img');
            await buttonIcon.waitFor();
            if (!blocked) await buttonIcon.evaluate(image => image.decode());
            const buttonIconGap = await buttonIcon.evaluate(icon => {
              const button = icon.closest('button');
              const label = Array.from(button.childNodes).find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
              const text = document.createRange();
              text.selectNode(label);
              return text.getBoundingClientRect().left - icon.getBoundingClientRect().right;
            });
            assert.ok(Math.abs(buttonIconGap - 4) < 1, 'The default application icon is 4px left of the Open label');
            await dialog.getByRole('button', { name: labels.options, exact: true }).click();
            const menu = page.getByRole('menu');
            const appItem = menu.getByRole('menuitem', { name: desktopApplication.name, exact: true });
            const icon = appItem.locator(blocked ? 'svg' : 'img');
            await icon.waitFor();
            if (!blocked) await icon.evaluate(image => image.decode());
            await menu.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
            const iconBounds = await icon.boundingBox();
            const labelBounds = await appItem.getByText(desktopApplication.name, { exact: true }).boundingBox();
            assert.equal(iconBounds.width, 14);
            assert.equal(iconBounds.height, 14);
            assert.ok(Math.abs(labelBounds.x - iconBounds.x - iconBounds.width - 4) < 1, 'The app icon is 4px left of the app name');
            await page.screenshot({ path: join(artifacts, `${engine.name()}-application-icon-${blocked ? 'fallback' : 'native'}.png`) });
          }
        }
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
  console.log(`SFTP preview size and toolbar passed in Chromium/WebKit, both languages and themes, at 380px/1280px/1600px. Screenshots: ${artifacts}`);
} finally {
  await server.close();
}
