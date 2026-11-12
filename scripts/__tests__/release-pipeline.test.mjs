import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { editTomlVersion, generateCandidates } from '../bump-version.mjs';
import { command, validateNotes, updateChangelog, changelogSection, assertBaseline, validVersion, readVersions, REVIEW_MARKER } from '../release-notes.mjs';
import { assertDraft, findReleaseByTag } from '../publish-release.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const directories = [];
async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shellspan-release-test-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('release notes', () => {
  it('updates only the selected version and preserves human-edited history and Markdown code blocks', async () => {
    const history = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
    const notes = '### 问题修复\n\n- SSH 命令取消后可以立即重试。\n\n```md\n## [v9.9.9]\n```';
    const meta = { version: '9.0.0', date: '2026-09-21' };
    const updated = updateChangelog(history, meta, notes);
    expect(changelogSection(updated, '9.0.0').notes).toBe(notes);
    expect(updated.endsWith(history.slice(history.indexOf('## [')))).toBe(true);
    const revised = notes.replace('立即重试', '安全重试');
    const synced = updateChangelog(updated, meta, revised);
    expect(changelogSection(synced, '9.0.0').notes).toBe(revised);
    expect(synced.match(/releases\/tag\/v9.0.0/g)).toHaveLength(1);
    expect(synced.endsWith(history.slice(history.indexOf('## [')))).toBe(true);
  });

  it.each(['', 'Release v2.1.0', '### 新增功能', `### 修复\n\n- 已修复\n${REVIEW_MARKER}`, '### 修复\n\n- TODO: 编辑说明'])('rejects unreviewed or missing notes: %s', notes => {
    expect(() => validateNotes(notes)).toThrow();
  });

  it('rejects stale baselines, downgrade versions, and build metadata', () => {
    expect(() => assertBaseline({ version: '2.1.0', baseTag: 'v2.0.57' }, 'v2.0.59')).toThrow(/changed/);
    expect(() => assertBaseline({ version: '2.0.56', baseTag: 'v2.0.57' }, 'v2.0.57')).toThrow(/newer/);
    expect(() => validVersion('2.1.0+build.1')).toThrow();
    expect(() => validVersion('2.1.0-rc.01')).toThrow();
    expect(validVersion('2.1.0-rc.1')).toBe('2.1.0-rc.1');
  });

  it('includes changes across failed and prerelease tags using real git-cliff and Git history', async () => {
    const directory = await temporaryDirectory();
    const git = args => command('git', args, directory);
    git(['-c', 'init.defaultBranch=fixture-history', 'init', '--quiet']);
    const configuration = await readFile(path.join(root, 'cliff.toml'));
    const changes = [
      ['chore: initialize release configuration', 'v1.0.0'],
      ['feat: expose SSH reconnect action', 'v1.1.0'],
      ['fix: retain active connection after retry', 'v1.1.1-rc.1'],
      ['refactor!: remove obsolete connection settings', null],
      ['docs: update developer instructions', null],
      ['Improve connection accessibility', null],
    ];
    // Batch the same real Git history instead of launching a process for every
    // add/commit/tag. Git parses exact byte-counted fast-import data, including
    // the real UTF-8 cliff configuration; git-cliff remains unmodified.
    const stream = [];
    const data = value => {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      stream.push(Buffer.from(`data ${bytes.length}\n`), bytes, Buffer.from('\n'));
    };
    let contents = '';
    for (const [index, [message, tag]] of changes.entries()) {
      const mark = index + 1;
      stream.push(Buffer.from(`commit refs/heads/fixture-history\nmark :${mark}\ncommitter Release tests <release-tests@localhost> ${1700000000 + index} +0000\n`));
      data(message);
      if (index) stream.push(Buffer.from(`from :${index}\n`));
      stream.push(Buffer.from(`M 100644 inline ${index ? 'changes.txt' : 'cliff.toml'}\n`));
      if (index) contents += message + '\n';
      data(index ? contents : configuration);
      stream.push(Buffer.from('\n'));
      if (tag) stream.push(Buffer.from(`reset refs/tags/${tag}\nfrom :${mark}\n\n`));
    }
    execFileSync('git', ['fast-import', '--quiet'], { cwd: directory, input: Buffer.concat(stream) });
    // Only the freshly created temporary repository is materialized here.
    git(['reset', '--hard', '--quiet', 'HEAD']);
    expect(git(['rev-list', '--count', 'HEAD'])).toBe('6');
    expect(git(['tag', '--list']).split(/\r?\n/)).toEqual(['v1.0.0', 'v1.1.0', 'v1.1.1-rc.1']);
    const base = git(['rev-parse', 'v1.0.0']);
    const notes = generateCandidates(base, git(['rev-parse', 'HEAD']), directory);
    expect(notes).toContain('expose SSH reconnect action');
    expect(notes).toContain('retain active connection after retry');
    expect(notes).toContain('remove obsolete connection settings');
    expect(notes).toContain('升级注意事项');
    expect(notes).toContain('Improve connection accessibility');
    expect(notes).not.toContain('update developer instructions');
    expect(notes.match(/### 新增功能/g)).toHaveLength(1);
  });

  it('preserves TOML comments and dependency versions when updating the real root package', async () => {
    const source = await readFile(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
    const current = parseToml(source).package.version;
    const edited = editTomlVersion(source, current, '3.0.0', doc => doc.package.version);
    expect(edited.replace('version = "3.0.0"', `version = "${current}"`)).toBe(source);
    const lock = await readFile(path.join(root, 'src-tauri/Cargo.lock'), 'utf8');
    const updated = editTomlVersion(lock, current, '3.0.0', doc => doc.package.find(pkg => pkg.name === 'ShellSpan' && !pkg.source)?.version);
    expect(parseToml(updated).package.find(pkg => pkg.name === 'ShellSpan').version).toBe('3.0.0');
    expect(parseToml(updated).package.filter(pkg => pkg.name !== 'ShellSpan')).toEqual(parseToml(lock).package.filter(pkg => pkg.name !== 'ShellSpan'));
  });

  it('detects version drift using real project manifests', async () => {
    const directory = await temporaryDirectory();
    await mkdir(path.join(directory, 'src-tauri'));
    for (const file of ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
      await copyFile(path.join(root, file), path.join(directory, file));
    }
    expect(readVersions(directory)).toEqual(readVersions(root));
    const file = path.join(directory, 'src-tauri/tauri.conf.json');
    const config = JSON.parse(await readFile(file, 'utf8'));
    config.version = '0.0.1';
    await writeFile(file, JSON.stringify(config));
    expect(() => readVersions(directory)).toThrow(/differ/);
  });
});

describe('release publication gates', () => {
  it.skipIf(!process.env.SHELLSPAN_DRAFT_RELEASE_TAG)('finds an existing real GitHub draft before publication', () => {
    const release = findReleaseByTag(process.env.SHELLSPAN_DRAFT_RELEASE_TAG);
    expect(release).toBeDefined();
    expect(release.tag_name).toBe(process.env.SHELLSPAN_DRAFT_RELEASE_TAG);
    expect(release.draft).toBe(true);
    expect(() => assertDraft(release)).not.toThrow();
    const byId = JSON.parse(command('gh', ['api', `repos/hi-fullmoon/ShellSpan/releases/${release.id}`]));
    expect(byId.id).toBe(release.id);
    expect(byId.draft).toBe(true);
  }, 30_000);

  it('allows drafts but refuses to replace any published release', () => {
    expect(() => assertDraft(undefined)).not.toThrow();
    expect(() => assertDraft({ draft: true })).not.toThrow();
    expect(() => assertDraft({ draft: false, prerelease: true })).toThrow(/immutable/);
    expect(() => assertDraft({ draft: false, prerelease: false })).toThrow(/immutable/);
  });

  it('requires the full quality gate at the same SHA and serializes publication', async () => {
    const release = parse(await readFile(path.join(root, '.github/workflows/release.yml'), 'utf8'));
    const quality = parse(await readFile(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8'));
    expect(release.jobs.quality.uses).toBe('./.github/workflows/quality-gate.yml');
    expect(release.jobs.quality.with.ref).toBe('${{ needs.preflight.outputs.sha }}');
    expect(release.jobs.build.needs).toEqual(['preflight', 'build-frontend', 'build-native-bash', 'build-native-macos-editor']);
    expect(release.jobs['build-native-bash'].needs).toBe('preflight');
    expect(release.jobs['build-native-macos-editor'].needs).toBe('preflight');
    expect(release.jobs.quality.needs).toEqual(['preflight', 'build-frontend', 'build-native-macos-editor']);
    expect(release.jobs.release.needs).toContain('build');
    expect(release.jobs.release.needs).toContain('quality');
    expect(release.jobs.release.if).toBeUndefined();
    expect(release.jobs.quality['continue-on-error']).toBeUndefined();
    expect(release.jobs.build['continue-on-error']).toBeUndefined();
    expect(release.jobs.release.concurrency.group).toBe('publish-release');
    expect(release.concurrency.group).toContain('inputs.tag || github.ref_name');
    for (const job of Object.values(quality.jobs)) {
      expect(job.steps.find(step => step.uses?.startsWith('actions/checkout@')).with.ref).toBe('${{ inputs.ref || github.sha }}');
    }
    for (const name of ['build', 'build-frontend', 'build-native-bash', 'build-native-macos-editor', 'release']) {
      expect(release.jobs[name].steps.find(step => step.uses?.startsWith('actions/checkout@')).with.ref).toBe('${{ needs.preflight.outputs.sha }}');
    }
    expect(release.on.workflow_dispatch.inputs).not.toHaveProperty('release_notes');
    const scripts = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).scripts;
    expect(scripts.changelog).toBe('node scripts/release-notes.mjs sync');
  });

  it('builds the frontend once in either entry point and runs platform tests with the current run artifact', async () => {
    const release = parse(await readFile(path.join(root, '.github/workflows/release.yml'), 'utf8'));
    const quality = parse(await readFile(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8'));
    const artifact = release.jobs.quality.with['frontend-artifact'];
    for (const producer of [quality.jobs.frontend, release.jobs['build-frontend']]) {
      expect(producer['runs-on']).toBe('ubuntu-24.04');
      const uploadIndex = producer.steps.findIndex(step => step.uses?.startsWith('actions/upload-artifact@'));
      expect(producer.steps.slice(0, uploadIndex).map(step => step.run)).toEqual(
        expect.arrayContaining(['pnpm check:ci:static', 'pnpm test', 'pnpm build']),
      );
      expect(producer.steps[uploadIndex].with).toMatchObject({ name: artifact, path: 'dist', 'if-no-files-found': 'error' });
    }
    expect(quality.on.workflow_call.inputs['frontend-artifact'].default).toBe('');
    expect(quality.jobs.frontend.if).toBe('${{ !inputs.frontend-artifact }}');
    const rust = quality.jobs.rust;
    expect(rust.needs).toBe('frontend');
    expect(rust.if.replace(/\s+/g, ' ')).toBe(
      "${{ !cancelled() && (needs.frontend.result == 'success' || (inputs.frontend-artifact != '' && needs.frontend.result == 'skipped')) }}",
    );
    expect(rust.steps.find(step => step.run === 'pnpm test').if).toBeUndefined();
    expect(rust.steps.map(step => step.run)).not.toContain('pnpm build');
    const download = rust.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
    expect(download.if).toBeUndefined();
    expect(download.with).toEqual({ name: `\${{ inputs.frontend-artifact || '${artifact}' }}`, path: 'dist' });
    expect(download['continue-on-error']).toBeUndefined();
    const packageDownload = release.jobs.build.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
    expect(packageDownload.with).toEqual({ name: artifact, path: 'dist' });
    const publishDownload = release.jobs.release.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
    expect(publishDownload.with).toEqual({ pattern: 'bundle-*', path: '.artifacts/releases/inputs' });
  });

  it('prepares the macOS shell fixtures before Rust tests and reuses the release ZLE build', async () => {
    const release = parse(await readFile(path.join(root, '.github/workflows/release.yml'), 'utf8'));
    const quality = parse(await readFile(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8'));
    const { strategy, steps } = quality.jobs.rust;
    expect(strategy.matrix.include).toContainEqual({ platform: 'macos', runner: 'xcode-27' });
    expect(quality.on.workflow_call.inputs['macos-editor-artifact'].default).toBe('');
    const preparation = steps.slice(0, steps.findIndex(step => step.name === 'Run Agent terminal contract tests'));
    expect(preparation.find(step => step.run === 'python3 -B scripts/native-input-p2/build.py --versions 5.3').if).toBe("runner.os == 'macOS'");
    const build = preparation.find(step => step.name === 'Build pinned Zsh and ZLE test resources');
    const download = preparation.find(step => step.name === 'Download pinned Zsh and ZLE test resources');
    const restore = preparation.find(step => step.name === 'Restore executable permission on downloaded Zsh');
    expect(build.if).toBe("runner.os == 'macOS' && !inputs.macos-editor-artifact");
    expect(download.if).toBe("runner.os == 'macOS' && inputs.macos-editor-artifact");
    expect(download.with).toEqual({ name: '${{ inputs.macos-editor-artifact }}', path: '.artifacts/tests' });
    expect(preparation.indexOf(restore)).toBeGreaterThan(preparation.indexOf(download));
    expect(restore.if).toBe(download.if);
    const producer = release.jobs['build-native-macos-editor'];
    expect(producer.steps.map(step => step.run)).toContain(build.run);
    const upload = producer.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    expect(release.jobs.quality.with['macos-editor-artifact']).toBe(upload.with.name);
  });
});
