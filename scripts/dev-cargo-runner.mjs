#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

// Tauri invokes its runner with Cargo arguments, from the Rust project folder.
// Sign after every successful development build, before executing the binary.
const args = process.argv.slice(2);
const cargo = process.env.CARGO || 'cargo';
let currentChild;
let interrupted;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = signal;
  currentChild?.kill(signal);
});

function launch(command, arguments_, stdio = 'inherit') {
  currentChild = spawn(command, arguments_, { stdio });
  const child = currentChild;
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)));
  });
  return { child, done };
}

async function main() {
  if (process.platform !== 'darwin' || args[0] !== 'run') {
    return launch(cargo, args).done;
  }
  const separator = args.indexOf('--');
  const buildArgs = args.slice(1, separator < 0 ? undefined : separator);
  const appArgs = separator < 0 ? [] : args.slice(separator + 1);
  const { child, done } = launch(cargo, ['build', ...buildArgs, '--message-format=json-render-diagnostics'], ['ignore', 'pipe', 'inherit']);
  let executable;
  const [code] = await Promise.all([done, (async () => {
    for await (const line of createInterface({ input: child.stdout })) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.reason === 'compiler-message' && event.message.rendered) {
        process.stderr.write(event.message.rendered);
      }
      if (event.reason === 'compiler-artifact' && event.executable && event.target.kind.includes('bin')) {
        assert(!executable || executable === event.executable, 'Select one development binary with --bin');
        executable = event.executable;
      }
    }
  })()]);
  if (code !== 0) return code;
  assert(executable, 'Cargo did not report a development executable');
  if (interrupted) return interrupted === 'SIGINT' ? 130 : 143;
  const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.dev.conf.json', import.meta.url), 'utf8'));
  const identity = process.env.SHELLSPAN_DEV_SIGNING_IDENTITY || 'Apple Development';
  const signed = await launch('/usr/bin/codesign', ['--force', '--sign', identity,
    '--identifier', config.identifier, '--timestamp=none', executable]).done;
  if (signed !== 0) return signed;
  // Cargo releases its artifact lock before running. Other builds can replace
  // target/debug/ShellSpan while it is alive, invalidating Keychain checks.
  // Give each normal development process its own signed application image.
  const image = await mkdtemp(join(dirname(executable), '.shellspan-dev-'));
  try {
    const bundle = join(image, 'ShellSpan Dev.app');
    const contents = join(bundle, 'Contents');
    const binary = join(contents, 'MacOS', 'ShellSpan');
    await mkdir(dirname(binary), { recursive: true });
    await copyFile(executable, binary);
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const plist = launch('/usr/bin/plutil', ['-convert', 'xml1', '-o', join(contents, 'Info.plist'), '-'], ['pipe', 'inherit', 'inherit']);
    plist.child.stdin.end(JSON.stringify({
      CFBundleExecutable: 'ShellSpan', CFBundleIdentifier: config.identifier,
      CFBundleName: 'ShellSpan Dev', CFBundleDisplayName: 'ShellSpan Dev',
      CFBundlePackageType: 'APPL', CFBundleShortVersionString: version, CFBundleVersion: version,
      NSHighResolutionCapable: true, LSMinimumSystemVersion: '10.15',
    }));
    const plistCode = await plist.done;
    if (plistCode !== 0) return plistCode;
    const bundleSigned = await launch('/usr/bin/codesign', ['--force', '--sign', identity,
      '--identifier', config.identifier, '--timestamp=none', bundle]).done;
    if (bundleSigned !== 0) return bundleSigned;
    const verified = await launch('/usr/bin/codesign', ['--verify', '--strict', '--test-requirement',
      '=anchor apple generic and certificate leaf[subject.OU] exists', bundle]).done;
    if (verified !== 0) return verified;
    const metadata = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', bundle], { encoding: 'utf8' });
    assert.equal(metadata.status, 0, 'Could not inspect the signed development application');
    const signing = metadata.stderr.split('\n').filter(line => /^(CDHash|TeamIdentifier)=/.test(line));
    assert.equal(signing.length, 2, 'Signed application identity is incomplete');
    console.log(`Development signing verified: ${signing.join(' ')}`);
    if (interrupted) return interrupted === 'SIGINT' ? 130 : 143;
    return await launch(binary, appArgs).done;
  } finally {
    await rm(image, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  currentChild?.kill('SIGTERM');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
