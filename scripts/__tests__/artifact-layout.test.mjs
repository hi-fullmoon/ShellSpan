import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import frontend from '../../vitest.config.ts';
import { artifactWorkspace } from '../native-input/artifact-paths.mjs';
import { captureValidationSources, readValidationGit, nativeValidationResourceDirectory, captureValidationAssets, frozenNativeInputLayout } from '../native-input/integration/frozen-validation.mjs';
import { nativeInputBuildDirectory, nativeInputBuildPath } from '../native-input/integration/resource-paths.mjs';
import { migrateBuildLayout } from '../native-input/migrate-build-layout.mjs';
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
  it('moves existing release build directories and nested x86_64 caches without changing their files', async () => {
    await withArtifactDirectory(async directory => {
      const fixture = 'scripts/native-input/prototype/readline-sources.json';
      const buildRoot = path.join(directory, nativeInputBuildPath);
      const architecture = 'linux-x86_64-glibc-2.28';
      const sections = [
        ['native-input-p0', 'prototype'], ['native-input-p2', 'integration'], ['native-input-p3', 'acceptance'],
        [`${architecture}/native-input-p0`, `${architecture}/prototype`],
        [`${architecture}/native-input-p2`, `${architecture}/integration`],
      ];
      for (const [oldName] of sections) {
        const output = path.join(buildRoot, oldName);
        await mkdir(output, { recursive: true });
        await copyFile(path.join(root, fixture), path.join(output, 'readline-sources.json'));
      }
      await mkdir(path.join(buildRoot, 'acceptance'));
      expect(() => migrateBuildLayout(directory)).toThrow('Build directory already exists');
      await access(path.join(buildRoot, 'native-input-p0/readline-sources.json'));
      await rm(path.join(buildRoot, 'acceptance'), { recursive: true });
      expect(migrateBuildLayout(directory)).toHaveLength(sections.length);
      const expected = await readFile(path.join(root, fixture));
      for (const [oldName, newName] of sections) {
        await expect(access(path.join(buildRoot, oldName))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(path.join(buildRoot, newName, 'readline-sources.json'))).toEqual(expected);
      }
      expect(migrateBuildLayout(directory)).toEqual([]);
    });
  });
  it.each(['prototype', 'integration', 'acceptance'])(
    'uses the same %s section name for test and release builds', section => {
      const nested = path.join(root, 'artifacts/tests/native-input/integration/dependency-cache/linux-x86_64-glibc-2.28');
      expect(nativeInputBuildDirectory(root, 'artifacts/tests', section)).toBe(path.join(root, 'artifacts/tests/native-input', section));
      expect(nativeInputBuildDirectory(root, nested, section)).toBe(path.join(nested, 'native-input', section));
      expect(nativeInputBuildDirectory(root, nativeInputBuildPath, section)).toBe(path.join(root, nativeInputBuildPath, section));
      const nestedRelease = path.join(nativeInputBuildPath, 'linux-x86_64-glibc-2.28');
      expect(nativeInputBuildDirectory(root, nestedRelease, section)).toBe(path.join(root, nestedRelease, section));
    },
  );
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
      const meta = path.join(snapshot, 'artifacts/tests/native-input/acceptance'), originalIndex = readValidationGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).toString().trim(), head = readValidationGit(root, ['rev-parse', 'HEAD']).toString().trim();
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
      const snapshot=path.join(directory,'ShellSpan'),defaultResources=path.join(snapshot,'artifacts/tests/native-input/integration/resources/native-input'),selected=path.join(snapshot,'artifacts/tests/rebuilt/native-input'),sibling=path.join(directory,'other');
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
      const meta = path.join(snapshot, 'artifacts/tests/native-input/acceptance');
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

  it.each([
    ['artifacts/tests/native-input/acceptance', 'artifacts/tests/native-input/integration/resources/native-input', false],
    ['artifacts/tests/native-input-p3', 'artifacts/tests/native-input-p2/resources/native-input', true],
  ])('reads the sealed %s index and resources without a .git directory', async (metadata, resources, legacy) => {
    await withArtifactDirectory(async directory => {
      const snapshot = path.join(directory, 'ShellSpan');
      const source = 'scripts/native-input/acceptance/linux-run.py';
      await mkdir(path.dirname(path.join(snapshot, source)), { recursive: true });
      for (const file of ['.gitignore', source]) await copyFile(path.join(root, file), path.join(snapshot, file));

      const meta = path.join(snapshot, metadata);
      const originalIndex = readValidationGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).toString().trim();
      const head = readValidationGit(root, ['rev-parse', 'HEAD']).toString().trim();
      const { gitDirectory, index } = createIndexReader(meta, originalIndex, head);
      await chmod(index, 0o400);
      const indexSha256 = createHash('sha256').update(await readFile(index)).digest('hex');
      const indexReceipt = { version: 1, root: snapshot, gitDirectory, index, indexSha256 };
      const indexPath = path.join(meta, 'snapshot-index.json');
      await writeFile(indexPath, JSON.stringify(indexReceipt));
      await expect(access(path.join(snapshot, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
      const resourceDirectory = path.join(snapshot, resources);
      await mkdir(resourceDirectory, { recursive: true });
      expect(frozenNativeInputLayout(snapshot)).toEqual({ metadataDirectory: meta, resourcesDirectory: resourceDirectory, legacy });
      expect(nativeValidationResourceDirectory(snapshot)).toBe(await realpath(resourceDirectory));

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
      const outsideIndex = path.join(directory, 'outside-index');
      await copyFile(index, outsideIndex);
      await writeFile(indexPath, JSON.stringify({ ...indexReceipt, index: outsideIndex }));
      expect(() => captureValidationSources(snapshot)).toThrow('Frozen source index must stay within snapshot metadata');
      const competingMeta = path.join(snapshot, legacy ? 'artifacts/tests/native-input/acceptance' : 'artifacts/tests/native-input-p3');
      await mkdir(competingMeta, { recursive: true });
      await copyFile(indexPath, path.join(competingMeta, 'snapshot-index.json'));
      expect(() => captureValidationSources(snapshot)).toThrow('Conflicting frozen native input layouts');
    });
  });

  it('resolves the nearest workspace for nested acceptance snapshots without assuming directory depth', async () => {
    await withArtifactDirectory(async directory => {
      expect(artifactWorkspace(directory)).toBe(root);
      const snapshot = path.join(directory, 'ShellSpan');
      const producer = path.join(snapshot, 'artifacts/tests/native-input/acceptance/paired-runtime');
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
    expect(nativeUpload.with.path).toBe('src-tauri/target/native-input/integration/resources/native-input');
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
