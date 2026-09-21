import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { command, readVersions, checkNotes, latestStable, assertBaseline, assertRemoteTag, REPOSITORY } from './release-notes.mjs';

try {
  const tag = process.env.RELEASE_TAG;
  const { version } = readVersions();
  if (tag !== `v${version}`) throw new Error('Tag must exactly match all four repository versions, including prerelease suffix');
  const { meta, notes } = checkNotes(version);
  assertBaseline(meta, latestStable());
  const releases = JSON.parse(command('gh', ['api', '--paginate', '--slurp', `repos/${REPOSITORY}/releases?per_page=100`])).flat();
  if (releases.some(release => release.tag_name === tag && !release.draft)) {
    throw new Error(`${tag} is already published. Published assets cannot be rebuilt or replaced.`);
  }
  const sha = command('git', ['rev-parse', 'HEAD']);
  const tagSha = command('git', ['rev-parse', `${tag}^{commit}`]);
  if (sha !== tagSha) throw new Error('Checkout does not match the release tag');
  assertRemoteTag(tag);
  const delimiter = `notes_${randomUUID()}`;
  appendFileSync(process.env.GITHUB_OUTPUT,
    `tag=${tag}\nversion=${version}\nsha=${sha}\nprerelease=${version.includes('-')}\nnotes<<${delimiter}\n${notes}\n${delimiter}\n`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
