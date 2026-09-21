import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = path.resolve(import.meta.dirname, '../../../..');
const server = await createServer({
  root, configFile: false, logLevel: 'error',
  resolve: { alias: { '@': path.join(root, 'src') } },
  plugins: [tailwindcss(), {
    name: 'attachment-border-test',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/border-test') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<html><head><script type="module" src="/src/components/ai/__tests__/attachment-border.browser-entry.tsx"></script></head><body><div id="root"></div></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ deviceScaleFactor: 2 });
      for (const width of [400, 760]) {
        await page.setViewportSize({ width, height: 300 });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/border-test`);
        const card = page.locator('.ai-composer-file-card');
        await card.waitFor();
        const style = await card.evaluate(element => {
          const content = element.querySelector('[data-slot="attachment-content"]');
          const media = element.querySelector('[data-slot="attachment-media"]');
          const title = element.querySelector('[data-slot="attachment-title"]');
          const cardStyle = getComputedStyle(element);
          return {
            background: getComputedStyle(content).backgroundColor,
            border: cardStyle.borderBottomWidth,
            radius: parseFloat(cardStyle.borderBottomLeftRadius),
            width: element.getBoundingClientRect().width,
            height: element.getBoundingClientRect().height,
            contentHeight: content.getBoundingClientRect().height,
            mediaHeight: media.getBoundingClientRect().height,
            titleFontSize: getComputedStyle(title).fontSize,
          };
        });
        assert.equal(style.background, 'rgba(0, 0, 0, 0)', 'Filename background must not paint over the rounded bottom border');
        assert.equal(style.border, '1px');
        assert.ok(style.radius > 0);
        assert.equal(style.width, 96);
        assert.equal(style.height, 76);
        assert.equal(style.contentHeight, 24);
        assert.equal(style.mediaHeight, 52);
        assert.equal(style.titleFontSize, '10px');
        await page.screenshot({ path: `/tmp/shellspan-attachment-border-${engine.name()}-${width}.png` });
        await page.getByRole('button', { name: /README.md/ }).click();
        await page.getByRole('dialog').waitFor();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
