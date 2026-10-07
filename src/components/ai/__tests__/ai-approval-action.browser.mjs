import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = '/src/components/ai/__tests__/ai-approval-action.browser-entry.tsx';
const server = await createServer({ root, configFile: false, appType: 'custom',
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src/` } },
  server: { host: '127.0.0.1', port: 0 } });
server.middlewares.use('/approval', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/approval', `<html><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));
});
await server.listen();
const approval = {
  sessionId: 'approval-render', turnId: 'turn', stepId: 'step', requestId: 'request',
  callId: 'call', approvalId: 'approval', risk: 'readOnly', effect: 'readOnly',
  prompt: 'Session task: list directory\nNative effect: readOnly', reason: null,
  expiresAtUnixMs: null, toolName: 'list_directory', evidenceRefs: [],
  target: { kind: 'remote', targetId: 'remote', sessionId: 'terminal', host: '175.178.66.45' },
  arguments: { path: '/apps/for-you' },
};
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [360, 760]) {
        const page = await browser.newPage({ viewport: { width, height: 720 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/approval`);
        const show = (changes = {}, locale = 'zh-CN') => page.evaluate(async args => {
          const { show } = await import(args.entry);
          await show(args.approval, args.locale);
        }, { entry, approval: { ...approval, ...changes }, locale });
        await show();
        const action = page.locator('[data-slot="ai-approval-action"]');
        await page.getByText('列出目录内容', { exact: true }).waitFor();
        assert.ok(await action.getByText('/apps/for-you', { exact: true }).isVisible());
        assert.ok(await page.getByText('175.178.66.45', { exact: true }).isVisible());
        assert.equal(await page.locator('#ai-approval-title').evaluate(el => el === document.activeElement), true);
        await page.screenshot({ path: `/tmp/ai-approval-action-${engine.name()}-${width}.png` });
        for (const [label, expected] of [['查看技术详情', 'details'], ['取消', 'reject'], ['允许执行一次', 'approve']]) {
          await page.getByRole('button', { name: label, exact: true }).click();
          assert.equal(await page.locator('body').getAttribute('data-action'), expected);
        }
        await show({}, 'en-US');
        await page.getByText('List directory contents', { exact: true }).waitFor();
        for (const [toolName, label] of [['read_file', '读取文件'], ['write_file', '写入文件'], ['edit_file', '编辑文件'], ['search_text', '搜索文件名或文件内容']]) {
          await show({ toolName, arguments: { path: '/apps/for-you', query: 'TODO' } });
          await page.getByText(label, { exact: true }).waitFor();
          assert.ok(await action.getByText('/apps/for-you', { exact: true }).isVisible());
          if (toolName === 'search_text') assert.ok(await page.getByText('搜索内容：TODO', { exact: true }).isVisible());
        }
        await show({ toolName: 'custom_tool', arguments: null, target: null });
        await page.getByText('调用工具：custom_tool', { exact: true }).waitFor();
        await show({ toolName: 'run_terminal_command', arguments: { command: 'pwd' } });
        assert.equal(await action.count(), 0);
        assert.ok(await page.getByText('pwd', { exact: true }).isVisible());
        assert.ok(await page.getByText('此命令尚无沙箱隔离，将以当前账户权限执行，可能影响工作目录之外的数据。', { exact: true }).isVisible());
        for (const locale of ['zh-CN', 'en-US']) {
          await show({approvalId:`resource-${locale}-${width}`,toolName:'run_terminal_command', target:{kind:'local',targetId:'local',sessionId:'terminal',cwd:'/project'},
            sandboxCapability:{status:'partial',files:true,network:true,processLifecycle:false,gaps:[]},
            arguments:{command:'cat .env.production',readPaths:['/project/.env.production']}}, locale);
          await page.getByText(locale === 'zh-CN' ? '文件读取授权：仅本次前台执行' : 'File read authorization: this foreground call only', {exact:true}).waitFor();
          assert.ok(await page.getByText('/project/.env.production', {exact:true}).isVisible());
          const scope = page.getByRole('combobox', {name:locale === 'zh-CN' ? '文件授权范围' : 'File authorization scope'});
          await scope.click();
          await page.getByRole('option', {name:locale === 'zh-CN' ? '当前会话' : 'Current session',exact:true}).click();
          await page.getByText(locale === 'zh-CN' ? '文件读取授权：当前会话' : 'File read authorization: current session', {exact:true}).waitFor();
          assert.equal(await page.getByText('此命令尚无沙箱隔离，将以当前账户权限执行，可能影响工作目录之外的数据。', {exact:true}).count(), 0);
          const panel = page.locator('[data-slot="ai-approval-panel"]');
          const bounds = await panel.boundingBox();
          assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
          await page.screenshot({path:`/tmp/ai-resource-read-${engine.name()}-${locale}-${width}.png`});
          await show({approvalId:`network-${locale}-${width}`,toolName:'run_terminal_command',target:{kind:'local',targetId:'local',sessionId:'terminal',cwd:'/project'},
            sandboxCapability:{status:'partial',files:true,network:true,processLifecycle:false,gaps:[]},
            arguments:{command:'pnpm view react version',networkTargets:[{host:'registry.npmjs.org',port:443,resolver:'cloudflare'}]}},locale);
          await page.getByText(locale === 'zh-CN' ? '本次执行的网络目标授权' : 'Network target authorization for this execution',{exact:true}).waitFor();
          assert.ok(await page.getByText('registry.npmjs.org:443',{exact:true}).isVisible());
          assert.ok(await page.getByText(locale === 'zh-CN' ? '允许将此主机名发送至 Cloudflare 加密 DNS 解析；仍拒绝非公网地址。' : 'Permit sending this hostname to Cloudflare encrypted DNS. Non-public results remain denied.',{exact:true}).isVisible());
          const networkScope = page.getByRole('combobox',{name:locale === 'zh-CN' ? '资源授权范围' : 'Resource authorization scope'});
          await networkScope.click();
          await page.getByRole('option',{name:locale === 'zh-CN' ? '当前会话' : 'Current session',exact:true}).click();
          await page.getByText(locale === 'zh-CN' ? '当前会话的网络目标授权' : 'Network target authorization for this session',{exact:true}).waitFor();
          await page.screenshot({path:`/tmp/ai-network-grant-${engine.name()}-${locale}-${width}.png`});
          await show({approvalId:`cache-${locale}-${width}`,callId:`cache-${locale}-${width}`,toolName:'run_terminal_command',target:{kind:'local',targetId:'local',sessionId:'terminal',cwd:'/project'},
            sandboxCapability:{status:'partial',files:true,network:true,processLifecycle:false,gaps:[]},
            arguments:{command:'pnpm build',writePaths:['/tmp/owned-project-cache']}},locale);
          await page.getByText(locale === 'zh-CN' ? '本次执行的缓存目录读写授权' : 'Cache directory read/write authorization for this execution',{exact:true}).waitFor();
          assert.ok(await page.getByText('/tmp/owned-project-cache',{exact:true}).isVisible());
          assert.equal(await page.locator('#ai-approval-title').evaluate(el => el === document.activeElement), true);
          const cacheScope = page.getByRole('combobox',{name:locale === 'zh-CN' ? '资源授权范围' : 'Resource authorization scope'});
          await cacheScope.focus();
          await page.keyboard.press('ArrowDown');
          await page.getByRole('option',{name:locale === 'zh-CN' ? '当前会话' : 'Current session',exact:true}).press('Enter');
          await page.getByText(locale === 'zh-CN' ? '当前会话的缓存目录读写授权' : 'Cache directory read/write authorization for this session',{exact:true}).waitFor();
          const cacheGeometry = await panel.evaluate(element => {
            const footer = element.querySelector('[data-slot="card-footer"]').getBoundingClientRect();
            return {overflow:element.scrollWidth > element.clientWidth,bottom:footer.bottom,viewport:innerHeight};
          });
          assert.equal(cacheGeometry.overflow,false);
          assert.ok(cacheGeometry.bottom <= cacheGeometry.viewport);
          await page.screenshot({path:`/tmp/ai-resource-cache-${engine.name()}-${locale}-${width}.png`});
        }
        await show({ toolName: 'trash_file', risk: 'destructive', effect: 'destructive',
          target: { kind: 'local', targetId: 'local', sessionId: 'terminal', label: '本机' },
          arguments: { path: '/workspace/old-config.json', expectedSha256: 'a'.repeat(64) } });
        const trashButton = page.getByRole('button', { name: '移入系统回收站', exact: true });
        assert.ok(await trashButton.isVisible());
        assert.ok(await page.getByText('可从回收站恢复', { exact: true }).isVisible());
        assert.equal(await page.getByText('可能造成数据丢失', { exact: true }).count(), 0);
        assert.ok(await page.getByText('仅移动此普通文件，执行前会重新核对内容。可从系统回收站恢复；失败不会改用永久删除。', { exact: true }).isVisible());
        assert.equal(await page.getByText('这项操作可能删除或覆盖数据，执行后可能难以撤销。', { exact: true }).count(), 0);
        await trashButton.click();
        assert.equal(await page.locator('body').getAttribute('data-action'), 'approve');
        await page.screenshot({ path: `/tmp/ai-trash-approval-${engine.name()}-${width}.png` });
        await show({ toolName: 'write_terminal_input', arguments: { inputKind: 'text', contentPersisted: false } });
        assert.equal(await page.getByRole('button', { name: '允许执行一次', exact: true }).isDisabled(), true);
        const longPath = '/apps/' + 'directory/'.repeat(100);
        await show({ arguments: { path: longPath } });
        const geometry = await page.locator('[data-slot="ai-approval-panel"]').evaluate(panel => {
          const footer = panel.querySelector('[data-slot="card-footer"]').getBoundingClientRect();
          return { overflow: panel.scrollWidth > panel.clientWidth, bottom: footer.bottom,
            viewport: innerHeight, text: panel.querySelector('code').textContent };
        });
        assert.equal(geometry.overflow, false, `Approval overflows at ${width}px`);
        assert.ok(geometry.bottom <= geometry.viewport, 'Approval controls must stay within viewport');
        assert.equal(geometry.text, longPath, 'The approval path must not be truncated');
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
