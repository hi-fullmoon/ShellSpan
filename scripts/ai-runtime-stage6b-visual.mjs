import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
const output = await mkdtemp(join(tmpdir(), 'shellspan-skills-visual-'));
const origin = 'http://127.0.0.1:1447';
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '1447', '--strictPort'], { stdio: 'ignore' });
let browser;
try {
  for (let i = 0;; i++) { try { if ((await fetch(origin)).ok) break; } catch {} if (i === 100) throw new Error('Vite startup timeout'); await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true }); const report = [];
  for (const width of [320, 400, 560, 720]) for (const theme of ['light', 'dark']) {
    const zh = theme === 'dark'; const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
    await page.goto(`${origin}/?aiStage6bVisual&theme=${theme}&locale=${zh ? 'zh-CN' : 'en-US'}`);
    await page.locator('[data-stage6b-ready]').waitFor(); await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('[data-message-scroller-viewport]').count(), 1);
    await page.getByRole('button', { name: zh ? '技能' : 'Skills', exact: true }).click();
    await page.getByRole('textbox', { name: zh ? '项目目录' : 'Project directory' }).fill('/explicit/project');
    await page.screenshot({ path: join(output, `${width}-${theme}-root.png`), animations: 'disabled' });
    await page.getByRole('button', { name: zh ? '读取技能' : 'Load skills' }).click();
    const menu = page.getByRole('menu'); await menu.waitFor();
    assert.equal(await menu.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    const box = await menu.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 800);
    await page.screenshot({ path: join(output, `${width}-${theme}-menu.png`), animations: 'disabled' });
    await page.getByRole('menuitem', { name: /\/user/ }).click();
    assert.equal(await page.getByTestId('ai-workspace-composer').inputValue(), 'ordinary draft /user ');
    report.push({ width, theme, oneMessageScroller: true, explicitRootEditable: true, menuInViewport: true, fullRuntimeFixtureRendered: true, slashInserted: true }); await page.close();
  }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(`PASS ${report.length} Skills browser scenes; evidence: ${output}`);
} finally { await browser?.close(); server.kill('SIGTERM'); }
