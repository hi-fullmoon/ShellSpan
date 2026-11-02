import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import frontend from '../../vitest.config.ts';
import { artifactWorkspace } from '../artifact-paths.mjs';
import { captureValidationSources, readValidationGit } from '../native-input-p2/frozen-validation.mjs';
import { createIndexReader } from '../native-input-p3/index-reader.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const artifactRoot = path.join(root, '.artifacts/tests/artifact-layout');

async function withArtifactDirectory(check) {
  await mkdir(artifactRoot, { recursive: true });
  const directory = await mkdtemp(path.join(artifactRoot, 'run-'));
  try {
    await check(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('generated artifact layout', () => {
  it('ignores real copied test sources in Git, frozen inventories and Vitest discovery', async () => {
    expect(frontend.test.exclude).toContain('**/.artifacts/**');
    await withArtifactDirectory(async directory => {
      const before = captureValidationSources(root);
      const copiedTest = path.join(directory, 'copied-source.test.mjs');
      await copyFile(path.join(root, 'scripts/__tests__/native-input-runner.test.mjs'), copiedTest);
      const relative = path.relative(root, copiedTest).split(path.sep).join('/');
      expect(readValidationGit(root, ['check-ignore', '--no-index', relative]).toString().trim()).toBe(relative);
      expect(captureValidationSources(root)).toEqual(before);
      const discovered = execFileSync(process.execPath, [
        path.join(root, 'node_modules/vitest/vitest.mjs'), 'list', '--filesOnly',
      ], { cwd: root, encoding: 'utf8', timeout: 20_000 });
      expect(discovered).not.toContain('copied-source.test.mjs');
      expect(discovered).toContain('native-input-runner.test.mjs');
    });
  }, 25_000);

  it('discovers sources and ignores generated files in a snapshot with no .git directory', async () => {
    await withArtifactDirectory(async directory => {
      const snapshot = path.join(directory, 'ShellSpan');
      const source = 'scripts/native-input-p3/linux-run.py';
      await mkdir(path.dirname(path.join(snapshot, source)), { recursive: true });
      for (const file of ['.gitignore', source]) await copyFile(path.join(root, file), path.join(snapshot, file));

      const meta = path.join(snapshot, '.artifacts/tests/native-input-p3');
      const originalIndex = readValidationGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).toString().trim();
      const head = readValidationGit(root, ['rev-parse', 'HEAD']).toString().trim();
      const { gitDirectory, index } = createIndexReader(meta, originalIndex, head);
      await chmod(index, 0o400);
      const indexSha256 = createHash('sha256').update(await readFile(index)).digest('hex');
      await writeFile(path.join(meta, 'snapshot-index.json'), JSON.stringify({ version: 1, root: snapshot, gitDirectory, index, indexSha256 }));
      await expect(access(path.join(snapshot, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });

      const before = captureValidationSources(snapshot);
      expect(Object.keys(before)).toEqual(['.gitignore', source]);
      const generated = '.artifacts/tests/copied-source.test.mjs';
      await copyFile(path.join(root, 'scripts/__tests__/native-input-runner.test.mjs'), path.join(snapshot, generated));
      expect(readValidationGit(snapshot, ['check-ignore', '--no-index', generated]).toString().trim()).toBe(generated);
      expect(captureValidationSources(snapshot)).toEqual(before);
      expect(createHash('sha256').update(await readFile(index)).digest('hex')).toBe(indexSha256);
      expect(() => readValidationGit(snapshot, ['add', '.'])).toThrow('Only read-only validation Git commands are allowed');
    });
  });

  it('resolves the nearest workspace for nested acceptance snapshots without assuming directory depth', async () => {
    await withArtifactDirectory(async directory => {
      expect(artifactWorkspace(directory)).toBe(root);
      const snapshot = path.join(directory, 'ShellSpan');
      const producer = path.join(snapshot, '.artifacts/tests/native-input-p3/paired-runtime');
      await mkdir(producer, { recursive: true });
      expect(artifactWorkspace(producer)).toBe(snapshot);
      expect(() => artifactWorkspace(path.parse(root).root)).toThrow('inside a workspace .artifacts directory');
    });
  });

  it('keeps CI resource transfers and release staging inside the shared artifact directory', async () => {
    const workflow = parse(await readFile(path.join(root, '.github/workflows/release.yml'), 'utf8'));
    const nativeUpload = workflow.jobs['build-native-bash'].steps.find(step => step.with?.name === 'native-linux-bash');
    const nativeDownload = workflow.jobs.build.steps.find(step => step.with?.name === 'native-linux-bash');
    expect(nativeUpload.with.path).toMatch(/^\.artifacts\/tests\//);
    expect(nativeDownload.with.path).toBe(nativeUpload.with.path);
    expect(nativeUpload.with['include-hidden-files']).toBe(true);

    const bundleUpload = workflow.jobs.build.steps.find(step => step.name === 'Upload bundle artifact');
    const bundleDownload = workflow.jobs.release.steps.find(step => step.name === 'Download bundle artifacts');
    expect(bundleUpload.with.path).toMatch(/^\.artifacts\/releases\//);
    expect(bundleUpload.with['include-hidden-files']).toBe(true);
    expect(bundleDownload.with.path).toMatch(/^\.artifacts\/releases\//);
  });
});
