import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const stylePaths = execFileSync('git', ['ls-files', 'src/components/ai/styles'], { cwd: root, encoding: 'utf8' }).trimEnd().split('\n');
const longCommand = ['git ls-files --', ...stylePaths].join(' \\\n  ');
const entry = '/src/components/ai/__tests__/ai-approval-action.browser-entry.tsx';
const server = await createServer({ root, configFile: false, appType: 'custom',
  optimizeDeps: { entries: [entry.slice(1)] },
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src/` } },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
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
        const page = await browser.newPage({ viewport: { width, height: 720 },
          permissions: engine === chromium ? ['clipboard-read', 'clipboard-write'] : [],
        });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/approval`);
        const show = (changes = {}, locale = 'zh-CN') => page.evaluate(async args => {
          const { show } = await import(args.entry);
          await show(args.approval, args.locale);
        }, { entry, approval: { ...approval, ...changes }, locale });
        await show();
        for (const dark of [false, true]) {
          await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark);
          assert.ok(await page.locator('span.text-app-warning[aria-hidden="true"]').evaluate(el => {
            const probe = document.createElement('span');
            probe.style.color = 'var(--app-warning)';
            el.append(probe);
            const matches = getComputedStyle(el).color === getComputedStyle(probe).color;
            probe.remove();
            return matches;
          }), 'Approval icon must use the theme warning color');
        }
        await page.evaluate(() => document.documentElement.classList.remove('dark'));
        const action = page.locator('[data-slot="ai-approval-action"]');
        const checkImpactAlignment = async () => {
          const geometry = await page.getByRole('note').evaluate(el => {
            const icon = el.querySelector(':scope > svg').getBoundingClientRect();
            const text = el.querySelector('[data-slot="alert-description"] > span');
            const box = text.getBoundingClientRect();
            return { offset: icon.y + icon.height / 2 - box.y - parseFloat(getComputedStyle(text).lineHeight) / 2,
              gap: box.x - icon.right, overflow: el.scrollWidth > el.clientWidth };
          });
          assert.equal(geometry.offset, 0, 'Impact icon aligns with the first text line');
          assert.equal(geometry.gap, 4);
          assert.equal(geometry.overflow, false);
        };
        await page.getByText('列出目录内容', { exact: true }).waitFor();
        assert.ok(await action.getByText('/apps/for-you', { exact: true }).isVisible());
        assert.ok(await page.getByText('175.178.66.45', { exact: true }).isVisible());
        assert.equal(await page.locator('#ai-approval-title').evaluate(el => el === document.activeElement), true);
        await page.screenshot({ path: `/tmp/ai-approval-action-${engine.name()}-${width}.png` });
        await checkImpactAlignment();
        for (const [label, expected] of [['查看技术详情', 'details'], ['取消', 'reject'], ['允许执行一次', 'approve']]) {
          await page.getByRole('button', { name: label, exact: true }).click();
          assert.equal(await page.locator('body').getAttribute('data-action'), expected);
        }
        await show({}, 'en-US');
        await page.getByText('List directory contents', { exact: true }).waitFor();
        await checkImpactAlignment();
        for (const [toolName, label] of [['read_file', '读取文件'], ['write_file', '写入文件'], ['edit_file', '编辑文件'], ['search_text', '搜索文件名或文件内容']]) {
          await show({ toolName, arguments: { path: '/apps/for-you', query: 'TODO' } });
          await page.getByText(label, { exact: true }).waitFor();
          assert.ok(await action.getByText('/apps/for-you', { exact: true }).isVisible());
          if (toolName === 'search_text') assert.ok(await page.getByText('搜索内容：TODO', { exact: true }).isVisible());
        }
        const vimMetadata = { path: '/apps/for-you/notes.txt', position: 'start', textProvided: true, contentPersisted: false };
        await show({ toolName: 'insert_vim_text', risk: 'stateChange', arguments: vimMetadata });
        assert.ok(await page.getByRole('button', { name: '允许执行一次', exact: true }).isDisabled());
        const vimText = '夜坐\n:write\n';
        await show({ toolName: 'insert_vim_text', risk: 'stateChange', arguments: { ...vimMetadata, text: vimText } });
        await page.getByText('待插入文本（转义显示）', { exact: true }).waitFor();
        assert.ok(await action.getByText(vimMetadata.path, { exact: true }).isVisible());
        assert.ok(await page.getByText(JSON.stringify(vimText), { exact: true }).isVisible());
        assert.ok(await page.getByRole('button', { name: '允许执行一次', exact: true }).isEnabled());
        await show({ toolName: 'save_vim_buffer', risk: 'stateChange', arguments: { path: vimMetadata.path } }, 'en-US');
        await page.getByText('Save entire editor buffer, including existing changes', { exact: true }).waitFor();
        await show({ toolName: 'custom_tool', arguments: null, target: null });
        await page.getByText('调用工具：custom_tool', { exact: true }).waitFor();
        await show({ toolName: 'run_terminal_command', arguments: { command: 'pwd' } });
        assert.equal(await action.count(), 0);
        assert.ok(await page.getByText('pwd', { exact: true }).isVisible());
        assert.ok(await page.getByText('此命令尚无沙箱隔离，将以当前账户权限执行，可能影响工作目录之外的数据。', { exact: true }).isVisible());
        const commandCard = page.locator('.ai-approval-command-card');
        const fade = commandCard.locator('.ai-native-code-fade');
        assert.equal(await fade.isVisible(), false, 'A short command must stay clear');
        for (const [locale, theme, heading, copyLabel, cancelLabel, approveLabel] of [
          ['zh-CN', 'light', '将执行', '复制命令', '取消', '允许执行一次'],
          ['en-US', 'dark', 'Command', 'Copy command', 'Cancel', 'Allow once'],
        ]) {
          const context = `${engine.name()}/${width}/${locale}`;
          await page.mouse.move(0, 0);
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          await show({ toolName: 'run_terminal_command', arguments: { command: longCommand } }, locale);
          assert.equal(await commandCard.locator('.ai-content-header').textContent(), heading);
          const viewport = commandCard.locator('pre');
          assert.equal(await viewport.textContent(), longCommand, `${context}: the complete command must be shown`);
          assert.equal(await viewport.getAttribute('aria-label'), heading);
          assert.equal(await viewport.evaluate(element => getComputedStyle(element).whiteSpace), 'pre-wrap');
          const footer = page.locator('.ai-approval-panel-footer');
          const approve = footer.getByRole('button', { name: approveLabel, exact: true });
          const { color, background, warning } = await approve.evaluate(async element => {
            await Promise.allSettled(element.getAnimations().map(animation => animation.finished));
            const style = getComputedStyle(element);
            const icon = element.closest('.ai-approval-panel').querySelector('.text-app-warning');
            return { color: style.color, background: style.backgroundColor, warning: getComputedStyle(icon).color };
          });
          if (theme === 'dark') {
            assert.equal(color, 'rgb(255, 255, 255)', `${context}: Allow once uses white text in dark mode`);
            const contrast = await approve.evaluate(element => {
              const canvas = document.createElement('canvas').getContext('2d');
              canvas.fillStyle = getComputedStyle(element).backgroundColor;
              canvas.fillRect(0, 0, 1, 1);
              const [red, green, blue] = Array.from(canvas.getImageData(0, 0, 1, 1).data, value => {
                const channel = value / 255;
                return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
              });
              return 1.05 / (0.2126 * red + 0.7152 * green + 0.0722 * blue + 0.05);
            });
            assert.ok(contrast >= 4.5, `${context}: white text contrast was ${contrast.toFixed(2)}:1`);
            assert.notEqual(background, warning, `${context}: only the button uses the darker warning fill`);
          } else {
            assert.equal(background, warning, `${context}: light mode keeps the warning fill`);
          }
          const footerBefore = await footer.boundingBox();
          await fade.waitFor({ state: 'visible' });
          await viewport.focus();
          assert.equal(await viewport.getAttribute('tabindex'), '0', `${context}: preview remains keyboard scrollable`);
          await viewport.evaluate(element => element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }));
          await fade.waitFor({ state: 'hidden' });
          assert.ok(await viewport.evaluate(element => element.scrollTop > 0), `${context}: the last command line is reachable`);
          assert.deepEqual(await footer.boundingBox(), footerBefore, `${context}: approval controls stay fixed`);
          await viewport.evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
          await fade.waitFor({ state: 'visible' });
          if (engine === chromium) {
            await commandCard.getByRole('button', { name: copyLabel, exact: true }).press('Enter');
            await page.waitForFunction(expected => navigator.clipboard.readText().then(value => value === expected), longCommand);
          }
          for (const [label, expected] of [[cancelLabel, 'reject'], [approveLabel, 'approve']]) {
            await footer.getByRole('button', { name: label, exact: true }).click();
            assert.equal(await page.locator('body').getAttribute('data-action'), expected);
          }
          await commandCard.locator('.ai-content-header').scrollIntoViewIfNeeded();
          await page.screenshot({ path: `/tmp/ai-approval-command-${engine.name()}-${width}-${theme}.png` });
        }
        await page.evaluate(() => { delete document.documentElement.dataset.theme; });
        for (const [locale, approvalLabel, title, passwordLabel, submitLabel] of [
          ['zh-CN', '批准并执行', '需要提权执行器认证', '执行器 SSH 密码', '认证并继续'],
          ['en-US', 'Approve and run', 'Elevation runner authentication required', 'Runner SSH password', 'Authenticate and continue'],
        ]) {
          const sudoApproval = { ...approval, toolName: 'run_terminal_command', risk: 'stateChange',
            target: { ...approval.target, host: '127.0.0.1', port: 22222, username: 'shellspan' },
            arguments: { command: '/usr/local/libexec/shellspan-sudo-jobs/effective-user', elevated: true,
              sudoOperation: { id: 'effective-user', runnerUsername: 'shellspan-runner', runnerPort: 22225 } } };
          await page.evaluate(async ({ entry, sudoApproval, locale }) => {
            const { showSudo } = await import(entry);
            await showSudo(sudoApproval, locale);
          }, { entry, sudoApproval, locale });
          const approve = page.getByRole('button', { name: approvalLabel, exact: true });
          assert.ok(await page.getByText('sudo -- /usr/local/libexec/shellspan-sudo-jobs/effective-user', { exact: true }).isVisible());
          assert.ok(await page.getByText(/shellspan-runner@127\.0\.0\.1:22225/).isVisible());
          await approve.click();
          const dialog = page.getByRole('dialog', { name: title });
          const password = dialog.getByLabel(passwordLabel, { exact: true });
          await password.waitFor();
          assert.equal(await password.getAttribute('type'), 'password');
          assert.ok(await dialog.getByText(/shellspan-runner@127\.0\.0\.1:22225/).isVisible());
          await page.waitForFunction(el => el === document.activeElement, await password.elementHandle());
          assert.ok(await dialog.getByRole('button', { name: submitLabel, exact: true }).isVisible());
          const box = await dialog.boundingBox();
          assert.ok(box.x >= 0 && box.x + box.width <= width && box.y + box.height <= 720);
          await password.press('Escape');
          await dialog.waitFor({ state: 'hidden' });
          assert.equal(await page.locator('body').getAttribute('data-action'), 'approval:cancel');
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
        await page.setViewportSize({ width, height: 520 });
        await page.evaluate(async args => {
          const { showComposer } = await import(args.entry);
          await showComposer(args.approval);
        }, { entry, approval: { ...approval, arguments: { path: longPath } } });
        const multilineDraft = Array.from({ length: 20 }, (_, index) => `草稿第 ${index + 1} 行`).join('\n');
        await page.locator('[data-composer-editor]').fill(multilineDraft);
        const composerGeometry = await page.locator('[data-composer-seat]').evaluate(seat => {
          const panel = seat.querySelector('[data-slot="ai-approval-panel"]').getBoundingClientRect();
          const input = seat.querySelector('[data-composer-card]').getBoundingClientRect();
          const footer = seat.querySelector('[data-slot="card-footer"]').getBoundingClientRect();
          return { top: panel.top, panelBottom: panel.bottom, inputTop: input.top,
            inputBottom: input.bottom, footerBottom: footer.bottom, height: innerHeight };
        });
        assert.ok(composerGeometry.top >= 0 && composerGeometry.inputBottom <= composerGeometry.height,
          `Approval and input must fit together at ${width}x520: ${JSON.stringify(composerGeometry)}`);
        assert.ok(composerGeometry.panelBottom <= composerGeometry.inputTop, 'Approval must be above the input');
        assert.ok(composerGeometry.footerBottom <= composerGeometry.height, 'Approval actions must remain visible');
        assert.equal(await page.locator('[data-composer-editor]').textContent(), multilineDraft);
        const editorGeometry = await page.locator('[data-composer-editor]').evaluate(el => {
          el.scrollTop = el.scrollHeight;
          return { height: el.clientHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
        });
        assert.ok(editorGeometry.height > 0 && editorGeometry.scrollHeight > editorGeometry.height && editorGeometry.scrollTop > 0,
          `The complete multiline draft must remain scrollable: ${JSON.stringify(editorGeometry)}`);
        const primaryHit = await page.locator('.ai-composer-primary').evaluate(el => {
          const box = el.getBoundingClientRect();
          const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return { clickable: el.contains(target), box: box.toJSON(), target: target?.outerHTML.slice(0, 180),
            card: el.closest('[data-composer-card]').getBoundingClientRect().toJSON() };
        });
        assert.ok(primaryHit.clickable, `The queue button must remain visible and reachable with a multiline draft: ${JSON.stringify(primaryHit)}`);
        await page.screenshot({ path: `/tmp/shellspan-approval-composer-${engine.name()}-${width}.png` });
        await page.locator('.ai-composer-primary').click();
        assert.equal(await page.locator('body').getAttribute('data-action'), 'queue');
        const viewportGeometry = await page.locator('[data-slot="scroll-area-viewport"]').evaluate(el => ({
          height: el.clientHeight, scrollHeight: el.scrollHeight, overflow: getComputedStyle(el).overflowY,
          box: el.getBoundingClientRect().toJSON(),
        }));
        assert.notEqual(viewportGeometry.overflow, 'visible', JSON.stringify(viewportGeometry));
        const hit = await page.getByRole('button', { name: '取消', exact: true }).evaluate(el => {
          const b = el.getBoundingClientRect();
          const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
          const panel = el.closest('[data-slot="ai-approval-panel"]');
          return { clickable: el.contains(top), top: top?.outerHTML.slice(0, 120),
            rows: getComputedStyle(panel).gridTemplateRows,
            display: getComputedStyle(panel).display,
            children: [...panel.children].map(c => ({ slot: c.dataset.slot,
              height: c.clientHeight, box: c.getBoundingClientRect().toJSON() })) };
        });
        assert.ok(hit.clickable, JSON.stringify({ hit, viewportGeometry }));
        for (const [label, decision] of [['取消', 'reject'], ['允许执行一次', 'approve']]) {
          const button = page.getByRole('button', { name: label, exact: true });
          await button.scrollIntoViewIfNeeded();
          const before = await button.boundingBox();
          await button.click();
          await button.locator('[data-slot="spinner"]').waitFor();
          const during = await button.boundingBox();
          const spinner = await button.locator('[data-slot="spinner"]').boundingBox();
          assert.deepEqual(during, before, 'Loading must preserve the clicked button bounds');
          assert.ok(Math.abs(spinner.x + spinner.width / 2 - during.x - during.width / 2) < 1);
          assert.ok(Math.abs(spinner.y + spinner.height / 2 - during.y - during.height / 2) < 1);
          assert.equal(await page.locator('body').getAttribute('data-action'), decision);
          await button.locator('[data-slot="spinner"]').waitFor({ state: 'hidden' });
        }
        assert.equal(await page.locator('[data-composer-editor]').textContent(), multilineDraft);
        await page.setViewportSize({ width, height: 300 });
        const compactGeometry = await page.locator('[data-composer-seat]').evaluate(el => {
          const box = el.getBoundingClientRect();
          const parentBox = el.parentElement.getBoundingClientRect();
          return {
            bottom: box.bottom, viewport: innerHeight,
            right: box.right, parentRight: parentBox.right,
            height: el.clientHeight, scrollHeight: el.scrollHeight,
          };
        });
        assert.ok(compactGeometry.bottom <= compactGeometry.viewport && compactGeometry.scrollHeight > compactGeometry.height,
          `A short window must keep the composer within the viewport and scrollable: ${JSON.stringify(compactGeometry)}`);
        assert.ok(Math.abs(compactGeometry.right - compactGeometry.parentRight) <= 1,
          `A scrollable composer seat must stay flush with its container right edge: ${JSON.stringify(compactGeometry)}`);
        await page.setViewportSize({ width: 960, height: 300 });
        const wideCompactGeometry = await page.locator('[data-composer-seat]').evaluate(el => {
          const box = el.getBoundingClientRect();
          const parentBox = el.parentElement.getBoundingClientRect();
          const innerBox = el.querySelector('[data-slot="ai-composer-seat-inner"]').getBoundingClientRect();
          return {
            right: box.right, parentRight: parentBox.right,
            innerWidth: innerBox.width, width: box.width,
            height: el.clientHeight, scrollHeight: el.scrollHeight,
          };
        });
        assert.ok(wideCompactGeometry.scrollHeight > wideCompactGeometry.height
          && Math.abs(wideCompactGeometry.right - wideCompactGeometry.parentRight) <= 1
          && wideCompactGeometry.innerWidth < wideCompactGeometry.width,
          `A wide short window must keep the scrollbar flush to the right edge while centering inner content: ${JSON.stringify(wideCompactGeometry)}`);
        await page.setViewportSize({ width, height: 300 });
        await page.locator('.ai-composer-primary').click();
        assert.equal(await page.locator('body').getAttribute('data-action'), 'queue');
        await page.getByRole('button', { name: '取消', exact: true }).click();
        assert.equal(await page.locator('body').getAttribute('data-action'), 'reject');
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
