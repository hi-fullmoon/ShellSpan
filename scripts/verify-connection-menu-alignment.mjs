import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import ts from 'typescript';

// Render the menu's real primitives and icons without creating connection data.
const source = await readFile(new URL('../src/components/workbench/connection-list.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('connection-list.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const classes = new Map();
for (const statement of ast.statements) {
  if (!ts.isVariableStatement(statement)) continue;
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isStringLiteral(declaration.initializer)) {
      classes.set(declaration.name.text, declaration.initializer.text);
    }
  }
}
const itemClass = classes.get('CONNECTION_MENU_ITEM_CLASS');
const destructiveClass = classes.get('CONNECTION_MENU_DESTRUCTIVE_ITEM_CLASS');
assert.ok(itemClass && destructiveClass);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto('http://localhost:1420');
  await page.evaluate(async ({ itemClass, destructiveClass }) => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const icons = await import('/node_modules/.vite/deps/lucide-react.js');
    const menu = await import('/src/components/ui/dropdown-menu.tsx');
    const { default: locale } = await import('/src/locales/en-US.ts');
    const actions = [
      ['StarIcon', 'workbench.connections.unfavorite'], ['PencilIcon', 'common.edit'],
      ['CopyIcon', 'common.duplicate'], ['HeartPulseIcon', 'remoteHealth.open'],
      ['CableIcon', 'portForward.open'], ['ZapIcon', 'hostQuickActions.open'],
      ['InfoIcon', 'hostOverview.open'], ['Trash2Icon', 'common.delete'],
    ];
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const h = React.createElement;
    ReactDOM.createRoot(host).render(h(menu.DropdownMenu, { defaultOpen: true },
      h(menu.DropdownMenuTrigger, {}, 'Menu'),
      h(menu.DropdownMenuContent, { className: 'w-52' },
        h(menu.DropdownMenuGroup, {}, ...[...actions, ...actions].map(([icon, key], index) =>
          h(menu.DropdownMenuItem, { key: index, className: index >= 8 ? undefined : index === 7 ? destructiveClass : itemClass },
            h(icons[icon]), locale[key]))))));
  }, { itemClass, destructiveClass });
  await page.getByRole('menu').waitFor();
  await page.getByRole('menu').evaluate(async menu => {
    await document.fonts.ready;
    await Promise.all(menu.getAnimations().map(animation => animation.finished));
  });
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 800 });
    const rows = await page.getByRole('menuitem').evaluateAll(items => items.map(item => {
      const icon = item.querySelector('svg').getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(item.lastChild);
      const text = range.getBoundingClientRect();
      const row = item.getBoundingClientRect();
      return { x: icon.x, width: icon.width, height: icon.height,
        gap: text.left - icon.right, center: icon.y + icon.height / 2 - row.y - row.height / 2,
        textOffset: text.y + text.height / 2 - row.y - row.height / 2 };
    }));
    assert.equal(rows.length, 16);
    for (const row of rows) {
      assert.equal(row.x, rows.indexOf(row) >= 8 ? rows[8].x : rows[0].x);
      assert.equal(row.width, 16);
      assert.equal(row.height, 16);
      assert.equal(row.gap, 4);
      assert.equal(row.center, 0);
      assert.equal(row.textOffset, 1);
    }
    await page.screenshot({ path: `/tmp/shellspan-connection-menu-${width}.png` });
    const accountGaps = await page.getByRole('menu').evaluate(menu => {
      menu.classList.add('workbench-user-menu');
      const gaps = [...menu.querySelectorAll('[role="menuitem"]')].map(item =>
        item.lastElementChild.getBoundingClientRect().left - item.querySelector('svg').getBoundingClientRect().right);
      menu.classList.remove('workbench-user-menu');
      return gaps;
    });
    for (const gap of accountGaps) assert.equal(gap, 4, `Account menu spacing at ${width}px`);
  }
} finally {
  await browser.close();
}
