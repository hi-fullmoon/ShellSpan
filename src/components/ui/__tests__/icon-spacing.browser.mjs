import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Run against Vite: node src/components/ui/__tests__/icon-spacing.browser.mjs
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { InfoIcon } = await import('/node_modules/.vite/deps/lucide-react.js');
    const { Alert, AlertDescription } = await import('/src/components/ui/alert.tsx');
    const { Marker, MarkerIcon, MarkerContent } = await import('/src/components/ui/marker.tsx');
    const { InputGroup, InputGroupAddon, InputGroupText } = await import('/src/components/ui/input-group.tsx');
    const { Button } = await import('/src/components/ui/button.tsx');
    const { Toaster } = await import('/src/components/ui/sonner.tsx');
    const { useToastStore } = await import('/src/stores/toastStore.ts');
    const host = document.createElement('main');
    host.id = 'icon-spacing-check';
    host.style.cssText = 'position:fixed;inset:0;background:var(--background);padding:16px;z-index:100';
    document.body.append(host);
    const h = React.createElement;
    const icon = () => h(InfoIcon);
    const text = () => h('span', {}, '操作提示');
    ReactDOM.createRoot(host).render(h('div', { className: 'flex flex-col gap-3' },
      ...['default', 'info', 'subtle', 'warning', 'destructive', 'destructiveSubtle'].flatMap(variant =>
        ['default', 'sm', 'xs'].map(size => h(Alert, { key: `${variant}-${size}`, variant, size, 'data-spacing': `${variant}-${size}` },
          icon(), h(AlertDescription, {}, '发送后会在当前终端新建续接会话，旧命令不会自动重试。')))),
      h(Marker, { 'data-spacing': 'marker' }, h(MarkerIcon, {}, icon()), h(MarkerContent, {}, '操作提示')),
      h(InputGroup, {}, h(InputGroupAddon, { 'data-spacing': 'addon' }, icon(), text())),
      h(InputGroupText, { 'data-spacing': 'input-text' }, icon(), text()),
      h(Button, { 'data-spacing': 'button' }, icon(), text()),
      h(Toaster),
    ));
    useToastStore.getState().addToast('保存成功', 'success', 60000);
  });
  await page.locator('#icon-spacing-check [data-sonner-toast] [data-icon]').waitFor();
  for (const width of [1280, 640, 320]) {
    await page.setViewportSize({ width, height: 1600 });
    const gaps = await page.locator('#icon-spacing-check').evaluate(host => {
      const samples = [...host.querySelectorAll('[data-spacing]')].map(element => {
        const [icon, text] = element.children;
        return { name: element.dataset.spacing, gap: text.getBoundingClientRect().left - icon.getBoundingClientRect().right };
      });
      const toast = host.querySelector('[data-sonner-toast]');
      samples.push({ name: 'toast', gap: toast.querySelector('[data-content]').getBoundingClientRect().left - toast.querySelector('[data-icon]').getBoundingClientRect().right });
      return samples;
    });
    for (const { name, gap } of gaps) assert.equal(gap, 4, `${name} spacing at ${width}px`);
    console.log(`${width}px: ${gaps.length} icon/text pairs measured at 4px`);
  }
} finally {
  await browser.close();
}
