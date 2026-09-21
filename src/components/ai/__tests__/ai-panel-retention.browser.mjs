import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  for (const width of [1200, 420]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
    await page.evaluate(async () => {
      const { useAppStore } = await import('/src/stores/appStore.ts');
      const { useAiPanelStore } = await import('/src/stores/aiPanelStore.ts');
      useAppStore.setState({ activeSection: 'workbench' });
      useAiPanelStore.getState().setOpen(true, 'workbench');
    });
    const panel = page.locator('[data-slot="ai-panel"][data-ai-scope="workbench"]');
    await panel.waitFor({ state: 'visible' });
    const original = await panel.locator('[data-slot="ai-workspace-root"]').elementHandle();
    for (let visit = 0; visit < 3; visit += 1) {
      await page.evaluate(async () => {
        const { useAiPanelStore } = await import('/src/stores/aiPanelStore.ts');
        useAiPanelStore.getState().setOpen(false, 'workbench');
      });
      await panel.waitFor({ state: 'hidden' });
      assert.equal(await original.evaluate(el => el.isConnected), true);
      assert.equal(await panel.evaluate(el => el.getBoundingClientRect().width), 0);
      await page.evaluate(async () => {
        const { useAiPanelStore } = await import('/src/stores/aiPanelStore.ts');
        useAiPanelStore.getState().setOpen(true, 'workbench');
      });
      await panel.waitFor({ state: 'visible' });
      assert.equal(await original.evaluate(el => el === document.querySelector(
        '[data-ai-scope="workbench"] [data-slot="ai-workspace-root"]',
      )), true);
    }
    console.log(JSON.stringify({ width, retainedAcrossCloses: true }));
    await page.close();
  }
} finally {
  await browser.close();
}
