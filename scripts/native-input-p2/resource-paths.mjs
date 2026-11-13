import { resolve } from 'node:path';

export const nativeInputBuildPath = 'src-tauri/target/native-input';
export const nativeInputGeneratedPath = `${nativeInputBuildPath}/generated`;

export function nativeInputReleaseDirectory(root) {
  return resolve(root, nativeInputGeneratedPath);
}
