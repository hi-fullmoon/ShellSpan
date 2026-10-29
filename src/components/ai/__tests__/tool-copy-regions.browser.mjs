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
const screenshots = join(tmpdir(), 'shellspan-tool-copy-regions');
await mkdir(screenshots, { recursive: true });
const toolPath = 'src/components/ai/workspace/ai-tool-presentation.tsx';
const revision = execFileSync('git', ['log', '-1', '--format=%H', '--', toolPath], { cwd: root, encoding: 'utf8' }).trim();
const data = {
  command: 'git log --oneline -3',
  output: execFileSync('git', ['log', '--oneline', '-3'], { cwd: root, encoding: 'utf8' }),
  path: 'package.json',
  file: await readFile(join(root, 'package.json'), 'utf8'),
  search: execFileSync('rg', ['--line-number', 'version', 'package.json'], { cwd: root, encoding: 'utf8' }),
  code: 'process.version',
  codeOutput: execFileSync(process.execPath, ['--print', 'process.version'], { encoding: 'utf8' }),
  patch: execFileSync('git', ['show', '--format=', revision, '--', toolPath], { cwd: root, encoding: 'utf8' }),
  recovery: JSON.parse(await readFile(join(root, 'src/test/fixtures/tool-result-read-recovery.json'), 'utf8')),
  plan: JSON.parse(await readFile(join(root, 'src/test/fixtures/conversation-fold-runtime.json'), 'utf8')).completed.events,
};
assert.ok(data.patch, 'Coverage requires a real tool presentation patch');
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(screenshots, 'vite-cache'), resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' }, optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'tool-copy-regions',
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
      const page = await browser.newPage();
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
          const recordedTool = (events, name) => projectAgentChatNodes(events)
            .flatMap(node => node.kind === 'turnProcess' ? node.children : []).find(node => node.kind === 'tool' && (!name || node.name === name));
          const failure = recordedTool(data.recovery.slice(0, 2));
          const plan = recordedTool(data.plan, 'update_plan');
          if (!failure || !plan) throw new Error('Recorded tools are missing');
          const shared = { kind: 'tool', state: 'succeeded', error: null, nativeName: null };
          const webOutput = await fetch(location.href).then(response => response.text());
          const nodes = [
            { ...shared, name: 'exec_command', input: { command: data.command }, output: data.output },
            { ...shared, name: 'read_file', input: { path: data.path }, output: data.file },
            { ...shared, name: 'git', input: { command: data.command }, output: data.output },
            { ...shared, name: 'run_code', input: { code: data.code, language: 'javascript' }, output: data.codeOutput },
            { ...shared, name: 'apply_patch', input: { patch: data.patch }, output: { diff: data.patch } },
            { ...shared, name: 'search_text', input: { query: 'version' }, output: data.search },
            { ...shared, name: 'fetch_url', input: { url: location.href }, output: webOutput },
            failure, plan,
          ];
          createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
            ...nodes.map((node, key) => React.createElement(AiToolExpandedContent, { node, key }))));
        }, { data, locale });
        await page.locator('.ai-terminal-command').waitFor();
        for (const theme of ['light', 'dark']) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          for (const width of [320, 720]) {
            await page.setViewportSize({ width, height: 1000 });
            const context = `${engine.name()}/${locale}/${theme}/${width}`;
            const checkRegion = async (card, region, active) => {
              await region.hover({ position: { x: 24, y: 8 } });
              const copies = card.locator('.ai-tool-copy-button');
              assert.deepEqual(await copies.evaluateAll(buttons => buttons.map(button => ({
                opacity: getComputedStyle(button).opacity, pointer: getComputedStyle(button).pointerEvents,
              }))), Array.from({ length: await copies.count() }, (_, index) => ({
                opacity: index === active ? '1' : '0', pointer: index === active ? 'auto' : 'none',
              })), `${context}: only the hovered region may reveal its copy action`);
            };
            for (const type of ['terminal', 'read', 'code', 'generic']) {
              for (const card of await page.locator(`[data-ai-tool-view="${type}"]`).all()) {
                const headers = card.locator('.ai-tool-surface-header');
                for (let index = 0; index < await headers.count(); index++) await checkRegion(card, headers.nth(index), index);
                const bodies = card.locator(type === 'terminal' ? '.ai-terminal-command-row, [data-ai-terminal-output] .ai-block-line:first-child'
                  : type === 'read' ? '.ai-read-lines' : type === 'code' ? '.ai-code-block-pre, .ai-io-text' : '.ai-io-text');
                for (let index = 0; index < await bodies.count(); index++) await checkRegion(card, bodies.nth(index), type === 'read' ? 1 : index);
                if (locale === 'zh-CN') await card.screenshot({ path: join(screenshots, `${engine.name()}-${theme}-${width}-${type}.png`) });
              }
            }
            for (const type of ['search', 'web', 'diff', 'error']) {
              const card = page.locator(`[data-ai-tool-view="${type}"]`);
              await checkRegion(card, card.locator('.ai-tool-surface-header').first(), 0);
              await checkRegion(card, card.locator('pre, .ai-search-results').first(), 0);
            }
            await page.mouse.move(0, 0);
            assert.ok(await page.locator('.ai-tool-copy-button').evaluateAll(buttons => buttons.every(button => getComputedStyle(button).opacity === '0')), `${context}: leaving must hide all copies`);
            await page.keyboard.press('Tab');
            for (const copy of await page.locator('.ai-tool-copy-button').all()) {
              await copy.focus();
              assert.equal(await copy.evaluate(button => getComputedStyle(button).opacity), '1', `${context}: keyboard focus must reveal the action`);
              await copy.blur();
            }
          }
        }
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  }
  console.log(`Tool copy region checks passed in Chromium/WebKit, both languages and themes, at 320px/720px. Screenshots: ${screenshots}`);
} finally { await server.close(); }
