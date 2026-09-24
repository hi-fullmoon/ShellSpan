import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { ConnectionCardGrid } = await import('/src/components/workbench/connection-list.tsx');
    const { ManagementCard } = await import('/src/components/workbench/management-card.tsx');
    const host = document.createElement('div');
    host.id = 'connection-grid-check';
    host.style.cssText = 'position:fixed;inset:0 auto auto 0;width:1100px;z-index:100;background:white';
    document.body.append(host);
    ReactDOM.createRoot(host).render(React.createElement(ConnectionCardGrid, null,
      React.createElement(ManagementCard, null, 'Connection card layout'),
    ));
  });
  await page.locator('#connection-grid-check .grid > *').waitFor();
  for (const viewport of [1440, 1000]) {
    await page.setViewportSize({ width: viewport, height: 900 });
    const measurements = await page.evaluate(async () => {
      const host = document.getElementById('connection-grid-check');
      const grid = host.querySelector('.grid');
      const card = grid.firstElementChild;
      const rows = [];
      const measure = () => {
        const width = grid.getBoundingClientRect().width;
        rows.push({ width, card: card.getBoundingClientRect().width,
          columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length });
      };
      // Read layout immediately, before observers or React can update state.
      for (const width of [1100, 600, 900, 899, 640, 639, 320, 1100]) {
        host.style.width = `${width}px`;
        measure();
      }
      // Also cover the intermediate widths during an animated panel opening.
      host.style.transition = 'width 200ms linear';
      await new Promise(requestAnimationFrame);
      host.style.width = '500px';
      const start = performance.now();
      do {
        await new Promise(requestAnimationFrame);
        measure();
      } while (performance.now() - start < 250);
      host.style.transition = '';
      return rows;
    });
    for (const { width, card, columns } of measurements) {
      const expected = width >= 900 ? 3 : width >= 640 ? 2 : 1;
      assert.equal(columns, expected, `Column count at ${width}px`);
      assert.ok(Math.abs(card - (width - (expected - 1) * 8) / expected) < 1,
        `Card width ${card}px at container width ${width}px`);
    }
    console.log(`Connection grid: ${measurements.length} synchronous and animated layouts passed at viewport ${viewport}px`);
  }
} finally {
  await browser.close();
}
