import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
    git(['init', '--quiet']);
    git(['config', 'user.name', 'Release tests']);
    git(['config', 'user.email', 'release-tests@localhost']);
    git(['config', 'commit.gpgsign', 'false']);
    await copyFile(path.join(root, 'cliff.toml'), path.join(directory, 'cliff.toml'));
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'chore: initialize release configuration']);
    git(['tag', 'v1.0.0']);
    const base = git(['rev-parse', 'HEAD']);
    const changes = [
      ['feat: expose SSH reconnect action', 'v1.1.0'],
      ['fix: retain active connection after retry', 'v1.1.1-rc.1'],
      ['refactor!: remove obsolete connection settings', null],
      ['docs: update developer instructions', null],
      ['Improve connection accessibility', null],
    ];
    for (const [message, tag] of changes) {
      await writeFile(path.join(directory, 'changes.txt'), message + '\n', { flag: 'a' });
      git(['add', '.']);
      git(['commit', '--quiet', '-m', message]);
      if (tag) git(['tag', tag]);
    }
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
    expect(release.jobs.build.needs).toContain('quality');
    expect(release.jobs.release.needs).toContain('quality');
    expect(release.jobs.release.concurrency.group).toBe('publish-release');
    expect(release.concurrency.group).toContain('inputs.tag || github.ref_name');
    for (const job of Object.values(quality.jobs)) {
      expect(job.steps.find(step => step.uses?.startsWith('actions/checkout@')).with.ref).toBe('${{ inputs.ref || github.sha }}');
    }
    for (const name of ['build', 'build-frontend', 'release']) {
      expect(release.jobs[name].steps.find(step => step.uses?.startsWith('actions/checkout@')).with.ref).toBe('${{ needs.preflight.outputs.sha }}');
    }
    expect(release.on.workflow_dispatch.inputs).not.toHaveProperty('release_notes');
    const scripts = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).scripts;
    expect(scripts.changelog).toBe('node scripts/release-notes.mjs sync');
  });
});
