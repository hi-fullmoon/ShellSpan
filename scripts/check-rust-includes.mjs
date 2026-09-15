import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_INCLUDE_CONTEXT_DEPTH = 8;

export async function includedRustFiles(root) {
  const included = new Set();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && file.endsWith('.rs')) {
        const source = await readFile(file, 'utf8');
        for (const match of source.matchAll(/\binclude!\s*\(\s*"([^"]+\.rs)"\s*\)/g)) {
          included.add(path.resolve(directory, match[1]));
        }
      }
    }
  }
  await walk(root);
  return [...included].sort();
}

function wrapRustIncludeSource(source, depth) {
  if (depth === 0) return source;
  const opening = Array.from(
    { length: depth },
    (_, index) => `${'    '.repeat(index)}mod __shellspan_include_${index} {\n`,
  ).join('');
  const closing = Array.from(
    { length: depth },
    (_, index) => `${'    '.repeat(depth - index - 1)}}\n`,
  ).join('');
  return `${opening}${source}${source.endsWith('\n') ? '' : '\n'}${closing}`;
}

function formatRustSource(source, rustfmt = 'rustfmt') {
  const result = spawnSync(rustfmt, ['--edition', '2021', '--emit', 'stdout'], {
    input: source,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result.status === 0 ? result.stdout : null;
}

export function rustIncludeSourceIsFormatted(source, rustfmt = 'rustfmt') {
  const normalizedSource = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  for (let depth = 0; depth <= MAX_INCLUDE_CONTEXT_DEPTH; depth += 1) {
    const contextualSource = wrapRustIncludeSource(normalizedSource, depth);
    if (formatRustSource(contextualSource, rustfmt) === contextualSource) return true;
  }
  return false;
}

export async function unformattedIncludedRustFiles(files, rustfmt = 'rustfmt') {
  const failures = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (!rustIncludeSourceIsFormatted(source, rustfmt)) failures.push(file);
  }
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..');
  const files = await includedRustFiles(path.join(root, 'src-tauri/src'));
  if (!files.length) throw new Error('No include! Rust files found; inspect the gate');
  const failures = await unformattedIncludedRustFiles(files);
  if (failures.length) {
    console.error(`FAIL rustfmt: ${failures.length} of ${files.length} include! files are not formatted:`);
    for (const file of failures) console.error(`- ${path.relative(root, file)}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS rustfmt: ${files.length} include! files`);
  }
}
