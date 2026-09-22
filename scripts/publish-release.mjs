import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { walkFiles, buildUpdaterManifest } from './build-updater-json.mjs';
import { command, checkNotes, readVersions, latestStable, assertBaseline, assertRemoteTag, REPOSITORY } from './release-notes.mjs';

export const PLATFORMS = ['darwin-aarch64', 'windows-x86_64'];
const assetSuffixes = ['.dmg', '.exe', '.app.tar.gz', '.nsis.zip', '.app.tar.gz.sig', '.nsis.zip.sig'];

export function assertDraft(release) {
  if (release && !release.draft) throw new Error('Published releases are immutable; publish a new version instead');
}

export function findReleaseByTag(tag) {
  // GitHub's by-tag endpoint excludes drafts, even for an authenticated writer.
  const releases = JSON.parse(command('gh', ['api', '--paginate', '--slurp', `repos/${REPOSITORY}/releases?per_page=100`])).flat();
  return releases.find(release => release.tag_name === tag);
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function fetchPublished(url, method = 'GET') {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetch(url, { method, signal: AbortSignal.timeout(15_000) });
      if (response.ok) return response;
      await response.body?.cancel();
      if (attempt === 5) throw new Error(`Public download returned ${response.status}: ${url}`);
    } catch (error) {
      if (attempt === 5) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 3_000));
  }
  throw new Error(`Public download unavailable: ${url}`);
}

export async function verifyUpdaterSignature(archive, signature, publicKey) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shellspan-signature-'));
  try {
    const keyPath = path.join(directory, 'key.pub');
    const sigPath = path.join(directory, 'archive.sig');
    await writeFile(keyPath, Buffer.from(publicKey, 'base64'));
    await writeFile(sigPath, Buffer.from(signature, 'base64'));
    execFileSync('minisign', ['-Vm', archive, '-p', keyPath, '-x', sigPath], { stdio: 'pipe' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function stageAssets({ artifactsRootDir, outputDir, tag, notes, publicKey }) {
  const manifest = await buildUpdaterManifest({ artifactsRootDir, tag, notes, repoSlug: REPOSITORY, expectedPlatforms: PLATFORMS });
  const files = (await walkFiles(artifactsRootDir)).filter(file => assetSuffixes.some(suffix => file.endsWith(suffix)));
  const names = files.map(file => path.basename(file));
  if (new Set(names).size !== names.length) throw new Error('Duplicate release asset filenames');
  for (const suffix of assetSuffixes) {
    if (files.filter(file => file.endsWith(suffix)).length !== 1) throw new Error(`Expected exactly one ${suffix} asset`);
  }
  // Tauri .sig and pubkey values encode complete minisign files in base64.
  for (const update of Object.values(manifest.platforms)) {
    const archive = files.find(file => path.basename(file) === path.basename(new URL(update.url).pathname));
    if (!archive) throw new Error('Updater manifest references a missing archive');
    await verifyUpdaterSignature(archive, update.signature, publicKey);
  }
  await mkdir(outputDir, { recursive: true });
  const staged = [];
  for (const file of files) {
    const destination = path.join(outputDir, path.basename(file));
    await copyFile(file, destination);
    staged.push(destination);
  }
  const manifestPath = path.join(outputDir, 'latest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  staged.push(manifestPath);
  const sums = await Promise.all(staged.map(async file => `${await sha256(file)}  ${path.basename(file)}`));
  const checksumPath = path.join(outputDir, 'SHA256SUMS');
  await writeFile(checksumPath, sums.join('\n') + '\n');
  staged.push(checksumPath);
  return staged;
}

async function publish() {
  const { version } = readVersions();
  const tag = `v${version}`;
  if (process.env.RELEASE_TAG !== tag) throw new Error('Release tag/version mismatch');
  const { meta, notes } = checkNotes(version);
  assertBaseline(meta, latestStable());
  let release = findReleaseByTag(tag);
  assertDraft(release);
  const tauri = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
  const assets = await stageAssets({ artifactsRootDir: 'release-inputs', outputDir: 'release-output/assets', tag, notes, publicKey: tauri.plugins.updater.pubkey });
  const notesFile = 'release-output/release-notes.md';
  await writeFile(notesFile, notes + '\n');
  const gh = args => command('gh', [...args, '--repo', REPOSITORY]);
  if (!release) {
    gh(['release', 'create', tag, '--draft', '--verify-tag', '--title', `ShellSpan ${tag}`, '--notes-file', notesFile]);
  } else {
    // Remove leftovers only from an unpublished draft; never alter public assets.
    for (const asset of release.assets) command('gh', ['api', '--method', 'DELETE', `repos/${REPOSITORY}/releases/assets/${asset.id}`]);
  }
  gh(['release', 'upload', tag, ...assets]);
  const downloadDir = await mkdtemp(path.join(os.tmpdir(), 'shellspan-release-download-'));
  try {
    gh(['release', 'download', tag, '--dir', downloadDir]);
    for (const asset of assets) {
      if (await sha256(asset) !== await sha256(path.join(downloadDir, path.basename(asset)))) {
        throw new Error(`Uploaded asset checksum mismatch: ${path.basename(asset)}`);
      }
    }
  } finally {
    await rm(downloadDir, { recursive: true, force: true });
  }
  // Recheck immediately before publication under the workflow's shared publish lock.
  assertBaseline(meta, latestStable());
  assertRemoteTag(tag);
  release = findReleaseByTag(tag);
  if (!release) throw new Error('Release draft disappeared before publication');
  assertDraft(release);
  const prerelease = version.includes('-');
  gh(['release', 'edit', tag, '--draft=false', `--prerelease=${prerelease}`, '--latest=false', '--notes-file', notesFile]);
  // Verify public downloads before directing stable clients to this release.
  const endpoint = `https://github.com/${REPOSITORY}/releases/download/${tag}/latest.json`;
  const publicManifest = await fetchPublished(endpoint);
  const remote = await publicManifest.json();
  const local = JSON.parse(await readFile('release-output/assets/latest.json', 'utf8'));
  if (JSON.stringify(remote) !== JSON.stringify(local)) throw new Error('Public updater manifest differs from verified assets');
  for (const update of Object.values(remote.platforms)) {
    await fetchPublished(update.url, 'HEAD');
  }
  if (!prerelease) gh(['release', 'edit', tag, '--latest']);
  console.log(`Published and verified ${tag}${prerelease ? ' (prerelease)' : ' (Latest)'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publish().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
