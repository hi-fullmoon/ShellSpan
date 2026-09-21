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
