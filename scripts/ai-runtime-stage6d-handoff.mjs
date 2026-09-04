import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

// Generated delivery metadata only. No staging, commits, ref changes or main writes.
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const stageBase = '31ce4343b9a834503c43db1b04b81fe0128e4ea0';
const cumulativeBase = '4f353d9bbfa2c6ccfe75a1023f4df46ab4fb8412';
const head = git('rev-parse', 'HEAD').trim();
if (head !== stageBase) throw new Error(`Unexpected base ${head}`);
const outputRelative = 'docs/ai-runtime-stage6d-handoff';
const output = join(root, outputRelative);
const excluded = file => /^docs\/ai-runtime-stage6[abcd]-handoff\//.test(file);
const pathspec = ['--', '.', ...['a', 'b', 'c', 'd'].map(stage => `:(exclude)docs/ai-runtime-stage6${stage}-handoff/**`)];
const names = (...args) => git(...args, '-z').split('\0').filter(Boolean).filter(file => !excluded(file)).sort();
const describe = file => ({ path: file, sha256: existsSync(join(root, file)) ? createHash('sha256').update(readFileSync(join(root, file))).digest('hex') : null });
const trackedStage6d = names('diff', '--name-only', '--no-renames', stageBase);
const trackedCumulative = names('diff', '--name-only', '--no-renames', cumulativeBase);
const untrackedProductFiles = names('ls-files', '--others', '--exclude-standard').filter(file =>
  /^(src\/|src-tauri\/src\/|docs\/|scripts\/)/.test(file) && /\.(tsx?|rs|md|mjs|json|py)$/.test(file)
  && !/(^|\/)(dist|target|node_modules|credentials)(\/|\.)/.test(file));
mkdirSync(output, { recursive: true });
const artifacts = [];
for (const [file, base] of [['stage6d-tracked.patch', stageBase], ['cumulative-tracked.patch', cumulativeBase]]) {
  git('diff', '--binary', '--no-ext-diff', '--no-renames', `--output=${join(output, file)}`, base, ...pathspec);
  artifacts.push(describe(`${outputRelative}/${file}`));
}
const predecessorDeliveryMetadata = ['a', 'b', 'c'].flatMap(stage => {
  const directory = `docs/ai-runtime-stage6${stage}-handoff`;
  return readdirSync(join(root, directory)).sort().map(file => describe(`${directory}/${file}`));
});
const inventory = {
  formatVersion: 1, worktree: root, head, stageBase, cumulativeBase,
  migration: {
    source6cWorktree: '/Users/zhengbiwen/.codex/worktrees/23d3/ShellSpan',
    source6cHead: stageBase,
    source6cInventorySha256: '2066a1486074e3276ebcf22387ce5f0a6e1267d6261d990ddc0a87deae1ccccf',
    source6cStagePatchSha256: 'b2494e61103bf98a4a8a70bff61db3a6615ea4181b4f5d3bf3e4e47fab65c099',
    verifiedSourceHashes: 143, copiedUntrackedProducts: 52,
    retainedMain: stageBase, exceptions: [],
    note: 'Exact-base application, 143/143 hashes matched before 6D changes. Main input-group user styling, lock/workspace and historical migration metadata preserved.',
  },
  acceptance: {
    macOSAndIsolatedLinuxGates: 'PASS; exact commands, counts and boundaries in docs/ai-runtime-stage6d-validation.md',
    windowsNative: 'NOT RUN', externalLiveProviders: 'NOT RUN; Stage 7 uses same-project configuration only',
    mainIntegrationAndStage7: 'PENDING',
  },
  note: 'Frozen cumulative source, no commit/merge/push. Apply ONE tracked patch to its exact base, copy EVERY untrackedProductFile, verify allCumulativeSourceFiles. Historical metadata is preserved separately; patches and inventory exclude themselves.',
  excluded: ['generated handoff metadata', 'node_modules', 'dist', 'target', 'temporary logs/screenshots', 'credentials'],
  trackedStage6d: trackedStage6d.map(describe), trackedCumulative: trackedCumulative.map(describe),
  untrackedProductFiles: untrackedProductFiles.map(describe),
  allCumulativeSourceFiles: [...new Set([...trackedCumulative, ...untrackedProductFiles])].sort().map(describe),
  predecessorDeliveryMetadata, artifacts,
};
writeFileSync(join(output, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
console.log(`Frozen ${inventory.allCumulativeSourceFiles.length} cumulative files; ${untrackedProductFiles.length} untracked products: ${output}`);

// Verify two exact exported bases; no index or Git ref is created or modified.
const temp = mkdtempSync(join(tmpdir(), 'shellspan-6d-reconstruct-'));
const results = [];
try {
  for (const [base, patch] of [[stageBase, 'stage6d-tracked.patch'], [cumulativeBase, 'cumulative-tracked.patch']]) {
    const destination = join(temp, base.slice(0, 8)); mkdirSync(destination);
    const archive = join(temp, `${base}.tar`);
    git('archive', `--output=${archive}`, base);
    execFileSync('tar', ['-xf', archive, '-C', destination]);
    execFileSync('git', ['apply', '--check', join(output, patch)], { cwd: destination });
    execFileSync('git', ['apply', join(output, patch)], { cwd: destination });
    for (const file of inventory.untrackedProductFiles) {
      const path = join(destination, file.path); mkdirSync(dirname(path), { recursive: true }); copyFileSync(join(root, file.path), path);
    }
    for (const file of inventory.allCumulativeSourceFiles) {
      const path = join(destination, file.path);
      const actual = existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
      if (actual !== file.sha256) throw new Error(`Reconstruction mismatch: ${base} ${file.path}`);
    }
    results.push({ base, patch, verifiedFiles: inventory.allCumulativeSourceFiles.length, copiedUntrackedProducts: inventory.untrackedProductFiles.length, status: 'PASS' });
  }
  const unlisted = names('ls-files', '--others', '--exclude-standard').filter(path => !untrackedProductFiles.includes(path));
  if (unlisted.length) throw new Error(`Unclassified new files: ${unlisted.join(', ')}`);
  for (const file of inventory.predecessorDeliveryMetadata) {
    if (describe(file.path).sha256 !== file.sha256) throw new Error(`Historical metadata changed: ${file.path}`);
  }
  writeFileSync(join(output, 'reconstruction.json'), `${JSON.stringify({ inventorySha256: describe(`${outputRelative}/inventory.json`).sha256, results, metadataHashes: 'PASS', unlistedProducts: [], head, stagedChanges: git('diff', '--cached', '--name-only').trim() }, null, 2)}\n`);
  console.log('Both exact bases reconstructed; every source/new-file hash and historical metadata verified.');
} finally { rmSync(temp, { recursive: true, force: true }); }
