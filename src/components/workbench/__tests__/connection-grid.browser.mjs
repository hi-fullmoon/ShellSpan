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
    const { rem, gap, measurements } = await page.evaluate(async () => {
      const host = document.getElementById('connection-grid-check');
      const grid = host.querySelector('.grid');
      const card = grid.firstElementChild;
      const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const columnGap = parseFloat(getComputedStyle(grid).columnGap);
      const rows = [];
      const measure = (phase) => {
        const width = grid.getBoundingClientRect().width;
        rows.push({
          phase,
          width,
          card: card.getBoundingClientRect().width,
          columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
        });
      };
      // Read layout immediately, before observers or React can update state.
      for (const width of [2330, 1690, 1240, 1100, 928, 927, 640, 616, 615, 320, 260, 1690]) {
        host.style.width = `${width}px`;
        measure('sync');
      }
      // Also cover the intermediate widths during an animated panel opening.
      host.style.transition = 'width 200ms linear';
      await new Promise(requestAnimationFrame);
      host.style.width = '500px';
      const start = performance.now();
      do {
        await new Promise(requestAnimationFrame);
        measure('animated');
      } while (performance.now() - start < 250);
      host.style.transition = '';
      return { rem: rootFontSize, gap: columnGap, measurements: rows };
    });
    const minTrack = 19 * rem;
    const expectedColumnsFor = (w) => Math.max(1, Math.floor((w + gap) / (minTrack + gap)));
    for (const { phase, width, card, columns } of measurements) {
      if (phase === 'sync') {
        const expected = expectedColumnsFor(width);
        assert.equal(columns, expected, `Column count at ${width}px`);
      } else {
        const minExpected = expectedColumnsFor(Math.floor(width));
        const maxExpected = expectedColumnsFor(Math.ceil(width));
        assert.ok(columns >= minExpected && columns <= maxExpected,
          `Animated column count ${columns} outside [${minExpected}, ${maxExpected}] at ${width}px`);
      }
      assert.ok(Math.abs(card - (width - (columns - 1) * gap) / columns) < 1,
        `Card width ${card}px at container width ${width}px`);
    }
    console.log(`Connection grid: ${measurements.length} synchronous and animated layouts passed at viewport ${viewport}px`);
  }
} finally {
  await browser.close();
}
