import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const destination = resolve(root, '.artifacts/tests/native-input-p2/baseline', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(destination, { recursive: true, mode: 0o700 });
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 128 * 1024 * 1024 });
writeFileSync(resolve(destination, 'status.txt'), git('status', '--short'));
writeFileSync(resolve(destination, 'head.txt'), git('rev-parse', 'HEAD'));
writeFileSync(resolve(destination, 'index.txt'), git('ls-files', '--stage'));
writeFileSync(resolve(destination, 'worktree.patch'), git('diff', '--binary', 'HEAD'));
writeFileSync(resolve(destination, 'HEAD.tar.gz'), git('archive', '--format=tar.gz', 'HEAD'));
const untracked = git('ls-files', '--others', '--exclude-standard', '-z');
writeFileSync(resolve(destination, 'untracked.list'), untracked);
execFileSync('tar', ['--null', '-czf', resolve(destination, 'untracked.tgz'), '-T', resolve(destination, 'untracked.list')], { cwd: root });
const paths = [...new Set(Buffer.concat([git('ls-files', '-z'), untracked]).toString().split('\0').filter(Boolean))];
const hashes = {};
for (const path of paths) {
  try {
    if (!statSync(resolve(root, path)).isFile()) continue;
    hashes[path] = createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
writeFileSync(resolve(destination, 'sources.json'), JSON.stringify(hashes, null, 2) + '\n');
const environment = {};
for (const [name, args] of [['uname', ['-a']], ['node', ['--version']], ['pnpm', ['--version']], ['rustc', ['--version']], ['cargo', ['--version']], ['clang', ['--version']], ['docker', ['version', '--format', '{{json .}}']]]) {
  try { environment[name] = execFileSync(name, args, { cwd: root, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) { environment[name] = { status: error.status, error: String(error.stderr ?? error.message) }; }
}
writeFileSync(resolve(destination, 'environment.json'), JSON.stringify(environment, null, 2) + '\n');
console.log(destination);
