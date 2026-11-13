import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const owner = resolve(import.meta.dirname, '../..');

describe('Tailwind generated-source boundary in a frozen copy without Git metadata', () => {
  it('excludes retained artifacts, including a real FIFO on Unix, while compiling shared-control classes', async () => {
    const parent = resolve(owner, '.artifacts/tests/tailwind-source');
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(resolve(parent, 'frozen-'));
    for (const path of ['.gitignore', 'src/styles/base.css', 'src/components/ui/button.tsx']) {
      await mkdir(dirname(resolve(root, path)), { recursive: true });
      await copyFile(resolve(owner, path), resolve(root, path));
    }
    const generated = ['.artifacts', 'src-tauri/target'];
    for (const directory of generated) {
      const ignored = resolve(root, directory, 'retained');
      await mkdir(ignored, { recursive: true });
      await copyFile(resolve(owner, 'src/components/ui/button.tsx'), resolve(ignored, 'button.tsx'));
      if (process.platform !== 'win32') execFileSync('mkfifo', [resolve(ignored, 'handoff.fifo')]);
    }
    const output = execFileSync(process.execPath, [resolve(owner, 'scripts/fixtures/tailwind-source-scan.mjs'), root], { cwd: owner, encoding: 'utf8', timeout: 12_000, maxBuffer: 2 * 1024 * 1024 });
    const result = JSON.parse(output);
    expect(result.scanned.some(path => relative(root, path) === ['src', 'components', 'ui', 'button.tsx'].join(sep))).toBe(true);
    for (const directory of generated) {
      expect(result.scanned.some(path => path.startsWith(resolve(root, directory) + sep))).toBe(false);
    }
    expect(result.selectors).toContain('.inline-flex');
    expect(result.selectors).toContain('.gap-1');
  });
});
