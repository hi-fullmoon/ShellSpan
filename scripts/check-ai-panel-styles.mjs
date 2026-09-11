import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../src/components/ai/', import.meta.url);
const rootPath = fileURLToPath(root);
const styles = new URL('./styles/ai-panel/', root);

const layoutProperties = new Set([
  'align-content', 'align-items', 'align-self', 'aspect-ratio', 'bottom',
  'box-sizing', 'column-gap', 'cursor', 'display', 'flex', 'flex-basis',
  'flex-direction', 'flex-grow', 'flex-shrink', 'flex-wrap', 'gap', 'grid-area',
  'grid-column', 'grid-row', 'grid-template-columns', 'grid-template-rows',
  'height', 'inset', 'inset-block', 'inset-inline', 'justify-content',
  'justify-items', 'justify-self', 'left', 'list-style', 'margin',
  'margin-block', 'margin-bottom', 'margin-inline', 'margin-left', 'margin-right',
  'margin-top', 'max-height', 'max-width', 'min-height', 'min-width',
  'object-fit', 'order', 'overflow', 'overflow-wrap', 'overflow-x', 'overflow-y',
  'padding', 'padding-block', 'padding-bottom', 'padding-inline', 'padding-left',
  'padding-right', 'padding-top', 'place-items', 'pointer-events', 'position',
  'right', 'row-gap', 'text-overflow', 'top', 'vertical-align', 'white-space',
  'width', 'word-break', 'z-index',
]);

function blocks(source) {
  const result = [];
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('{', cursor);
    if (open < 0) break;
    const header = source.slice(cursor, open).trim();
    let depth = 1;
    let close = open + 1;
    for (; close < source.length && depth > 0; close += 1) {
      if (source[close] === '{') depth += 1;
      else if (source[close] === '}') depth -= 1;
    }
    result.push({ header, body: source.slice(open + 1, close - 1) });
    cursor = close;
  }
  return result;
}

function inspectCss(file, source, failures) {
  for (const { header, body } of blocks(source.replaceAll(/\/\*[\s\S]*?\*\//g, ''))) {
    if (/^@(container|layer|media|supports)\b/.test(header)) {
      inspectCss(file, body, failures);
      continue;
    }
    if (header.startsWith('@')) continue;
    const declarations = body
      .split(';')
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map((declaration) => declaration.slice(0, declaration.indexOf(':')).trim());
    if (declarations.length === 0) {
      failures.push(`${file}: empty rule ${header}`);
      continue;
    }
    if (/^\.ai-[a-z0-9-]+$/.test(header)
      && declarations.every((property) => layoutProperties.has(property))) {
      failures.push(`${file}: layout-only rule ${header} belongs in a component className`);
    }
  }
}

const failures = [];
for (const name of readdirSync(styles).filter((name) => name.endsWith('.css')).sort()) {
  inspectCss(name, readFileSync(new URL(name, styles), 'utf8'), failures);
}

function inspectComponents(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) inspectComponents(path);
    else if (entry.name.endsWith('.tsx') && /space-[xy]-/.test(readFileSync(path, 'utf8'))) {
      failures.push(`${path}: use flex/grid gap utilities instead of space-x/space-y`);
    }
  }
}
inspectComponents(rootPath);

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('AI panel style boundaries are clean.');
}
