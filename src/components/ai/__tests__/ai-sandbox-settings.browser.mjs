import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = path.resolve(import.meta.dirname, '../../../..');
const evidence = process.env.SHELLSPAN_NATIVE_CHECK_REPORT
  ? JSON.parse(await readFile(process.env.SHELLSPAN_NATIVE_CHECK_REPORT, 'utf8')) : undefined;
const remoteTarget = process.env.SHELLSPAN_REMOTE_SESSION_LOG
  ? JSON.parse((await readFile(process.env.SHELLSPAN_REMOTE_SESSION_LOG, 'utf8')).split('\n').find(line => line && JSON.parse(line).type === 'session/created')).data.target : undefined;
if (evidence) {
  assert.equal(evidence.coverage, 'frozen-session-native-launcher');
  assert.equal(evidence.capability.status, 'partial');
}
const server = await createServer({
  root, configFile: false, logLevel: 'error',
  resolve: { alias: { '@': path.join(root, 'src') } },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  plugins: [tailwindcss(), { name: 'sandbox-ui-review', configureServer(vite) {
    vite.middlewares.use((request, response, next) => {
      if (request.url === '/native-remote-target' && remoteTarget) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(remoteTarget));
        return;
      }
      if (request.url === '/native-sandbox-evidence' && evidence) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ capability: evidence.capability, target: evidence.contract.target }));
        return;
      }
      if (!request.url?.startsWith('/sandbox-review')) return next();
      response.setHeader('Content-Type', 'text/html');
      response.end('<html><head><script type="module" src="/src/components/ai/__tests__/ai-sandbox-settings.browser-entry.tsx"></script></head><body><div id="root"></div></body></html>');
    });
  } }], server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await webkit.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [1280, 400, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 480 : 800 });
      await page.goto(`${server.resolvedUrls.local[0]}sandbox-review?locale=${locale}${evidence ? '&native=1' : ''}`);
      const trigger = page.getByRole('button', { name: locale === 'zh-CN' ? '会话设置' : 'Session settings' });
      await trigger.waitFor();
      const geometry = await trigger.evaluate(button => {
        const header = button.closest('.ai-session-header');
        const toolbar = document.querySelector('.ai-composer-toolbar');
        const icon = button.querySelector('svg').getBoundingClientRect();
        const neighbor = header.querySelector('button:last-child svg');
        const svg = button.querySelector('svg');
        return { height: button.getBoundingClientRect().height, overflow: toolbar.scrollWidth > toolbar.clientWidth || header.scrollWidth > header.clientWidth, inToolbar: toolbar.contains(button),
          iconSize: [icon.width, icon.height], neighborSize: [neighbor.getBoundingClientRect().width, neighbor.getBoundingClientRect().height],
          stroke: svg.getAttribute('stroke-width'), neighborStroke: neighbor.getAttribute('stroke-width'),
          color: getComputedStyle(svg).color, neighborColor: getComputedStyle(neighbor).color,
        };
      });
      assert.equal(geometry.height, 28);
      assert.equal(geometry.overflow, false);
      assert.deepEqual(geometry.iconSize, [16, 16]);
      assert.deepEqual(geometry.iconSize, geometry.neighborSize);
      assert.equal(geometry.stroke, geometry.neighborStroke);
      assert.equal(geometry.color, geometry.neighborColor);
      assert.equal(geometry.inToolbar, false, 'Policy belongs in session settings, not the composer toolbar');
      await trigger.hover();
      const tooltip = page.locator('[data-slot="tooltip-content"]');
      await tooltip.waitFor();
      assert.equal(await tooltip.innerText(), locale === 'zh-CN' ? '会话设置' : 'Session settings');
      await page.mouse.move(width / 2, 200);
      await trigger.focus();
      await page.keyboard.press('Enter');
      const popup = page.getByRole('dialog');
      await popup.waitFor();
      const bounds = await popup.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'Popover fits narrow viewport');
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize().height, 'Popover stays within viewport height');
      await page.screenshot({ path: `/tmp/shellspan-sandbox-workspace-${locale}-${width}.png`, animations: 'disabled' });
      const select = page.getByRole('combobox');
      await select.focus();
      await page.keyboard.press('ArrowDown');
      await page.getByRole('option', { name: locale === 'zh-CN' ? '主机运维' : 'Host operations' }).waitFor();
      const readOnlyOption = page.getByRole('option', { name: locale === 'zh-CN' ? '只读检查' : 'Read-only inspection' });
      if (evidence) {
        assert.notEqual(await readOnlyOption.getAttribute('aria-disabled'), 'true');
        await readOnlyOption.press('Enter');
        await page.getByText(locale === 'zh-CN' ? '原生命令默认禁止网络' : 'Native commands deny network by default').waitFor();
        assert.equal(await popup.getByText(locale === 'zh-CN' ? '部分限制有效' : 'Partially enforced', { exact: true }).count(), 1);
        await select.focus();
        await page.keyboard.press('ArrowDown');
      } else {
        assert.equal(await readOnlyOption.getAttribute('aria-disabled'), 'true');
      }
      await page.getByRole('option', { name: locale === 'zh-CN' ? '主机运维' : 'Host operations' }).press('Enter');
      try {
        await page.getByText(locale === 'zh-CN' ? /未启用文件与网络隔离/ : /File and network isolation are not enabled/).waitFor({ timeout: 3000 });
      } catch (error) {
        await page.screenshot({ path: '/tmp/shellspan-sandbox-failure.png' });
        throw new Error(`${locale}/${width}: ${await page.locator('body').innerText()}`, { cause: error });
      }
      await page.screenshot({ path: `/tmp/shellspan-sandbox-${locale}-${width}.png`, animations: 'disabled' });
      await page.keyboard.press('Escape');
      await page.waitForFunction(label => document.activeElement?.getAttribute('aria-label') === label,
        locale === 'zh-CN' ? '会话设置' : 'Session settings');
      assert.equal(await page.getByRole('button', { name: locale === 'zh-CN' ? '会话设置' : 'Session settings' }).evaluate(button => button === document.activeElement), true, 'Focus returns to policy trigger');
      const executionTrigger = page.getByRole('button', { name: locale === 'zh-CN' ? /^执行方式:/ : /^Execution method:/ });
      await page.mouse.move(0, 200);
      await executionTrigger.hover();
      await page.locator('[data-slot="tooltip-content"]').filter({ hasText: locale === 'zh-CN' ? '执行方式:' : 'Execution method:' }).waitFor();
      await executionTrigger.click();
      const executionMenu = page.getByRole('menu');
      await executionMenu.waitFor();
      assert.equal(await executionMenu.locator('[data-slot="dropdown-menu-label"]').innerText(), locale === 'zh-CN' ? '执行方式' : 'Execution method');
      await page.keyboard.press('Escape');
      await page.evaluate(async () => {
        const entry = await import('/src/components/ai/__tests__/ai-sandbox-settings.browser-entry.tsx');
        entry.showApprovalMenu();
      });
      const approvalMenu = page.getByRole('menu');
      await approvalMenu.waitFor();
      assert.equal(await approvalMenu.locator('[data-slot="dropdown-menu-label"]').innerText(), locale === 'zh-CN' ? '操作审批' : 'Operation approval');
      assert.equal(await approvalMenu.getByRole('menuitem').count(), 3);
      const approvalBounds = await approvalMenu.boundingBox();
      assert.ok(approvalBounds.x >= 0 && approvalBounds.x + approvalBounds.width <= width, 'Approval menu fits narrow viewport');
      await page.screenshot({ path: `/tmp/shellspan-approval-${locale}-${width}.png`, animations: 'disabled' });
      await page.keyboard.press('Escape');
    }
  }
  for (const locale of ['zh-CN', 'en-US']) {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto(`${server.resolvedUrls.local[0]}sandbox-review?locale=${locale}${evidence ? '&native=1' : ''}`);
    await page.getByRole('button', { name: locale === 'zh-CN' ? '会话设置' : 'Session settings' }).click();
    await page.getByRole('button', { name: locale === 'zh-CN' ? '选择项目目录' : 'Choose project directory' }).click();
    const rootDialog = page.getByRole('dialog', {name:locale === 'zh-CN' ? '选择项目目录' : 'Choose project directory'});
    const input = rootDialog.locator('input');
    await input.fill(root);
    await page.keyboard.press('Enter');
    await rootDialog.waitFor({state:'hidden'});
    await page.getByRole('button', { name: locale === 'zh-CN' ? '会话设置' : 'Session settings' }).click();
    if (evidence) await page.getByText(root, {exact:true}).waitFor();
    await page.screenshot({path:`/tmp/shellspan-root-selection-${locale}-360.png`,animations:'disabled'});
    if (remoteTarget) {
      await page.goto(`${server.resolvedUrls.local[0]}sandbox-review?locale=${locale}&remote=1`);
      await page.getByRole('button', {name:locale === 'zh-CN' ? '会话设置' : 'Session settings'}).click();
      await page.getByRole('button', {name:locale === 'zh-CN' ? '验证远端执行环境' : 'Verify remote execution environment'}).click();
      await page.getByText(locale === 'zh-CN' ? /远端验证失败/ : /Remote verification failed/).waitFor();
      assert.equal(await page.getByText(locale === 'zh-CN' ? '部分限制有效' : 'Partially enforced',{exact:true}).count(),0);
      await page.screenshot({path:`/tmp/shellspan-remote-verification-${locale}-360.png`,animations:'disabled'});
    }
  }
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await server.close(); }
