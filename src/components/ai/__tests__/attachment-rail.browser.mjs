import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Run after pnpm build. This checks the compiled styles at representative pane widths.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const assets = `${root}dist/assets`;
const stylesheet = readdirSync(assets).find(name => /^main-.*\.css$/u.test(name));
assert.ok(stylesheet, 'Build the frontend before running this layout check');
const css = readFileSync(`${assets}/${stylesheet}`, 'utf8');
const cards = Array.from({ length: 6 }, (_, index) =>
  `<div data-slot="attachment" data-orientation="vertical" data-state="done" class="group/attachment relative flex w-fit max-w-full min-w-0 shrink-0 flex-wrap ai-image-thumbnail isolate size-16 min-w-16 has-data-[slot=attachment-media]:p-0" data-card-index="${index}">
    <div data-slot="attachment-media" class="relative flex aspect-square w-10 shrink-0 overflow-hidden ai-image-thumbnail-media size-full"><img class="h-full w-full object-cover" alt="Image ${index}" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='92'%3E%3Crect width='120' height='92' fill='blue'/%3E%3C/svg%3E" /></div>
    <button data-slot="attachment-trigger" class="absolute inset-0 z-10"></button>
    <div data-slot="attachment-actions" class="relative z-20 flex shrink-0 items-center group-data-[orientation=vertical]/attachment:absolute group-data-[orientation=vertical]/attachment:top-0.75 group-data-[orientation=vertical]/attachment:right-0.75">
      <button data-slot="attachment-action" class="ai-image-thumbnail-remove size-5" aria-label="Remove image">×</button>
    </div>
  </div>`).join('');

const browser = await chromium.launch({ headless: true });
try {
  for (const width of [400, 760]) {
    const page = await browser.newPage({ viewport: { width, height: 600 } });
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>
      <main style="width:100%;padding:12px">
        <div data-slot="input-group" class="flex w-full min-w-0 flex-col items-stretch overflow-hidden">
          <div data-slot="input-group-addon" class="block w-full min-w-0 px-3">
            <div class="ai-image-rail relative min-w-0 flex-1" data-unified-attachments="true">
              <div data-slot="attachment-group" class="ai-image-rail-viewport flex w-full min-w-0 snap-x snap-mandatory gap-2 overflow-x-auto overflow-y-hidden p-0 scrollbar-none">
                ${cards}<div data-slot="attachment" data-orientation="vertical" data-state="processing" class="group/attachment relative flex w-24 flex-col shrink-0 rounded-xl border bg-card text-card-foreground text-xs ai-composer-file-card focus-within:ring-0" data-file-kind="markdown" data-document-name="README.md">
                  <div data-slot="attachment-media" class="relative flex shrink-0 items-center justify-center overflow-hidden"><svg data-slot="document-kind-icon" class="size-4 group-data-[orientation=vertical]/attachment:size-6" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 2h9l5 5v15H5z" fill="none" stroke="currentColor" stroke-width="2" /></svg></div>
                  <div data-slot="attachment-content" class="max-w-full min-w-0 flex-1 leading-tight group-data-[orientation=vertical]/attachment:px-1">
                    <span data-slot="attachment-title" class="block max-w-full min-w-0 truncate font-medium">服务合同202...</span>
                  </div>
                  <div data-slot="attachment-actions" class="relative z-20 flex group-data-[orientation=vertical]/attachment:absolute group-data-[orientation=vertical]/attachment:top-3 group-data-[orientation=vertical]/attachment:right-3">
                    <button data-slot="attachment-action" class="ai-composer-file-remove size-5 bg-secondary hover:bg-secondary/80" aria-label="Cancel">×</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main></body></html>`);
    const rail = page.locator('.ai-image-rail-viewport');
    const layout = await rail.evaluate(element => ({
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
      snap: getComputedStyle(element).scrollSnapType,
      scrollbar: getComputedStyle(element).scrollbarWidth,
    }));
    assert.ok(layout.width <= width && layout.scrollWidth > layout.width, `${width}px rail should overflow horizontally`);
    assert.equal(layout.snap, 'none');
    assert.equal(layout.scrollbar, 'none');
    assert.equal(await rail.locator(':scope > [data-slot="attachment"]').count(), 7);
    for (const image of await rail.locator('[data-card-index]').all()) {
      const geometry = await image.evaluate(card => {
        const cardRect = card.getBoundingClientRect();
        const mediaRect = card.querySelector('[data-slot="attachment-media"]').getBoundingClientRect();
        const actionRect = card.querySelector('[data-slot="attachment-action"]').getBoundingClientRect();
        return { card: { x: cardRect.x, width: cardRect.width }, media: { x: mediaRect.x, width: mediaRect.width }, action: { x: actionRect.x, width: actionRect.width } };
      });
      assert.equal(geometry.card.width, 120, `${width}px image card should not reserve width for remove: ${JSON.stringify(geometry)}`);
      assert.equal(geometry.media.width, geometry.card.width, `${width}px image should fill its card: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.action.x >= geometry.card.x && geometry.action.x + geometry.action.width <= geometry.card.x + geometry.card.width,
        `${width}px remove should overlay its image: ${JSON.stringify(geometry)}`);
    }
    const actionPosition = await rail.locator('[data-document-name="README.md"]').evaluate(card => {
      const cardRect = card.getBoundingClientRect();
      const actionRect = card.querySelector('[data-slot="attachment-action"]').getBoundingClientRect();
      return { card: { x: cardRect.x, y: cardRect.y, width: cardRect.width, height: cardRect.height }, action: { x: actionRect.x, y: actionRect.y, width: actionRect.width, height: actionRect.height } };
    });
    assert.ok(actionPosition.action.x + actionPosition.action.width > actionPosition.card.x + actionPosition.card.width - 8
      && actionPosition.action.y < actionPosition.card.y + actionPosition.card.height / 2,
    `${width}px cancel should be in the attachment's top right: ${JSON.stringify(actionPosition)}`);
    const fileCard = rail.locator('[data-document-name="README.md"]');
    const labelPosition = await fileCard.evaluate(card => {
      const media = card.querySelector('[data-slot="attachment-media"]').getBoundingClientRect();
      const title = card.querySelector('[data-slot="attachment-title"]').getBoundingClientRect();
      return { media: { bottom: media.bottom }, title: { y: title.y }, hasContentIcon: Boolean(card.querySelector('[data-slot="attachment-content"] > svg')) };
    });
    assert.equal(labelPosition.hasContentIcon, false, `${width}px file icon should only appear above the filename`);
    assert.ok(labelPosition.title.y >= labelPosition.media.bottom, `${width}px filename should stay below the file icon`);
    const cancel = fileCard.locator('[data-slot="attachment-action"]');
    assert.equal(await cancel.evaluate(button => getComputedStyle(button).opacity), '0');
    await fileCard.hover();
    assert.equal(await cancel.evaluate(button => getComputedStyle(button).opacity), '1');
    await rail.locator('[data-card-index="0"]').hover();
    assert.equal(await cancel.evaluate(button => getComputedStyle(button).opacity), '0');
    await cancel.focus();
    assert.equal(await cancel.evaluate(button => getComputedStyle(button).opacity), '1');
    console.log(`${width}px attachment rail: clipped width, hidden scrollbar, and mixed cards verified`);
    await page.close();
  }
} finally {
  await browser.close();
}
