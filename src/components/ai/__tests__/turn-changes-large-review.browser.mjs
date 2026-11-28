import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const cacheDir = join(tmpdir(), 'shellspan-turn-changes-large-review', 'vite-cache');
await mkdir(cacheDir, { recursive: true });

const server = await createServer({
  configFile: false,
  root,
  appType: 'custom',
  logLevel: 'error',
  cacheDir,
  resolve: { alias: { '@': `${root}src` } },
  optimizeDeps: {
    entries: ['src/components/ai/workspace/ai-turn-changes-summary.tsx'],
    include: ['react', 'react-dom/client'],
  },
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 0, hmr: false },
});

server.middlewares.use('/__turn-changes', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body style="margin:0"><main id="root" class="ai-panel-shell relative" style="height:100vh;width:100vw;overflow:hidden"></main></body></html>');
});

async function launchBrowser() {
  for (const options of [{}, { channel: 'msedge' }, { channel: 'chrome' }]) {
    try {
      return await chromium.launch(options);
    } catch {
      // Try next available Chromium-family browser.
    }
  }
  return chromium.launch();
}

try {
  await server.listen();
  const browser = await launchBrowser();
  try {
    for (const width of [380, 720]) {
      const page = await browser.newPage({ viewport: { width, height: 840 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));

      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__turn-changes`);
      await page.evaluate(async () => {
        const { React, createRoot } = await import('/src/components/ai/__tests__/agent-content-surfaces.browser-runtime.ts');
        await import('/src/styles/base.css');
        await import('/src/components/ai/styles/styles.css');
        const {
          AiTurnChangesSummary,
          AiTurnRollbackContext,
        } = await import('/src/components/ai/workspace/ai-turn-changes-summary.tsx');
        const { initI18n } = await import('/src/locales/index.ts');
        await initI18n('zh-CN');

        const makeLargeFileContent = (index, lineCount) => Array.from(
          { length: lineCount },
          (_, line) => `export function module${index}Step${line}(input: number): number { return input + ${line}; }`,
        ).join('\n');

        const children = Array.from({ length: 30 }, (_, index) => {
          const isLargeNew = index % 5 === 0;
          return {
            kind: 'tool',
            key: `tool:${index}`,
            sourceKind: 'agent',
            sessionId: 'sess-stress',
            turnId: 'turn-stress',
            stepId: `step-${index}`,
            firstSeq: index * 2 + 1,
            lastSeq: index * 2 + 2,
            timestamp: new Date().toISOString(),
            callId: `call-${index}`,
            name: isLargeNew ? 'write_file' : 'apply_patch',
            nativeName: isLargeNew ? 'write_file' : 'apply_patch',
            title: null,
            summary: '',
            state: 'succeeded',
            effect: 'stateChange',
            durationMs: 42,
            detailRef: { kind: 'agentTool', sessionId: 'sess-stress', callId: `call-${index}`, turnId: 'turn-stress', stepId: `step-${index}` },
            evidenceRefs: [],
            input: isLargeNew
              ? { path: `src/features/group-${Math.floor(index / 5)}/large-file-${index}.ts`, content: makeLargeFileContent(index, 460) }
              : {
                  path: `src/features/group-${Math.floor(index / 5)}/service-${index}.ts`,
                  old_string: `export const value_${index} = 1;\nexport const flag_${index} = false;\n`,
                  new_string: `export const value_${index} = 2;\nexport const flag_${index} = true;\nexport const extra_${index} = 'ok';\n`,
                },
            output: null,
            error: null,
            target: null,
            idempotency: 'no',
            approval: null,
          };
        });

        const process = {
          kind: 'turnProcess',
          key: 'turn-process:stress',
          sourceKind: 'agent',
          sessionId: 'sess-stress',
          turnId: 'turn-stress',
          stepId: null,
          firstSeq: 1,
          lastSeq: 65,
          timestamp: new Date().toISOString(),
          status: 'completed',
          answerGeneration: 'req-stress',
          hasStartBoundary: true,
          hasEndBoundary: true,
          childKeys: children.map((child) => child.key),
          children,
        };

        const host = document.getElementById('root');
        createRoot(host).render(
          React.createElement(
            AiTurnRollbackContext.Provider,
            { value: () => {} },
            React.createElement(
              'div',
              { style: { padding: '12px', height: '100%', overflow: 'auto' } },
              React.createElement(AiTurnChangesSummary, { process }),
            ),
          ),
        );
      });

      const context = `chromium/${width}`;
      await page.locator('.ai-turn-changes-trigger').click();

      // Open the 21st file (a 460-line new file: index 20) and verify fast open + focused expansion.
      const targetPath = 'src/features/group-4/large-file-20.ts';
      const openElapsedMs = await page.evaluate(async (path) => {
        const button = document.querySelector(`button[title="${path}"]`);
        const start = performance.now();
        button.click();
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        return performance.now() - start;
      }, targetPath);

      const dialog = page.locator('[role="dialog"]');
      await dialog.waitFor();
      assert.ok(openElapsedMs < 500, `${context}: opening 30-file review took ${openElapsedMs.toFixed(1)}ms`);

      const initialState = await dialog.evaluate((el, path) => {
        const header = el.querySelector('.ai-turn-changes-dialog-header');
        const headerRect = header.getBoundingClientRect();
        const expandedTriggers = el.querySelectorAll('.ai-turn-changes-review-trigger[aria-expanded="true"]');
        const bodies = el.querySelectorAll('[data-ai-turn-changes-file-body]');
        const targetSection = el.querySelector(`[data-ai-turn-changes-review-file="${path}"]`);
        const targetRect = targetSection.getBoundingClientRect();
        const viewport = el.querySelector('[data-slot="scroll-area-viewport"]');
        const viewportRect = viewport.getBoundingClientRect();
        const addedRows = targetSection.querySelectorAll('[data-diff="added"]').length;
        const paginationBar = targetSection.querySelector('[data-diff-pagination]');
        const rollbackBtn = el.querySelector('button[aria-label]');
        return {
          headerHeight: Math.round(headerRect.height),
          expandedCount: expandedTriggers.length,
          bodyCount: bodies.length,
          targetVisible: targetRect.top >= viewportRect.top - 2 && targetRect.top < viewportRect.bottom,
          addedRows,
          hasPagination: Boolean(paginationBar),
          hasHeader: Boolean(rollbackBtn),
        };
      }, targetPath);

      assert.equal(initialState.headerHeight, 40, `${context}: overlay header must stay single-row 40px`);
      assert.equal(initialState.expandedCount, 1, `${context}: large review should only expand selected file initially`);
      assert.equal(initialState.bodyCount, 1, `${context}: only selected file body should mount initially`);
      assert.equal(initialState.targetVisible, true, `${context}: selected file should scroll into view immediately`);
      assert.equal(initialState.addedRows, 200, `${context}: large new file should cap initial rows at 200`);
      assert.equal(initialState.hasPagination, true, `${context}: pagination fold bar should appear for 460-line file`);

      // Wait for chunked syntax highlighting to colorize the visible lines.
      await page.waitForFunction(
        (path) => {
          const section = document.querySelector(`[data-ai-turn-changes-review-file="${path}"]`);
          return Boolean(section && section.querySelectorAll('.hljs-keyword').length > 20);
        },
        targetPath,
        { timeout: 3000 },
      );

      // Verify jump-to-file popover scrolls for 30 files and filters/jumps properly.
      await page.getByTestId('turn-changes-jump-trigger').click();
      const jumpViewport = page.locator('[data-slot="popover-content"] [data-slot="scroll-area-viewport"]');
      await jumpViewport.waitFor();
      const jumpMetrics = await jumpViewport.evaluate((el) => ({
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      }));
      assert.ok(
        jumpMetrics.clientHeight > 0 && jumpMetrics.clientHeight <= 260 && jumpMetrics.scrollHeight > jumpMetrics.clientHeight,
        `${context}: jump menu list should scroll within max-h-64 (client=${jumpMetrics.clientHeight}, scroll=${jumpMetrics.scrollHeight})`,
      );
      const filterInput = page.locator('[data-slot="popover-content"] input[type="search"]');
      await filterInput.fill('service-29');
      await filterInput.press('Enter');
      await page.waitForFunction(
        () => {
          const section = document.querySelector('[data-ai-turn-changes-review-file="src/features/group-5/service-29.ts"]');
          return Boolean(section && section.querySelector('[data-ai-turn-changes-file-body]'));
        },
        { timeout: 2000 },
      );

      // Click "Expand all" and verify viewport lazy virtualization keeps mounted bodies bounded.
      await page.getByTestId('turn-changes-toggle-all').click();
      await page.waitForTimeout(250);
      const expandAllStats = await dialog.evaluate((el) => {
        const expandedTriggers = el.querySelectorAll('.ai-turn-changes-review-trigger[aria-expanded="true"]').length;
        const mountedBodies = el.querySelectorAll('[data-ai-turn-changes-file-body]').length;
        const placeholders = el.querySelectorAll('[data-ai-turn-changes-placeholder]').length;
        return { expandedTriggers, mountedBodies, placeholders };
      });
      assert.equal(expandAllStats.expandedTriggers, 30, `${context}: all 30 files should be logically expanded`);
      assert.ok(
        expandAllStats.mountedBodies < 20 && expandAllStats.placeholders > 0,
        `${context}: off-screen expanded files should stay virtualized as placeholders (mounted=${expandAllStats.mountedBodies}, placeholders=${expandAllStats.placeholders})`,
      );

      // Scroll back to the very top and verify the first large file mounts smoothly.
      await dialog.locator('[data-slot="scroll-area-viewport"]').evaluate((el) => { el.scrollTop = 0; });
      await page.waitForFunction(
        () => {
          const first = document.querySelector('[data-ai-turn-changes-review-file="src/features/group-0/large-file-0.ts"]');
          return Boolean(first && first.querySelector('[data-ai-turn-changes-file-body]'));
        },
        { timeout: 3000 },
      );

      assert.deepEqual(errors, [], `${context}: no runtime page errors`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
