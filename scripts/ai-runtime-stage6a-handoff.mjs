import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Generates delivery artifacts only. Never stages, commits, changes refs, or
// writes outside this checkout. Re-run after any source/document change.
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const output = join(root, 'docs/ai-runtime-stage6a-handoff');
mkdirSync(output, { recursive: true });
const baseline = '4f353d9bbfa2c6ccfe75a1023f4df46ab4fb8412';
const excludes = ['--', '.', ':(exclude)docs/ai-runtime-stage6a-handoff/**'];
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const names = (...args) => git(...args, '-z').split('\0').filter(Boolean);
const describe = (file) => ({ path: file, sha256: existsSync(join(root, file)) ? createHash('sha256').update(readFileSync(join(root, file))).digest('hex') : null });
const trackedStage6a = names('diff', '--name-only', '--no-renames', 'HEAD');
const trackedCumulative = names('diff', '--name-only', '--no-renames', baseline);
const untracked = names('ls-files', '--others', '--exclude-standard').filter(file =>
  !file.startsWith('docs/ai-runtime-stage6a-handoff/') && /^(src\/|src-tauri\/src\/|docs\/|scripts\/)/.test(file)
  && /\.(tsx?|rs|md|mjs|json)$/.test(file) && !/(^|\/)(dist|target|node_modules|credentials)(\/|\.)/.test(file));
const artifacts = [];
for (const [file, base] of [['stage6a-tracked.patch', 'HEAD'], ['cumulative-tracked.patch', baseline]]) {
  const destination = join(output, file);
  git('diff', '--binary', '--no-ext-diff', `--output=${destination}`, base, ...excludes);
  artifacts.push(describe(`docs/ai-runtime-stage6a-handoff/${file}`));
}
const inventory = {
  formatVersion: 1, worktree: resolve(root), head: git('rev-parse', 'HEAD').trim(),
  stage5Base: '3e40eefa49ea6a5c56ce5201dbec298687918d1f',
  restoredWip: '48fd8fda6abc37e05497bd74209c76fe1931bf43', cumulativeBase: baseline,
  note: 'Frozen source bytes; no commit, merge, push or main-checkout mutation. Patches contain tracked files only: copy untracked product files from the worktree and verify every hash. Inventory itself and generated patches are delivery metadata, not product files.',
  excluded: ['node_modules', 'dist', 'target', 'temporary logs/screenshots', 'credentials', 'generated handoff metadata'],
  trackedStage6a: trackedStage6a.map(describe), trackedCumulative: trackedCumulative.map(describe),
  untrackedProductFiles: untracked.map(describe),
  allCumulativeSourceFiles: [...new Set([...trackedCumulative, ...untracked])].sort().map(describe),
  artifacts,
};
writeFileSync(join(output, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
console.log(`Frozen handoff: ${output}; ${inventory.allCumulativeSourceFiles.length} cumulative source files; ${untracked.length} untracked product files.`);
