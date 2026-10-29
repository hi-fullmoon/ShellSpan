import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const screenshots = join(tmpdir(), 'shellspan-question-submission-recovery');
await mkdir(screenshots, { recursive: true });
const diagnostics = [
  'network connection lost', 'question cannot bypass required recovery reconciliation',
  'question was cancelled', 'question Session has ended', 'unknown or stale question identity',
  'question answer conflicts with its committed answer', 'unknown answer id',
  'UNKNOWN_ROUTE: removed-provider', `storage error: ${'unable to read session records; '.repeat(100)}`,
];
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'question-submission-recovery',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell @container/ai-workspace" style="height:100vh;display:flex;flex-direction:column;justify-content:flex-end"></main></body></html>');
      });
    },
  }],
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium ? { channel: 'chromium' } : {});
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      for (const locale of ['zh-CN', 'en-US']) {
        for (const width of [380, 720]) {
          await page.setViewportSize({ width, height: 600 });
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
          await page.evaluate(async locale => {
            const { default: React } = await import('/node_modules/.vite/deps/react.js');
            const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
            await import('/src/styles/base.css');
            await import('/src/components/ai/styles/styles.css');
            const { AiQuestionPanel } = await import('/src/components/ai/workspace/ai-question-panel.tsx');
            const { questionSubmissionIssue } = await import('/src/lib/ai/question-submission.ts');
            const { useAgentQuestionStore } = await import('/src/stores/agentQuestionStore.ts');
            const { questionKey } = await import('/src/types/agent-question.ts');
            const { initI18n } = await import('/src/locales/index.ts');
            const { useAppStore } = await import('/src/stores/appStore.ts');
            await initI18n(locale);
            useAppStore.setState({ locale });
            const question = {
              identity: { sessionId: 'question-layout', turnId: 'turn', stepId: 'step', requestId: 'request', callId: 'call', questionRequestId: 'question' },
              questions: [{ id: 'retest', header: 'Live re-test', question: locale === 'zh-CN'
                ? '实时端到端复测（iptables -S + curl 走 SOCKS 10808 隧道 + 外网端口探测）目前被运行时的执行门禁挡住。你希望怎么继续？'
                : 'The live end-to-end re-test (iptables -S, curl through SOCKS 10808, and external port checks) is blocked by the runtime execution gate. How would you like to continue?', multi_select: false }],
              status: 'pending', answers: [], firstSeq: 1, lastSeq: 1, timestamp: '2026-10-29T00:00:00Z',
            };
            const submission = { identity: question.identity, clientOperationId: crypto.randomUUID(), answers: [{ id: 'retest', selected: [], custom: 'Retry the checks' }] };
            const view = ReactDOM.createRoot(document.getElementById('root'));
            // Render the production form from retained failure state; no runtime or command result is simulated.
            window.showQuestionFailure = diagnostic => {
              const issue = questionSubmissionIssue(diagnostic);
              useAgentQuestionStore.getState().setDraft(questionKey(question.identity), { answers: submission.answers, submission, issue });
              view.render(React.createElement(AiQuestionPanel, {
                key: diagnostic, question,
                onAnswer: async () => { throw new Error('Rendering checks must not submit answers'); },
                onRefresh: async () => { throw new Error('Rendering checks must not refresh a runtime'); },
                onOpenSettings: () => { document.getElementById('root').dataset.settingsOpened = 'true'; },
              }));
              return issue;
            };
          }, locale);
          for (const diagnostic of diagnostics) {
            const issue = await page.evaluate(diagnostic => window.showQuestionFailure(diagnostic), diagnostic);
            const alert = page.locator(`[data-question-error="${issue.reason}"]`);
            await alert.waitFor();
            assert.ok((await alert.textContent()).includes(issue.detail));
            const refresh = page.getByRole('button', { name: locale === 'zh-CN' ? '刷新状态' : 'Refresh status', exact: true });
            const retry = page.getByRole('button', { name: locale === 'zh-CN' ? '重试原答案' : 'Retry same answers', exact: true });
            assert.equal(await retry.count(), Number(issue.retry));
            assert.ok(await refresh.isEnabled());
            const buttons = page.locator('.ai-question-footer-actions button');
            const bounds = await buttons.evaluateAll(elements => elements.map(element => {
              const rect = element.getBoundingClientRect();
              return { left: rect.left, right: rect.right, bottom: rect.bottom, height: rect.height };
            }));
            assert.ok(bounds.every(rect => rect.left >= 0 && rect.right <= width && rect.bottom <= 600), `${engine.name()}/${locale}/${width}/${issue.reason}: recovery actions must fit the panel: ${JSON.stringify(bounds)}`);
            assert.ok(bounds.every(rect => Math.abs(rect.height - bounds[0].height) < 1));
            const content = page.locator('.ai-question-panel-content');
            assert.ok(await content.evaluate(element => element.clientHeight >= 32), 'The question body must retain usable scroll space');
            assert.ok(await page.locator('[data-slot="ai-question-panel"]').evaluate(element => element.scrollWidth <= element.clientWidth));
            await content.evaluate(element => { element.scrollTop = element.scrollHeight; });
            const reason = alert.locator('pre');
            assert.ok(await reason.isVisible());
            await reason.focus();
            assert.ok(await reason.evaluate(element => document.activeElement === element));
            await page.screenshot({ path: join(screenshots, `${engine.name()}-${locale}-${width}-${issue.reason}.png`) });
            if (issue.editable) {
              await page.getByRole('button', { name: locale === 'zh-CN' ? '修改答案' : 'Edit answers', exact: true }).click();
              assert.ok(await page.getByRole('textbox').isEnabled());
              assert.equal(await alert.count(), 0);
            }
            if (issue.reason === 'model') {
              await page.getByRole('button', { name: locale === 'zh-CN' ? '模型设置' : 'Model settings', exact: true }).click();
              assert.equal(await page.locator('#root').getAttribute('data-settings-opened'), 'true');
            }
          }
        }
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  }
  console.log(`Question recovery rendering passed in Chromium/WebKit, both languages, at 380px/720px. Screenshots: ${screenshots}`);
} finally { await server.close(); }
