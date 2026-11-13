import assert from 'node:assert/strict';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export const recoveryScope = 'com.shellspan.validation.native-input-p3';
const controlledCuts = Object.fromEntries(
  ['input-in-progress', 'input-complete', 'intent', 'armed', 'after-accept'].flatMap(cut =>
    ['stop', 'cancel', 'takeover'].map(action => [`${cut}-${action}`, Object.freeze({ cut, disconnect: false })])),
);
export const sshRecoveryCases = Object.freeze({
  'before-key-disconnect': Object.freeze({ cut: 'before-accept', disconnect: true }),
  'before-key-timeout': Object.freeze({ cut: 'before-accept', disconnect: false }),
  'before-key-cancel': Object.freeze({ cut: 'before-accept', disconnect: false }),
  'before-key-stop': Object.freeze({ cut: 'before-accept', disconnect: false }),
  'before-key-takeover': Object.freeze({ cut: 'before-accept', disconnect: false }),
  'running-stop': Object.freeze({ cut: null, disconnect: false }),
  'running-cancel': Object.freeze({ cut: null, disconnect: false }),
  'running-takeover': Object.freeze({ cut: null, disconnect: false }),
  'runtime-multi-agent': Object.freeze({ cut: null, disconnect: false }),
  'close-running-terminal': Object.freeze({ cut: null, disconnect: false }),
  'delegation': Object.freeze({ cut: null, disconnect: false }),
  'after-key-disconnect': Object.freeze({ cut: 'key', disconnect: true }),
  'after-key-timeout': Object.freeze({ cut: 'accept-receipt', disconnect: false }),
  'reconnect-tail': Object.freeze({ cut: null, disconnect: false }),
});
export const sshPositiveCases = Object.freeze({
  'positive-byte-boundary': Object.freeze({ cut: null, disconnect: false }),
  'positive-source-boundaries': Object.freeze({ cut: null, disconnect: false }),
  'positive-parent-shell': Object.freeze({ cut: null, disconnect: false }),
  'positive-jobs': Object.freeze({ cut: null, disconnect: false }),
  'positive-file-chain': Object.freeze({ cut: null, disconnect: false }),
  'display-geometry': Object.freeze({ cut: null, disconnect: false }),
  'ordinary-input': Object.freeze({ cut: null, disconnect: false }),
  'raw-no-sftp': Object.freeze({ cut: null, disconnect: false }),
  'raw-unapproved-shell': Object.freeze({ cut: null, disconnect: false }),
  'raw-resource-mismatch': Object.freeze({ cut: null, disconnect: false }),
});
export const sshControlEofCases = Object.freeze({
  'before-key-control-eof': Object.freeze({ cut: 'before-accept', disconnect: false }),
  'after-key-control-eof': Object.freeze({ cut: 'key', disconnect: false }),
});
const sshCrashCases = Object.freeze({
  'crash-before-key': Object.freeze({ cut: 'before-accept', disconnect: false }),
  'crash-after-key': Object.freeze({ cut: 'key', disconnect: false }),
});
const historyCases = Object.fromEntries(['default', 'small', 'custom', 'empty', 'unset']
  .map(variant => [`history-${variant}`, Object.freeze({ cut: null, disconnect: false })]));
const userCases = Object.freeze({ ...sshRecoveryCases, ...sshPositiveCases, ...sshControlEofCases, ...sshCrashCases, ...historyCases, ...controlledCuts });
export const sshNativeCases = Object.freeze({ ...userCases, 'crash-restart': Object.freeze({ cut: null, disconnect: false }) });

export function parseSshRecoveryArgs(args) {
  const { values } = parseArgs({ args, options: {
    'list-cases': { type: 'boolean' }, 'case': { type: 'string' },
    fixture: { type: 'string' }, 'check-fixture': { type: 'boolean' }, bash: { type: 'boolean' },
  } });
  const selected = values.case;
  for (const flag of ['--case', '--fixture']) {
    assert(args.filter(arg => arg === flag || arg.startsWith(`${flag}=`)).length <= 1, `Specify ${flag} once`);
  }
  assert(selected === undefined || Object.hasOwn(userCases, selected), 'Unknown native SSH case');
  if (values['list-cases']) {
    assert(!values.fixture && !values['check-fixture'], '--list-cases does not take a fixture');
    return { mode: 'list', cases: (selected ? [selected] : Object.keys(userCases))
      .map(id => ({ id, ...sshNativeCases[id] })) };
  }
  assert(values.fixture, 'Specify --fixture with the exact owned fixture.json path');
  if (values['check-fixture']) {
    assert(!selected, '--check-fixture only checks the local fixture record');
    return { mode: 'check', fixture: values.fixture };
  }
  assert(selected, 'Specify exactly one --case (use --list-cases to discover cases)');
  return { mode: 'run', id: selected, fixture: values.fixture, ...(values.bash ? { bash: true } : {}) };
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function readOwnedSshFixture(root, argument, bash = false) {
  const base = resolve(root, '.artifacts/tests/native-input-p2/ssh');
  const file = resolve(argument);
  assert(file.startsWith(`${base}/`) && file.endsWith('/fixture.json'), 'Use a ZLE fixture from this sealed source root');
  const id = file.slice(base.length + 1, -'/fixture.json'.length);
  assert(uuid.test(id), 'Fixture directory must be its exact owner UUID');
  function readRecord(path) {
    const info = lstatSync(path);
    assert(info.isFile() && info.size <= 16384 && realpathSync(path) === path, 'Fixture records must be bounded regular files in the owned directory');
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  const fixture = readRecord(file), owner = readRecord(resolve(dirname(file), 'owner.json'));
  assert.equal(fixture.id, id);
  assert.equal(fixture.container, `shellspan-nip-p2-${id}`);
  for (const field of ['id', 'root', 'container', 'image', 'imageId', 'mainVariant']) assert.equal(owner[field], fixture[field], `Fixture owner ${field} differs`);
  assert(fixture.mainVariant === undefined || fixture.mainVariant === 'unknown' && fixture.sftpEnabled === true);
  assert(fixture.root === root && fixture.shell === (bash ? 'bash' : 'zsh') && fixture.username === (bash ? 'native53' : 'nativeZle')
    && fixture.host === '127.0.0.1' && Number.isInteger(fixture.port) && fixture.port > 1024 && fixture.port <= 65535
    && /^sha256:[a-f0-9]{64}$/.test(fixture.imageId) && /^[a-f0-9]{64}$/.test(fixture.hostKeySha256)
    && (bash ? fixture.image === fixture.imageId : fixture.credentialReference === `shellspan-native-p3-${id}`), 'Fixture target or pinned identity differs');
  return { ...fixture, file };
}

export const readOwnedZleFixture = readOwnedSshFixture;

export function requireSshRecoveryRunner(values, environment = process.env) {
  const id = values['native-input-p3-ssh-recovery'];
  if (id === undefined) return undefined;
  const bash = values['native-input-p2'] === true;
  const directory = environment.SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR;
  assert(Object.hasOwn(sshNativeCases, id) && values['no-model'] === true
    && (bash ? values['native-input-p3'] === undefined : values['native-input-p3'] === 'zsh')
    && values['data-scope'] === recoveryScope
    && values['native-input-p3-ssh-recovery-fixture'] && directory?.startsWith('/')
    && environment.SHELLSPAN_LOCAL_HOME === resolve(directory, 'home')
    && environment.SHELLSPAN_DATA_DIR === resolve(directory, 'data')
    && Object.keys(values).every(key => ['native-input-p3-ssh-recovery', 'native-input-p3-ssh-recovery-fixture', bash ? 'native-input-p2' : 'native-input-p3', 'no-model', 'data-scope'].includes(key)),
  'SSH recovery requires an isolated no-model native run, one fixture and exact data/HOME');
  if (id === 'crash-restart') {
    const record = lstatSync(resolve(directory, 'ssh-crash-prior.json'));
    assert(record.isFile() && record.size > 0 && record.size <= 1024 * 1024, 'Restart requires an owned original crash record');
  }
  return id;
}
