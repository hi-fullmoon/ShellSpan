import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Run with the Vite development server: node src/components/ai/__tests__/ai-error-notice.browser.mjs
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { AiErrorNotice } = await import('/src/components/ai/workspace/ai-error-notice.tsx');
    const { Alert, AlertDescription } = await import('/src/components/ui/alert.tsx');
    const { Button } = await import('/src/components/ui/button.tsx');
    const { XIcon, InfoIcon } = await import('/node_modules/.vite/deps/lucide-react.js');
    const host = document.createElement('main');
    host.id = 'notice-check';
    host.style.cssText = 'position:fixed;inset:0;background:var(--background);padding:16px;z-index:100';
    document.body.append(host);
    const h = React.createElement;
    ReactDOM.createRoot(host).render(h('div', { className: 'flex flex-col gap-3' },
      h(AiErrorNotice, {
        title: 'Error',
        action: h(Button, {
          size: 'icon-xs', variant: 'ghost', 'aria-label': 'Dismiss error',
          onClick: () => host.dataset.dismissed = 'true',
        }, h(XIcon)),
      }, 'IMAGE_MODEL_UNSUPPORTED: image input is not enabled for this model'),
      h(Alert, { variant: 'info', size: 'sm', role: 'status' },
        h(InfoIcon, { 'aria-hidden': true }),
        h(AlertDescription, { className: 'min-w-0 break-words' },
          '发送后会在当前终端新建续接会话，旧命令不会自动重试。')),
      h(AiErrorNotice, { title: 'Error' },
        'IMAGE_MODEL_UNSUPPORTED: image input is not enabled for this model'),
    ));
  });
  await page.locator('#notice-check button').waitFor();
  await page.evaluate(() => document.fonts.ready);
  let wideHeight;
  for (const width of [1280, 640, 320]) {
    await page.setViewportSize({ width, height: 800 });
    const geometry = await page.locator('#notice-check').evaluate(host => {
      const alerts = [...host.querySelectorAll('[data-slot="alert"]')];
      const rect = element => {
        const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
        return { x, y, width, height, right, bottom };
      };
      return {
        alerts: alerts.map(rect),
        descriptions: alerts.map(alert => rect(alert.querySelector('[data-slot="alert-description"]'))),
        icons: alerts.map(alert => rect(alert.querySelector(':scope > svg'))),
        lineHeights: alerts.map(alert => parseFloat(getComputedStyle(alert.querySelector('[data-slot="alert-description"]')).lineHeight)),
        description: rect(alerts[0].querySelector('[data-slot="alert-description"]')),
        button: rect(host.querySelector('button')),
        overflow: host.scrollWidth > host.clientWidth,
      };
    });
    const [error, status, plainError] = geometry.alerts;
    if (width === 1280) {
      assert.equal(error.height, status.height, 'Single-line error and status heights must match');
      assert.equal(error.height, plainError.height, 'Dismiss control must not increase height');
      wideHeight = error.height;
    }
    if (width === 320) assert.ok(error.height > wideHeight, 'Long errors must wrap');
    assert.equal(geometry.overflow, false);
    geometry.alerts.forEach((alert, index) => {
      const text = geometry.descriptions[index];
      const icon = geometry.icons[index];
      assert.equal(icon.width, 14);
      assert.equal(icon.height, 14);
      assert.equal(text.x - icon.right, 4, 'Icon and text spacing must be 4px');
      if (width === 1280) {
        assert.ok(Math.abs(icon.y + icon.height / 2 - alert.y - alert.height / 2 + (index === 1 ? 1 : 0)) < 0.1,
          'Single-line icons must be vertically centered');
      }
      assert.ok(Math.abs(text.y + text.height / 2 - alert.y - alert.height / 2) < 0.1,
        'Text must remain centered without a fixed optical offset');
      assert.ok(Math.abs(icon.y + icon.height / 2 - text.y - geometry.lineHeights[index] / 2 + (index === 1 ? 1 : 0)) < 0.1,
        'Icons must align with the first text line, including wrapped notices');
    });
    assert.ok(geometry.description.right <= geometry.button.x, 'Text must not overlap the button');
    assert.ok(geometry.button.y >= error.y && geometry.button.bottom <= error.bottom);
    assert.ok(Math.abs(geometry.button.y + geometry.button.height / 2 - error.y - error.height / 2) < 1);
    assert.equal(geometry.button.height, 24, 'Keep the dismiss hit area');
    console.log(JSON.stringify({ width, ...geometry }));
    if (width === 640) await page.locator('#notice-check').screenshot({ path: '/tmp/shellspan-notice-alignment.png' });
  }
  await page.locator('#notice-check button').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#notice-check').getAttribute('data-dismissed'), 'true');
} finally {
  await browser.close();
}
