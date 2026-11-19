import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { assertNativeGuiAllowed } from '../integration/gui-lock.mjs';
import { editorValidationEnvironment } from './editor-validation.mjs';
import { requireEditorResources } from './editor-resources.mjs';
import { parseSshRecoveryArgs, readOwnedSshFixture, recoveryScope, sshNativeCases } from './ssh-recovery-cases.mjs';
import { cleanZlePeer, inspectSshPeer, provisionZlePeerPassword, readSshEffect } from './ssh-recovery-fixture.mjs';
import { configureSshHistory, inspectSshHistory } from './ssh-history-fixture.mjs';

const checkout = resolve(import.meta.dirname, '../../..');
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseSshRecoveryArgs(process.argv.slice(2));
  if (options.mode === 'list') console.log(JSON.stringify(options.cases, null, 2));
  else {
    const fixture = readOwnedSshFixture(checkout, options.fixture, options.bash);
    if (options.mode === 'check') console.log(JSON.stringify({ fixture, scope: 'local fixture records only' }, null, 2));
    else await runCase(checkout, options.id, fixture);
  }
}

// A caller can mount temporary storage at a new case's exact evidence path.
// The frozen App and its normal runner still own build, signature and receipts.
export async function runMountedSshRecoveryCase(root, id, fixtureFile, bash = false) {
  root = realpathSync(root);
  assert(root.startsWith(resolve(checkout, 'artifacts/tests/native-input/acceptance/acceptance-source') + '/'));
  assert(Object.hasOwn(sshNativeCases, id) && id !== 'crash-restart');
  const stage = JSON.parse(readFileSync(resolve(root, 'artifacts/tests/native-input/acceptance/candidate-stage.json'), 'utf8'));
  assert(stage.sealed && stage.root === root, 'Mounted evidence requires an owned sealed source root');
  const fixture = readOwnedSshFixture(root, fixtureFile, bash);
  await runCase(root, id, fixture, true);
}

async function runCase(root, id, fixture, mountedEvidence = false) {
  assertNativeGuiAllowed();
  assert(process.platform === 'darwin' && process.arch === 'arm64', 'Actual macOS arm64 App required');
  assert.equal(fixture.sftpEnabled === false, id === 'raw-no-sftp', 'Fixture SFTP configuration must match the selected case');
  const unknownMain = id === 'raw-unapproved-shell';
  assert.equal(fixture.mainVariant === 'unknown', unknownMain, 'Fixture Main digest variant must match the selected case');
  const resources = resolve(root, 'artifacts/tests/native-input/integration/resources/native-input');
  const targets = ['macos-arm64', 'linux-aarch64-glibc-2.36'];
  const bash = fixture.shell === 'bash';
  const audits = targets.map(target => requireEditorResources(root, target));
  const readCatalogue = target => JSON.parse(readFileSync(resolve(resources, `editors-${target}.json`), 'utf8')).profiles[0];
  const bashCatalogue = target => JSON.parse(readFileSync(resolve(resources, `catalogue-${target}.json`), 'utf8')).profiles.find(entry => entry.bashVersion === '5.3');
  const linux = bash ? bashCatalogue(targets[1]) : readCatalogue(targets[1]);
  const local = bash ? bashCatalogue(targets[0]) : readCatalogue(targets[0]);
  assert(bash ? linux?.readlineVersion === '8.3.6' && local?.readlineVersion === '8.3.6'
    : linux.profile.verifiedProfileId === 'zsh-5.9-zle-5.9-linux-aarch64-glibc-2.36-native' && linux.core && local.shell);
  const validation = await editorValidationEnvironment(root, resources, targets);
  const peer = inspectSshPeer(fixture);
  assert(peer.platform === 'aarch64' && peer.libc === 'glibc 2.36', 'Actual SSH platform differs');
  assert.equal(peer.mainSha256 === linux.shellSha256, !unknownMain, 'Actual SSH shell digest does not match the selected fixture variant');

  // A fixture is consumed by one case only, including a failed attempt.
  const directory = resolve(root, 'artifacts/tests/native-input/integration/ssh-recovery', fixture.id);
  if (mountedEvidence) {
    assert.equal(realpathSync(directory), directory, 'Case mount path must not be redirected');
    const info = statSync(directory);
    // macOS creates this event-journal directory even on a freshly formatted volume.
    const hasCaseFiles = readdirSync(directory).some(name => name !== '.fseventsd');
    assert(info.isDirectory() && info.dev !== statSync(dirname(directory)).dev && !hasCaseFiles,
      'Expected an empty dedicated volume at the exact case evidence path');
  } else {
    mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
    mkdirSync(directory, { mode: 0o700 });
  }
  const home = resolve(directory, 'home'), data = resolve(directory, 'data');
  for (const path of [home, data]) mkdirSync(path, { mode: 0o700 });
  const save = (name, value) => writeFileSync(resolve(directory, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const reference = `native-p2-secret-${randomUUID()}`;
  const shell = resolve(resources, bash ? `${local.id}/bash` : local.shell);
  // The native credential API resolves the login keychain using process HOME.
  // Test shells and app data have independent directories below this run.
  const environment = { ...process.env, ...validation, SHELL: shell, LC_ALL: 'en_US.UTF-8',
    SHELLSPAN_DATA_DIR: data, SHELLSPAN_LOCAL_HOME: home, SHELLSPAN_LOCAL_SHELL: shell,
    SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR: directory, SHELLSPAN_P2_CREDENTIAL_REFERENCE: reference,
    SHELLSPAN_DEV_SIGNING_KEYCHAIN: resolve(process.env.HOME, 'Library/Keychains/login.keychain-db'),
  };
  const manualModes = {
    SHELLSPAN_ACCEPTANCE_MANUAL_SSH_FOCUS: ['display-geometry'],
    SHELLSPAN_ACCEPTANCE_MANUAL_SSH_TAKEOVER: ['before-key-takeover', 'running-takeover'],
  };
  const manualEnvironment = {};
  for (const [key, cases] of Object.entries(manualModes)) {
    if (process.env[key] !== undefined) {
      const mode = process.env[key];
      assert(cases.includes(id) && (mode === '1' || key === 'SHELLSPAN_ACCEPTANCE_MANUAL_SSH_TAKEOVER' && mode === 'system-input'));
      manualEnvironment[key] = mode;
    }
    delete environment[key];
  }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('SHELLSPAN_ACCEPTANCE_SUBMISSION') || ['SHELLSPAN_ACCEPTANCE_CONTROL_TRACE', 'SHELLSPAN_ACCEPTANCE_REPEAT_COMMIT', 'SHELLSPAN_ACCEPTANCE_RAW_PTY', 'SHELLSPAN_ACCEPTANCE_SSH_RECOVERY'].includes(key)) delete environment[key];
  }
  const base = ['--no-model', '--data-scope', recoveryScope];
  const initialization = [...base, '--data-initialize', '--native-input-p2-credential'];
  async function run(name, args, input, expectedCode = 0, options = environment) {
    const command = ['scripts/verification/agent/verify-ai-session-stream.mjs', ...args];
    save(`${name}-command`, [process.execPath, ...command]);
    const fd = openSync(resolve(directory, `${name}.log`), 'wx', 0o600);
    try {
      const child = spawn(process.execPath, command, { cwd: root, env: options, stdio: ['pipe', fd, fd] });
      child.stdin.on('error', () => {}); // Child exit remains the authoritative failure.
      child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
      const outcome = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      save(`${name}-exit`, outcome);
      assert.equal(outcome.code, expectedCode, `${name} unexpected exit; see ${directory}`);
    } finally { closeSync(fd); }
  }
  save('inputs', { id, fixture, peer, audits, linux, reference, modelCalls: 0 });
  console.log(directory);
  const failures = [];
  let provisioningAttempted = false;
  let applicationEvidence;
  let applicationEnvironment = environment;
  const crash = id === 'crash-before-key' || id === 'crash-after-key';
  const history = id.startsWith('history-') ? id.slice('history-'.length) : undefined;
  const jobHistory = ['positive-jobs', 'positive-job-completion'].includes(id);
  const appArgs = scenario => [...base, ...(bash ? ['--native-input-p2'] : ['--native-input-p3', 'zsh']),
    '--native-input-p3-ssh-recovery', scenario, '--native-input-p3-ssh-recovery-fixture', fixture.file];
  const read = name => JSON.parse(readFileSync(resolve(directory, `${name}.json`), 'utf8'));
  try {
    assert.equal(readSshEffect(fixture).text, null, 'Fixture already has a submission effect');
    if (id === 'raw-resource-mismatch') {
      const name = `${bash ? 'catalogue' : 'editors'}-${targets[1]}.json`;
      const original = resolve(resources, name);
      const bytes = readFileSync(original);
      const catalogue = JSON.parse(bytes);
      const profile = catalogue.profiles.find(profile => profile.shellSha256 === peer.mainSha256);
      assert(profile && profile.moduleSha256 !== profile.shellSha256);
      const negative = resolve(directory, 'manifest-negative-resources');
      const sha = bytes => createHash('sha256').update(bytes).digest('hex');
      const copies = [[profile.module, profile.moduleSha256], [profile.relay, profile.relaySha256]];
      if (profile.core) copies.push([profile.core, profile.editorSha256]);
      for (const [file, expected] of copies) {
        const destination = resolve(negative, file);
        assert(destination.startsWith(`${negative}/`));
        const source = resolve(resources, file);
        assert.equal(sha(readFileSync(source)), expected);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        copyFileSync(source, destination);
        assert.equal(sha(readFileSync(destination)), expected);
      }
      profile.moduleSha256 = profile.shellSha256;
      const changed = resolve(negative, name);
      writeFileSync(changed, JSON.stringify(catalogue, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      assert.equal(sha(readFileSync(original)), sha(bytes));
      save('manifest-mismatch-input', { original, originalSha256: sha(bytes), changed,
        changedSha256: sha(readFileSync(changed)), declaredModuleSha256: profile.moduleSha256, copies });
      applicationEnvironment = { ...environment, ...await editorValidationEnvironment(root, negative, targets) };
    }
    if (history || jobHistory) configureSshHistory(fixture, directory, history ?? 'default');
    const password = randomBytes(36).toString('base64url');
    provisionZlePeerPassword(fixture, password);
    provisioningAttempted = true;
    await run('initialize', [...initialization, 'provision'], { reference, password });
    await run('application', appArgs(id), undefined, crash ? 1 : 0, { ...applicationEnvironment, ...manualEnvironment });
    if (crash) {
      const signal = read('ssh-crash-signal'), original = read('native-webview-evidence');
      assert(signal.syscallAccepted && signal.signal === 'SIGKILL' && signal.pid === original.records.cut.pid);
      const end = read(signal.imageRecord.replace('-process.json', '-end'));
      assert(end.verified && end.exitCode === 143, 'Signed App runner did not observe the deliberate abnormal exit');
      const trace = readFileSync(signal.cut.trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const keys = trace.filter(entry => entry.event === 'accept-key-write-returned');
      const effects = readSshEffect(fixture);
      assert.equal(keys.length, Number(id === 'crash-after-key'));
      assert.deepEqual(effects, original.records.observedEffect);
      save('ssh-crash-prior', { cut: signal.cut, signal, signedExit: end, original, effect: effects, keys });
      await run('application-restart', appArgs('crash-restart'));
    }
    applicationEvidence = read(crash ? 'native-webview-restart-evidence' : 'native-webview-evidence');
    if (history) {
      const audit = inspectSshHistory(fixture, history);
      save('history-verification', audit);
      if (!audit.absent) {
        assert(audit.history.includes(applicationEvidence.records.prepared.source), 'Actual native source missing from the configured history file');
        assert(!audit.history.includes('__shellspan') && !audit.history.includes('SKIP_HISTORY_MARK'), 'Private or ignored input was written to history');
        if (history === 'custom') assert.equal(audit.history.split('\n').filter(line => line.includes('SSH_HIST_ DUP')).length, 1);
      }
    }
    if (jobHistory) {
      const audit = inspectSshHistory(fixture, 'default');
      save('job-history-verification', audit);
      const { launchEntry } = applicationEvidence.records.jobHistory;
      const persisted = fixture.shell === 'bash' ? launchEntry : launchEntry.replaceAll('\n', '\\\n');
      const entries = audit.history.split('\n').filter(line => line && !/^#\d+$/.test(line)).join('\n');
      assert.equal(entries, `${persisted}\nexit`, 'Actual disk history retained private job management or duplicated/changed the launch entry');
    }
  } catch (error) { failures.push(error); }
  if (history && !applicationEvidence && existsSync(resolve(directory, 'native-webview-evidence.json'))) try {
    save('history-disk-after-failure', inspectSshHistory(fixture, history));
  } catch (error) { save('history-disk-observation-failure', { error: String(error) }); }
  try {
    const file = resolve(data, 'terminal-submissions/intentions.sqlite');
    let rows = [];
    const exists = existsSync(file);
    if (exists) {
      const database = new DatabaseSync(file, { readOnly: true });
      try { rows = database.prepare('SELECT call_key,agent_session_id,record_json,settled FROM submissions ORDER BY call_key').all(); }
      finally { database.close(); }
    }
    save('ledger-after-app', { exists, rows });
    if (applicationEvidence) {
      if (['reconnect-tail', 'display-geometry', 'ordinary-input', 'raw-no-sftp', 'raw-unapproved-shell', 'raw-resource-mismatch'].includes(id)
        || /^input-(in-progress|complete)-(cancel|stop|takeover)$/.test(id)) assert.equal(rows.length, 0, 'An operation without durable intent created a ledger row');
      else if (['positive-jobs', 'positive-job-completion', 'positive-file-chain'].includes(id)) {
        const intents = applicationEvidence.trace.filter(event => event.event === 'intent-record-returned');
        assert(rows.length > 0 && rows.length === intents.length, 'Actual native tool intents missing or duplicated');
        for (const row of rows) {
          const record = JSON.parse(row.record_json);
          assert.equal(row.agent_session_id, applicationEvidence.records.id);
          assert.equal(row.settled, 1);
          assert.equal(record.noAutoReplay, true);
          assert(intents.some(event => isDeepStrictEqual(event.details.identity, record.identity)));
        }
      }
      else {
        const { records } = applicationEvidence;
        assert.equal(rows.length, 1, 'Exact durable submission row missing or duplicated');
        assert.equal(rows[0].agent_session_id, records.id);
        const settled = id.endsWith('-timeout') || /^(before-key|running|intent|armed|after-accept)-(cancel|stop|takeover)$/.test(id)
          || id.startsWith('positive-') || ['runtime-multi-agent', 'delegation'].includes(id) || Boolean(history);
        if (id === 'close-running-terminal') assert.equal(rows[0].settled, Number(records.recovery.length === 0));
        else assert.equal(rows[0].settled, Number(settled));
        assert.deepEqual(JSON.parse(rows[0].record_json), { version: 1, identity: records.cut?.identity ?? records.identity, noAutoReplay: true });
      }
    }
  } catch (error) { failures.push(error); }
  try {
    const effect = readSshEffect(fixture);
    save('effect-after-app', effect);
    if (applicationEvidence) assert.deepEqual(effect, applicationEvidence.records.finalEffect ?? { text: null, sha256: null }, 'Remote effect changed after App observation');
  } catch (error) { failures.push(error); }
  let credentialDeleted = false, stopped = false;
  if (provisioningAttempted) try {
    await run('credential-cleanup', [...initialization, 'cleanup'], { reference });
    credentialDeleted = true;
  } catch (error) { failures.push(error); }
  try { cleanZlePeer(fixture); stopped = true; } catch (error) { failures.push(error); }
  save('result', { id, credentialDeleted, stopped, retained: true, errors: failures.map(String), exitCode: failures.length ? 1 : 0 });
  if (failures.length) throw new AggregateError(failures, `${fixture.shell} SSH recovery ${id} failed; evidence retained in ${directory}`);
}
