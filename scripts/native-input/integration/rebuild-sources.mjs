import { cp, mkdir, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

export async function readBashBuildInputs(root) {
  return JSON.parse(await readFile(resolve(root, 'scripts/native-input/integration/bash-build-inputs.json'), 'utf8'));
}

export function bashBuildInputsForTarget(inputs, target) {
  return [...inputs.adapter, ...inputs.common, ...(inputs.targets[target] ?? [])];
}

function isRebuildSourcePath(path) {
  const name = basename(path);
  return !['target', '__pycache__', '.DS_Store', 'Thumbs.db'].includes(name)
    && !name.startsWith('._') && !name.endsWith('.pyc') && !name.endsWith('.swp');
}

export async function copyNativeRebuildSources(root, tree, inputs) {
  for (const name of ['src-tauri/native-input-editors', 'src-tauri/vendor/portable-pty']) {
    await cp(resolve(root, name), resolve(tree, name), { recursive: true, filter: isRebuildSourcePath });
  }
  // The shipped Windows example compiles this real result-capture module.
  for (const name of new Set([...inputs, 'src-tauri/src/terminal_command/capture.rs'])) {
    await mkdir(resolve(tree, name, '..'), { recursive: true });
    await cp(resolve(root, name), resolve(tree, name));
  }
}
