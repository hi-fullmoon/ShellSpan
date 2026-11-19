import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import frontend from '../../vitest.config.ts';
import { artifactWorkspace } from '../native-input/artifact-paths.mjs';
import { captureValidationSources, readValidationGit, nativeValidationResourceDirectory, captureValidationAssets } from '../native-input/integration/frozen-validation.mjs';
import { createIndexReader } from '../native-input/acceptance/index-reader.mjs';
import { editorValidationEnvironment } from '../native-input/acceptance/editor-validation.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const artifactRoot = path.join(root, 'artifacts/tests/artifact-layout');

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
  it.each([
    ['scripts/native-input/prototype', 'Cargo.toml'],
    ['scripts/native-input/acceptance/credential-cleanup', 'src/main.rs'],
  ])('excludes the %s Cargo cache from Git, frozen sources and ordinary test discovery', async (tool, sourceFile) => {
    expect(frontend.test.exclude).toContain(`**/${tool}/target/**`);
    await withArtifactDirectory(async directory => {
      const snapshot = path.join(directory, 'ShellSpan'), source = `${tool}/${sourceFile}`, generated = `${tool}/target/debug/cache.test.mjs`;
      await mkdir(path.dirname(path.join(snapshot, source)), { recursive: true });
      for (const file of ['.gitignore', source]) await copyFile(path.join(root, file), path.join(snapshot, file));
      await copyFile(path.join(root, 'scripts/__tests__/native-input-runner.test.mjs'), path.join(snapshot, 'ordinary.test.mjs'));
      const meta = path.join(snapshot, 'artifacts/tests/native-input-p3'), originalIndex = readValidationGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).toString().trim(), head = readValidationGit(root, ['rev-parse', 'HEAD']).toString().trim();
      const {gitDirectory, index} = createIndexReader(meta, originalIndex, head);await chmod(index, 0o400);
      const indexSha256 = createHash('sha256').update(await readFile(index)).digest('hex');await writeFile(path.join(meta, 'snapshot-index.json'), JSON.stringify({version: 1, root: snapshot, gitDirectory, index, indexSha256}));
      const before = captureValidationSources(snapshot);expect(Object.keys(before).sort()).toEqual(['.gitignore', 'ordinary.test.mjs', source].sort());
      await mkdir(path.dirname(path.join(snapshot, generated)), {recursive: true});await copyFile(path.join(root, 'scripts/__tests__/native-input-runner.test.mjs'), path.join(snapshot, generated));
      expect(readValidationGit(snapshot, ['check-ignore', '--no-index', generated]).toString().trim()).toBe(generated);expect(captureValidationSources(snapshot)).toEqual(before);
      const discovered = execFileSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'list', '--filesOnly', '--config', path.join(root, 'vitest.config.ts'), '--root', snapshot], {cwd: root, encoding: 'utf8', timeout: 20000});
      expect(discovered).toContain('ordinary.test.mjs');expect(discovered).not.toContain('cache.test.mjs');expect(createHash('sha256').update(await readFile(index)).digest('hex')).toBe(indexSha256);
    });
  }, 25000);
  it('freezes the actual selected resource tree instead of the default producer inputs', async () => {
    await withArtifactDirectory(async directory => {
      const snapshot=path.join(directory,'ShellSpan'),defaultResources=path.join(snapshot,'artifacts/tests/native-input-p2/resources/native-input'),selected=path.join(snapshot,'artifacts/tests/rebuilt/native-input'),sibling=path.join(directory,'other');
      for(const folder of [defaultResources,selected,sibling])await mkdir(folder,{recursive:true});
      await writeFile(path.join(defaultResources,'module.dll'),'old');await writeFile(path.join(selected,'module.dll'),'rebuilt');
      expect(captureValidationAssets(nativeValidationResourceDirectory(snapshot,selected))).toEqual({'module.dll':createHash('sha256').update('rebuilt').digest('hex')});
      expect(captureValidationAssets(nativeValidationResourceDirectory(snapshot))).toEqual({'module.dll':createHash('sha256').update('old').digest('hex')});
      for(const invalid of [snapshot,sibling])expect(()=>nativeValidationResourceDirectory(snapshot,invalid)).toThrow('strict descendant');
    });
  });
  it('admits frozen descendant editor resources with native platform path separators', async () => {
    await withArtifactDirectory(async directory => {
      const snapshot = path.join(directory, 'ShellSpan');
      await mkdir(snapshot, { recursive: true });
      await copyFile(path.join(root, '.gitignore'), path.join(snapshot, '.gitignore'));
      const meta = path.join(snapshot, 'artifacts/tests/native-input-p3');
      const originalIndex = readValidationGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).toString().trim();
      const head = readValidationGit(root, ['rev-parse', 'HEAD']).toString().trim();
      const { gitDirectory, index } = createIndexReader(meta, originalIndex, head);
      await chmod(index, 0o400);
      const indexSha256 = createHash('sha256').update(await readFile(index)).digest('hex');
      await writeFile(path.join(meta, 'snapshot-index.json'), JSON.stringify({ root: snapshot, gitDirectory, index, indexSha256 }));
      const stage = path.join(directory, 'stage');
      await mkdir(stage);
      const sources = captureValidationSources(snapshot);
      await writeFile(path.join(stage, 'sources.json'), JSON.stringify(sources));
      await writeFile(path.join(meta, 'candidate-stage.json'), JSON.stringify({ root: snapshot, directory: stage, sealed: true }));
      const resources = path.join(meta, 'validation-resources');
      await mkdir(resources);
      expect(await editorValidationEnvironment(snapshot, resources, ['windows-x64'])).toEqual({ SHELLSPAN_NATIVE_EDITOR_VALIDATION_ROOT: resources });
      expect(JSON.parse(await readFile(path.join(resources, 'editor-validation.json'), 'utf8')).sourceManifestSha256)
        .toBe(createHash('sha256').update(await readFile(path.join(stage, 'sources.json'))).digest('hex'));
      expect(captureValidationSources(snapshot)).toEqual(sources);
      expect(createHash('sha256').update(await readFile(index)).digest('hex')).toBe(indexSha256);
    });
  });

  it('rejects a snapshot root and sibling directories before writing validation markers', async () => {
    await withArtifactDirectory(async directory => {
      const snapshot = path.join(directory, 'ShellSpan');
      const sibling = path.join(directory, 'ShellSpan-resources');
      await mkdir(snapshot);
      await mkdir(sibling);
      for (const resources of [snapshot, sibling]) {
        await expect(editorValidationEnvironment(snapshot, resources, ['windows-x64']))
          .rejects.toThrow('strict descendant');
        await expect(access(path.join(resources, 'editor-validation.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
    });
  });
  it('ignores real copied test sources in Git, frozen inventories and Vitest discovery', async () => {
    expect(frontend.test.exclude).toContain('**/artifacts/**');
    expect(frontend.test.exclude).toContain('**/src-tauri/target/**');
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
      const source = 'scripts/native-input/acceptance/linux-run.py';
      await mkdir(path.dirname(path.join(snapshot, source)), { recursive: true });
      for (const file of ['.gitignore', source]) await copyFile(path.join(root, file), path.join(snapshot, file));

      const meta = path.join(snapshot, 'artifacts/tests/native-input-p3');
      const originalIndex = readValidationGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).toString().trim();
      const head = readValidationGit(root, ['rev-parse', 'HEAD']).toString().trim();
      const { gitDirectory, index } = createIndexReader(meta, originalIndex, head);
      await chmod(index, 0o400);
      const indexSha256 = createHash('sha256').update(await readFile(index)).digest('hex');
      await writeFile(path.join(meta, 'snapshot-index.json'), JSON.stringify({ version: 1, root: snapshot, gitDirectory, index, indexSha256 }));
      await expect(access(path.join(snapshot, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });

      const before = captureValidationSources(snapshot);
      expect(Object.keys(before)).toEqual(['.gitignore', source]);
      for (const generated of ['artifacts/tests/copied-source.test.mjs', 'src-tauri/target/native-input/copied-source.test.mjs']) {
        await mkdir(path.dirname(path.join(snapshot, generated)), { recursive: true });
        await copyFile(path.join(root, 'scripts/__tests__/native-input-runner.test.mjs'), path.join(snapshot, generated));
        expect(readValidationGit(snapshot, ['check-ignore', '--no-index', generated]).toString().trim()).toBe(generated);
      }
      expect(captureValidationSources(snapshot)).toEqual(before);
      expect(createHash('sha256').update(await readFile(index)).digest('hex')).toBe(indexSha256);
      expect(() => readValidationGit(snapshot, ['add', '.'])).toThrow('Only read-only validation Git commands are allowed');
    });
  });

  it('resolves the nearest workspace for nested acceptance snapshots without assuming directory depth', async () => {
    await withArtifactDirectory(async directory => {
      expect(artifactWorkspace(directory)).toBe(root);
      const snapshot = path.join(directory, 'ShellSpan');
      const producer = path.join(snapshot, 'artifacts/tests/native-input-p3/paired-runtime');
      await mkdir(producer, { recursive: true });
      expect(artifactWorkspace(producer)).toBe(snapshot);
      expect(artifactWorkspace(path.join(producer, 'artifacts', 'output.json'))).toBe(snapshot);
      expect(() => artifactWorkspace(path.parse(root).root)).toThrow('inside a workspace artifacts/tests directory');
    });
  });

  it('keeps CI resource transfers and release staging in the build directory', async () => {
    const workflow = parse(await readFile(path.join(root, '.github/workflows/release.yml'), 'utf8'));
    const nativeBuild = workflow.jobs['build-native-bash'];
    const buildSteps = workflow.jobs.build.steps;
    const nativeUpload = nativeBuild.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    expect(nativeUpload.with.name).toBe('native-linux-bash-${{ matrix.arch }}');
    expect(nativeUpload.with.path).toBe('src-tauri/target/native-input/native-input-p2/resources/native-input');
    expect(nativeUpload.with['include-hidden-files']).toBe(true);
    const cacheIndex = buildSteps.findIndex(step => step.name === 'Cache Rust build');
    expect(cacheIndex).toBeGreaterThanOrEqual(0);
    for (const arch of ['amd64', 'arm64']) {
      expect(nativeBuild.strategy.matrix.include).toContainEqual(expect.objectContaining({ arch }));
      const download = buildSteps.find(step => step.with?.name === `native-linux-bash-${arch}`);
      expect(download?.with.path).toBe(nativeUpload.with.path);
      expect(buildSteps.indexOf(download)).toBeGreaterThan(cacheIndex);
    }

    const editorUpload = workflow.jobs['build-native-macos-editor'].steps.find(step => step.with?.name === 'native-macos-editor');
    const editorDownload = workflow.jobs.build.steps.find(step => step.with?.name === editorUpload.with.name);
    expect(editorDownload.with.path).toBe('src-tauri/target/native-input');
    expect(editorUpload.with.path.trim().split('\n').every(entry => entry.startsWith(`${editorDownload.with.path}/`))).toBe(true);
    expect(editorUpload.with['include-hidden-files']).toBe(true);
    expect(buildSteps.indexOf(editorDownload)).toBeGreaterThan(cacheIndex);

    const bundleUpload = workflow.jobs.build.steps.find(step => step.name === 'Upload bundle artifact');
    const bundleDownload = workflow.jobs.release.steps.find(step => step.name === 'Download bundle artifacts');
    expect(bundleUpload.with.path).toBe('src-tauri/target/releases/staging');
    expect(bundleUpload.with['include-hidden-files']).toBe(true);
    expect(bundleDownload.with.path).toBe('src-tauri/target/releases/inputs');
  });
});
