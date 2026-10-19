import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { command, VERSION_FILES } from '../release-notes.mjs';
import { replaceTag, recoverRelease } from '../recover-release.mjs';
import { assertPreparedQuality, assertQuality } from '../release-quality.mjs';
import { assertDraft, findReleaseByTag } from '../publish-release.mjs';

const directories = [];
const root = path.resolve(import.meta.dirname, '../..');
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function repository() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shellspan-recovery-'));
  directories.push(directory);
  const checkout = path.join(directory, 'checkout');
  await mkdir(checkout);
  const git = args => command('git', args, checkout);
  command('git', ['init', '--bare', '--quiet', path.join(directory, 'remote.git')]);
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Release recovery tests']);
  git(['config', 'user.email', 'release-recovery@localhost']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'tag.gpgsign', 'false']);
  git(['remote', 'add', 'origin', path.join(directory, 'remote.git')]);
  await writeFile(path.join(checkout, 'README.md'), 'Unpublished release recovery\n');
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'chore: prepare recovery acceptance']);
  git(['tag', '-a', 'v1.0.1', '-m', 'Unpublished acceptance tag']);
  git(['push', '--quiet', 'origin', 'refs/tags/v1.0.1']);
  const previous = git(['rev-parse', 'refs/tags/v1.0.1']);
  const previousCommit = git(['rev-parse', 'v1.0.1^{commit}']);
  await writeFile(path.join(checkout, 'README.md'), 'Reviewed recovery target\n');
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'fix: update recovery acceptance']);
  return { checkout, git, previous, previousCommit, target: git(['rev-parse', 'HEAD']) };
}

describe('unpublished tag recovery with real Git remotes', () => {
  it('replaces only the leased annotated tag and records an auditable reason', async () => {
    const { checkout, git, previous, target } = await repository();
    const object = replaceTag('v1.0.1', previous, target, 'Correct Bash prompt cancellation', checkout);
    expect(git(['ls-remote', 'origin', 'refs/tags/v1.0.1']).split(/\s/)[0]).toBe(object);
    expect(git(['cat-file', '-t', object])).toBe('tag');
    const annotation = git(['cat-file', '-p', object]);
    expect(annotation).toContain(`object ${target}`);
    expect(annotation).toContain(`Previous tag object: ${previous}`);
    expect(annotation).toContain('Reason: Correct Bash prompt cancellation');
    expect(git(['rev-parse', 'refs/tags/v1.0.1'])).toBe(previous);
  });

  it('rejects a stale lease and a peeled commit without changing the remote', async () => {
    const { checkout, git, previous, previousCommit, target } = await repository();
    expect(() => replaceTag('v1.0.1', previousCommit, target, 'Peeled commit must not match', checkout)).toThrow();
    expect(git(['ls-remote', 'origin', 'refs/tags/v1.0.1']).split(/\s/)[0]).toBe(previous);
    const object = replaceTag('v1.0.1', previous, target, 'First recovery', checkout);
    expect(() => replaceTag('v1.0.1', previous, target, 'Stale recovery', checkout)).toThrow();
    expect(git(['ls-remote', 'origin', 'refs/tags/v1.0.1']).split(/\s/)[0]).toBe(object);
  });

  it('rejects invalid versions, incomplete SHAs and missing audit reasons before push', async () => {
    const { checkout, git, previous, target } = await repository();
    expect(() => replaceTag('main', previous, target, 'Invalid tag', checkout)).toThrow();
    expect(() => replaceTag('v1.0.1', previous.slice(0, 7), target, 'Short SHA', checkout)).toThrow();
    expect(() => replaceTag('v1.0.1', previous, target, ' ', checkout)).toThrow();
    expect(git(['ls-remote', 'origin', 'refs/tags/v1.0.1']).split(/\s/)[0]).toBe(previous);
  });

  it('refuses recovery outside the serialized workflow and missing quality evidence', () => {
    expect(() => recoverRelease()).toThrow(/main recovery workflow/);
    expect(() => assertPreparedQuality({})).toThrow(/metadata/);
    expect(() => assertPreparedQuality({ qualityRunId: '123' })).toThrow(/metadata/);
    expect(() => assertQuality('HEAD')).toThrow(/exact commit/);
  });

  it('shares the publication lock and keeps recovery inputs out of shell code', async () => {
    const recovery = parse(await readFile(path.join(root, '.github/workflows/release-recover.yml'), 'utf8'));
    const release = parse(await readFile(path.join(root, '.github/workflows/release.yml'), 'utf8'));
    const quality = parse(await readFile(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8'));
    expect(recovery.jobs.recover.concurrency.group).toBe(release.jobs.release.concurrency.group);
    expect(recovery.jobs.recover.concurrency['cancel-in-progress']).toBe(false);
    expect(recovery.jobs.recover.if).toBe("github.ref == 'refs/heads/main'");
    for (const step of recovery.jobs.recover.steps) expect(step.run || '').not.toContain('${{');
    expect(recovery.permissions.actions).toBe('write');
    expect(release.permissions.actions).toBe('read');
    expect(release.jobs.release.permissions.actions).toBe('read');
    expect(quality.on).toHaveProperty('workflow_dispatch');
  });
});

// Read-only acceptance against real GitHub history. No API stubs or remote writes.
describe.skipIf(!process.env.SHELLSPAN_RELEASE_QUALITY_SUCCESS_SHA)('real GitHub quality evidence', () => {
  it('blocks real version preparation before touching files when a commit has no CI evidence', async () => {
    const { checkout, git } = await repository();
    await mkdir(path.join(checkout, 'src-tauri'));
    for (const file of VERSION_FILES) await copyFile(path.join(root, file), path.join(checkout, file));
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'chore: record unvalidated release manifests']);
    const before = await Promise.all(VERSION_FILES.map(file => readFile(path.join(checkout, file))));
    let failure;
    try {
      execFileSync(process.execPath, [path.join(root, 'scripts/bump-version.mjs'), 'patch'], { cwd: checkout, encoding: 'utf8', stdio: 'pipe' });
    } catch (error) { failure = error; }
    expect(failure?.status).toBe(1);
    expect(failure?.stderr).toContain('Full Quality Gate has not passed');
    expect(await Promise.all(VERSION_FILES.map(file => readFile(path.join(checkout, file))))).toEqual(before);
    expect(git(['status', '--porcelain'])).toBe('');
  }, 60_000);

  it('accepts the full successful main gate and rejects an unrelated run ID', () => {
    const sha = process.env.SHELLSPAN_RELEASE_QUALITY_SUCCESS_SHA;
    const id = assertQuality(sha);
    expect(Number.isSafeInteger(id)).toBe(true);
    expect(() => assertQuality(sha, id + 1)).toThrow(/has not passed/);
  }, 60_000);

  it('rejects failed or cancelled code validation and already published recovery', () => {
    expect(() => assertQuality(process.env.SHELLSPAN_RELEASE_QUALITY_FAILED_SHA)).toThrow(/has not passed/);
    expect(() => assertDraft(findReleaseByTag(process.env.SHELLSPAN_RELEASE_PUBLISHED_TAG))).toThrow(/immutable/);
  }, 60_000);
});
