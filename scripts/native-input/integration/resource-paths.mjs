import { isAbsolute, relative, resolve, sep } from 'node:path';

export const nativeInputBuildPath = 'src-tauri/target/native-input';
export const nativeInputGeneratedPath = `${nativeInputBuildPath}/generated`;

const releaseSections = { prototype: 'native-input-p0', integration: 'native-input-p2', acceptance: 'native-input-p3' };

export function nativeInputBuildDirectory(root, buildRoot, section) {
  const base = resolve(root, buildRoot);
  const fromTests = relative(resolve(root, 'artifacts/tests'), base);
  if (fromTests !== '..' && !fromTests.startsWith(`..${sep}`) && !isAbsolute(fromTests)) {
    return resolve(base, 'native-input', section);
  }
  return resolve(base, releaseSections[section]);
}

export function nativeInputReleaseDirectory(root) {
  return resolve(root, nativeInputGeneratedPath);
}
