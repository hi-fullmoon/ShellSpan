import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..');
  const files = await includedRustFiles(path.join(root, 'src-tauri/src'));
  if (!files.length) throw new Error('No include! Rust files found; inspect the gate');
  const result = spawnSync('rustfmt', ['--edition', '2021', '--check', ...files], { stdio: 'inherit', cwd: root });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else console.log(`PASS rustfmt: ${files.length} include! files`);
}
