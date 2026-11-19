import assert from 'node:assert/strict';
import { mkdir, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

// node src/components/ui/__tests__/context-menu-hover.browser.mjs
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = `${root}artifacts/tests/context-menu-hover`;
await mkdir(output, { recursive: true });
const path = `${root}AGENTS.md`;
const metadata = await stat(path);
const entry = { path, name: 'AGENTS.md', kind: 'file', size: metadata.size, modifiedAt: metadata.mtimeMs };
const fileUrl = pathToFileURL(path).href;
const directory = root.slice(0, -1);
const { username } = userInfo();
const engine = process.env.SHELLSPAN_TEST_ENGINE ?? 'chromium';
const menuAppearance = item => item.evaluate(element => {
  const menu = element.closest('[role="menu"]');
  const { backgroundColor, border, borderRadius, boxShadow, padding } = getComputedStyle(menu);
  const probe = document.createElement('span');
  probe.style.boxShadow = 'var(--shadow-dialog)';
  menu.append(probe);
  // Tailwind includes transparent shadow layers before the visible dialog shadow.
  const hasDialogShadow = boxShadow.endsWith(getComputedStyle(probe).boxShadow);
  probe.remove();
  const label = element.lastElementChild;
  const icon = element.querySelector('svg');
  return {
    surface: { backgroundColor, border, borderRadius, hasDialogShadow, padding },
    menuWidth: getComputedStyle(menu).width,
    labelColor: getComputedStyle(label).color,
    iconStroke: getComputedStyle(icon).stroke,
    iconWidth: getComputedStyle(icon).width,
    iconHeight: getComputedStyle(icon).height,
    iconGap: Math.round(label.getBoundingClientRect().left - icon.getBoundingClientRect().right),
    opacity: getComputedStyle(element).opacity,
  };
});
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `${output}/vite-${engine}`,
  optimizeDeps: { entries: ['src/components/ui/__tests__/context-menu-hover.browser-entry.tsx'], force: true },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/context-menu-hover', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/context-menu-hover',
    '<html><body><div id="root"></div><script type="module" src="/src/components/ui/__tests__/context-menu-hover.browser-entry.tsx"></script></body></html>'));
});
let browser;
try {
  await server.listen();
  browser = await (engine === 'webkit' ? webkit : chromium).launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/context-menu-hover`);
  for (const theme of ['light', 'dark']) {
    for (const locale of ['zh-CN', 'en-US']) {
      for (const width of [1280, 380]) {
        await page.setViewportSize({ width, height: 900 });
        let reference;
        let fileMenuAppearance;
        let disabledFileItemOpacity;
        const iconKinds = ['icon', 'connection-actions', 'log-actions'];
        for (const kind of ['account', ...iconKinds, 'terminal', 'shared', 'file', 'agent-path', 'blank', 'bookmark']) {
          const labels = await page.evaluate(async options => {
            const { show } = await import('/src/components/ui/__tests__/context-menu-hover.browser-entry.tsx');
            return show(options);
          }, { kind, theme, locale, entry, fileUrl, directory, username });
          const button = name => page.getByRole('button', { name, exact: true });
          const menuItem = name => page.getByRole('menuitem', { name, exact: true });
          if (kind === 'account') await button(labels.account).click();
          if (kind === 'terminal') await page.getByRole('tab').click({ button: 'right' });
          if (kind === 'shared') await page.getByTestId('context-trigger').click({ button: 'right' });
          if (kind === 'agent-path') await page.getByRole('link', { name: entry.name, exact: true }).click({ button: 'right' });
          const isIcon = iconKinds.includes(kind);
          const targets = isIcon ? [button(labels[kind])] : {
            account: [menuItem(labels.appearance)],
            terminal: [menuItem(labels.template)],
            shared: [menuItem(labels.copy)],
            file: [menuItem(labels.copy), menuItem(labels.remove)],
            'agent-path': [menuItem(labels.copyPath)],
            blank: [menuItem(labels.refresh)],
            bookmark: [button(directory)],
          }[kind];
          for (const item of targets) {
            const isDelete = kind === 'file' && (await item.textContent()).trim() === labels.remove;
            const expectedBackground = isDelete
              ? `color-mix(in oklab, var(--destructive) ${theme === 'dark' ? 20 : 10}%, transparent)`
              : 'color-mix(in srgb, var(--foreground) 5%, transparent)';
            await item.hover();
            await page.waitForFunction(({ element, expectedBackground }) => {
              const probe = document.createElement('span');
              probe.style.backgroundColor = expectedBackground;
              element.append(probe);
              const expected = getComputedStyle(probe).backgroundColor;
              probe.remove();
              return getComputedStyle(element).backgroundColor === expected;
            }, { element: await item.elementHandle(), expectedBackground }, { timeout: 5000 }).catch(async error => {
              await page.screenshot({ path: `${output}/${engine}-failure.png` });
              const details = await item.evaluate(element => ({
                text: element.textContent,
                background: getComputedStyle(element).backgroundColor,
                hover: element.matches(':hover'),
                focus: element.matches(':focus'),
                highlighted: element.hasAttribute('data-highlighted'),
              }));
              throw new Error(`${engine}/${theme}/${locale}/${width}/${kind}: ${JSON.stringify(details)}`, { cause: error });
            });
            const result = await item.evaluate(element => ({
              background: getComputedStyle(element).backgroundColor,
              color: getComputedStyle(element).color,
              text: element.textContent.trim(),
              height: element.getBoundingClientRect().height,
            }));
            reference ??= result.background;
            if (isIcon) {
              assert.equal(await item.getAttribute('aria-label'), labels[kind], 'Icon action has a readable label');
              assert.equal(result.height, 32, 'Icon action height');
            } else {
              assert.ok(result.text.length > 0, `${kind}: readable label`);
              assert.ok(result.height >= 28, `${kind}: menu item height`);
            }
            if (isDelete) {
              assert.notEqual(result.background, reference, 'Delete uses its destructive hover background');
              const danger = await item.evaluate(element => {
                const probe = document.createElement('span');
                probe.style.color = 'var(--app-error)';
                element.append(probe);
                const color = getComputedStyle(probe).color;
                probe.remove();
                return color;
              });
              assert.equal(result.color, danger, 'Delete keeps its warning text color');
              const iconStroke = await item.locator('svg').evaluate(icon => getComputedStyle(icon).stroke);
              assert.equal(iconStroke, danger, 'Delete icon matches the warning text color');
            } else {
              assert.equal(result.background, reference, `${engine}/${theme}/${locale}/${width}/${kind}: hover background`);
            }
            if (kind === 'file' && !isDelete) {
              fileMenuAppearance = await menuAppearance(item);
              assert.equal(fileMenuAppearance.surface.hasDialogShadow, true, 'The SFTP file menu uses the dialog shadow');
              assert.equal(fileMenuAppearance.iconGap, 4, 'The SFTP file menu uses a 4px icon gap');
            }
            if (kind === 'agent-path') {
              assert.deepEqual(await menuAppearance(item), fileMenuAppearance, 'The AI path menu matches the SFTP file menu');
            }
          }
          if (kind === 'file') {
            disabledFileItemOpacity = (await menuAppearance(menuItem(labels.openFile))).opacity;
          }
          if (kind === 'agent-path') {
            await menuItem(labels.openWith).hover();
            const submenu = page.getByRole('menu', { name: labels.openWith });
            const appearance = await menuAppearance(submenu.getByRole('menuitem', { name: labels.defaultApp }));
            assert.deepEqual(appearance.surface, fileMenuAppearance.surface, 'The Open with submenu uses the same surface');
            assert.equal(appearance.opacity, disabledFileItemOpacity, 'Disabled items use the same opacity');
            await page.keyboard.press('Escape');
            await submenu.waitFor({ state: 'hidden' });
          }
          if (kind === 'blank') {
            const disabled = page.getByRole('menuitem', { name: labels.paste, exact: true });
            assert.equal(await disabled.isDisabled(), true, 'Paste remains disabled without clipboard content');
          }
          if (kind === 'shared') {
            await page.keyboard.press('ArrowDown');
            const focused = page.locator('[role="menuitem"]:focus');
            assert.equal(await focused.evaluate(element => getComputedStyle(element).backgroundColor), reference,
              'Keyboard focus uses the same background');
            await page.keyboard.press('Escape');
          } else {
            await page.screenshot({ path: `${output}/${engine}-${theme}-${locale}-${width}-${kind}.png` });
          }
        }
      }
    }
  }
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log(`Context-menu hover checks passed (${engine}, light/dark, zh-CN/en-US, 1280/380px).`);
} finally {
  await browser?.close();
  await server.close();
}
