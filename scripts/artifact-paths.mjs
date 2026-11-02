import { basename, dirname, resolve } from 'node:path';

export function artifactWorkspace(fileOrDirectory) {
  let directory = resolve(fileOrDirectory);
  while (basename(directory) !== '.artifacts') {
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Expected a path inside a workspace .artifacts directory');
    directory = parent;
  }
  return dirname(directory);
}
