import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const { default: React } = await import('/@id/react');
    const { default: ReactDOM } = await import('/@id/react-dom/client');
    const { SectionNav } = await import('/src/components/titlebar/section-nav.tsx');
    const { initI18n } = await import('/src/locales/index.ts');
    await import('/src/styles/base.css');
    await initI18n('zh-CN');
    const surface = document.createElement('div');
    surface.id = 'section-nav-preview';
    surface.className = 'flex h-10 items-center bg-app-surface pl-[76px]';
    document.body.replaceChildren(surface);
    ReactDOM.createRoot(surface).render(React.createElement(SectionNav));
  });
  const navigation = page.getByRole('navigation');
  await navigation.getByRole('button', { name: '工作台', exact: true }).waitFor();
  for (const width of [1280, 400]) {
    await page.setViewportSize({ width, height: 720 });
    const geometry = await navigation.getByRole('button').evaluateAll(buttons => buttons.map(button => {
      const rect = button.getBoundingClientRect();
      const icon = button.querySelector('svg').getBoundingClientRect();
      const text = button.querySelector('span').getBoundingClientRect();
      const style = getComputedStyle(button);
      const svg = button.querySelector('svg');
      const bounds = svg.getBBox();
      const point = svg.createSVGPoint();
      point.x = bounds.x + bounds.width / 2;
      point.y = bounds.y + bounds.height / 2;
      const paintedCenter = point.matrixTransform(svg.getScreenCTM()).y;
      point.y = bounds.y;
      const paintedTop = point.matrixTransform(svg.getScreenCTM()).y;
      point.y = bounds.y + bounds.height;
      const paintedBottom = point.matrixTransform(svg.getScreenCTM()).y;
      return { height: rect.height, right: rect.right, radius: parseFloat(style.borderRadius), gap: text.left - icon.right, top: rect.top, iconHeight: icon.height, iconCenter: icon.top + icon.height / 2, textCenter: text.top + text.height / 2, center: rect.top + rect.height / 2, paintedCenter, paintedTop, paintedBottom };
    }));
    assert.equal(geometry.length, 3);
    for (const item of geometry) {
      assert.equal(item.height, 28, `Original control height at ${width}px`);
      assert.ok(item.radius >= item.height / 2, `Capsule radius at ${width}px`);
      assert.equal(item.gap, 4, `Icon spacing at ${width}px`);
      assert.equal(item.iconHeight, 14, `Consistent icon size at ${width}px`);
      assert.equal(item.textCenter - item.iconCenter, 1, `Label optical offset at ${width}px`);
      assert.equal(item.iconCenter, item.center, `Vertical centering at ${width}px`);
      assert.ok(Math.abs(item.paintedCenter - item.center) < 0.01, `Visible icon strokes centered at ${width}px`);
      assert.ok(Math.abs(item.paintedTop - geometry[0].paintedTop) < 0.01, `Visible icon top edges aligned at ${width}px`);
      assert.ok(Math.abs(item.paintedBottom - geometry[0].paintedBottom) < 0.01, `Visible icon bottom edges aligned at ${width}px`);
      assert.ok(item.right <= width, `Navigation fits at ${width}px`);
      assert.equal(item.top, geometry[0].top, `Single navigation row at ${width}px`);
    }
  }
  await navigation.getByRole('button', { name: '终端', exact: true }).click();
  assert.equal(await navigation.getByRole('button', { name: '终端', exact: true }).getAttribute('aria-current'), 'page');
  const sftp = navigation.getByRole('button', { name: 'SFTP', exact: true });
  await sftp.focus();
  await page.keyboard.press('Enter');
  assert.equal(await sftp.getAttribute('aria-current'), 'page');
  await page.waitForFunction(() => {
    const active = document.querySelector('#section-nav-preview [aria-current="page"]');
    return active?.textContent === 'SFTP' && active.classList.contains('bg-app-tab-active');
  });
  await page.screenshot({ animations: 'disabled', path: '/Users/zhengbiwen/.codex/visualizations/2026/10/04/01a106a4-59e6-72a1-9783-ae402b02402e/section-nav-implemented.png' });
} finally {
  await browser.close();
}
