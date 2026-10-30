import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const artifacts = join(tmpdir(), 'shellspan-tool-detail-scroll-layout');
await mkdir(artifacts, { recursive: true });
// Exercise long input and diff output with an actual repository change.
const source = 'src/components/ai/workspace/ai-tool-details.tsx';
const revision = execFileSync('git', ['log', '-1', '--format=%H', '--', source], { cwd: root, encoding: 'utf8' }).trim();
const patch = execFileSync('git', ['show', '--format=', '--unified=20', revision, '--', source], { cwd: root, encoding: 'utf8' });
assert.ok(patch.length > 1000, 'The repository patch must contain enough content to scroll');
const largeRevision = execFileSync('git', ['log', '-1', '--format=%H', '--', 'src/components/ai'], { cwd: root, encoding: 'utf8' }).trim();
const largePatch = execFileSync('git', ['show', '--format=', '--unified=1000', largeRevision, '--', 'src/components/ai'], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
assert.ok(largePatch.length > 64 * 1024, 'The actual repository patch must exercise plain-output fallback');
const failures = JSON.parse(await readFile(join(root, 'src/test/fixtures/tool-result-read-recovery.json'), 'utf8'));
const path = join(root, 'package.json');
const file = await readFile(path, 'utf8');
const codePath = 'scripts/check-ai-panel-styles.mjs';
const code = await readFile(join(root, codePath), 'utf8');
const stdout = execFileSync(process.execPath, [codePath], { cwd: root, encoding: 'utf8' });
const search = execFileSync('rg', ['--line-number', '"version"', path], { cwd: root, encoding: 'utf8' });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(artifacts, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false,
    fs: { allow: [root, await realpath(join(root, 'node_modules'))] } },
  plugins: [tailwindcss()],
});
server.middlewares.use('/__details', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell" style="height:100vh"></main></body></html>');
});

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      for (const locale of ['zh-CN', 'en-US']) {
        for (const scenario of ['terminal', 'code', 'read', 'search', 'web', 'trash', 'diff', 'large-diff', 'failure', 'empty']) {
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__details`);
          await page.evaluate(async ({ patch, failures, locale, scenario, path, file, codePath, code, stdout, search }) => {
            const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
            await import('/src/styles/base.css');
            await import('/src/components/ai/styles/styles.css');
            const { AiToolDetails } = await import('/src/components/ai/workspace/ai-tool-details.tsx');
            const { projectAgentChatNodes } = await import('/src/lib/ai/conversation-projection.ts');
            const { initI18n } = await import('/src/locales/index.ts');
            const { useAppStore } = await import('/src/stores/appStore.ts');
            await initI18n(locale);
            useAppStore.setState({ locale });
            let node = scenario === 'empty' ? null : scenario === 'failure'
              ? projectAgentChatNodes(failures.slice(0, 2))
                .flatMap(item => item.kind === 'turnProcess' ? item.children : [])
                .find(item => item.kind === 'tool')
              : { kind: 'tool', name: 'apply_patch', nativeName: null, state: 'succeeded',
                summary: 'src/components/ai/workspace/ai-tool-details.tsx', durationMs: null,
                input: { patch }, output: { diff: patch }, error: null, target: null,
                effect: 'stateChange', evidenceRefs: [], idempotency: null, approval: null };
            if (scenario === 'terminal') node = { ...node, name: 'run_terminal_command', input: { command: `node ${codePath}` }, output: { stdout, exitCode: 0 } };
            if (scenario === 'code') node = { ...node, name: 'run_code', input: { code, language: 'javascript' }, output: { stdout } };
            if (scenario === 'read') node = { ...node, name: 'read_file', input: { path }, output: file };
            if (scenario === 'search') node = { ...node, name: 'search_text', input: { path, query: '"version"' }, output: search };
            if (scenario === 'web') {
              const url = new URL('/package.json', location.href).href;
              const result = await fetch(url);
              if (!result.ok) throw new Error('The actual local HTTP read must succeed');
              node = { ...node, name: 'web_fetch', input: { url }, output: await result.text() };
            }
            if (scenario === 'trash') node = { ...node, name: 'trash_file', state: 'running', input: { path }, output: null };
            if (scenario !== 'empty' && !node) throw new Error('The recorded tool must be available');
            createRoot(document.getElementById('root')).render(React.createElement(AiToolDetails, { node, onBack() {} }));
          }, { patch: scenario === 'large-diff' ? largePatch : patch, failures, locale, scenario, path, file, codePath, code, stdout, search });
          const detail = page.locator('[data-slot="ai-tool-details"]');
          await detail.waitFor();
          if (scenario !== 'empty') await detail.locator('.ai-detail-section').first().waitFor();
          if (scenario !== 'empty') {
            const output = detail.locator('.ai-detail-section').nth(1);
            assert.equal(await output.locator('.ai-terminal-command-row, .ai-code-content, .ai-io-input').count(), 0, `${scenario}: input must stay outside output`);
            if (['code', 'read', 'search', 'web', 'trash'].includes(scenario)) {
              assert.equal(await output.locator('.ai-tool-surface-header').count(), 0, `${scenario}: output must not repeat input headers`);
            }
            if (scenario === 'code') assert.equal(await output.locator('.ai-code-output pre').textContent(), stdout);
            if (scenario === 'web') assert.equal(await output.locator('.ai-web-content pre').textContent(), file);
          }
          if (scenario === 'diff') await detail.locator('.ai-diff-body').first().waitFor();
          if (scenario === 'large-diff') {
            const output = detail.locator('.ai-detail-section').nth(1);
            await output.locator('.ai-io-output').waitFor();
            assert.equal(await output.locator('.ai-io-input, .ai-tool-surface-header').count(), 0, 'Plain output must not repeat input or section headings');
            assert.equal(await output.locator('.ai-io-section').count(), 1);
          }
          for (const size of [{ width: 220, height: 360 }, { width: 390, height: 420 }, { width: 720, height: 900 }]) {
            await page.setViewportSize(size);
            const context = `${engine.name()}/${locale}/${scenario}/${size.width}x${size.height}`;
            const outside = await detail.evaluate(element => {
              const containers = [document.documentElement, element, ...element.querySelectorAll('.ai-details-body, .ai-detail-sections')];
              return containers.map(container => ({
                slot: container.className, overflowY: getComputedStyle(container).overflowY,
                height: container.clientHeight, scrollHeight: container.scrollHeight,
                width: container.clientWidth, scrollWidth: container.scrollWidth,
              }));
            });
            for (const container of outside) {
              assert.ok(container.scrollHeight <= container.height + 1 && container.scrollWidth <= container.width + 1,
                `${context}: no outer overflow: ${JSON.stringify(container)}`);
            }
            if (scenario === 'empty') continue;
            assert.equal(outside.at(-1).overflowY, 'hidden', `${context}: the section stack must not scroll`);
            const headers = detail.locator('.ai-detail-section-header');
            const positions = await headers.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top));
            const viewports = detail.locator('.ai-detail-section > .ai-tool-content-region > [data-slot="scroll-area"] > [data-slot="scroll-area-viewport"]');
            assert.equal(await viewports.count(), 3);
            for (let index = 0; index < 3; index++) {
              const viewport = viewports.nth(index);
              const dimensions = await viewport.evaluate(element => ({
                height: element.clientHeight, scrollHeight: element.scrollHeight,
                bottom: element.getBoundingClientRect().bottom,
              }));
              assert.ok((dimensions.scrollHeight === 0 ? dimensions.height === 0 : dimensions.height >= 20) && dimensions.bottom <= size.height,
                `${context}: section ${index} stays usable inside the panel: ${JSON.stringify(dimensions)}`);
              if (dimensions.scrollHeight <= dimensions.height) continue;
              await viewport.focus();
              await viewport.press('End');
              await page.waitForFunction(index => {
                const viewports = document.querySelectorAll('.ai-detail-section > .ai-tool-content-region > [data-slot="scroll-area"] > [data-slot="scroll-area-viewport"]');
                return viewports[index].scrollTop > 0;
              }, index);
              assert.deepEqual(await headers.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top)), positions,
                `${context}: scrolling content must keep all section headings fixed`);
              await viewport.evaluate(element => { element.scrollTop = 0; });
            }
            for (const button of await detail.locator('.ai-tool-copy-button').all()) {
              await button.focus();
              assert.equal(await button.evaluate(element => getComputedStyle(element).opacity), '1', `${context}: copy stays keyboard accessible`);
              await button.blur();
            }
            await page.waitForFunction(() => document.querySelectorAll('[role="tooltip"]').length === 0);
            if (locale === 'zh-CN' && size.width > 220) {
              for (const theme of ['light', 'dark']) {
                await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
                await detail.screenshot({ path: join(artifacts, `${engine.name()}-${scenario}-${theme}-${size.width}.png`) });
              }
            }
          }
        }
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  }
  console.log(`Tool details keep inputs separate and fit without outer scrolling in Chromium/WebKit, both languages, at 220x360, 390x420 and 720x900. Screenshots: ${artifacts}`);
} finally { await server.close(); }
