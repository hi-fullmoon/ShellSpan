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
      const text = button.querySelector('span').getBoundingClientRect();
      const style = getComputedStyle(button);
      return { height: rect.height, right: rect.right, radius: parseFloat(style.borderRadius), top: rect.top, iconCount: button.querySelectorAll('svg').length, textCenter: text.left + text.width / 2, center: rect.left + rect.width / 2 };
    }));
    assert.equal(geometry.length, 3);
    for (const item of geometry) {
      assert.equal(item.height, 28, `Original control height at ${width}px`);
      assert.ok(item.radius >= item.height / 2, `Capsule radius at ${width}px`);
      assert.equal(item.iconCount, 0, `Text-only navigation at ${width}px`);
      assert.ok(Math.abs(item.textCenter - item.center) < 0.01, `Label centered at ${width}px`);
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
  await page.screenshot({ animations: 'disabled', path: process.env.SHELLSPAN_SCREENSHOT_PATH ?? '/tmp/shellspan-section-nav.png' });
} finally {
  await browser.close();
}
