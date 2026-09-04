import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const output = await mkdtemp(join(tmpdir(), 'shellspan-question-visual-'));
const origin = 'http://127.0.0.1:1446';
const server = spawn(
  'pnpm',
  ['exec', 'vite', '--host', '127.0.0.1', '--port', '1446', '--strictPort'],
  { stdio: 'ignore' },
);
let browser;
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    if (i === 100) throw new Error('Vite startup timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true });
  const evidence = [];
  for (const width of [320, 400, 560, 720])
    for (const theme of ['light', 'dark']) {
      const locale = theme === 'dark' ? 'zh-CN' : 'en-US';
      const page = await browser.newPage({
        viewport: { width, height: 800 },
        reducedMotion: 'reduce',
      });
      await page.goto(
        `${origin}/?aiStage6aVisual&theme=${theme}&locale=${locale}`,
      );
      await page.locator('[data-stage6a-ready]').waitFor();
      await page.evaluate(() => document.fonts.ready);
      const card = page.locator('[data-slot="ai-question-panel"]');
      const submit = card.locator('button').last();
      assert.equal(await submit.isDisabled(), true);
      assert.equal(
        await page.locator('[data-message-scroller-viewport]').count(),
        1,
      );
      const box = await submit.boundingBox();
      assert.ok(
        box && box.y >= 0 && box.y + box.height <= 800,
        'submit clipped',
      );
      const overflow = await card.evaluate(
        (el) => el.scrollWidth > el.clientWidth + 1,
      );
      assert.equal(overflow, false);
      await page.screenshot({
        path: join(output, `${width}-${theme}-pending.png`),
        animations: 'disabled',
      });
      for (const input of await card.getByRole('textbox').all())
        await input.fill('Custom answer');
      await submit.click();
      await card.waitFor({ state: 'detached' });
      assert.equal(
        await page.getByTestId('ai-workspace-composer').inputValue(),
        'ordinary unsent draft',
      );
      assert.equal(
        await page
          .locator('[data-slot="ai-question-history"] textarea')
          .count(),
        0,
      );
      evidence.push({
        width,
        theme,
        locale,
        oneMessageScroller: true,
        submitInViewport: true,
        noHorizontalOverflow: true,
        draftPreserved: true,
      });
      await page.close();
    }
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(evidence, null, 2),
  );
  console.log(`PASS ${evidence.length} browser scenes; evidence: ${output}`);
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
