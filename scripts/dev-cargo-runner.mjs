#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm,writeFile } from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import { dirname, join, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import {verifyFrozenValidation,writeFrozenCheckpoint} from './native-input-p2/frozen-validation.mjs';

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
  const frozenManifest=process.env.SHELLSPAN_ACCEPTANCE_FROZEN_MANIFEST;
  const evidenceDirectory=process.env.SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR;
  const recordId=JSON.parse(process.env.TAURI_CONFIG??'{}').identifier==='com.shellspan.validation.native-input-p3'?`${process.pid}-${randomUUID()}`:String(process.pid);
  const checkFrozen=stage=>{
    if(!frozenManifest)return undefined;
    const check=verifyFrozenValidation(frozenManifest,stage);
    assert(evidenceDirectory&&isAbsolute(evidenceDirectory));
    writeFrozenCheckpoint(join(evidenceDirectory,`frozen-runner-${recordId}-${stage}.json`),check);
    return check;
  };
  checkFrozen('before-native-build');
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
  checkFrozen('after-native-build');
  assert(executable, 'Cargo did not report a development executable');
  if (interrupted) return interrupted === 'SIGINT' ? 130 : 143;
  const config = { ...JSON.parse(await readFile(new URL('../src-tauri/tauri.dev.conf.json', import.meta.url), 'utf8')),
    ...(process.env.TAURI_CONFIG ? JSON.parse(process.env.TAURI_CONFIG) : {}) };
  const identity = process.env.SHELLSPAN_DEV_SIGNING_IDENTITY || 'Apple Development';
  const keychain = process.env.SHELLSPAN_DEV_SIGNING_KEYCHAIN;
  assert(!keychain || isAbsolute(keychain), 'Development signing keychain must be an absolute path');
  const keychainArguments = keychain ? ['--keychain', keychain] : [];
  const signed = await launch('/usr/bin/codesign', ['--force', '--sign', identity,
    ...keychainArguments, '--identifier', config.identifier, '--timestamp=none', executable]).done;
  if (signed !== 0) return signed;
  // Cargo releases its artifact lock before running. Other builds can replace
  // target/debug/ShellSpan while it is alive, invalidating Keychain checks.
  // Give each normal development process its own signed application image.
  const isolatedP3=frozenManifest&&JSON.parse(await readFile(frozenManifest,'utf8')).root.includes('.artifacts/tests/native-input-p3/acceptance-source/');
  const image = await mkdtemp(join(isolatedP3?evidenceDirectory:dirname(executable), '.shellspan-dev-'));
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
      ...keychainArguments, '--identifier', config.identifier, '--timestamp=none', bundle]).done;
    if (bundleSigned !== 0) return bundleSigned;
    const verified = await launch('/usr/bin/codesign', ['--verify', '--strict', '--test-requirement',
      '=anchor apple generic and certificate leaf[subject.OU] exists', bundle]).done;
    if (verified !== 0) return verified;
    const metadata = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', bundle], { encoding: 'utf8' });
    assert.equal(metadata.status, 0, 'Could not inspect the signed development application');
    const signing = metadata.stderr.split('\n').filter(line => /^(CDHash|TeamIdentifier)=/.test(line));
    assert.equal(signing.length, 2, 'Signed application identity is incomplete');
    const binarySha256=process.env.SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR?createHash('sha256').update(await readFile(binary)).digest('hex'):undefined;
    const frozenStart=checkFrozen('before-native-launch');
    if(process.env.SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR){
      const evidence=process.env.SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR;
      assert(isAbsolute(evidence)&&join(evidence,'data')===process.env.SHELLSPAN_DATA_DIR,'Acceptance image record requires the owned isolated data directory');
      await writeFile(join(evidence,`native-image-${recordId}.json`),JSON.stringify({capturedAt:new Date().toISOString(),identifier:config.identifier,binarySha256,signing,
        ...(frozenManifest?{frozenManifest,frozenInputs:frozenStart,tauriConfigSha256:createHash('sha256').update(process.env.TAURI_CONFIG??'').digest('hex')}:{})},null,2),{flag:'wx',mode:0o600});
    }
    console.log(`Development signing verified: ${signing.join(' ')}`);
    if (interrupted) return interrupted === 'SIGINT' ? 130 : 143;
    const application=launch(binary,appArgs);
    if(frozenManifest)writeFrozenCheckpoint(join(evidenceDirectory,`native-image-${recordId}-process.json`),{frozenManifest,runnerPid:process.pid,appPid:application.child.pid,executable:binary});
    const exitCode=await application.done;
    if(frozenManifest){
      let verified=false;let failure;
      try{checkFrozen('after-native-exit');assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'),binarySha256,'Actual signed native image drifted during execution');verified=true;}
      catch(error){failure=String(error);}
      writeFrozenCheckpoint(join(evidenceDirectory,`native-image-${recordId}-end.json`),{frozenManifest,binarySha256,exitCode,verified,failure});
      assert(verified,failure??'Frozen native end verification failed');
    }
    return exitCode;
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
