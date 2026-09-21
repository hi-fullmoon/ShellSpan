import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const browser = await (process.env.SHELLSPAN_TEST_ENGINE === 'webkit' ? webkit : chromium).launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { InfoIcon } = await import('/node_modules/.vite/deps/lucide-react.js');
    const { Alert, AlertTitle, AlertDescription } = await import('/src/components/ui/alert.tsx');
    const host = document.createElement('main');
    host.id = 'alert-alignment-check';
    host.className = 'ai-panel-shell font-sans text-sm leading-[22px]';
    host.style.cssText = 'position:absolute;inset:0;background:var(--background);padding:16px;z-index:100;overflow:auto';
    document.body.append(host);
    const h = React.createElement;
    ReactDOM.createRoot(host).render(h('div', { className: 'flex flex-col gap-3' },
      ...['info', 'default', 'subtle', 'warning', 'destructive', 'destructiveSubtle'].flatMap(variant =>
        ['default', 'sm', 'xs'].flatMap(size =>
          ['zh', 'en'].flatMap(language => [false, true].map(titled =>
            h(Alert, { key: `${variant}-${size}-${language}-${titled}`, variant, size },
              h(InfoIcon),
              titled && h(AlertTitle, {}, language === 'zh' ? '操作提示' : 'Session continuation'),
              h(AlertDescription, {}, language === 'zh'
                ? '发送后会在当前终端新建续接会话，旧命令不会自动重试。'
                : 'Sending starts a continuation session in the current terminal. Previous commands are not retried automatically.'))))))));
  });
  await page.locator('#alert-alignment-check [role="alert"]').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  // Measure painted pixels, not just layout boxes: CJK glyphs sit above the line center.
  const sample = page.locator('#alert-alignment-check [role="alert"]').nth(4);
  const regions = await sample.evaluate(alert => {
    const root = alert.getBoundingClientRect();
    return ['svg', '[data-slot="alert-description"]'].map(selector => {
      const box = alert.querySelector(selector).getBoundingClientRect();
      return { x: box.x - root.x, y: box.y - root.y, width: box.width, height: box.height };
    });
  });
  const screenshot = await sample.screenshot();
  const paintedCenters = await page.evaluate(async ({ data, regions }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    return regions.map(box => {
      let top = Infinity;
      let bottom = -Infinity;
      for (let y = Math.floor(box.y * 2); y < Math.ceil((box.y + box.height) * 2); y++) {
        for (let x = Math.floor(box.x * 2); x < Math.floor((box.x + box.width) * 2); x++) {
          const offset = (y * canvas.width + x) * 4;
          if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 130) {
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
      }
      if (!Number.isFinite(top)) throw new Error('No painted foreground pixels');
      return (top + bottom) / 4;
    });
  }, { data: screenshot.toString('base64'), regions });
  // Diagnostic only: desktop WKWebView and standalone browsers can use different
  // fallback glyph metrics. Preserve the measurement instead of treating box checks
  // as proof of optical alignment in the desktop application.
  console.log({ paintedCenters });
  for (const width of [1280, 640, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const measurements = await page.locator('#alert-alignment-check [role="alert"]').evaluateAll(alerts => alerts.map(alert => {
      const icon = alert.querySelector(':scope > svg').getBoundingClientRect();
      const text = alert.querySelector('[data-slot="alert-title"], [data-slot="alert-description"]');
      const box = text.getBoundingClientRect();
      return {
        delta: icon.y + icon.height / 2 - box.y - parseFloat(getComputedStyle(text).lineHeight) / 2,
        correction: parseFloat(getComputedStyle(alert).getPropertyValue('--alert-icon-offset')),
        gap: box.x - icon.right,
        overflow: alert.scrollWidth > alert.clientWidth,
      };
    }));
    for (const [index, result] of measurements.entries()) {
      assert.ok(Math.abs(result.delta + result.correction) < 0.1, `Sample ${index} at ${width}px: first-line offset ${result.delta}`);
      assert.equal(result.gap, 4);
      assert.equal(result.overflow, false);
    }
    await page.screenshot({ path: `/tmp/shellspan-alert-alignment-${width}.png` });
    console.log(`${width}px: ${measurements.length} alerts aligned with the first line`);
  }
} finally {
  await browser.close();
}
