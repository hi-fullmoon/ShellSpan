import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, access } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import semver from 'semver';
import { command, readVersions, checkNotes, updateChangelog, VERSION_FILES, REPOSITORY } from '../release-notes.mjs';
import { editTomlVersion, writePreparedVersion } from '../bump-version.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const directories = [];
const notes = '### 问题修复\n\n- 修复 SSH 命令取消后无法立即重试的问题。';

async function copyManifests() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shellspan-release-regression-'));
  directories.push(directory);
  await mkdir(path.join(directory, 'src-tauri'));
  for (const file of [...VERSION_FILES, 'CHANGELOG.md', '.gitignore']) {
    await copyFile(path.join(root, file), path.join(directory, file));
  }
  return directory;
}

async function reviewedRepository() {
  const directory = await copyManifests();
  const git = args => command('git', args, directory);
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Release regression tests']);
  git(['config', 'user.email', 'release-regression@localhost']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.autocrlf', 'false']);
  const commit = () => {
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'chore: record release regression state']);
  };
  await copyFile(path.join(root, 'src/lib/update.ts'), path.join(directory, 'update.ts'));
  commit();
  const { version: current, packageName } = readVersions(directory);
  const version = semver.inc(current, 'patch');
  const baseTag = `v${current}`;
  git(['tag', baseTag]);
  const sha = git(['rev-parse', 'HEAD']);
  const meta = { version, repository: REPOSITORY, date: '2026-09-21', baseTag, baseSha: sha, headSha: sha };
  for (const file of VERSION_FILES) {
    const target = path.join(directory, file);
    const source = await readFile(target, 'utf8');
    if (file.endsWith('.json')) {
      const json = JSON.parse(source);
      json.version = version;
      await writeFile(target, JSON.stringify(json, null, 2) + '\n');
    } else {
      const select = file.endsWith('.toml')
        ? doc => doc.package.version
        : doc => doc.package.find(pkg => pkg.name === packageName && !pkg.source).version;
      await writeFile(target, editTomlVersion(source, current, version, select));
    }
  }
  await mkdir(path.join(directory, 'release-notes'));
  await writeFile(path.join(directory, `release-notes/${version}.md`), notes);
  await writeFile(path.join(directory, `release-notes/${version}.json`), JSON.stringify(meta));
  const changelog = path.join(directory, 'CHANGELOG.md');
  await writeFile(changelog, updateChangelog(await readFile(changelog, 'utf8'), meta, notes));
  return { directory, version, git, commit };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('reviewed release boundary', () => {
  it('accepts version-only preparation before staging, after staging, and after committing', async () => {
    const { directory, version, git, commit } = await reviewedRepository();
    expect(checkNotes(version, directory).notes).toBe(notes);
    git(['add', '.']);
    expect(checkNotes(version, directory).notes).toBe(notes);
    commit();
    expect(checkNotes(version, directory).notes).toBe(notes);
    await mkdir(path.join(directory, 'release-inputs'));
    await copyFile(path.join(root, 'src/lib/update.ts'), path.join(directory, 'release-inputs/update.ts'));
    expect(checkNotes(version, directory).notes).toBe(notes);
  });

  it.each(['worktree', 'index', 'HEAD', 'untracked'])('rejects additional code in %s', async location => {
    const { directory, version, git, commit } = await reviewedRepository();
    commit();
    const file = path.join(directory, location === 'untracked' ? 'new-update.ts' : 'update.ts');
    if (location === 'untracked') await copyFile(path.join(root, 'src/lib/update.ts'), file);
    else await writeFile(file, '\n// Additional release change\n', { flag: 'a' });
    if (location === 'index') {
      git(['add', 'update.ts']);
      // An index-only change must be rejected even when the working copy is restored.
      await copyFile(path.join(root, 'src/lib/update.ts'), file);
    }
    if (location === 'HEAD') commit();
    expect(() => checkNotes(version, directory)).toThrow(/Code changed after notes/);
  });

  for (const file of VERSION_FILES) {
    it.each(['worktree', 'index', 'HEAD'])(`rejects non-version changes to ${file} in %s`, async location => {
      const { directory, version, git, commit } = await reviewedRepository();
      commit();
      const target = path.join(directory, file);
      const original = await readFile(target, 'utf8');
      let updated;
      if (file.endsWith('.json')) {
        const json = JSON.parse(original);
        if (file === 'package.json') json.scripts.build = 'tsc --noEmit';
        else json.app.security.csp = null;
        updated = JSON.stringify(json, null, 2);
      } else if (file.endsWith('.toml')) {
        updated = original.replace('description = "', 'description = "Revised ');
      } else {
        // Modify the resolution of a dependency, not the root package version.
        updated = original.replace('registry+https://github.com/rust-lang/crates.io-index', 'registry+https://example.com/crates-index');
      }
      expect(updated).not.toBe(original);
      await writeFile(target, updated);
      if (location === 'index') {
        git(['add', file]);
        await writeFile(target, original);
      }
      if (location === 'HEAD') {
        commit();
        await writeFile(target, original);
      }
      expect(() => checkNotes(version, directory)).toThrow(new RegExp(`Non-version release changes.*\\(${location}\\)`));
    });
  }
});

describe('release preparation recovery', () => {
  async function originalFiles(directory) {
    return Promise.all(VERSION_FILES.map(file => readFile(path.join(directory, file))));
  }

  it('restores all versions when the notes directory is a file and preserves that file', async () => {
    const directory = await copyManifests();
    const before = await originalFiles(directory);
    const blocker = path.join(directory, 'release-notes');
    await copyFile(path.join(root, 'docs/releasing.md'), blocker);
    const existing = await readFile(blocker);
    const version = semver.inc(readVersions(directory).version, 'patch');
    expect(() => writePreparedVersion(version, { version }, notes, directory)).toThrow();
    expect(await originalFiles(directory)).toEqual(before);
    expect(await readFile(blocker)).toEqual(existing);
  });

  it('removes a newly created note and restores versions when the metadata filename exceeds the filesystem limit', async () => {
    const directory = await copyManifests();
    const before = await originalFiles(directory);
    // A real filesystem failure on the second file: .md fits in 255 bytes,
    // while .json exceeds that component limit. No injected I/O failure.
    const prefix = `${semver.inc(readVersions(directory).version, 'major')}-`;
    const version = prefix + 'a'.repeat(251 - prefix.length);
    expect(semver.valid(version)).toBe(version);
    expect(() => writePreparedVersion(version, { version }, notes, directory)).toThrow();
    expect(await originalFiles(directory)).toEqual(before);
    await expect(access(path.join(directory, 'release-notes'))).rejects.toThrow();
  });

  it('preserves an existing version note without changing any versions', async () => {
    const directory = await copyManifests();
    const before = await originalFiles(directory);
    const version = semver.inc(readVersions(directory).version, 'patch');
    await mkdir(path.join(directory, 'release-notes'));
    const file = path.join(directory, `release-notes/${version}.md`);
    await writeFile(file, notes);
    expect(() => writePreparedVersion(version, { version }, notes, directory)).toThrow(/already exist/);
    expect(await originalFiles(directory)).toEqual(before);
    expect(await readFile(file, 'utf8')).toBe(notes);
  });

  it('rolls back versions and new notes when real Cargo validation fails', async () => {
    const directory = await copyManifests();
    const before = await originalFiles(directory);
    const version = semver.inc(readVersions(directory).version, 'patch');
    // These real manifests require a library source, which has not been copied.
    expect(() => writePreparedVersion(version, { version }, notes, directory)).toThrow(/cargo/);
    expect(await originalFiles(directory)).toEqual(before);
    await expect(access(path.join(directory, 'release-notes'))).rejects.toThrow();
  });

  it('prepares all files successfully for a real Cargo project', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'shellspan-release-success-'));
    directories.push(directory);
    command('cargo', ['init', '--lib', '--name', 'release_preparation_probe', '--vcs', 'none', 'src-tauri'], directory);
    command('cargo', ['generate-lockfile', '--manifest-path', 'src-tauri/Cargo.toml'], directory);
    for (const file of ['package.json', 'src-tauri/tauri.conf.json']) {
      const json = JSON.parse(await readFile(path.join(root, file), 'utf8'));
      json.version = '0.1.0';
      await writeFile(path.join(directory, file), JSON.stringify(json));
    }
    writePreparedVersion('0.1.1', { version: '0.1.1' }, notes, directory);
    expect(readVersions(directory).version).toBe('0.1.1');
    expect(await readFile(path.join(directory, 'release-notes/0.1.1.md'), 'utf8')).toContain(notes);
    expect(JSON.parse(await readFile(path.join(directory, 'release-notes/0.1.1.json'), 'utf8')).version).toBe('0.1.1');
  });

  it('blocks the actual pnpm version command before any manifest changes', async () => {
    const directory = await copyManifests();
    const before = await originalFiles(directory);
    await mkdir(path.join(directory, 'scripts'));
    await copyFile(path.join(root, 'scripts/reject-package-version.mjs'), path.join(directory, 'scripts/reject-package-version.mjs'));
    const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    expect(pkg.scripts).not.toHaveProperty('version');
    let result;
    try {
      // Constant shell command works with both the Windows pnpm.cmd shim and
      // POSIX pnpm; no paths or user content are interpolated into the shell.
      execSync('pnpm version patch --no-git-tag-version', { cwd: directory, encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      result = error;
    }
    expect(result?.status).toBe(1);
    expect(`${result?.stdout}${result?.stderr}`).toContain('Use pnpm release:prepare');
    expect(await originalFiles(directory)).toEqual(before);
  });
});
