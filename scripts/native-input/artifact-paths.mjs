import { basename, dirname, resolve } from 'node:path';

export function artifactWorkspace(fileOrDirectory) {
  let directory = resolve(fileOrDirectory);
  while (true) {
    const parent = dirname(directory);
    if (basename(directory) === 'tests' && basename(parent) === 'artifacts') return dirname(parent);
    if (parent === directory) throw new Error('Expected a path inside a workspace artifacts/tests directory');
    directory = parent;
  }
}
