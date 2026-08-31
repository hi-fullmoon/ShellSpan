import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildUpdaterManifest } from '../build-updater-json.mjs';

const tempDirs = [];

async function createArtifact(
  rootDir,
  platform,
  archiveRelativePath,
  signature,
  updaterArchiveSuffix,
) {
  const artifactDir = path.join(rootDir, platform);
  const bundleDir = path.join(artifactDir, 'bundle');
  const archivePath = path.join(bundleDir, archiveRelativePath);

  await mkdir(path.dirname(archivePath), { recursive: true });
  await writeFile(
    path.join(artifactDir, 'release-metadata.json'),
    JSON.stringify({ platform, updaterArchiveSuffix }, null, 2),
  );
  await writeFile(archivePath, 'archive');
  await writeFile(`${archivePath}.sig`, `${signature}\n`);
}

describe('buildUpdaterManifest', () => {
  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await import('node:fs/promises').then(({ rm }) =>
          rm(dir, { recursive: true, force: true }),
        );
      }
    }
  });

  it('builds a combined updater manifest from multiple platform artifacts', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'shellspan-release-'));
    tempDirs.push(rootDir);

    await createArtifact(
      rootDir,
      'darwin-aarch64',
      path.join('macos', 'ShellSpan.app.tar.gz'),
      'sig-macos-arm',
      '.app.tar.gz',
    );
    await createArtifact(
      rootDir,
      'darwin-x86_64',
      path.join('macos', 'ShellSpan-x64.app.tar.gz'),
      'sig-macos-intel',
      '.app.tar.gz',
    );
    await createArtifact(
      rootDir,
      'windows-x86_64',
      path.join('msi', 'ShellSpan_1.0.1_x64_en-US.msi.zip'),
      'sig-windows',
      '.msi.zip',
    );
    await mkdir(path.join(rootDir, 'windows-x86_64', 'bundle', 'nsis'), { recursive: true });
    await writeFile(
      path.join(rootDir, 'windows-x86_64', 'bundle', 'nsis', 'ShellSpan_1.0.1_x64-setup.nsis.zip'),
      'unused updater archive',
    );

    const manifest = await buildUpdaterManifest({
      artifactsRootDir: rootDir,
      notes: 'Release v1.0.1',
      repoSlug: 'hi-fullmoon/ShellSpan',
      tag: 'v1.0.1',
    });

    expect(manifest.version).toBe('v1.0.1');
    expect(manifest.notes).toBe('Release v1.0.1');
    expect(manifest.platforms).toEqual({
      'darwin-aarch64': {
        signature: 'sig-macos-arm',
        url: 'https://github.com/hi-fullmoon/ShellSpan/releases/download/v1.0.1/ShellSpan.app.tar.gz',
      },
      'darwin-x86_64': {
        signature: 'sig-macos-intel',
        url: 'https://github.com/hi-fullmoon/ShellSpan/releases/download/v1.0.1/ShellSpan-x64.app.tar.gz',
      },
      'windows-x86_64': {
        signature: 'sig-windows',
        url: 'https://github.com/hi-fullmoon/ShellSpan/releases/download/v1.0.1/ShellSpan_1.0.1_x64_en-US.msi.zip',
      },
    });
  });
});
