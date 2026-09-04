import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Delivery artifacts only: no staging, commits, ref changes, or main-checkout writes.
// Re-run after any source/document edit. Copy every untracked product separately.
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (...args) => execFileSync('git', args, {
  cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});
const head = git('rev-parse', 'HEAD').trim();
const stageBase = '1ac0c1e4a070bd8024063af5c58e4b2add3b7395';
const cumulativeBase = '4f353d9bbfa2c6ccfe75a1023f4df46ab4fb8412';
if (head !== stageBase) throw new Error(`Stage 6B base changed: expected ${stageBase}, got ${head}`);
const outputRelative = 'docs/ai-runtime-stage6b-handoff';
const output = join(root, outputRelative);
const previousRelative = 'docs/ai-runtime-stage6a-handoff';
const excludedMetadata = file => /^docs\/ai-runtime-stage6[ab]-handoff\//.test(file);
const pathspec = ['--', '.', ':(exclude)docs/ai-runtime-stage6a-handoff/**',
  ':(exclude)docs/ai-runtime-stage6b-handoff/**'];
const names = (...args) => git(...args, '-z').split('\0').filter(Boolean).sort();
const describe = file => ({
  path: file,
  sha256: existsSync(join(root, file))
    ? createHash('sha256').update(readFileSync(join(root, file))).digest('hex') : null,
});
const trackedStage6b = names('diff', '--name-only', '--no-renames', stageBase).filter(file => !excludedMetadata(file));
const trackedCumulative = names('diff', '--name-only', '--no-renames', cumulativeBase).filter(file => !excludedMetadata(file));
const untrackedProductFiles = names('ls-files', '--others', '--exclude-standard').filter(file =>
  !excludedMetadata(file) && /^(src\/|src-tauri\/src\/|docs\/|scripts\/)/.test(file)
  && /\.(tsx?|rs|md|mjs|json|py)$/.test(file)
  && !/(^|\/)(dist|target|node_modules|credentials)(\/|\.)/.test(file));
const predecessorDeliveryMetadata = readdirSync(join(root, previousRelative)).sort()
  .map(file => describe(`${previousRelative}/${file}`));
mkdirSync(output, { recursive: true });
const artifacts = [];
for (const [file, base] of [['stage6b-tracked.patch', stageBase], ['cumulative-tracked.patch', cumulativeBase]]) {
  git('diff', '--binary', '--no-ext-diff', '--no-renames', `--output=${join(output, file)}`, base, ...pathspec);
  artifacts.push(describe(`${outputRelative}/${file}`));
}
const inventory = {
  formatVersion: 1,
  worktree: resolve(root), head, stageBase, cumulativeBase,
  migration: {
    source6aWorktree: '/Users/zhengbiwen/.codex/worktrees/ad7b/ShellSpan',
    source6aHead: '25af899f9cde2c5da039e3f76c652b173334e6ea',
    source6aTrackedPatchSha256: '6ddb4b860e46b602309a18bf87141127fe6214473f41b86e06f66ff9c601e7f8',
    verifiedCumulativeSourceFilesBeforeEdits: 89,
    copiedUntrackedProductFilesBeforeEdits: 13,
    retainedMainCommit: stageBase,
    note: 'The independent conversation-projection change from main is retained. Its merged file intentionally differs from the frozen 6A source.',
  },
  note: 'Frozen cumulative source bytes, without commit, merge, push or main-checkout mutation. Apply one tracked patch to its exact base, copy all untrackedProductFiles from this worktree, then verify allCumulativeSourceFiles. Preserve predecessorDeliveryMetadata as historical evidence. Generated 6B patches and this inventory are delivery metadata, excluded from source/self-hashes.',
  acceptance: {
    macOSAndIsolatedLinuxGates: 'PASS; see docs/ai-runtime-stage6b-validation.md for exact evidence and ignored cases',
    windowsNativeCompilationAndJunctionExecution: 'NOT RUN',
    externalLiveProviders: 'NOT RUN; reserved for Stage 7 using same-project configuration',
    mainIntegrationAndStage6c6d7: 'PENDING',
  },
  excluded: ['node_modules', 'dist', 'target', 'temporary logs/screenshots', 'credentials', 'generated handoff metadata'],
  trackedStage6b: trackedStage6b.map(describe),
  trackedCumulative: trackedCumulative.map(describe),
  untrackedProductFiles: untrackedProductFiles.map(describe),
  allCumulativeSourceFiles: [...new Set([...trackedCumulative, ...untrackedProductFiles])].sort().map(describe),
  predecessorDeliveryMetadata,
  artifacts,
};
writeFileSync(join(output, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
console.log(`Frozen handoff: ${output}; ${inventory.allCumulativeSourceFiles.length} cumulative source files; ${untrackedProductFiles.length} untracked product files.`);
