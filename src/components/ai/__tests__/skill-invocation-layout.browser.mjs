import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const screenshots = join(tmpdir(), 'shellspan-skill-invocation-layout');
await mkdir(screenshots, { recursive: true });
const events = JSON.parse(await readFile(join(root, 'src/test/fixtures/agent-skills-runtime.json'), 'utf8'));
const failureEvents = JSON.parse(await readFile(join(root, 'src/test/fixtures/skill-load-failure.json'), 'utf8'));
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  cacheDir: join(screenshots, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  plugins: [tailwindcss(), {
    name: 'skill-invocation-layout',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell"></main></body></html>');
      });
    },
  }],
});

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium ? { channel: 'chromium' } : {});
    try {
      const page = await browser.newPage({ reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      for (const locale of ['zh-CN', 'en-US']) {
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
        const diagnostic = await page.evaluate(async ({ events, failureEvents, locale }) => {
          const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
          await import('/src/styles/base.css');
          await import('/src/components/ai/styles/styles.css');
          const { AiConversationNodeList } = await import('/src/components/ai/workspace/ai-conversation-node-seat.tsx');
          const { AiToolExpandedContent } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
          const { projectAgentChatNodes } = await import('/src/lib/ai/conversation-projection.ts');
          const { initI18n } = await import('/src/locales/index.ts');
          const { useAppStore } = await import('/src/stores/appStore.ts');
          await initI18n(locale);
          useAppStore.setState({ locale });
          const nodes = projectAgentChatNodes(events).flatMap(item => item.kind === 'turnProcess' ? item.children : [item]);
          const skill = nodes.find(item => item.kind === 'contextInjection' && item.loadedSkill);
          const tool = nodes.find(item => item.kind === 'tool' && item.name === 'skill');
          if (!skill || !tool) throw new Error('Recorded skill invocation and tool are missing');
          const failure = projectAgentChatNodes(failureEvents)
            .flatMap(item => item.kind === 'turnProcess' ? item.children : [item])
            .find(item => item.kind === 'contextInjection' && item.provenance.kind === 'skill-invocation');
          if (!failure || failure.loadedSkill || !failure.content) throw new Error('Recorded skill load failure is missing');
          createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
            React.createElement('section', { id: 'skill' }, React.createElement(AiConversationNodeList, { nodes: [skill] })),
            React.createElement('section', { id: 'failure' }, React.createElement(AiConversationNodeList, { nodes: [failure] })),
            React.createElement('section', { id: 'tool' }, React.createElement(AiToolExpandedContent, { node: tool }))));
          return failure.content;
        }, { events, failureEvents, locale });
        const trigger = page.locator('#skill button[aria-expanded]');
        await trigger.click();
        const skill = page.locator('#skill .ai-io-section');
        const viewport = skill.locator('[data-slot="scroll-area-viewport"]');
        await viewport.waitFor();
        await page.locator('#failure button[aria-expanded]').click();
        const failure = page.locator('#failure');
        const failureTitle = locale === 'zh-CN' ? '加载失败' : 'Failed to load';
        await failure.getByLabel(failureTitle).waitFor();
        assert.equal(await failure.locator('pre').textContent(), diagnostic, 'The original failure diagnostic is preserved');
        assert.equal(await failure.getByText(locale === 'zh-CN' ? '完整指令' : 'Full instructions', { exact: true }).count(), 0);
        for (const theme of ['light', 'dark']) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          for (const width of [220, 390, 720]) {
            await page.setViewportSize({ width, height: 800 });
            const context = `${engine.name()}/${locale}/${theme}/${width}`;
            const layout = await skill.evaluate(element => {
              const reference = document.querySelector('#tool .ai-io-section');
              const body = element.querySelector('pre');
              const referenceBody = reference.querySelector('pre');
              const viewport = element.querySelector('[data-slot="scroll-area-viewport"]');
              const header = element.querySelector('.ai-tool-surface-header');
              const appearance = element => {
                const style = getComputedStyle(element);
                return [style.font, style.color, style.padding, style.backgroundColor,
                  style.borderTopWidth, style.borderTopColor, style.borderRadius];
              };
              const headerTop = header.getBoundingClientRect().top;
              viewport.scrollTop = viewport.scrollHeight;
              return {
                surface: appearance(element), referenceSurface: appearance(reference),
                body: appearance(body), referenceBody: appearance(referenceBody),
                left: element.getBoundingClientRect().left, referenceLeft: reference.getBoundingClientRect().left,
                fits: element.getBoundingClientRect().right <= innerWidth && viewport.scrollWidth <= viewport.clientWidth,
                capped: viewport.clientHeight <= 260,
                scrolls: viewport.scrollTop > 0,
                fixedHeader: header.getBoundingClientRect().top === headerTop,
              };
            });
            assert.deepEqual(layout.surface, layout.referenceSurface, `${context}: shared content surface`);
            assert.deepEqual(layout.body, layout.referenceBody, `${context}: shared typography and padding`);
            assert.equal(layout.left, layout.referenceLeft, `${context}: shared indentation`);
            assert.ok(layout.fits && layout.capped && layout.scrolls && layout.fixedHeader,
              `${context}: content fits, scrolls to the end and retains its header: ${JSON.stringify(layout)}`);
            const copy = skill.getByRole('button', { name: locale === 'zh-CN' ? '复制' : 'Copy', exact: true });
            await page.keyboard.press('Tab');
            await copy.focus();
            assert.equal(await copy.evaluate(element => getComputedStyle(element).opacity), '1', `${context}: keyboard copy action`);
            await copy.blur();
            await viewport.evaluate(element => { element.scrollTop = 0; });
            await page.mouse.move(1, 1);
            await page.getByRole('tooltip').waitFor({ state: 'hidden' });
            if (locale === 'zh-CN') {
              await page.locator('#skill').screenshot({ path: join(screenshots, `${engine.name()}-${theme}-${width}.png`) });
              await failure.screenshot({ path: join(screenshots, `${engine.name()}-${theme}-${width}-failure.png`) });
            }
          }
        }
        await trigger.focus();
        await page.keyboard.press('Enter');
        assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
        await page.keyboard.press('Space');
        assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  }
  console.log(`Skill invocation layout passed in Chromium/WebKit, both languages and themes, at 220px/390px/720px. Screenshots: ${screenshots}`);
} finally { await server.close(); }
