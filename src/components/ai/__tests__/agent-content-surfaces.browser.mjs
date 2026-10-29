import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePatch } from 'diff';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const captureAll = process.argv.includes('--screenshots');
const screenshots = process.env.SHELLSPAN_SCREENSHOT_DIR ?? join(tmpdir(), 'shellspan-agent-content-surfaces');
const captures = [];
const copyRegions = '[data-ai-tool-view], .ai-markdown-code-block, .ai-approval-command, .ai-semantic-note-body, .ai-queue-notice-preview, .ai-detail-code-wrap, .ai-detail-section';
await mkdir(screenshots, { recursive: true });
const path = join(root, 'package.json');
const file = await readFile(path, 'utf8');
const codePath = 'scripts/check-ai-panel-styles.mjs';
const code = await readFile(join(root, codePath), 'utf8');
const codeOutput = execFileSync(process.execPath, [codePath], { cwd: root, encoding: 'utf8' });
const search = execFileSync('rg', ['--line-number', '.', 'package.json'], { cwd: root, encoding: 'utf8' });
const toolPath = 'src/components/ai/workspace/ai-tool-presentation.tsx';
const workingPatch = execFileSync('git', ['diff', '--', toolPath], { cwd: root, encoding: 'utf8' });
const lastRevision = execFileSync('git', ['log', '-1', '--format=%H', '--', toolPath], { cwd: root, encoding: 'utf8' }).trim();
const patch = workingPatch || execFileSync('git', ['show', '--format=', '--unified=20', lastRevision, '--', toolPath], { cwd: root, encoding: 'utf8' });
const longArgs = ['show', '--format=', '--unified=20', lastRevision, '--', toolPath, 'src/components/ai/styles/tool-results.css', 'src/components/ai/__tests__/ai-tool-presentation.test.tsx', 'src/components/ai/__tests__/ai-details-layout.test.tsx'];
const longCommand = `git ${longArgs.join(' ')}`;
const longOutput = captureAll ? execFileSync('git', longArgs, { cwd: root, encoding: 'utf8' }) : '';
assert.ok(patch.length, 'The browser check requires an actual repository patch');
const patchLines = parsePatch(patch).flatMap(file => file.hunks.flatMap(hunk => hunk.lines))
  .filter(line => !line.startsWith('\\')).length;
const guide = await readFile(join(root, 'AGENTS.md'), 'utf8');
const recovery = JSON.parse(await readFile(join(root, 'src/test/fixtures/tool-result-read-recovery.json'), 'utf8'));
const recordedTerminal = JSON.parse(await readFile(join(root, 'src/test/fixtures/terminal-unknown-execution.json'), 'utf8'));
const icon = await readFile(join(root, 'public/shellspan-icon.svg'));
const sha256 = body => createHash('sha256').update(body).digest('hex');
const assets = [
  { id: 'artifact-text', url: '/package.json', title: 'package.json', mediaType: 'application/json', sha256: sha256(file), sizeBytes: Buffer.byteLength(file), createdAtUnixMs: (await stat(path)).mtimeMs },
  { id: 'artifact-image', url: '/shellspan-icon.svg', title: 'shellspan-icon.svg', mediaType: 'image/svg+xml', sha256: sha256(icon), sizeBytes: icon.length, createdAtUnixMs: (await stat(join(root, 'public/shellspan-icon.svg'))).mtimeMs },
];
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(screenshots, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'agent-content-surfaces',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell" style="display:grid;gap:12px;padding:12px"></main></body></html>');
      });
    },
  }],
});
try {
  await server.listen();
  for (const engine of captureAll ? [chromium] : [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium ? { channel: 'chromium' } : {});
    try {
      const page = await browser.newPage(engine === chromium ? { permissions: ['clipboard-read', 'clipboard-write'] } : {});
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      for (const locale of captureAll ? ['zh-CN'] : ['zh-CN', 'en-US']) {
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
        const copyChecks = await page.evaluate(async data => {
          const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
          await import('/src/styles/base.css');
          await import('/src/components/ai/styles/styles.css');
          const { AiToolExpandedContent } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
          const { AssistantMessageContent } = await import('/src/components/ai/assistant-message-content.tsx');
          const { AiToolDetails } = await import('/src/components/ai/workspace/ai-tool-details.tsx');
          const { AiArtifactDetails } = await import('/src/components/ai/workspace/ai-artifact-details.tsx');
          const { AiApprovalPanel } = await import('/src/components/ai/workspace/ai-approval-panel.tsx');
          const { AiQueueNotice } = await import('/src/components/ai/workspace/ai-queue-notice.tsx');
          const { AiConversationNodeList } = await import('/src/components/ai/workspace/ai-conversation-node-seat.tsx');
          const { projectAgentChatNodes } = await import('/src/lib/ai/conversation-projection.ts');
          const { initI18n, t } = await import('/src/locales/index.ts');
          const { useAppStore } = await import('/src/stores/appStore.ts');
          await initI18n(data.locale);
          useAppStore.setState({ locale: data.locale });
          const response = await fetch('/package.json');
          const webBody = await response.text();
          if (webBody !== data.file) throw new Error('HTTP preview must contain the real repository file');
          const base = { kind: 'tool', state: 'succeeded', error: null, nativeName: null, target: null,
            evidenceRefs: [], durationMs: null, sourceKind: 'agent', sessionId: 'content-surfaces',
            key: 'content-surfaces', firstSeq: 1, lastSeq: 2, input: null, output: null };
          const tool = (name, input, output) => ({ ...base, name, input, output });
          const read = tool('read_file', { path: data.path }, data.file);
          const failed = projectAgentChatNodes(data.recovery.slice(0, 2))
            .flatMap(node => node.kind === 'turnProcess' ? node.children : []).find(node => node.kind === 'tool');
          const call = data.recordedTerminal.find(event => event.type === 'tool/call');
          const approval = data.recordedTerminal.find(event => event.type === 'tool/approval');
          const block = (id, content, height) => React.createElement('section', {
            key: id, id, style: { minWidth: 0, ...(height ? { height } : {}) },
          }, content);
          const expanded = node => React.createElement(AiToolExpandedContent, { node, compact: true });
          const blocks = [
            block('terminal', expanded({
              ...tool('exec_command', { command: `cat ${data.path}`, cwd: data.root }, data.file),
              target: { kind: 'local', label: data.hostname },
            })),
            block('read', expanded(read)),
            block('search', expanded(tool('search_text', { query: '.', path: data.path }, data.search))),
            block('web', expanded(tool('probe_http', { url: response.url }, { status: response.status, body: webBody }))),
            block('diff', React.createElement(AiToolExpandedContent, {
              node: tool('apply_patch', { patch: data.patch }, { diff: data.patch }),
            })),
            block('code', expanded(tool('run_code', { code: data.code, language: 'javascript' }, data.codeOutput))),
            block('generic', expanded(tool('git', { content: data.code }, data.file))),
            block('error', expanded(failed)),
            block('queue', React.createElement(AiQueueNotice, { conflict: false, error: failed.error })),
            block('markdown', React.createElement(AssistantMessageContent, {
              blocks: [{ type: 'text', text: `\u0060\u0060\u0060javascript\n${data.code}\n\u0060\u0060\u0060` }], streaming: false,
            })),
            block('approval', React.createElement(AiApprovalPanel, { approval: {
              ...approval.data, sessionId: call.sessionId, turnId: call.turnId, stepId: call.stepId,
              toolName: call.data.call.name, arguments: call.data.call.arguments, prompt: null,
              approvalId: approval.data.requestId, effect: approval.data.risk, target: null, evidenceRefs: [],
            }, decision: null, error: null, onApprove() {}, onReject() {}, onOpenDetails() {} })),
            block('notes', React.createElement(AiConversationNodeList, { nodes: [
              { ...base, kind: 'systemPrompt', key: 'guide', content: data.guide },
            ] })),
            block('details', React.createElement(AiToolDetails, { node: read, onBack() {} }), 600),
          ];
          if (data.captureAll) {
            const dispatched = data.recordedTerminal.findIndex(event => event.type === 'tool/execution' && event.data.status === 'dispatched');
            const running = projectAgentChatNodes(data.recordedTerminal.slice(0, dispatched + 1))
              .flatMap(node => node.kind === 'turnProcess' ? node.children : []).find(node => node.kind === 'tool');
            if (!running || running.state !== 'running') throw new Error('Running screenshot must use the recorded dispatched state');
            blocks.push(
              block('command-collapsed', expanded(tool('exec_command', { command: data.longCommand }, data.longOutput))),
              block('command-expanded', expanded(tool('exec_command', { command: data.longCommand }, data.longOutput))),
              block('running', expanded(running)),
            );
          }
          for (const [id, node] of [
            ['details-diff', tool('apply_patch', { patch: data.patch }, { diff: data.patch })],
            ['details-code', tool('run_code', { code: data.code, language: 'javascript' }, data.codeOutput)],
            ['details-generic', tool('git', { content: data.code }, data.file)],
          ]) {
            blocks.push(block(id, React.createElement(AiToolDetails, { node, onBack() {} }), 600));
          }
          for (const asset of data.assets) {
            blocks.push(block(asset.id, React.createElement(AiArtifactDetails, {
              sessionId: base.sessionId,
              node: { ...base, kind: 'artifact', artifactId: asset.sha256, title: asset.title, sha256: asset.sha256 },
              onBack() {},
              load: async () => {
                const bytes = new Uint8Array(await (await fetch(asset.url)).arrayBuffer());
                return { metadata: { artifactId: asset.sha256, kind: 'file', ...asset, sensitivity: 'internal' },
                  bodyBase64: btoa(String.fromCharCode(...bytes)), truncated: false };
              },
            }), 600));
          }
          createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null, ...blocks));
          return [
            ['terminal', t('ai.workspace.tool.copyCommand'), `cat ${data.path}`],
            ['terminal', t('ai.workspace.tool.copyOutput'), data.file],
            ['read', t('ai.workspace.tool.copyInput'), data.path],
            ['read', t('ai.workspace.tool.copyOutput'), data.file],
            ['search', t('ai.workspace.tool.copyOutput'), data.search],
            ['web', t('ai.workspace.tool.copyOutput'), webBody],
            ['diff', t('ai.workspace.tool.copyOutput'), data.patch],
            ['code', t('ai.workspace.tool.copyInput'), data.code],
            ['code', t('ai.workspace.tool.copyOutput'), data.codeOutput],
            ['generic', t('ai.workspace.tool.copyInput'), JSON.stringify({ content: data.code }, null, 2)],
            ['generic', t('ai.workspace.tool.copyOutput'), data.file],
            ['error', t('ai.workspace.tool.copyOutput'), failed.error],
            ['queue', t('ai.workspace.tool.copyOutput'), failed.error],
            ['notes', t('common.copy'), data.guide],
            ['approval', t('ai.workspace.tool.copyCommand'), call.data.call.arguments.command],
            ['markdown', t('common.copy'), data.code],
            ['artifact-text', t('common.copy'), JSON.stringify(JSON.parse(data.file), null, 2)],
          ];
        }, { locale, path, file, code, codeOutput, search, patch, guide, recovery, recordedTerminal, assets, captureAll, longCommand, longOutput, root, hostname: hostname() });
        await page.locator('#artifact-text .ai-detail-code-wrap').waitFor();
        await page.locator('#artifact-image img').waitFor();
        await page.locator('#notes button[aria-expanded="false"]').click();
        await page.locator('#queue button[aria-expanded="false"]').click();
        await page.locator('.ai-semantic-note-body').waitFor();
        if (captureAll) await page.locator('#command-expanded .ai-terminal-command').click();
        for (const [id, label, expected] of copyChecks) {
          const button = page.locator(`#${id}`).getByRole('button', { name: label, exact: true });
          assert.equal(await button.count(), 1, `${id}/${label}: one copy icon for each content region`);
          assert.equal(await button.locator('svg').count(), 1, `${id}/${label}: icon-only action`);
          const inHeader = await button.evaluate(element => Boolean(element.closest('.ai-tool-surface-header')));
          assert.equal(await button.evaluate(element => getComputedStyle(element).position), inHeader ? 'static' : 'absolute',
            `${id}/${label}: header actions must use the header layout and content actions must use overlays`);
          await page.evaluate(() => document.activeElement?.blur());
          await page.mouse.move(1, 1);
          assert.equal(await button.evaluate(element => getComputedStyle(element).opacity), '0', `${id}/${label}: copy icon must be hidden at rest`);
          const ownRegion = button.locator('xpath=ancestor::*[@data-ai-copy-region][1]');
          const region = await ownRegion.count() ? ownRegion : page.locator(`#${id}`).locator(copyRegions).first();
          await region.hover({ position: { x: 5, y: 5 } });
          assert.equal(await button.evaluate(element => getComputedStyle(element).opacity), '1', `${id}/${label}: hovering content must show its copy icon`);
          await page.mouse.move(1, 1);
          assert.equal(await button.evaluate(element => getComputedStyle(element).opacity), '0', `${id}/${label}: leaving content must hide its copy icon`);
          await page.keyboard.press('Tab');
          await button.focus();
          assert.equal(await button.evaluate(element => getComputedStyle(element).opacity), '1', `${id}/${label}: keyboard focus must reveal the copy icon`);
          if (engine === chromium && !captureAll) {
            await button.focus();
            const copyElement = await button.elementHandle();
            await button.press('Enter');
            const copied = page.locator(`#${id}`).getByRole('button', { name: locale === 'zh-CN' ? '已复制' : 'Copied', exact: true });
            await copied.waitFor();
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected,
              `${id}/${label}: clipboard must contain the complete original content`);
            await page.waitForFunction(({ element, label }) => element.getAttribute('aria-label') === label,
              { element: copyElement, label });
          }
        }
        assert.equal(await page.locator('#read .ai-read-line').count(), file.split('\n').length);
        assert.equal(await page.locator('#search .ai-search-result').count(), search.split('\n').filter(Boolean).length);
        assert.equal(await page.locator('#diff [data-diff]').count(), patchLines);
        for (const selector of ['#details-diff .ai-diff-block', '#details-code .ai-code-content', '#details-generic .ai-io-card']) {
          assert.equal(await page.locator(selector).evaluate(element => getComputedStyle(element).maxHeight), 'none',
            `${selector}: detail sections must own scrolling without nested height limits`);
        }
        for (const theme of ['light', 'dark']) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          for (const width of [380, 720]) {
            await page.setViewportSize({ width, height: 900 });
            const copyPositions = await page.locator('.ai-tool-copy-button, .ai-markdown-code-copy, .ai-detail-copy').evaluateAll(elements =>
              elements.map(element => ({
                position: getComputedStyle(element).position,
                inHeader: Boolean(element.closest('.ai-tool-surface-header')),
                left: element.getBoundingClientRect().left,
                right: element.getBoundingClientRect().right,
              })));
            assert.ok(copyPositions.every(button => button.position === (button.inHeader ? 'static' : 'absolute') && button.left >= 0 && button.right <= width),
              `${engine.name()}/${locale}/${theme}/${width}: copy actions must use their region's layout and stay inside the panel`);
            const terminalHeader = page.locator('#terminal .ai-terminal-header');
            assert.equal((await terminalHeader.textContent()).trim(), 'Shell', 'The Shell header must omit host and directory information');
            await page.evaluate(() => document.activeElement?.blur());
            await terminalHeader.hover();
            assert.deepEqual(await page.locator('#terminal .ai-tool-copy-button').evaluateAll(buttons => buttons.map(button => getComputedStyle(button).opacity)), ['1', '1'],
              'Hovering the Shell card must reveal both copy icons');
            for (const id of ['terminal', 'read']) {
              const regions = page.locator(`#${id} [data-ai-copy-region]`);
              assert.equal(await regions.count(), 2, `${id}: input and output each have a copy header`);
              await page.evaluate(() => document.activeElement?.blur());
              for (const index of [0, 1]) {
                await regions.nth(index).hover({ position: { x: 5, y: 5 } });
                for (const other of [0, 1]) {
                  const button = regions.nth(other).locator('.ai-tool-copy-button');
                  assert.equal(await button.evaluate(element => getComputedStyle(element).opacity), '1',
                    `${id}/${theme}/${width}: hovering the card reveals copy action ${other}`);
                }
                if (locale === 'en-US') await page.locator(`#${id}`).screenshot({ path: join(screenshots, `${engine.name()}-${theme}-${width}-${id}-region-${index}.png`) });
              }
            }
            const surfaces = await page.locator([
              '[data-ai-tool-view]', '#markdown .ai-markdown-code-block', '.ai-approval-command',
              '.ai-semantic-note-body', '.ai-queue-notice-preview', '.ai-detail-code-wrap', '.ai-artifact-image-surface', '.ai-detail-section',
            ].join(',')).evaluateAll(elements => elements.filter(element => !element.closest('.ai-detail-section [data-ai-tool-view]')).map(element => {
              const style = getComputedStyle(element);
              return { label: element.closest('section[id]').id, background: style.backgroundColor,
                border: style.borderTopWidth, borderColor: style.borderTopColor,
                radii: ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'].map(property => style[property]),
                right: element.getBoundingClientRect().right };
            }));
            const reference = surfaces.find(surface => surface.label === 'terminal');
            assert.ok(surfaces.length >= 15);
            for (const surface of surfaces) {
              assert.equal(surface.background, reference.background, `${engine.name()}/${locale}/${theme}/${width}/${surface.label}: neutral background`);
              assert.equal(surface.border, '1px', `${surface.label}: thin border`);
              assert.equal(surface.borderColor, reference.borderColor, `${surface.label}: border color`);
              assert.deepEqual(surface.radii, ['12px', '12px', '12px', '12px'], `${surface.label}: every content border must use the same corner radius`);
              assert.ok(surface.right <= width, `${surface.label}: narrow panel bounds`);
            }
            const failureStyle = await page.locator('#queue .ai-queue-failure-notice').evaluate(element => {
              const probe = document.createElement('span');
              probe.style.color = 'var(--ai-error)';
              element.append(probe);
              const expectedIconColor = getComputedStyle(probe).color;
              probe.remove();
              return {
                background: getComputedStyle(element).backgroundColor,
                neutral: getComputedStyle(document.querySelector('#details .ai-details-root')).backgroundColor,
                radius: getComputedStyle(element).borderTopLeftRadius,
                iconColor: getComputedStyle(element.querySelector(':scope > svg')).color,
                expectedIconColor,
              };
            });
            assert.equal(failureStyle.background, failureStyle.neutral, 'Queue failure must use the neutral surface');
            assert.equal(failureStyle.radius, '12px', 'Queue failure must keep the shared corner radius');
            assert.equal(failureStyle.iconColor, failureStyle.expectedIconColor, 'The error icon must retain the theme error color');
            assert.equal(await page.locator('.ai-io-divider').count(), 0, 'Tool input and output must not have a divider');
            const dividerWidths = await page.locator('.ai-block-banner, .ai-code-block-banner').evaluateAll(elements =>
              elements.map(element => getComputedStyle(element).borderBottomWidth));
            assert.ok(dividerWidths.every(width => width === '0px'), 'Tool headers and output must share an uninterrupted surface');
            const inputOutputGap = await page.locator('#generic').evaluate(element => {
              const content = element.querySelectorAll('.ai-io-text');
              return content[1].getBoundingClientRect().top - content[0].getBoundingClientRect().bottom;
            });
            assert.ok(inputOutputGap >= 20, 'Spacing must distinguish tool input from output');
            for (const selector of ['#read .ai-read-lines', '#search .ai-search-results', '#web .ai-web-content',
              '#diff .ai-diff-block', '#code .ai-code-content', '#generic .ai-io-card', '#markdown .ai-code-block-pre']) {
              const body = page.locator(selector);
              const size = await body.evaluate(element => ({ height: element.getBoundingClientRect().height,
                overflow: getComputedStyle(element).overflowY, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
              assert.ok(size.height <= 260 && size.scrollHeight > size.clientHeight, `${selector}: capped content height`);
              assert.equal(size.overflow, 'auto', `${selector}: native scrolling`);
              await body.evaluate(element => element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }));
              assert.ok(await body.evaluate(element => element.scrollTop > 0), `${selector}: final output must be reachable`);
              await body.evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
            }
            if (captureAll) {
              const views = [
                ['terminal', '命令执行', 'execution'],
                ['command-collapsed', '命令输入 · 默认两行', 'execution'],
                ['command-expanded', '命令输入 · 单击展开全部', 'execution'],
                ['running', '命令执行中', 'execution'],
                ['read', '文件读取结果', 'execution'],
                ['search', '搜索结果', 'execution'],
                ['web', '网页 / HTTP 结果', 'execution'],
                ['diff', '文件差异', 'execution'],
                ['code', '代码工具 · 输入', 'content'],
                ['code-output', '代码工具 · 输出', 'content', 'code'],
                ['generic', '通用工具 · 输入', 'content'],
                ['generic-output', '通用工具 · 输出', 'content', 'generic'],
                ['markdown', '回复中的代码块', 'content'],
                ['error', '工具错误详情', 'content'],
                ['queue', '队列错误详情', 'content'],
                ['notes', '系统说明 / 上下文内容', 'content'],
                ['approval', '审批中的命令', 'content'],
                ['details', '文件读取 · 详情页', 'details'],
                ['details-diff', '文件差异 · 详情页', 'details'],
                ['details-code', '代码工具 · 详情页', 'details'],
                ['details-generic', '通用工具 · 详情页', 'details'],
                ['artifact-text', '文本 / JSON 文件预览', 'files'],
                ['artifact-image', '图片文件预览', 'files'],
              ];
              for (const [id, label, group, source = id] of views) {
                const section = page.locator(`#${source}`);
                await page.evaluate(() => document.activeElement?.blur());
                await section.evaluate(element => {
                  for (const viewport of element.querySelectorAll('[data-slot="scroll-area-viewport"], .ai-terminal-transcript, .ai-read-lines, .ai-search-results, .ai-web-content, .ai-diff-block, .ai-code-content, .ai-io-card, .ai-semantic-note-body, .ai-queue-notice-preview, .ai-approval-command, .ai-code-block-pre')) {
                    viewport.scrollTo({ top: 0, left: 0, behavior: 'instant' });
                  }
                });
                if (id.endsWith('-output')) {
                  await section.evaluate(element => {
                    const viewport = element.querySelector('.ai-code-content, .ai-io-card');
                    const output = element.querySelector('.ai-io-section:last-child');
                    viewport.scrollTop += output.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
                  });
                }
                await page.mouse.move(1, 1);
                await page.getByRole('tooltip').waitFor({ state: 'hidden' });
                const filename = `${theme}-${width}-${id}.png`;
                await section.screenshot({ path: join(screenshots, filename) });
                captures.push({ id, label, group, theme, width, interaction: 'idle', filename });
                const region = section.locator(copyRegions).first();
                if (await region.count()) await region.hover({ position: { x: 5, y: 5 } });
                else await section.hover({ position: { x: 50, y: 5 } });
                const hoverFilename = `${theme}-${width}-${id}-hover.png`;
                await section.screenshot({ path: join(screenshots, hoverFilename) });
                captures.push({ id, label, group, theme, width, interaction: 'hover', filename: hoverFilename });
                if (id.endsWith('-output')) await section.locator('.ai-code-content, .ai-io-card').evaluate(element => { element.scrollTop = 0; });
              }
            } else if (locale === 'en-US' && ((theme === 'light' && width === 720) || (theme === 'dark' && width === 380))) {
              for (const id of ['read', 'diff', 'code', 'markdown']) {
                await page.locator(`#${id}`).screenshot({ path: join(screenshots, `${engine.name()}-${theme}-${width}-${id}.png`) });
              }
            }
          }
        }
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
  if (captureAll) {
    await writeFile(join(screenshots, 'manifest.json'), JSON.stringify({ captures }, null, 2));
    console.log(`Captured ${captures.length} screenshots across all content regions, both themes and panel widths: ${screenshots}`);
  } else {
    console.log(`Agent content surfaces, borders and capped scrolling passed in Chromium/WebKit, both languages and themes, at 380px/720px. Screenshots: ${screenshots}`);
  }
} finally {
  await server.close();
}
