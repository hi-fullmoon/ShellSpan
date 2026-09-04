import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Generated delivery metadata only. No staging, commits, ref changes or main writes.
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const stageBase = '31ce4343b9a834503c43db1b04b81fe0128e4ea0';
const cumulativeBase = '4f353d9bbfa2c6ccfe75a1023f4df46ab4fb8412';
const head = git('rev-parse', 'HEAD').trim();
if (head !== stageBase) throw new Error(`Unexpected base ${head}`);
const outputRelative = 'docs/ai-runtime-stage6c-handoff';
const output = join(root, outputRelative);
const excluded = file => /^docs\/ai-runtime-stage6[abc]-handoff\//.test(file);
const pathspec = ['--', '.', ...['a', 'b', 'c'].map(stage => `:(exclude)docs/ai-runtime-stage6${stage}-handoff/**`)];
const names = (...args) => git(...args, '-z').split('\0').filter(Boolean).filter(file => !excluded(file)).sort();
const describe = file => ({ path: file, sha256: existsSync(join(root, file)) ? createHash('sha256').update(readFileSync(join(root, file))).digest('hex') : null });
const trackedStage6c = names('diff', '--name-only', '--no-renames', stageBase);
const trackedCumulative = names('diff', '--name-only', '--no-renames', cumulativeBase);
const untrackedProductFiles = names('ls-files', '--others', '--exclude-standard').filter(file =>
  /^(src\/|src-tauri\/src\/|docs\/|scripts\/)/.test(file) && /\.(tsx?|rs|md|mjs|json|py)$/.test(file)
  && !/(^|\/)(dist|target|node_modules|credentials)(\/|\.)/.test(file));
mkdirSync(output, { recursive: true });
const artifacts = [];
for (const [file, base] of [['stage6c-tracked.patch', stageBase], ['cumulative-tracked.patch', cumulativeBase]]) {
  git('diff', '--binary', '--no-ext-diff', '--no-renames', `--output=${join(output, file)}`, base, ...pathspec);
  artifacts.push(describe(`${outputRelative}/${file}`));
}
const predecessorDeliveryMetadata = ['a', 'b'].flatMap(stage => {
  const directory = `docs/ai-runtime-stage6${stage}-handoff`;
  return readdirSync(join(root, directory)).sort().map(file => describe(`${directory}/${file}`));
});
const inventory = {
  formatVersion: 1, worktree: root, head, stageBase, cumulativeBase,
  migration: {
    source6bWorktree: '/Users/zhengbiwen/.codex/worktrees/5d5b/ShellSpan',
    source6bHead: '1ac0c1e4a070bd8024063af5c58e4b2add3b7395',
    source6bInventorySha256: 'c7e3eedeedfbdef44cea1b101976c70b8898372d5083ced055944f6047e33422',
    source6bStagePatchSha256: '189a79cb7780000e8042291913b8777daa082c58581c13b6df73d83212fbf6d3',
    verifiedSourceHashes: 119, copiedUntrackedProducts: 35,
    retainedMain: stageBase,
    note: '12 intentional merges retain main request/start/system-prompt snapshots and cumulative 6A/6B. See Stage 6C implementation report.',
  },
  acceptance: {
    macOSAndIsolatedLinuxGates: 'PASS; exact commands, counts and boundaries in docs/ai-runtime-stage6c-validation.md',
    windowsNative: 'NOT RUN', externalLiveProviders: 'NOT RUN; Stage 7 uses same-project configuration only',
    mainIntegrationStage6dAndStage7: 'PENDING',
  },
  note: 'Frozen cumulative source, no commit/merge/push. Apply ONE tracked patch to its exact base, copy EVERY untrackedProductFile, verify allCumulativeSourceFiles. Historical metadata is preserved separately; patches and inventory exclude themselves.',
  excluded: ['generated handoff metadata', 'node_modules', 'dist', 'target', 'temporary logs/screenshots', 'credentials'],
  trackedStage6c: trackedStage6c.map(describe), trackedCumulative: trackedCumulative.map(describe),
  untrackedProductFiles: untrackedProductFiles.map(describe),
  allCumulativeSourceFiles: [...new Set([...trackedCumulative, ...untrackedProductFiles])].sort().map(describe),
  predecessorDeliveryMetadata, artifacts,
};
writeFileSync(join(output, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
console.log(`Frozen ${inventory.allCumulativeSourceFiles.length} cumulative files; ${untrackedProductFiles.length} untracked products: ${output}`);
