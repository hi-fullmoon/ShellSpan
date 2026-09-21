import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import { parse as parseToml } from 'smol-toml';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { isDeepStrictEqual } from 'node:util';

export const REPOSITORY = 'hi-fullmoon/ShellSpan';
export const REVIEW_MARKER = '<!-- release-review-required -->';
export const VERSION_FILES = ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];
const markdown = unified().use(remarkParse);

export function command(program, args, cwd = process.cwd()) {
  return execFileSync(program, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
}

export function validVersion(value) {
  if (typeof value !== 'string' || semver.valid(value) !== value || value.includes('+')) {
    throw new Error(`Invalid release version: ${value}; use x.y.z or x.y.z-rc.1 without build metadata`);
  }
  return value;
}

export function readVersions(root = process.cwd()) {
  const read = file => readFileSync(path.join(root, file), 'utf8');
  const pkg = JSON.parse(read('package.json'));
  const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
  const cargo = parseToml(read('src-tauri/Cargo.toml'));
  const lock = parseToml(read('src-tauri/Cargo.lock'));
  const packages = lock.package.filter(item => item.name === cargo.package.name && !item.source);
  if (packages.length !== 1) throw new Error('Cannot identify the root Cargo.lock package');
  const versions = [pkg.version, tauri.version, cargo.package.version, packages[0].version];
  validVersion(pkg.version);
  if (versions.some(version => version !== pkg.version)) {
    throw new Error(`Release versions differ: ${versions.join(', ')}`);
  }
  return { version: pkg.version, packageName: cargo.package.name };
}

function nodeText(node) {
  return node.value ?? node.children?.map(nodeText).join('') ?? '';
}

export function validateNotes(notes) {
  const tree = markdown.parse(notes);
  if (notes.includes(REVIEW_MARKER) || /\b(TODO|TBD|FIXME)\b/.test(notes)) {
    throw new Error('Release notes still require review');
  }
  const text = tree.children.filter(node => node.type !== 'html').map(nodeText).join('\n').trim();
  if (!text || /^Release v?\d[^\n]*$/.test(text)) throw new Error('Release notes are empty or a placeholder');
  if (!tree.children.some(node => node.type === 'list' && nodeText(node).trim())) {
    throw new Error('Release notes must contain at least one user-facing change');
  }
  if (tree.children.some(node => node.type === 'heading' && node.depth < 3)) {
    throw new Error('Release notes use ### sections; version headings are generated');
  }
  if (notes.includes('github.com/zhengbiwen/ShellSpan')) throw new Error('Release notes reference the old repository');
  return notes.trim();
}

export function changelogSection(changelog, version) {
  const nodes = markdown.parse(changelog).children;
  const headings = nodes.filter(node => node.type === 'heading' && node.depth === 2);
  const matching = headings.filter(node => {
    const text = nodeText(node);
    return text.startsWith(`[v${version}]`) || text === `v${version}` || text.startsWith(`v${version} - `);
  });
  if (matching.length > 1) throw new Error(`Duplicate changelog version: ${version}`);
  const heading = matching[0];
  if (!heading) return null;
  const index = headings.indexOf(heading);
  const end = headings[index + 1]?.position.start.offset ?? changelog.length;
  return { start: heading.position.start.offset, end, notes: changelog.slice(heading.position.end.offset, end).trim() };
}

export function updateChangelog(changelog, meta, notes) {
  validateNotes(notes);
  const entry = `## [v${meta.version}](https://github.com/${REPOSITORY}/releases/tag/v${meta.version}) - ${meta.date}\n\n${notes.trim()}\n\n`;
  const section = changelogSection(changelog, meta.version);
  if (section) return changelog.slice(0, section.start) + entry + changelog.slice(section.end);
  const first = markdown.parse(changelog).children.find(node => node.type === 'heading' && node.depth === 2);
  const offset = first?.position.start.offset ?? changelog.length;
  return changelog.slice(0, offset).trimEnd() + '\n\n' + entry + changelog.slice(offset);
}

export function loadNotes(version, root = process.cwd()) {
  validVersion(version);
  const meta = JSON.parse(readFileSync(path.join(root, `release-notes/${version}.json`), 'utf8'));
  if (meta.version !== version || meta.repository !== REPOSITORY || !/^\d{4}-\d{2}-\d{2}$/.test(meta.date)) {
    throw new Error('Release note metadata does not match this release');
  }
  if (!/^v\d/.test(meta.baseTag) || !semver.valid(meta.baseTag) || semver.prerelease(meta.baseTag)) {
    throw new Error('Release notes must start from a stable release');
  }
  for (const sha of [meta.baseSha, meta.headSha]) {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Release notes must record exact commits');
  }
  const notes = validateNotes(readFileSync(path.join(root, `release-notes/${version}.md`), 'utf8'));
  return { meta, notes };
}

export function checkNotes(version, root = process.cwd()) {
  if (readVersions(root).version !== version) throw new Error('Release notes version differs from the application version');
  const { meta, notes } = loadNotes(version, root);
  const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  if (changelogSection(changelog, version)?.notes !== notes) {
    throw new Error('CHANGELOG.md differs from reviewed notes; run pnpm changelog');
  }
  const base = command('git', ['rev-parse', `${meta.baseTag}^{commit}`], root);
  if (base !== meta.baseSha) throw new Error('The release baseline tag has moved');
  command('git', ['merge-base', '--is-ancestor', meta.baseSha, meta.headSha], root);
  command('git', ['merge-base', '--is-ancestor', meta.headSha, 'HEAD'], root);
  const allowed = new Set([...VERSION_FILES,
    'CHANGELOG.md', `release-notes/${version}.md`, `release-notes/${version}.json`]);
  for (const args of [
    ['diff', '--name-only', '-z', meta.headSha, 'HEAD'],
    ['diff', '--cached', '--name-only', '-z'],
    ['diff', '--name-only', '-z'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ]) {
    const changed = execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    const unexpected = changed.filter(file => !allowed.has(file));
    if (unexpected.length) throw new Error(`Code changed after notes were prepared: ${unexpected.join(', ')}; regenerate and review the release range`);
  }
  const packageName = parseToml(command('git', ['show', `${meta.headSha}:src-tauri/Cargo.toml`], root)).package.name;
  for (const file of VERSION_FILES) {
    const baseline = manifestContent(file, command('git', ['show', `${meta.headSha}:${file}`], root), packageName);
    for (const [location, source] of [
      ['HEAD', command('git', ['show', `HEAD:${file}`], root)],
      ['index', command('git', ['show', `:${file}`], root)],
      ['worktree', readFileSync(path.join(root, file), 'utf8')],
    ]) {
      const candidate = manifestContent(file, source, packageName);
      if (![baseline.version, version].includes(candidate.version) || !isDeepStrictEqual(baseline.content, candidate.content)) {
        throw new Error(`Non-version release changes in ${file} (${location}); regenerate and review the release range`);
      }
    }
  }
  return { meta, notes };
}

function manifestContent(file, source, packageName) {
  const content = file.endsWith('.json') ? JSON.parse(source) : parseToml(source);
  let target = content;
  if (file === 'src-tauri/Cargo.toml') target = content.package;
  if (file === 'src-tauri/Cargo.lock') {
    const packages = content.package.filter(pkg => pkg.name === packageName && !pkg.source);
    if (packages.length !== 1) throw new Error('Cannot identify root package in release baseline');
    target = packages[0];
  }
  const version = target.version;
  delete target.version;
  return { version, content };
}

export function latestStable() {
  const release = JSON.parse(command('gh', ['api', `repos/${REPOSITORY}/releases/latest`]));
  if (release.draft || release.prerelease || !semver.valid(release.tag_name) || semver.prerelease(release.tag_name)
    || !release.assets?.some(asset => asset.name === 'latest.json')) {
    throw new Error('Latest must be a published stable release with an updater manifest');
  }
  return release.tag_name;
}

export function assertBaseline(meta, latestTag) {
  if (meta.baseTag !== latestTag) throw new Error(`Stable release changed from ${meta.baseTag} to ${latestTag}; prepare and review notes again`);
  if (!semver.gt(meta.version, latestTag)) throw new Error('Release version must be newer than the latest stable release');
}

export function assertRemoteTag(tag) {
  const commit = JSON.parse(command('gh', ['api', `repos/${REPOSITORY}/commits/${tag}`]));
  if (commit.sha !== command('git', ['rev-parse', 'HEAD'])) {
    throw new Error('Remote release tag no longer matches the validated commit');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { version } = readVersions();
    if (process.argv[2] === 'sync') {
      const { meta, notes } = loadNotes(version);
      writeFileSync('CHANGELOG.md', updateChangelog(readFileSync('CHANGELOG.md', 'utf8'), meta, notes));
      console.log(`Synced reviewed notes for v${version}; historical entries preserved`);
    } else if (process.argv[2] === 'check') {
      checkNotes(version);
      console.log(`Release notes and versions validated for v${version}`);
    } else {
      throw new Error('Usage: node scripts/release-notes.mjs sync|check');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
