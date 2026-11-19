import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { captureValidationSources } from './integration/frozen-validation.mjs';

const [lane, ...extra] = process.argv.slice(2);
assert(extra.length === 0 && ['integration', 'acceptance'].includes(lane),
  'Usage: node scripts/native-input/freeze.mjs <integration|acceptance>');
const root = resolve(import.meta.dirname, '../..');
const integration = lane === 'integration';
const directory = integration
  ? resolve(root, 'artifacts/tests/native-input-p2/baseline', new Date().toISOString().replaceAll(':', '-'))
  : resolve(root, 'artifacts/tests/native-input-p3/source-revisions', randomUUID());
mkdirSync(directory, { recursive: true, mode: 0o700 });

const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 128 * 1024 * 1024 });
const sources = captureValidationSources(root);
for (const [name, args] of [
  ['status.txt', ['status', '--short']],
  ['head.txt', ['rev-parse', 'HEAD']],
  ['index.txt', ['ls-files', '--stage']],
  ['worktree.patch', ['diff', '--binary', 'HEAD']],
  ['HEAD.tar.gz', ['archive', '--format=tar.gz', 'HEAD']],
  ['untracked.list', ['ls-files', '--others', '--exclude-standard', '-z']],
]) {
  writeFileSync(resolve(directory, name), git(args));
}
execFileSync('tar', ['--null', '-czf', resolve(directory, 'untracked.tgz'), '-T', resolve(directory, 'untracked.list')], { cwd: root });
assert.deepEqual(captureValidationSources(root), sources, 'Source changed during the native input freeze');
writeFileSync(resolve(directory, 'sources.json'), JSON.stringify(sources, null, 2) + '\n');

if (integration) {
  const environment = {};
  for (const [name, args] of [
    ['uname', ['-a']], ['node', ['--version']], ['pnpm', ['--version']], ['rustc', ['--version']],
    ['cargo', ['--version']], ['clang', ['--version']], ['docker', ['version', '--format', '{{json .}}']],
  ]) {
    try {
      environment[name] = execFileSync(name, args,
        { cwd: root, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (error) {
      environment[name] = { status: error.status, error: String(error.stderr ?? error.message) };
    }
  }
  writeFileSync(resolve(directory, 'environment.json'), JSON.stringify(environment, null, 2) + '\n');
} else {
  const archives = Object.fromEntries(['HEAD.tar.gz', 'worktree.patch', 'untracked.tgz'].map(name =>
    [name, createHash('sha256').update(readFileSync(resolve(directory, name))).digest('hex')]));
  writeFileSync(resolve(directory, 'freeze.json'), JSON.stringify({
    createdAt: new Date().toISOString(), root, directory, sourceCount: Object.keys(sources).length, archives,
  }, null, 2) + '\n');
}

console.log(directory);
