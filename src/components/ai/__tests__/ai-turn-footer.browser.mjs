import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Replay a real session: node src/components/ai/__tests__/ai-turn-footer.browser.mjs /path/to/session.jsonl
const events = (await readFile(process.argv[2], 'utf8')).trim().split('\n').map(JSON.parse);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  for (const locale of ['zh-CN', 'en-US']) {
    await page.evaluate(async ({ events, locale, processStatus }) => {
      await import('/src/components/ai/styles/styles.css');
      const { default: React } = await import('/node_modules/.vite/deps/react.js');
      const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { AiTurnFooter } = await import('/src/components/ai/workspace/ai-turn-footer.tsx');
      const { projectAgentChatNodes } = await import('/src/lib/ai/conversation-projection.ts');
      const { initI18n } = await import('/src/locales/index.ts');
      await initI18n(locale);
      const node = projectAgentChatNodes(events).find(node => node.kind === 'turnTail'
        && (processStatus ? node.status === processStatus : node.stats.totalTokens != null) && node.durationMs != null);
      if (!node) throw new Error('Session must contain a completed turn with usage and timing');
      document.querySelector('#footer-check')?.remove();
      const host = document.createElement('main');
      host.id = 'footer-check';
      host.className = 'ai-panel-shell';
      host.style.cssText = 'position:fixed;inset:0;padding:16px;background:var(--background);z-index:10';
      document.body.append(host);
      ReactDOM.createRoot(host).render(React.createElement(AiTurnFooter, { node }));
    }, { events, locale, processStatus: process.argv[3] });
    const triggers = page.locator('#footer-check button[aria-haspopup="dialog"]');
    await triggers.first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await triggers.count(), process.argv[3] === 'failed' ? 1 : 2);
    for (const width of [900, 360, 240]) {
      await page.setViewportSize({ width, height: 600 });
      for (const trigger of await triggers.all()) {
        const geometry = await trigger.evaluate(button => {
          const icon = button.querySelector('svg').getBoundingClientRect();
          const label = button.querySelector('span').getBoundingClientRect();
          const rect = button.getBoundingClientRect();
          return {
            iconOffset: icon.y + icon.height / 2 - rect.y - rect.height / 2,
            textOffset: label.y + label.height / 2 - icon.y - icon.height / 2,
            gap: label.x - icon.right,
            height: rect.height,
            right: rect.right,
          };
        });
        assert.ok(Math.abs(geometry.iconOffset) < 0.1, 'Keep icons centered in the button');
        assert.ok(Math.abs(geometry.textOffset - 1) < 0.1,
          'Apply 1px optical correction for Geist/CJK text');
        assert.equal(geometry.gap, 4);
        assert.equal(geometry.height, 28);
        assert.ok(geometry.right <= width);
        await trigger.focus();
        await page.keyboard.press('Enter');
        const panel = page.locator('.ai-turn-stat-panel');
        await panel.waitFor();
        const heading = await panel.locator('h2').evaluate(title => {
          const icon = title.querySelector('svg').getBoundingClientRect();
          const text = title.querySelector('span').getBoundingClientRect();
          return { gap: text.left - icon.right, offset: text.y + text.height / 2 - icon.y - icon.height / 2 };
        });
        assert.equal(heading.gap, 4, 'Popover titles must share the 4px icon spacing');
        assert.ok(Math.abs(heading.offset - 1) < 0.1, 'Popover titles must share the optical text correction');
        if (width === 360) await panel.screenshot({ path: `/tmp/shellspan-stat-${locale}-${await trigger.getAttribute('aria-label') ?? await trigger.textContent()}.png` });
        await page.keyboard.press('Escape');
        await panel.waitFor({ state: 'hidden' });
      }
      const timestamp = await page.locator('#footer-check time').evaluate(time => {
        const rect = time.getBoundingClientRect();
        const labels = [...time.parentElement.querySelectorAll('button[aria-haspopup="dialog"] > span')]
          .map(label => label.getBoundingClientRect())
          .filter(label => Math.abs(label.y - rect.y) < 10);
        return {
          height: rect.height,
          offsets: labels.map(label => rect.y - label.y),
        };
      });
      assert.equal(timestamp.height, 20, 'Timestamp and stat labels must use the same line height');
      if (width === 900) assert.ok(timestamp.offsets.length > 0, 'Wide layout must keep the timestamp on the stat row');
      for (const offset of timestamp.offsets) {
        assert.ok(Math.abs(offset) < 0.1, 'Timestamp must align with adjacent stat text');
      }
      console.log(JSON.stringify({ locale, width, aligned: true }));
      if (width === 360) await page.locator('#footer-check').screenshot({ path: `/tmp/shellspan-footer-${locale}.png` });
    }
    for (const trigger of await triggers.all()) {
      await trigger.focus();
      await page.keyboard.press('Enter');
      await page.locator('.ai-turn-stat-panel').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('.ai-turn-stat-panel').waitFor({ state: 'hidden' });
    }
  }
} finally {
  await browser.close();
}
