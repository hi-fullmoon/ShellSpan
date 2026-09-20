import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const docx = await readFile(require.resolve('mammoth/test/test-data/single-paragraph.docx'));
const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet('Quarterly sales');
sheet.addRow(['Region', 'Revenue']);
sheet.addRow(['华东', 1234.5]);
sheet.getCell('C2').value = { formula: 'B2*2', result: 2469 };
const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
pdf.addPage().drawText('Document upload integration test', { font, x: 40, y: 700 });
const pdfBytes = Buffer.from(await pdf.save());
const blankPdf = await PDFDocument.create();
blankPdf.addPage();
const blankPdfBytes = Buffer.from(await blankPdf.save());
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  plugins: [react(), tailwindcss(), viteStaticCopy({ targets: ['cmaps', 'standard_fonts'].map(directory => ({
    src: `node_modules/pdfjs-dist/${directory}/*`, dest: `pdfjs/${directory}`, rename: { stripBase: true },
  })) })],
  resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__document-upload', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__document-upload', '<html><body><div id="root"></div><script type="module" src="/scripts/perf/document-upload-page.tsx"></script></body></html>'));
});

try {
  await server.listen();
  const address = server.httpServer.address();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [380, 1000]) {
        const page = await browser.newPage({ viewport: { width, height: 720 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
        await page.goto(`http://127.0.0.1:${address.port}/__document-upload`);
        const editor = page.getByRole('textbox');
        const input = page.locator('input[type=file][accept*=".pdf"]');
        await editor.fill('Summarize these documents');
        const composerBefore = await page.locator('[data-composer-card]').boundingBox();
        await page.getByRole('button', { name: 'Add file or folder' }).click();
        await page.getByRole('menuitem', { name: 'Add file' }).waitFor();
        assert.match(await page.getByRole('menuitem', { name: 'Add file' }).getAttribute('title'), /DOCX.*XLSX/);
        assert.match(await page.getByRole('menu').innerText(), /Skills/);
        assert.match(await page.getByRole('menu').innerText(), /Chat history/);
        await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
        const menu = await page.getByRole('menu').boundingBox();
        assert.ok(menu.x >= 0 && menu.x + menu.width <= width + 1);
        assert.ok(Math.abs(menu.height - 360) <= 1, 'Menu has a fixed 360px height');
        assert.ok(Math.abs(menu.y + menu.height + 8 - composerBefore.y) <= 1, 'Menu floats above the whole composer');
        assert.deepEqual(await page.locator('[data-composer-card]').boundingBox(), composerBefore, 'Opening the menu does not move the composer');
        assert.equal(await page.getByRole('menu').locator('input').count(), 0);
        const scrollViewport = page.locator('[data-composer-menu-scroll]');
        assert.ok(await scrollViewport.evaluate(element => element.scrollHeight > element.clientHeight), 'Long lists scroll inside the fixed panel');
        await page.setViewportSize({ width, height: 420 });
        await page.waitForFunction(() => {
          const popup = document.querySelector('[role="menu"]')?.getBoundingClientRect();
          const composer = document.querySelector('[data-composer-card]')?.getBoundingClientRect();
          return popup && composer && popup.top >= 7 && popup.bottom <= composer.top - 7;
        });
        await page.setViewportSize({ width, height: 720 });
        await page.waitForFunction(() => Math.abs(document.querySelector('[role="menu"]')?.getBoundingClientRect().height - 360) <= 1);
        await page.keyboard.press('Escape');
        console.log(`${engine.name()} ${width}px: uploading real document batch`);
        await input.setInputFiles([
          { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('文档上传保留中文正文') },
          { name: 'report.PDF', mimeType: 'application/pdf', buffer: pdfBytes },
          { name: 'document.docx', mimeType: '', buffer: docx },
          { name: 'sales.xlsx', mimeType: '', buffer: xlsx },
        ]);
        await page.waitForFunction(() => document.querySelector('[data-document-name="sales.xlsx"]') || document.querySelector('[data-variant="error"]'), undefined, { timeout: 60000 }).catch(async error => {
          console.error(await page.locator('body').innerText());
          console.error(errors);
          await page.screenshot({ path: '/tmp/shellspan-menu-failure.png' });
          throw error;
        });
        if (await page.locator('[data-variant="error"]').count()) {
          console.error(await page.getByTestId('notices').innerText());
          for (const [name, bytes] of [['report.pdf', pdfBytes], ['document.docx', docx], ['sales.xlsx', xlsx]]) {
            console.error(name, await page.evaluate(async ({ name, data }) => {
              const { extractDocument } = await import('/src/lib/ai/document-extract.ts');
              try { return (await extractDocument(new File([new Uint8Array(data)], name), new AbortController().signal)).slice(0, 80); }
              catch (error) { return String(error); }
            }, { name, data: [...bytes] }));
          }
          throw new Error('Document batch failed');
        }
        assert.equal(await editor.innerText(), 'Summarize these documents');
        assert.equal(await page.locator('[data-document-name]').count(), 4);
        const imageBytes = await page.screenshot();
        await input.setInputFiles({ name: 'composer.png', mimeType: 'image/png', buffer: imageBytes });
        await page.getByRole('img', { name: 'composer.png', exact: true }).waitFor();
        const rail = page.locator('[data-unified-attachments] > [data-slot="attachment-group"]');
        assert.equal(await rail.count(), 1);
        assert.equal(await rail.evaluate(element => getComputedStyle(element).columnGap), '8px');
        assert.equal(await rail.locator('[data-slot="attachment"]').count(), 5);
        const cards = await rail.locator('[data-slot="attachment"]').evaluateAll(elements => elements.map(element => {
          const { width, height, y } = element.getBoundingClientRect();
          return { width, height, y };
        }));
        assert.ok(cards.every(card => card.width === 120 && card.height === 92 && card.y === cards[0].y), 'Images and documents share one row and equal compact card dimensions');
        assert.ok((await rail.boundingBox()).width <= width, 'Attachment viewport fits the composer');
        await rail.evaluate(element => { element.scrollLeft = 0; });
        await page.screenshot({ path: `/tmp/shellspan-attachments-${engine.name()}-${width}.png` });
        await input.setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: imageBytes });
        await page.getByRole('img', { name: 'second.png', exact: true }).waitFor();
        const previewTrigger = page.getByRole('button', { name: 'Preview image composer.png', exact: true });
        await previewTrigger.click();
        const imageDialog = page.getByRole('dialog');
        await imageDialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
        assert.equal(await imageDialog.getByText('125%', { exact: true }).count(), 1);
        assert.equal(await imageDialog.getByRole('button', { name: 'Previous image', exact: true }).isDisabled(), true);
        await imageDialog.getByRole('button', { name: 'Next image', exact: true }).click();
        await imageDialog.getByRole('img', { name: 'second.png', exact: true }).waitFor();
        assert.equal(await imageDialog.getByText('100%', { exact: true }).count(), 1);
        assert.equal(await imageDialog.getByText('2 / 2', { exact: true }).count(), 1);
        assert.equal(await imageDialog.getByRole('button', { name: 'Next image', exact: true }).isDisabled(), true);
        await page.keyboard.press('ArrowLeft');
        await imageDialog.getByRole('img', { name: 'composer.png', exact: true }).waitFor();
        await page.keyboard.press('ArrowRight');
        await imageDialog.getByRole('img', { name: 'second.png', exact: true }).waitFor();
        await page.screenshot({ path: `/tmp/shellspan-image-gallery-${engine.name()}-${width}.png` });
        await page.keyboard.press('Escape');
        await imageDialog.waitFor({ state: 'hidden' });
        assert.equal(await previewTrigger.evaluate(element => element === document.activeElement), true);
        await page.getByRole('button', { name: 'Remove image second.png', exact: true }).click();
        await previewTrigger.click();
        assert.equal(await imageDialog.getByRole('button', { name: 'Next image', exact: true }).count(), 0);
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: /Remove.*composer.png/ }).click();
        assert.equal(await rail.locator('[data-slot="attachment"]').count(), 4);
        await page.getByRole('button', { name: 'Preview sales.xlsx', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        assert.match(await dialog.innerText(), /Quarterly sales/);
        assert.match(await dialog.innerText(), /华东/);
        const bounds = await dialog.boundingBox();
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 721);
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        const sent = JSON.parse(await page.getByTestId('sent').textContent());
        assert.equal(sent.text, 'Summarize these documents');
        assert.equal(sent.documents.length, 4);
        const contents = sent.documents.map(document => document.text).join('\n');
        assert.match(contents, /文档上传保留中文正文/);
        assert.match(contents, /Document upload integration test/);
        assert.match(contents, /Walking on imported air/);
        assert.match(contents, /B2\*2 = 2469/);
        assert.equal(await editor.textContent(), '');
        await editor.fill('@');
        assert.equal(await page.getByRole('option', { name: 'Summarize these documents', exact: true }).count(), 0);
        await page.getByText('Type to search chat history', { exact: true }).waitFor();
        await editor.fill('@Summarize');
        await page.getByRole('option', { name: 'Summarize these documents', exact: true }).waitFor();
        await editor.fill('@');
        assert.equal(await page.getByRole('option', { name: 'Summarize these documents', exact: true }).count(), 0);
        await editor.fill('@Summarize');
        await page.getByRole('option', { name: 'Summarize these documents', exact: true }).click();
        await page.getByRole('button', { name: 'Preview Summarize these documents.txt', exact: true }).click();
        const reference = page.getByRole('dialog');
        assert.match(await reference.innerText(), /Summarize these documents/);
        assert.doesNotMatch(await reference.innerText(), /Walking on imported air/);
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Remove Summarize these documents.txt', exact: true }).click();
        await input.setInputFiles({ name: 'scanned.pdf', mimeType: 'application/pdf', buffer: blankPdfBytes });
        await page.getByText('Some PDF pages have no extractable text', { exact: false }).waitFor();
        assert.equal(await editor.textContent(), '');
        await input.setInputFiles({ name: 'old.doc', mimeType: 'application/msword', buffer: docx });
        await page.getByText('Unsupported format.', { exact: false }).waitFor();
        await input.setInputFiles({ name: 'renamed.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a PDF') });
        await page.getByText('Cannot read this document.', { exact: false }).waitFor();
        await page.getByRole('button', { name: 'Switch mode' }).click();
        await editor.fill('hello @');
        const mention = page.getByRole('listbox', { name: 'Add context' });
        await mention.waitFor();
        const mentionBounds = await mention.boundingBox();
        assert.ok(mentionBounds.x >= 0 && mentionBounds.x + mentionBounds.width <= width, 'Mention panel stays inside the viewport');
        assert.ok(mentionBounds.y + mentionBounds.height < (await page.locator('[data-composer-card]').boundingBox()).y, 'Mention panel is above the composer');
        assert.equal(await page.getByRole('option', { name: 'Upload local files' }).getAttribute('aria-selected'), 'true');
        assert.equal(await page.getByRole('option', { name: 'Summarize these documents', exact: true }).count(), 0);
        await page.screenshot({ path: `/tmp/shellspan-mention-${engine.name()}-${width}.png` });
        await editor.pressSequentially('network');
        await page.getByRole('option', { name: 'Diagnose DNS, ports, routing and connectivity' }).waitFor();
        await editor.press('Enter');
        assert.equal(await editor.textContent(), 'hello /network-diagnosis ');
        await editor.fill('about @Summarize');
        await page.getByRole('option', { name: 'Summarize these documents', exact: true }).click();
        await page.getByRole('button', { name: 'Preview Summarize these documents.txt', exact: true }).waitFor();
        assert.equal(await editor.textContent(), 'about ');
        await page.getByRole('button', { name: 'Remove Summarize these documents.txt', exact: true }).click();
        await editor.fill('@');
        const chooserPromise = page.waitForEvent('filechooser');
        await page.getByRole('option', { name: 'Upload local files' }).click();
        await (await chooserPromise).setFiles({ name: 'mention.txt', mimeType: 'text/plain', buffer: Buffer.from('Local attachment chosen from the mention panel') });
        await page.getByRole('button', { name: 'Preview mention.txt', exact: true }).waitFor();
        assert.equal(await editor.textContent(), '');
        await page.getByRole('button', { name: 'Remove mention.txt', exact: true }).click();
        await page.getByRole('button', { name: 'Add file or folder' }).click();
        await page.getByRole('menu').waitFor();
        assert.equal(await page.getByRole('textbox', { name: 'Search skills or chats' }).count(), 0);
        await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
        await page.screenshot({ path: `/tmp/shellspan-add-menu-${engine.name()}-${width}.png` });
        await page.getByRole('menuitem', { name: '/network-diagnosis' }).click();
        await page.getByRole('menu').waitFor({ state: 'hidden' });
        assert.match(await editor.textContent(), /\/network-diagnosis/);
        await page.waitForFunction(() => document.activeElement?.hasAttribute('data-composer-editor'), undefined, { timeout: 3000 });
        await editor.fill('');
        await input.setInputFiles({ name: 'agent.md', mimeType: 'text/markdown', buffer: Buffer.from('# Agent document') });
        await page.getByRole('button', { name: 'Preview agent.md', exact: true }).waitFor();
        assert.equal(await editor.textContent(), '');
        await page.getByRole('button', { name: 'Remove agent.md', exact: true }).click();
        assert.equal(await page.locator('[data-document-name]').count(), 0);
        await page.getByRole('button', { name: 'New conversation' }).click();
        assert.equal(await editor.textContent(), '');
        assert.equal(await page.locator('[data-document-name]').count(), 0);
        // Cancel an actual asynchronous Office import before it can modify the draft.
        await input.setInputFiles({ name: 'cancel.xlsx', mimeType: '', buffer: xlsx });
        const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
        if (await cancel.isVisible()) await cancel.click();
        await page.getByRole('button', { name: 'New conversation' }).click();
        await page.waitForTimeout(300);
        assert.equal(await editor.textContent(), '');
        assert.deepEqual(errors, []);
        console.log(`${engine.name()} ${width}px: PDF, DOCX, XLSX, text, errors, submit and session isolation passed`);
        await page.close();
      }
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
