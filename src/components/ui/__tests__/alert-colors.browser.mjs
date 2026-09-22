import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { InfoIcon, TriangleAlertIcon, CircleAlertIcon } = await import('/node_modules/.vite/deps/lucide-react.js');
    const { Alert, AlertDescription } = await import('/src/components/ui/alert.tsx');
    const host = document.createElement('main');
    host.id = 'alert-color-check';
    host.style.cssText = 'position:fixed;inset:0;background:var(--background);padding:16px;z-index:100;overflow:auto';
    document.body.append(host);
    const h = React.createElement;
    ReactDOM.createRoot(host).render(h('div', { className: 'flex flex-col gap-3' },
      ...[
        ['info', InfoIcon, 'primary', 'foreground'],
        ['warning', TriangleAlertIcon, 'app-warning', 'app-warning'],
        ['destructive', CircleAlertIcon, 'destructive', 'destructive'],
        ['destructiveSubtle', CircleAlertIcon, 'destructive', 'foreground'],
      ].flatMap(([variant, Icon, token, textToken]) => ['default', 'sm', 'xs'].map(size =>
        h(Alert, { key: `${variant}-${size}`, variant, size, 'data-color-token': token, 'data-text-token': textToken },
          h(Icon), h(AlertDescription, {}, '发送后会在当前终端新建续接会话，旧命令不会自动重试。'))))));
  });
  await page.locator('#alert-color-check svg').first().waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const results = await page.locator('#alert-color-check [role="alert"]').evaluateAll(alerts => alerts.map(alert => {
        const probe = document.createElement('span');
        alert.append(probe);
        probe.style.color = `var(--${alert.dataset.colorToken})`;
        const expectedIcon = getComputedStyle(probe).color;
        probe.style.color = `var(--${alert.dataset.textToken})`;
        const expectedText = getComputedStyle(probe).color;
        probe.remove();
        return {
          icon: getComputedStyle(alert.querySelector('svg')).color,
          text: getComputedStyle(alert).color,
          expectedIcon, expectedText,
          overflow: alert.scrollWidth > alert.clientWidth,
        };
      }));
      for (const result of results) {
        assert.equal(result.icon, result.expectedIcon, `${theme}, ${width}px: icon color`);
        assert.equal(result.text, result.expectedText, `${theme}, ${width}px: text color`);
        assert.equal(result.overflow, false);
      }
      await page.screenshot({ path: `/tmp/shellspan-alert-colors-${theme}-${width}.png` });
    }
  }
} finally {
  await browser.close();
}
