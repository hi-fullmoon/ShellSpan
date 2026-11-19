import assert from 'node:assert/strict';
import { lstatSync, renameSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sections = [
  ['native-input-p0', 'prototype'],
  ['native-input-p2', 'integration'],
  ['native-input-p3', 'acceptance'],
];

export function migrateBuildLayout(root) {
  const buildRoot = resolve(root, 'src-tauri/target/native-input');
  const directories = [buildRoot, resolve(buildRoot, 'linux-x86_64-glibc-2.28')];
  const moves = [];
  for (const directory of directories) {
    const directoryStatus = lstatSync(directory, { throwIfNoEntry: false });
    if (!directoryStatus) continue;
    assert(directoryStatus.isDirectory(), `Expected a build directory: ${directory}`);
    for (const [oldName, newName] of sections) {
      const source = resolve(directory, oldName);
      const status = lstatSync(source, { throwIfNoEntry: false });
      if (!status) continue;
      assert(status.isDirectory(), `Expected a build directory: ${source}`);
      const destination = resolve(directory, newName);
      assert(!lstatSync(destination, { throwIfNoEntry: false }), `Build directory already exists: ${destination}`);
      moves.push({ source, destination });
    }
  }

  const relocated = [];
  try {
    for (const move of moves) {
      renameSync(move.source, move.destination);
      relocated.push(move);
    }
  } catch (error) {
    for (const move of relocated.reverse()) {
      assert(!lstatSync(move.source, { throwIfNoEntry: false }), `Cannot restore build directory: ${move.source}`);
      renameSync(move.destination, move.source);
    }
    throw error;
  }
  return relocated.map(({ source, destination }) => ({ from: relative(root, source), to: relative(root, destination) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2, 'Usage: node scripts/native-input/migrate-build-layout.mjs');
  const root = resolve(import.meta.dirname, '../..');
  console.log(JSON.stringify({ relocated: migrateBuildLayout(root) }));
}
