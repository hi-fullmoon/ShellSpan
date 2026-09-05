import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
const output = await mkdtemp(join(tmpdir(), 'shellspan-skills-visual-'));
const origin = 'http://127.0.0.1:1447';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1447', '--strictPort'], { stdio: 'ignore' });
let browser;
try {
  for (let i = 0;; i++) { try { if ((await fetch(origin)).ok) break; } catch {} if (i === 100) throw new Error('Vite startup timeout'); await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true }); const report = [];
  for (const width of [320, 400, 560, 720]) for (const theme of ['light', 'dark']) {
    const zh = theme === 'dark'; const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
    await page.goto(`${origin}/?aiStage6bVisual&theme=${theme}&locale=${zh ? 'zh-CN' : 'en-US'}`);
    await page.locator('[data-stage6b-ready]').waitFor(); await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('[data-message-scroller-viewport]').count(), 1);
    assert.equal(await page.getByRole('button', { name: zh ? '技能' : 'Skills', exact: true }).count(), 0);
    const composer = page.locator('[data-composer-card]');
    const closedComposer = await composer.boundingBox();
    await page.getByTestId('ai-workspace-composer').fill('ordinary draft /');
    const menu = page.locator('[data-skill-completion]'); await menu.waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.getByRole('option').count(), 5);
    assert.equal(await menu.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    const box = await menu.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 800);
    const openComposer = await composer.boundingBox();
    assert.ok(closedComposer && openComposer && box);
    assert.ok(box.y + box.height < openComposer.y, 'skill menu has its own surface above the composer');
    assert.ok(Math.abs(box.x - openComposer.x) <= 1 && Math.abs(box.width - openComposer.width) <= 1, 'menu matches composer width');
    assert.ok(Math.abs(openComposer.height - closedComposer.height) <= 1, 'opening skills preserves input height');
    await page.screenshot({ path: join(output, `${width}-${theme}-menu.png`), animations: 'disabled' });
    await page.getByRole('option', { name: /system-status/ }).click();
    assert.equal(await page.getByTestId('ai-workspace-composer').evaluate(el => el.textContent ? el.innerText : ''), 'ordinary draft /system-status ');
    report.push({ width, theme, oneMessageScroller: true, noDirectoryRequired: true, menuInViewport: true, menuAboveComposer: true, inputHeightPreserved: true, fullRuntimeFixtureRendered: true, slashInserted: true }); await page.close();
  }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(`PASS ${report.length} Skills browser scenes; evidence: ${output}`);
} finally { await browser?.close(); server.kill('SIGTERM'); }
