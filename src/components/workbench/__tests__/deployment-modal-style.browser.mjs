import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const files = [
  'deployment-workflow-center.tsx',
  'deployment/approval-dialog.tsx',
  'deployment/evidence-dialog.tsx',
  'deployment/release-list.tsx',
  'deployment/workflow-settings-dialog.tsx',
  'deployment/workflow-editor-toolbar.tsx',
];
for (const file of files) {
  const source = ts.createSourceFile(file, await readFile(`${root}src/components/workbench/${file}`, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let footers = 0;
  function visit(node) {
    if (ts.isJsxOpeningElement(node) && ['DialogFooter', 'AlertDialogFooter'].includes(node.tagName.getText(source))) {
      footers += 1;
      const className = node.attributes.properties.find((property) => property.name?.getText(source) === 'className');
      if (className) {
        assert(ts.isStringLiteral(className.initializer), `${file}: inspect dynamic footer classes`);
        assert(!className.initializer.text.split(/\s+/).some((value) => value.startsWith('border')), `${file}: modal footer must not add a divider`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert(footers > 0, `${file}: expected modal footer coverage`);
}

const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  plugins: [tailwindcss(), {
    name: 'deployment-modal-style-check',
    resolveId(id) {
      if (id === '/modal-runtime.js') return id;
    },
    load(id) {
      if (id === '/modal-runtime.js') return `
        export { default as React } from 'react';
        export { createRoot } from 'react-dom/client';
      `;
    },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><div id="root"></div></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await webkit.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.evaluate(async () => {
    await import('/src/styles/base.css');
    const { React, createRoot } = await import('/modal-runtime.js');
    const { initI18n } = await import('/src/locales/index.ts');
    const { DeploymentValidationDialog } = await import('/src/components/workbench/deployment-workflow-center.tsx');
    await initI18n('zh-CN');
    createRoot(document.getElementById('root')).render(React.createElement(DeploymentValidationDialog, {
      open: true, onOpenChange: () => {}, issues: [], nodeName: (id) => id,
      onSelectNode: () => {}, validating: false, onValidate: () => {},
    }));
  });
  await page.getByRole('dialog').waitFor();
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 640 }]) {
    await page.setViewportSize(viewport);
    const metrics = await page.getByRole('dialog').evaluate((dialog) => {
      const footer = dialog.querySelector('[data-slot="dialog-footer"]');
      const scroll = dialog.querySelector('[data-slot="scroll-area"]');
      const bounds = dialog.getBoundingClientRect();
      return {
        border: getComputedStyle(footer).borderTopWidth,
        shrink: getComputedStyle(footer).flexShrink,
        footerOutsideScroll: !scroll.contains(footer),
        inViewport: bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight,
      };
    });
    assert.deepEqual(metrics, { border: '0px', shrink: '0', footerOutsideScroll: true, inViewport: true }, JSON.stringify(viewport));
    await page.screenshot({ path: `/tmp/shellspan-modal-${viewport.width}.png` });
  }
  console.log('Deployment modal styles: footer checks and wide/narrow rendering passed.');
} finally {
  await browser?.close();
  await server.close();
}
