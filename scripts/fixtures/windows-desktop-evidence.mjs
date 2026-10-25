import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [mode, evidenceDirectory] = process.argv.slice(2);
assert(['before', 'initialized', 'after'].includes(mode), 'Unknown evidence phase');
assert(evidenceDirectory && path.isAbsolute(evidenceDirectory), 'Absolute owned evidence directory required');
const root = process.cwd();
const relativeEvidence = path.relative(root, evidenceDirectory);
assert(relativeEvidence && !relativeEvidence.startsWith('..') && !path.isAbsolute(relativeEvidence), 'Evidence must belong to workspace');
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const sources = {};
function visit(relative) {
  for (const entry of readdirSync(relative, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = `${relative}/${entry.name}`;
    assert(!entry.isSymbolicLink(), `Cannot freeze a symlink: ${file}`);
    if (entry.isDirectory()) visit(file);
    else if (entry.isFile()) sources[file] = digest(file);
  }
}
const directories = ['src', 'src-tauri/src', 'src-tauri/examples', 'src-tauri/capabilities', 'src-tauri/vendor/portable-pty', 'scripts', 'protocol', '.github', 'docs', 'release-notes'];
const files = ['package.json', 'pnpm-lock.yaml', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.dev.conf.json', 'vite.config.ts', 'vitest.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'rust-toolchain.toml', 'README.md', 'CHANGELOG.md', 'cliff.toml', 'components.json'];
for (const directory of directories) visit(directory);
for (const file of files) sources[file] = digest(file);
const archive = path.join(evidenceDirectory, 'source-before.tar.gz');
if (mode === 'before') {
  assert(!existsSync(archive), 'Refusing an existing source archive');
  execFileSync('tar.exe', ['-czf', archive, '-C', root, ...directories, ...files], { stdio: 'pipe', timeout: 60000 });
}
const executable = path.join(root, 'src-tauri/target/debug/ShellSpan.exe');
const document = {
  phase: mode,
  observedAt: new Date().toISOString(),
  source: sources,
  sourceArchive: { path: archive, sha256: digest(archive) },
  executable: existsSync(executable) ? { path: executable, sha256: digest(executable) } : null,
  references: Object.fromEntries(['native_editor_layout', 'native_powershell_output_baseline'].map(name => {
    const file = path.join(root, `src-tauri/target/debug/examples/${name}.exe`);
    return [name, existsSync(file) ? { path: file, sha256: digest(file) } : null];
  })),
};
// Preserve the observed hashes even if a later invariant fails. A failed
// assertion is not permission to lose the actual end-of-run observations.
const output = path.join(evidenceDirectory, `source-${mode}.json`);
writeFileSync(output, JSON.stringify(document, null, 2), { flag: 'wx' });
if (mode !== 'before') {
  const before = JSON.parse(readFileSync(path.join(evidenceDirectory, 'source-before.json'), 'utf8'));
  assert.deepEqual(sources, before.source, 'Source inputs changed during desktop verification');
  assert.deepEqual(document.sourceArchive, before.sourceArchive, 'Frozen source archive changed during verification');
  assert(document.executable, 'Actual desktop executable is missing');
  assert.deepEqual(document.references, before.references, 'Native comparison executables changed during desktop verification');
}
