import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const screenshots = join(tmpdir(), 'shellspan-tool-copy-alignment');
await mkdir(screenshots, { recursive: true });
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const codePath = 'scripts/check-ai-panel-styles.mjs';
const toolPath = 'src/components/ai/workspace/ai-tool-presentation.tsx';
const workingPatch = git(['diff', '--', toolPath]);
const revision = git(['log', '-1', '--format=%H', '--', toolPath]).trim();
const data = {
  short: { command: 'git rev-parse --short HEAD', output: git(['rev-parse', '--short', 'HEAD']), path: 'src/vite-env.d.ts' },
  long: { command: 'git log --oneline -100', output: git(['log', '--oneline', '-100']), path: 'package.json' },
  code: await readFile(join(root, codePath), 'utf8'),
  codeOutput: execFileSync(process.execPath, [codePath], { cwd: root, encoding: 'utf8' }),
  shortCode: 'process.version',
  shortCodeOutput: execFileSync(process.execPath, ['--print', 'process.version'], { encoding: 'utf8' }),
  patch: workingPatch || git(['show', '--format=', revision, '--', toolPath]),
  search: execFileSync('rg', ['--line-number', 'version', 'package.json'], { cwd: root, encoding: 'utf8' }),
  plan: JSON.parse(await readFile(join(root, 'src/test/fixtures/conversation-fold-runtime.json'), 'utf8')).completed.events,
  recovery: JSON.parse(await readFile(join(root, 'src/test/fixtures/tool-result-read-recovery.json'), 'utf8')),
};
for (const scenario of [data.short, data.long]) scenario.file = await readFile(join(root, scenario.path), 'utf8');
assert.ok(data.patch.length > 0, 'Alignment coverage requires a real tool-presentation patch');
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(screenshots, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'tool-copy-alignment',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell" style="padding:12px"></main></body></html>');
      });
    },
  }],
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium ? { channel: 'chromium' } : {});
    try {
      const page = await browser.newPage(engine === chromium ? { permissions: ['clipboard-read', 'clipboard-write'] } : {});
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      for (const locale of ['zh-CN', 'en-US']) {
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
        await page.evaluate(async ({ data, locale }) => {
          const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
          await import('/src/styles/base.css');
          await import('/src/components/ai/styles/styles.css');
          const { AiToolExpandedContent } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
          const { projectAgentChatNodes } = await import('/src/lib/ai/conversation-projection.ts');
          const { initI18n } = await import('/src/locales/index.ts');
          const { useAppStore } = await import('/src/stores/appStore.ts');
          await initI18n(locale);
          useAppStore.setState({ locale });
          const view = createRoot(document.getElementById('root'));
          const failure = projectAgentChatNodes(data.recovery.slice(0, 2))
            .flatMap(node => node.kind === 'turnProcess' ? node.children : []).find(node => node.kind === 'tool');
          if (!failure) throw new Error('Recorded error is missing');
          const plan = projectAgentChatNodes(data.plan)
            .flatMap(node => node.kind === 'turnProcess' ? node.children : []).find(node => node.kind === 'tool' && node.name === 'update_plan');
          if (!plan) throw new Error('Recorded plan is missing');
          const url = location.href;
          const webOutput = await fetch(url).then(response => response.text());
          window.renderToolSurfaces = scenario => {
            const result = data[scenario];
            const shared = { kind: 'tool', state: 'succeeded', error: null, nativeName: null };
            const nodes = [
              { ...shared, name: 'exec_command', input: { command: result.command }, output: result.output },
              { ...shared, name: 'read_file', input: { path: result.path }, output: result.file },
              { ...shared, name: 'git', input: { command: result.command }, output: result.output },
              { ...shared, name: 'run_code', input: { code: scenario === 'long' ? data.code : data.shortCode, language: 'javascript' }, output: scenario === 'long' ? data.codeOutput : data.shortCodeOutput },
              { ...shared, name: 'apply_patch', input: { patch: data.patch }, output: { diff: data.patch } },
              failure,
              { ...shared, name: 'search_text', input: { query: 'version' }, output: data.search },
              { ...shared, name: 'fetch_url', input: { url }, output: webOutput },
              plan,
            ];
            view.render(React.createElement(React.Fragment, null,
              ...nodes.map((node, key) => React.createElement(AiToolExpandedContent, { node, key }))));
          };
        }, { data, locale });
        for (const scenario of ['short', 'long']) {
          await page.evaluate(scenario => window.renderToolSurfaces(scenario), scenario);
          await page.locator('.ai-terminal-command').filter({ hasText: data[scenario].command }).waitFor();
          for (const theme of ['light', 'dark']) {
            await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
            for (const width of [320, 380, 720]) {
              await page.setViewportSize({ width, height: 1000 });
              const context = `${engine.name()}/${locale}/${scenario}/${theme}/${width}`;
              const positions = await page.locator('.ai-tool-copy-button').evaluateAll(buttons => buttons.map(button => {
                const card = button.closest('[data-ai-tool-view]').getBoundingClientRect();
                const copy = button.getBoundingClientRect();
                return { inset: card.right - copy.right, right: copy.right, width: copy.width, height: copy.height };
              }));
              assert.ok(positions.length >= 9, `${context}: all result types must be measured`);
              for (const position of positions) {
                assert.ok(Math.abs(position.inset - positions[0].inset) < 1, `${context}: copy positions differ: ${JSON.stringify(positions)}`);
                assert.ok(position.right <= width && position.width === 24 && position.height === 24, `${context}: copy buttons must fit`);
              }
              const read = page.locator('[data-ai-tool-view="read"]');
              const inputCopy = read.getByRole('button', { name: locale === 'zh-CN' ? '复制输入' : 'Copy input', exact: true });
              const outputCopy = read.getByRole('button', { name: locale === 'zh-CN' ? '复制输出' : 'Copy output', exact: true });
              const opacity = button => button.evaluate(element => getComputedStyle(element).opacity);
              assert.equal(await read.locator('.ai-tool-surface-header').count(), 1, `${context}: read results must have no output heading row`);
              await read.locator('.ai-tool-surface-header').hover();
              assert.equal(await opacity(inputCopy), '1', `${context}: path hover must show its copy button`);
              assert.equal(await opacity(outputCopy), '0', `${context}: path hover must not reveal the output action`);
              await read.locator('.ai-read-lines').hover({ position: { x: 30, y: 20 } });
              assert.equal(await opacity(inputCopy), '0', `${context}: content hover must not reveal the path action`);
              assert.equal(await opacity(outputCopy), '1', `${context}: content hover must show its copy button`);
              if (locale === 'zh-CN' && scenario === 'long') await read.screenshot({ path: join(screenshots, `${engine.name()}-${theme}-${width}-read.png`) });
              await page.mouse.move(0, 0);
              for (const [button, expected] of [[inputCopy, data[scenario].path], [outputCopy, data[scenario].file]]) {
                await button.focus();
                assert.equal(await opacity(button), '1', `${context}: keyboard focus must reveal the copy action`);
                if (engine === chromium) {
                  await button.press('Enter');
                  await page.waitForFunction(expected => navigator.clipboard.readText().then(text => text === expected), expected);
                }
                await button.blur();
              }
              const assertRegionCopy = async (card, region, activeIndex) => {
                const copies = card.locator('.ai-tool-copy-button');
                await region.hover({ position: { x: 24, y: 8 } });
                const visibility = await copies.evaluateAll(buttons => buttons.map(button => ({
                  opacity: getComputedStyle(button).opacity,
                  pointerEvents: getComputedStyle(button).pointerEvents,
                })));
                assert.deepEqual(visibility, Array.from({ length: await copies.count() }, (_, index) => ({
                  opacity: index === activeIndex ? '1' : '0', pointerEvents: index === activeIndex ? 'auto' : 'none',
                })), `${context}: only the hovered copy region may reveal its action`);
              };
              const terminal = page.locator('[data-ai-tool-view="terminal"]');
              for (const [region, index] of [
                [terminal.locator('.ai-terminal-header'), 0], [terminal.locator('.ai-terminal-command-row'), 0],
                [terminal.locator('[data-ai-terminal-output] .ai-tool-surface-header'), 1],
                [terminal.locator('[data-ai-terminal-output] .ai-block-line').first(), 1],
              ]) await assertRegionCopy(terminal, region, index);
              const code = page.locator('[data-ai-tool-view="code"]');
              for (const [region, index] of [
                [code.locator(':scope > .ai-tool-surface-header'), 0], [code.locator('.ai-code-block-pre'), 0],
                [code.locator('.ai-io-section .ai-tool-surface-header'), 1], [code.locator('.ai-io-text'), 1],
              ]) await assertRegionCopy(code, region, index);
              for (const card of await page.locator('[data-ai-tool-view="generic"]').all()) {
                const sections = card.locator('.ai-io-section');
                for (let index = 0; index < await sections.count(); index++) {
                  await assertRegionCopy(card, sections.nth(index).locator('.ai-tool-surface-header'), index);
                  await assertRegionCopy(card, sections.nth(index).locator('.ai-io-text'), index);
                }
              }
              for (const type of ['search', 'web', 'diff', 'error']) {
                const card = page.locator(`[data-ai-tool-view="${type}"]`);
                await assertRegionCopy(card, card.locator('.ai-tool-surface-header').first(), 0);
                await assertRegionCopy(card, card.locator('pre, .ai-search-results').first(), 0);
              }
              await page.mouse.move(0, 0);
              assert.ok(await page.locator('.ai-tool-copy-button').evaluateAll(buttons => buttons.every(button => getComputedStyle(button).opacity === '0')),
                `${context}: leaving every tool region must hide all copy actions`);
              for (const copy of await page.locator('.ai-tool-copy-button').all()) {
                await copy.focus();
                assert.equal(await opacity(copy), '1', `${context}: every tool copy action must be visible on keyboard focus`);
                await copy.blur();
              }
              const transcript = page.locator('.ai-terminal-transcript [data-slot="scroll-area-viewport"]');
              const generic = page.locator('.ai-io-card [data-slot="scroll-area-viewport"]').first();
              for (const viewport of [transcript, generic]) {
                const overflow = await viewport.evaluate(element => element.scrollHeight > element.clientHeight);
                assert.equal(overflow, scenario === 'long', `${context}: the real output must exercise both scrolling states`);
                if (!overflow) continue;
                await viewport.focus();
                assert.equal(await viewport.getAttribute('tabindex'), '0', `${context}: scrollable content must support keyboard focus`);
                await viewport.evaluate(element => element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }));
                assert.ok(await viewport.evaluate(element => element.scrollTop > 0), `${context}: the last output line must be reachable`);
                await viewport.evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
              }
              assert.ok(await page.locator('.ai-tool-scroll-area').evaluateAll(elements => elements.every(element => element.getBoundingClientRect().height <= 260)), `${context}: content height must remain capped`);
              if (locale === 'zh-CN' && scenario === 'long') {
                for (const type of ['terminal', 'generic']) {
                  const card = page.locator(`[data-ai-tool-view="${type}"]`).first();
                  await card.locator(type === 'terminal' ? '.ai-terminal-header' : '.ai-tool-surface-header').first().hover();
                  await card.screenshot({ path: join(screenshots, `${engine.name()}-${theme}-${width}-${type}.png`) });
                }
              }
            }
          }
        }
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  }
  console.log(`Tool copy regions, keyboard focus, alignment and scrolling passed in Chromium/WebKit, both languages and themes, at 320px/380px/720px. Screenshots: ${screenshots}`);
} finally { await server.close(); }
