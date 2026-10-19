import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { command, readVersions, checkNotes, latestStable, assertBaseline, REPOSITORY, validVersion } from './release-notes.mjs';
import { assertPreparedQuality } from './release-quality.mjs';
import { assertDraft, findReleaseByTag } from './publish-release.mjs';

// The lease compares the tag object, not its peeled commit. An annotated tag
// replacement pointing at the same commit is still a concurrent modification.
export function replaceTag(tag, expectedObject, target, reason, root = process.cwd()) {
  if (!tag.startsWith('v')) throw new Error('Expected a version tag');
  validVersion(tag.slice(1));
  if (![expectedObject, target].every(sha => /^[a-f0-9]{40}$/.test(sha))) throw new Error('Exact tag object and target SHA required');
  if (!reason?.trim() || reason.includes('\0')) throw new Error('A recovery reason is required');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['cat-file', '-e', `${target}^{commit}`]);
  const identity = git(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'var', 'GIT_COMMITTER_IDENT']);
  const annotation = `object ${target}\ntype commit\ntag ${tag}\ntagger ${identity}\n\nRecover unpublished ${tag}\nPrevious tag object: ${expectedObject}\nTarget: ${target}\nReason: ${reason.trim()}\nWorkflow: ${process.env.GITHUB_RUN_ID || 'local'}\n`;
  const object = execFileSync('git', ['mktag'], { cwd: root, input: annotation, encoding: 'utf8' }).trim();
  git(['push', `--force-with-lease=refs/tags/${tag}:${expectedObject}`, 'origin', `${object}:refs/tags/${tag}`]);
  return object;
}

export function recoverRelease() {
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.GITHUB_WORKFLOW_REF?.includes('/release-recover.yml@refs/heads/main')) {
    throw new Error('Recovery must run through the main recovery workflow under the shared publication lock');
  }
  const { RELEASE_TAG: tag, EXPECTED_TAG_OBJECT: expected, TARGET_SHA: target, RECOVERY_REASON: reason } = process.env;
  const { version } = readVersions();
  if (tag !== `v${version}` || target !== command('git', ['rev-parse', 'HEAD'])) throw new Error('Recovery checkout/version mismatch');
  const { meta } = checkNotes(version);
  assertPreparedQuality(meta);
  assertBaseline(meta, latestStable());
  const activePages = JSON.parse(command('gh', ['api', '--paginate', '--slurp',
    `repos/${REPOSITORY}/actions/workflows/release.yml/runs?per_page=100`]));
  if (activePages.flatMap(page => page.workflow_runs).some(run => run.status !== 'completed')) {
    throw new Error('Wait for all Release workflow runs to finish before recovering a tag');
  }
  assertDraft(findReleaseByTag(tag));
  const remoteObject = command('git', ['ls-remote', 'origin', `refs/tags/${tag}`]).split(/\s/)[0];
  if (!expected || remoteObject !== expected) throw new Error('Remote tag object differs from the expected failed tag');
  // The workflow holds publish-release throughout these checks, the lease push,
  // draft cleanup and dispatch. Public versions can never enter this path.
  assertDraft(findReleaseByTag(tag));
  const object = replaceTag(tag, expected, target, reason);
  const draft = findReleaseByTag(tag);
  assertDraft(draft);
  if (draft) command('gh', ['api', '--method', 'DELETE', `repos/${REPOSITORY}/releases/${draft.id}`]);
  command('gh', ['workflow', 'run', 'release.yml', '--repo', REPOSITORY, '--ref', 'main', '-f', `tag=${tag}`]);
  console.log(`Recovered ${tag}: ${expected} -> ${object}; target ${target}. Release workflow requested.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { recoverRelease(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
