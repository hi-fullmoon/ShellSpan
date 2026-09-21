import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async () => {
    await import('/src/components/ai/styles/styles.css');
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { AiComposerEditor } = await import('/src/components/ai/workspace/ai-composer-editor.tsx');
    const { InputGroup } = await import('/src/components/ui/input-group.tsx');
    const host = document.createElement('main');
    host.id = 'focus-check';
    host.className = 'ai-panel-shell';
    host.style.cssText = 'position:fixed;inset:0;padding:20px;background:var(--background);z-index:100';
    document.body.append(host);
    const h = React.createElement;
    function Editor({ mode }) {
      return h('section', { className: 'ai-composer-seat', 'data-ai-mode': mode },
        h('button', { type: 'button' }, mode),
        h('div', { className: 'ai-composer-input-anchor' },
          h(InputGroup, { className: 'h-auto' }, h(AiComposerEditor, {
            value: '', onChange: value => { host.dataset.draft = value; }, onSelectionChange: () => {}, commandNames: [],
            placeholder: mode, 'aria-label': mode, className: 'min-h-20 w-full p-3',
          }))));
    }
    ReactDOM.createRoot(host).render(h(React.Fragment, null,
      h(Editor, { mode: 'ask' }), h(Editor, { mode: 'agent' })));
  });
  for (const width of [900, 360]) {
    await page.setViewportSize({ width, height: 600 });
    const focusShadows = new Map();
    for (const mode of ['ask', 'agent']) {
      const section = page.locator(`#focus-check [data-ai-mode="${mode}"]`);
      const editor = section.locator('[contenteditable]');
      const card = section.locator('[data-slot="input-group"]');
      const blur = section.getByRole('button');
      await blur.click();
      await card.evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
      const idleShadow = await card.evaluate(el => getComputedStyle(el).boxShadow);
      const idleStroke = await card.evaluate(el => getComputedStyle(el).getPropertyValue('--ai-elevation-stroke-color'));
      for (const method of ['click', 'keyboard']) {
        await blur.click();
        if (method === 'click') await editor.click();
        else await page.keyboard.press('Tab');
        assert.equal(await editor.evaluate(el => el === document.activeElement), true);
        await card.evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
        const focused = await card.evaluate(el => ({
          shadow: getComputedStyle(el).boxShadow,
          stroke: getComputedStyle(el).getPropertyValue('--ai-elevation-stroke-color'),
          accent: getComputedStyle(el).getPropertyValue('--ai-accent'),
        }));
        assert.equal(focused.stroke, focused.accent);
        assert.notEqual(focused.stroke, idleStroke);
        assert.notEqual(focused.shadow, idleShadow, `${mode} must visibly change its focus shadow`);
        if (mode === 'ask') focusShadows.set(method, focused.shadow);
        else assert.equal(focused.shadow, focusShadows.get(method), 'Ask and Agent must render the same focus shadow');
      }
      await editor.fill('Focus');
      assert.equal(await editor.textContent(), 'Focus');
      await blur.click();
      assert.equal(await card.evaluate(el => getComputedStyle(el).getPropertyValue('--ai-elevation-stroke-color')), idleStroke);
      console.log(JSON.stringify({ width, mode, focus: 'passed' }));
    }
  }
} finally {
  await browser.close();
}
