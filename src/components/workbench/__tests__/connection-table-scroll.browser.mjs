import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const makeProfiles = (count) =>
  Array.from({ length: count }, (_, index) => ({
    id: `profile-${index + 1}`,
    name: `prod-server-${String(index + 1).padStart(2, '0')}`,
    host: `10.20.${Math.floor(index / 20)}.${(index % 20) + 1}`,
    port: 22,
    username: 'root',
    authMethod: index % 2 === 0 ? 'password' : 'key',
    favorite: index === 0,
    group: index % 3 === 0 ? 'production' : undefined,
    tags: index % 2 === 0 ? ['web', 'eu'] : [],
    notes: index % 4 === 0 ? 'Primary cluster node' : '',
    createdAt: 1700000000000 + index,
    updatedAt: 1700000000000 + index,
  }));

async function launchChromium() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try {
      return await chromium.launch(options);
    } catch {
      // Fall back to system Chrome/Edge when Playwright's bundled shell is unavailable.
    }
  }
  return chromium.launch();
}

const browser = await launchChromium();
try {
  const page = await browser.newPage({ colorScheme: 'light', viewport: { width: 1280, height: 720 } });
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');

  await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { ConnectionList } = await import('/src/components/workbench/connection-list.tsx');
    const { initI18n } = await import('/src/locales/index.ts');
    const { saveConnectionViewMode } = await import('/src/lib/connections/connection-view.ts');

    await initI18n('zh-CN');
    saveConnectionViewMode('table');

    document.getElementById('root').style.display = 'none';
    const host = document.createElement('div');
    host.id = 'connection-table-scroll-check';
    host.style.cssText = 'position:fixed;inset:0 auto auto 0;width:1100px;height:520px;z-index:100;background:var(--background)';
    document.body.append(host);

    const root = ReactDOM.createRoot(host);
    const noop = () => {};
    window.__renderConnectionTableScroll = (profiles) => {
      root.render(
        React.createElement(ConnectionList, {
          profiles,
          initialized: true,
          onAdd: noop,
          onEdit: noop,
          onDelete: noop,
          onConnectTerminal: noop,
          onConnectSftp: noop,
          onDuplicate: noop,
          onToggleFavorite: noop,
          onImport: noop,
          onExport: noop,
        }),
      );
    };
  });

  // 1. Short list: no vertical scrollbar initially
  await page.evaluate((profiles) => window.__renderConnectionTableScroll(profiles), makeProfiles(2));
  await page.locator('#connection-table-scroll-check [data-slot="connection-table-row"]').first().waitFor();
  await page.waitForTimeout(80);

  const shortState = await page.evaluate(() => {
    const host = document.getElementById('connection-table-scroll-check');
    const viewport = host.querySelector('[data-slot="scroll-area-viewport"]');
    const scrollbar = host.querySelector('[data-slot="scroll-area-scrollbar"][data-orientation="vertical"]');
    return {
      overflows: viewport.scrollHeight > viewport.clientHeight,
      hasScrollbar: Boolean(scrollbar),
    };
  });
  assert.equal(shortState.overflows, false, '2 rows should fit without overflowing');
  assert.equal(shortState.hasScrollbar, false, '2 rows should not mount a vertical scrollbar');

  // 2. Dynamically grow to 40 rows: scrollbar must appear immediately without scrolling or resizing
  await page.evaluate((profiles) => window.__renderConnectionTableScroll(profiles), makeProfiles(40));
  await page.locator('#connection-table-scroll-check [data-slot="scroll-area-scrollbar"][data-orientation="vertical"]').waitFor({ timeout: 2000 });

  for (const width of [1100, 520]) {
    await page.evaluate((nextWidth) => {
      const host = document.getElementById('connection-table-scroll-check');
      host.style.width = `${nextWidth}px`;
      const viewport = host.querySelector('[data-slot="scroll-area-viewport"]');
      viewport.scrollTop = 0;
    }, width);
    await page.waitForTimeout(80);

    // Verify scrollbar appears, has thumb height, and does not overlap action buttons
    const atTop = await page.evaluate(() => {
      const host = document.getElementById('connection-table-scroll-check');
      const viewport = host.querySelector('[data-slot="scroll-area-viewport"]');
      const scrollbar = host.querySelector('[data-slot="scroll-area-scrollbar"][data-orientation="vertical"]');
      const thumb = scrollbar?.querySelector('[data-slot="scroll-area-thumb"]');
      const firstRow = host.querySelector('[data-slot="connection-table-row"]');
      const actionButtons = firstRow ? [...firstRow.querySelectorAll('button')] : [];
      const lastButtonRect = actionButtons[actionButtons.length - 1]?.getBoundingClientRect();
      const scrollbarRect = scrollbar?.getBoundingClientRect();
      return {
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
        scrollWidth: viewport.scrollWidth,
        clientWidth: viewport.clientWidth,
        hasOverflowYAttr: viewport.hasAttribute('data-has-overflow-y'),
        hasOverflowStartAttr: viewport.hasAttribute('data-overflow-y-start'),
        thumbHeight: thumb ? thumb.getBoundingClientRect().height : 0,
        scrollbarLeft: scrollbarRect ? scrollbarRect.left : 0,
        lastButtonRight: lastButtonRect ? lastButtonRect.right : 0,
      };
    });

    assert.ok(atTop.scrollHeight > atTop.clientHeight, `Width ${width}: content overflows vertically`);
    assert.ok(atTop.scrollWidth <= atTop.clientWidth + 1, `Width ${width}: no horizontal overflow (${atTop.scrollWidth} <= ${atTop.clientWidth})`);
    assert.equal(atTop.hasOverflowYAttr, true, `Width ${width}: viewport exposes data-has-overflow-y`);
    assert.equal(atTop.hasOverflowStartAttr, false, `Width ${width}: scrollTop=0 has no data-overflow-y-start`);
    assert.ok(atTop.thumbHeight >= 20, `Width ${width}: thumb has visible height (${atTop.thumbHeight})`);
    assert.ok(
      atTop.lastButtonRight <= atTop.scrollbarLeft - 4,
      `Width ${width}: trailing action button (${atTop.lastButtonRight}) clears scrollbar track (${atTop.scrollbarLeft})`,
    );

    // Scroll down and check sticky header, scroll shadow, scrollbar z-order, and keyboard focus clearance
    const scrolled = await page.evaluate(async () => {
      const host = document.getElementById('connection-table-scroll-check');
      const viewport = host.querySelector('[data-slot="scroll-area-viewport"]');
      const thead = host.querySelector('thead');
      const scrollbar = host.querySelector('[data-slot="scroll-area-scrollbar"][data-orientation="vertical"]');
      viewport.scrollTop = 360;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const viewportRect = viewport.getBoundingClientRect();
      const theadRect = thead.getBoundingClientRect();
      const scrollbarRect = scrollbar.getBoundingClientRect();
      const topAtScrollbar = document.elementFromPoint(
        scrollbarRect.left + scrollbarRect.width / 2,
        theadRect.top + theadRect.height / 2,
      );

      // Focus an item above the current scroll position and verify scroll-pt-8 keeps it below sticky header
      const secondRowButton = host.querySelectorAll('[data-slot="connection-table-row"]')[1]?.querySelector('button');
      secondRowButton?.scrollIntoView({ block: 'nearest' });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const focusedButtonRect = secondRowButton?.getBoundingClientRect();

      return {
        scrollTopBeforeFocus: 360,
        theadTopDelta: Math.abs(theadRect.top - viewportRect.top),
        theadHeight: theadRect.height,
        theadBoxShadow: getComputedStyle(thead).boxShadow,
        hasOverflowStartAttr: viewport.hasAttribute('data-overflow-y-start'),
        scrollbarAboveHeader: Boolean(topAtScrollbar && scrollbar.contains(topAtScrollbar)),
        focusedButtonTop: focusedButtonRect?.top ?? 0,
        theadBottom: thead.getBoundingClientRect().bottom,
      };
    });

    assert.ok(scrolled.theadTopDelta <= 1, `Width ${width}: sticky header stays pinned to viewport top (delta=${scrolled.theadTopDelta})`);
    assert.equal(scrolled.hasOverflowStartAttr, true, `Width ${width}: data-overflow-y-start set when scrolled`);
    assert.notEqual(scrolled.theadBoxShadow, 'none', `Width ${width}: sticky header renders scroll elevation shadow`);
    assert.equal(scrolled.scrollbarAboveHeader, true, `Width ${width}: scrollbar paints above sticky header`);
    assert.ok(
      scrolled.focusedButtonTop >= scrolled.theadBottom - 1,
      `Width ${width}: scrollIntoView button (${scrolled.focusedButtonTop}) clears sticky header bottom (${scrolled.theadBottom})`,
    );
  }

  // 3. Dynamically shrink back to 2 rows: scrollbar must disappear immediately
  await page.evaluate((profiles) => window.__renderConnectionTableScroll(profiles), makeProfiles(2));
  await page.waitForTimeout(100);
  const shrunk = await page.evaluate(() => {
    const host = document.getElementById('connection-table-scroll-check');
    return {
      hasScrollbar: Boolean(host.querySelector('[data-slot="scroll-area-scrollbar"][data-orientation="vertical"]')),
    };
  });
  assert.equal(shrunk.hasScrollbar, false, 'Shrinking back to 2 rows immediately removes vertical scrollbar');

  // 4. Empty state stays vertically centered inside ScrollAreaContent
  await page.evaluate(() => window.__renderConnectionTableScroll([]));
  await page.locator('#connection-table-scroll-check [data-slot="panel-empty-state"]').waitFor();
  const emptyCenter = await page.evaluate(() => {
    const host = document.getElementById('connection-table-scroll-check');
    const viewport = host.querySelector('[data-slot="scroll-area-viewport"]').getBoundingClientRect();
    const empty = host.querySelector('[data-slot="empty-state"]').getBoundingClientRect();
    const viewportMidY = viewport.top + viewport.height / 2;
    const emptyMidY = empty.top + empty.height / 2;
    return Math.abs(viewportMidY - emptyMidY);
  });
  assert.ok(emptyCenter < 20, `Empty state remains vertically centered (delta=${emptyCenter})`);

  console.log('Connection table scroll UX check passed across wide and narrow containers');
} finally {
  await browser.close();
}
