import { resolve } from 'node:path';

export function nativeInputReleaseDirectory(root) {
  return resolve(root, '.artifacts/releases/native-input/generated');
}
