import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const locale of ['en-US', 'zh-CN']) {
    await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
    await page.evaluate(async locale => {
      const { default: React } = await import('/@id/react');
      const { default: ReactDOM } = await import('/@id/react-dom/client');
      const { AgentPermissionSelector } = await import('/src/components/ai/agent-permission-selector.tsx');
      const { useTerminalStore } = await import('/src/stores/terminalStore.ts');
      const { useAppStore } = await import('/src/stores/appStore.ts');
      const { initI18n } = await import('/src/locales/index.ts');
      await import('/src/styles/base.css');
      await import('/src/components/ai/styles/styles.css');
      useAppStore.setState({ locale });
      await initI18n(locale);
      useTerminalStore.getState().addSession({
        sessionId: 'menu-layout', title: 'Menu layout', host: 'local', port: 0, username: '',
      }, 'menu-layout');
      useTerminalStore.getState().setStatus('menu-layout', {
        sessionId: 'menu-layout', status: 'connected',
      });
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement('main', {
        className: 'ai-panel-shell @container/ai-workspace p-4',
        style: { paddingTop: '400px' },
      }, React.createElement(AgentPermissionSelector, {
        sessionId: 'menu-layout', variant: 'composer',
      })));
    }, locale);
    await page.locator('[data-slot="agent-permission-trigger-content"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    for (const width of [720, 320, 240]) {
      await page.setViewportSize({ width, height: 800 });
      await page.locator('[data-slot="dropdown-menu-trigger"]').click();
      const menu = page.locator('.ai-permission-menu');
      await menu.waitFor();
      assert.equal(await menu.locator('[data-slot="agent-permission-option-title"]').first().textContent(),
        locale === 'en-US' ? 'Approve for me' : '帮我批准');
      const layout = await menu.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left, right: rect.right,
          overflow: element.scrollWidth > element.clientWidth,
          titles: [...element.querySelectorAll('[data-slot="agent-permission-option-title"]')].map(title => {
            const range = document.createRange();
            range.selectNodeContents(title);
            const bounds = title.getBoundingClientRect();
            return {
              lines: range.getClientRects().length,
              left: bounds.left, right: bounds.right,
            };
          }),
          badges: [...element.querySelectorAll('[data-slot="badge"]')].map(badge => {
            const bounds = badge.getBoundingClientRect();
            const title = badge.parentElement.querySelector('[data-slot="agent-permission-option-title"]').getBoundingClientRect();
            return { top: bounds.top, left: bounds.left, right: bounds.right, titleBottom: title.bottom, titleRight: title.right };
          }),
        };
      });
      assert.equal(layout.titles.length, 3);
      assert.ok(layout.left >= 0 && layout.right <= width, `${locale}/${width}: menu must fit the viewport`);
      assert.equal(layout.overflow, false, `${locale}/${width}: menu must not clip horizontally`);
      for (const title of layout.titles) {
        assert.equal(title.lines, 1, `${locale}/${width}: menu titles must stay on one line`);
        assert.ok(title.left >= layout.left && title.right <= layout.right, `${locale}/${width}: title must fit`);
      }
      for (const badge of layout.badges) {
        assert.ok(badge.right <= layout.right, `${locale}/${width}: badge must fit`);
        assert.ok(badge.top >= badge.titleBottom || badge.left >= badge.titleRight,
          `${locale}/${width}: badge must not overlap the title`);
      }
      if (locale === 'en-US' && width === 720) {
        assert.ok(layout.badges.every(badge => badge.left >= badge.titleRight), 'Wide menu should keep badges beside titles');
        await menu.screenshot({ path: '/tmp/shellspan-permission-menu-en.png' });
      }
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
    }
  }
} finally {
  await browser.close();
}
