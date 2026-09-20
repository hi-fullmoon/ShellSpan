import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const taskStyles = await readFile(fileURLToPath(new URL('../styles/tasks.css', import.meta.url)), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [320, 760]) {
    const page = await browser.newPage({ viewport: { width, height: 480 } });
    await page.setContent(`<!doctype html>
      <style>
        * { box-sizing: border-box; }
        body { margin: 0; padding: 20px; font-family: sans-serif; }
        .ai-task-strip-trigger { display: flex; align-items: center; gap: 4px; height: 32px; width: 100%; padding: 4px 12px; }
        .ai-task-strip-trigger > svg { flex: none; }
        .ai-task-strip-title { flex: none; }
        .ai-task-strip-progress { min-width: 0; flex: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        ${taskStyles}
      </style>
      <button class="ai-task-strip-trigger">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 4h2m2 0h6M2 9h2m2 0h6" stroke="currentColor" /></svg>
        <span class="ai-task-strip-title">任务</span>
        <span class="ai-task-strip-progress">2 已完成 · 2 进行中</span>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="m3 9 4-4 4 4" stroke="currentColor" /></svg>
      </button>`);
    const layout = await page.locator('.ai-task-strip-trigger').evaluate(element => {
      const icon = element.querySelector('svg');
      const title = element.querySelector('.ai-task-strip-title');
      const progress = element.querySelector('.ai-task-strip-progress');
      const center = node => {
        const rect = node.getBoundingClientRect();
        return rect.top + rect.height / 2;
      };
      return {
        titleLineHeight: getComputedStyle(title).lineHeight,
        progressLineHeight: getComputedStyle(progress).lineHeight,
        titleTop: title.getBoundingClientRect().top,
        progressTop: progress.getBoundingClientRect().top,
        iconCenter: center(icon),
        titleCenter: center(title),
        progressCenter: center(progress),
        triggerCenter: center(element),
      };
    });
    assert.equal(layout.titleLineHeight, layout.progressLineHeight);
    assert.ok(Math.abs(layout.titleTop - layout.progressTop) <= 1, `${width}px: text rows differ: ${JSON.stringify(layout)}`);
    for (const center of [layout.iconCenter, layout.titleCenter, layout.progressCenter]) {
      assert.ok(Math.abs(center - layout.triggerCenter) <= 1, `${width}px: row is off center: ${JSON.stringify(layout)}`);
    }
    console.log(`${width}px: task icon, title, and progress align`);
    await page.close();
  }
} finally {
  await browser.close();
}
