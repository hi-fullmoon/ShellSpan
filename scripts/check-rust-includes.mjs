import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_INCLUDE_CONTEXT_DEPTH = 8;
const RUSTFMT_TIMEOUT_MS = 30_000;
const RUSTFMT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

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

function formatRustSource(source, rustfmt, timeoutMs) {
  return new Promise((resolve, reject) => {
    let inputError;
    // Drain stdout while writing stdin. A synchronous pipe exchange can stall
    // on large include files; always bound the formatter's lifetime as well.
    const child = execFile(rustfmt, ['--edition', '2021', '--emit', 'stdout'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: RUSTFMT_MAX_OUTPUT_BYTES,
    }, (error, stdout) => {
      if (error?.killed && error.signal === 'SIGKILL' && error.code === null) {
        reject(new Error(`rustfmt timed out after ${timeoutMs} ms`, { cause: error }));
      } else if (error && typeof error.code === 'number') {
        // A source may parse only when wrapped in its include context.
        resolve(null);
      } else if (error || inputError) {
        reject(error ?? inputError);
      } else {
        resolve(stdout);
      }
    });
    child.stdin.on('error', error => { inputError = error; });
    child.stdin.end(source);
  });
}

export async function rustIncludeSourceIsFormatted(source, rustfmt = 'rustfmt', { timeoutMs = RUSTFMT_TIMEOUT_MS } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('rustfmt timeout must be a positive safe integer');
  }
  const normalizedSource = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  for (let depth = 0; depth <= MAX_INCLUDE_CONTEXT_DEPTH; depth += 1) {
    const contextualSource = wrapRustIncludeSource(normalizedSource, depth);
    try {
      if (await formatRustSource(contextualSource, rustfmt, timeoutMs) === contextualSource) return true;
    } catch (cause) {
      throw new Error(`include context depth ${depth}: ${cause.message}`, { cause });
    }
  }
  return false;
}

export async function unformattedIncludedRustFiles(files, rustfmt = 'rustfmt', options = {}) {
  const failures = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    try {
      if (!await rustIncludeSourceIsFormatted(source, rustfmt, options)) failures.push(file);
    } catch (cause) {
      throw new Error(`Cannot check ${file}: ${cause.message}`, { cause });
    }
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
