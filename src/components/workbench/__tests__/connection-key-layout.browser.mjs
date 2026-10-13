import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { ConnectionFormDrawer } = await import('/src/components/workbench/connection-form-drawer.tsx');
    const host = document.createElement('div');
    document.body.append(host);
    ReactDOM.createRoot(host).render(React.createElement(ConnectionFormDrawer, {
      open: true, onClose() {}, onSubmit() {}, onConnect() {},
    }));
  });
  const drawer = page.locator('[data-slot="drawer-content"]').last();
  await drawer.locator('[data-slot="toggle-group-item"]').nth(1).click();
  const input = drawer.locator('input[placeholder="/path/to/key"]');
  await input.waitFor();
  await input.fill('/Users/operator/.ssh/id_ed25519');
  for (const width of [1440, 420, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await input.scrollIntoViewIfNeeded();
    const measurements = await input.evaluate((element) => {
      const button = element.parentElement.querySelector('button');
      const row = element.parentElement.getBoundingClientRect();
      const field = element.getBoundingClientRect();
      const action = button.getBoundingClientRect();
      return {
        fieldHeight: field.height, buttonHeight: action.height,
        fieldTop: field.top, buttonTop: action.top,
        fieldFont: getComputedStyle(element).fontSize,
        buttonFont: getComputedStyle(button).fontSize,
        rowRight: row.right, buttonRight: action.right,
        rowTop: row.top, rowBottom: row.bottom,
        buttonBottom: action.bottom,
        overlapsText: action.left < field.right,
        iconCount: button.querySelectorAll('svg').length,
        buttonText: button.textContent,
        buttonLabel: button.getAttribute('aria-label'),
      };
    });
    assert.equal(measurements.fieldHeight, 36, `Input height at ${width}px`);
    assert.equal(measurements.buttonHeight, 32, `Icon hit target at ${width}px`);
    assert.ok(measurements.buttonTop >= measurements.rowTop && measurements.buttonBottom <= measurements.rowBottom, `Icon within input at ${width}px`);
    assert.equal(measurements.buttonFont, measurements.fieldFont, `Font size at ${width}px`);
    assert.equal(measurements.overlapsText, false, `Icon overlaps text at ${width}px`);
    assert.equal(measurements.iconCount, 1);
    assert.equal(measurements.buttonText, '');
    assert.ok(measurements.buttonLabel, 'Browse action has an accessible name');
    assert.ok(measurements.buttonRight <= measurements.rowRight + 1, `Overflow at ${width}px`);
    await page.screenshot({ path: `/tmp/shellspan-connection-key-${width}.png` });
  }
  await input.focus();
  await page.keyboard.press('Tab');
  assert.equal(await input.evaluate((element) => document.activeElement === element.parentElement.querySelector('button')), true, 'Tab reaches browse action');
  assert.equal(await input.inputValue(), '/Users/operator/.ssh/id_ed25519');
  console.log('Private-key browse icon: containment, hit target, text clearance and keyboard focus passed at 1440, 420 and 320px.');
} finally {
  await browser.close();
}
