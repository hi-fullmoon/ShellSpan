import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';
import { createCanvas, loadImage } from 'canvas';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = resolve(process.argv[2] ?? '/tmp/shellspan-agent-notices');
const engine = process.env.SHELLSPAN_TEST_ENGINE === 'chromium' ? chromium : webkit;
const entry = '/src/components/ai/__tests__/agent-notice-catalog.browser-entry.tsx';
await mkdir(join(output, 'samples'), { recursive: true });

// Only replay existing events; never invoke a model, approve a tool or synthesize
// runtime responses. Private ledgers stay local and are not copied into the report.
async function recordedNotices() {
  const selected = new Map();
  const found = new Set();
  for (const app of ['com.shellspan', 'com.shellspan-dev']) {
    const directory = join(homedir(), 'Library/Application Support', app, 'agent-runtime/sessions-v5');
    const names = await readdir(directory).catch(() => []);
    for (const name of names.filter(name => name.endsWith('.jsonl'))) {
      const path = join(directory, name);
      if ((await stat(path)).size > 8_000_000) continue;
      const events = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; } // A running ledger may end with an incomplete frame.
      });
      for (const event of events) {
        const key = event.type === 'request/retry' ? 'retry'
          : (event.type === 'session/ended' || event.type === 'agent/status') && event.data.status === 'cancelled' ? 'cancelled'
          : event.type === 'tool/approval' && ['destructive', 'sensitiveRead', 'stateChange', 'externalSideEffect'].includes(event.data.risk) ? event.data.risk
          : event.type === 'tool/call' && event.data.call.name === 'write_terminal_input' && event.data.call.arguments?.contentPersisted === false ? 'volatile'
          : event.type === 'tool/result' && event.data.name === 'trash_file' && event.data.status === 'completed' ? 'trash' : null;
        if (!key || found.has(key)) continue;
        found.add(key);
        selected.set(path, events);
      }
    }
  }
  return [...selected.values()];
}
const events = await recordedNotices();
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `/tmp/shellspan-notice-catalog-${process.pid}`,
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use(async (request, response, next) => {
  if (request.url === '/recorded-notices') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(events));
  } else if (request.url?.startsWith('/project-entries?')) {
    const query = new URL(request.url, 'http://localhost').searchParams.get('q') ?? '';
    const entries = (await readdir(root, { withFileTypes: true })).filter(entry => entry.name.includes(query))
      .map(entry => ({ path: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' }));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ entries, scope: null, status: 'ready', code: null, excluded: 0 }));
  } else if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end(await server.transformIndexHtml('/', `<!doctype html><html><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));
  } else next();
});

const report = [];
const groups = [
  ['availability', '连接、模型与会话提示'], ['recovery', '终端恢复提示'],
  ['errors', '错误、同步与队列提示'], ['approval', '权限与审批提示'], ['transcript', '对话与执行状态提示'],
];
const sheets = [];
try {
  await server.listen();
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    const cases = await page.evaluate(async entry => (await import(entry)).loadRecordedNotices(), entry);
    for (const theme of ['light', 'dark']) {
      for (const locale of ['zh-CN', 'en-US']) {
        for (const sample of cases) {
          for (const width of [760, 360]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(async ({ entry, id, locale, theme }) => (await import(entry)).show(id, locale, theme), { entry, id: sample.id, locale, theme });
            if (sample.id === 'file-reference') await page.locator('[data-composer-editor]').fill('@');
            const element = page.locator(sample.selector).first();
            await element.waitFor({ state: 'visible', timeout: 10_000 });
            if (sample.id !== 'draft-error') assert.doesNotMatch(await element.innerText(),
              /taskTokenBudgetExceeded:|retryable model failure:|network recovery after model transport failure/,
              `${sample.id}/${locale}: system summaries must not expose raw runtime diagnostics`);
            const measurements = await element.evaluate(element => {
              const svg = element.querySelector(':scope > svg, .ai-disclosure-leading > svg, [data-slot="marker-icon"] > svg');
              const description = element.querySelector('[data-slot="alert-description"]');
              const text = element.matches('p') ? element : element.querySelector('[data-slot="alert-title"]:not(.sr-only), .ai-disclosure-title, .ai-turn-error-copy')
                ?? description?.querySelector(':scope > span') ?? description ?? element.querySelector('[data-slot="marker-content"]');
              const icon = svg?.getBoundingClientRect();
              const box = text?.getBoundingClientRect();
              const style = text && getComputedStyle(text);
              const directText = element.matches('p') && [...element.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
              const range = directText && document.createRange();
              if (range) range.selectNode(directText);
              return { hasIcon: Boolean(svg), delta: icon && box && style
                ? icon.y + icon.height / 2 - box.y - parseFloat(style.paddingTop) - parseFloat(style.lineHeight) / 2 : null,
                gap: icon && box ? (range ? range.getBoundingClientRect().left : box.x) - icon.right : null,
                overflow: element.scrollWidth > element.clientWidth + 1 };
            });
            const name = `${sample.id}-${theme}-${locale}-${width}.png`;
            await element.screenshot({ path: join(output, 'samples', name), animations: 'disabled' });
            report.push({ ...sample, theme, locale, width, ...measurements, image: `samples/${name}` });
          }
        }
        for (const [group, title] of groups) {
          const samples = report.filter(sample => sample.group === group && sample.theme === theme && sample.locale === locale);
          const ids = [...new Set(samples.map(sample => sample.id))];
          const images = await Promise.all(samples.map(async sample => ({ ...sample, bitmap: await loadImage(join(output, sample.image)) })));
          const padding = 32;
          const labelHeight = 54;
          const rows = ids.map(id => images.filter(image => image.id === id));
          const heights = rows.map(row => Math.max(...row.map(image => image.bitmap.height / 2)) + labelHeight + 24);
          const canvas = createCanvas(1200 * 2, Math.ceil(140 + heights.reduce((sum, height) => sum + height, 0)) * 2);
          const context = canvas.getContext('2d');
          context.scale(2, 2);
          context.fillStyle = theme === 'dark' ? '#141414' : '#f5f6f8';
          context.fillRect(0, 0, canvas.width / 2, canvas.height / 2);
          context.fillStyle = theme === 'dark' ? '#eeeeee' : '#172033';
          context.font = '600 24px "PingFang SC", sans-serif';
          context.fillText(`Agent 提示检查 · ${title}`, padding, 44);
          context.font = '14px "PingFang SC", sans-serif';
          context.fillText(`${engine.name()} 实际组件渲染 · ${locale} · ${theme === 'dark' ? '深色' : '浅色'} · 左：760px 容器 / 右：360px 容器`, padding, 74);
          context.fillText('单行对齐文字中心，多行对齐第一行。图片保留组件实际尺寸。', padding, 98);
          let top = 128;
          for (const [index, row] of rows.entries()) {
            context.fillStyle = theme === 'dark' ? '#eeeeee' : '#172033';
            context.font = '500 16px "PingFang SC", sans-serif';
            context.fillText(`${String(index + 1).padStart(2, '0')}  ${row[0].label}`, padding, top + 20);
            for (const item of row) context.drawImage(item.bitmap, item.width === 760 ? padding : 830, top + 36, item.bitmap.width / 2, item.bitmap.height / 2);
            top += heights[index];
          }
          const name = `${group}-${theme}-${locale}.png`;
          await writeFile(join(output, name), canvas.toBuffer('image/png'));
          sheets.push({ group, title, theme, locale, image: name, cases: ids.length });
        }
      }
    }
    assert.deepEqual(errors, [], 'Catalog must render without browser errors');
    await writeFile(join(output, 'measurements.json'), JSON.stringify(report, null, 2));
    const failures = report.filter(sample => sample.overflow || (sample.kind !== 'panel' && !sample.hasIcon));
    assert.deepEqual(failures, [], 'Every captured notice must contain its icon and fit its container');
    const offsets = report.filter(sample => !sample.kind && sample.delta !== null && Math.abs(sample.delta) > 0.1);
    assert.deepEqual(offsets, [], 'Notice status icons must align with the first text line');
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Agent 提示检查</title><style>body{font:16px system-ui;background:#f5f6f8;color:#172033;margin:32px auto;max-width:1200px;padding:0 24px}img{width:100%;height:auto;margin:12px 0 32px}a{color:#2457d6}details{margin:20px 0}summary{cursor:pointer;font-weight:600}</style><h1>Agent 带图标提示效果总览</h1><p>${cases.length} 个场景，${report.length} 张组件截图。每张总览同时呈现 760px 和 360px 容器。</p>${['zh-CN', 'en-US'].flatMap(locale => ['light', 'dark'].map(theme => `<details${locale === 'zh-CN' && theme === 'light' ? ' open' : ''}><summary>${locale} / ${theme}</summary>${sheets.filter(sheet => sheet.locale === locale && sheet.theme === theme).map(sheet => `<h2>${sheet.title}（${sheet.cases} 项）</h2><a href="${sheet.image}"><img src="${sheet.image}" alt="${sheet.title}"></a>`).join('')}</details>`)).join('')}<p><a href="measurements.json">逐项测量和源码路径</a></p></html>`;
    await writeFile(join(output, 'index.html'), html);
    console.log(JSON.stringify({ cases: cases.length, screenshots: report.length, sheets: sheets.length,
      offsets: report.filter(sample => !sample.kind && sample.delta !== null && Math.abs(sample.delta) > 0.1).map(({ id, theme, locale, width, delta, gap }) => ({ id, theme, locale, width, delta, gap })), output }));
  } finally { await browser.close(); }
} finally { await server.close(); }
