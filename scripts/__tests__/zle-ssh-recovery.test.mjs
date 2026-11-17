import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { parseSshRecoveryArgs, readOwnedZleFixture, requireSshRecoveryRunner } from '../native-input-p3/ssh-recovery-cases.mjs';
import { macSubmissionControlMode } from '../native-input-p3/mac-submission.mjs';

const root = resolve(import.meta.dirname, '../..');

describe('ZLE SSH recovery offline discovery and admission', () => {
  it('lists the independent cut, reconnect and positive cases without a fixture', () => {
    const listing = parseSshRecoveryArgs(['--list-cases']);
    expect(listing).toEqual({ mode: 'list', cases: [
      { id: 'before-key-disconnect', cut: 'before-accept', disconnect: true },
      { id: 'before-key-timeout', cut: 'before-accept', disconnect: false },
      { id: 'before-key-cancel', cut: 'before-accept', disconnect: false },
      { id: 'before-key-stop', cut: 'before-accept', disconnect: false },
      { id: 'before-key-takeover', cut: 'before-accept', disconnect: false },
      { id: 'running-stop', cut: null, disconnect: false },
      { id: 'running-cancel', cut: null, disconnect: false },
      { id: 'running-takeover', cut: null, disconnect: false },
      { id: 'runtime-multi-agent', cut: null, disconnect: false },
      { id: 'close-running-terminal', cut: null, disconnect: false },
      { id: 'delegation', cut: null, disconnect: false },
      { id: 'after-key-disconnect', cut: 'key', disconnect: true },
      { id: 'after-key-timeout', cut: 'accept-receipt', disconnect: false },
      { id: 'reconnect-tail', cut: null, disconnect: false },
      { id: 'positive-byte-boundary', cut: null, disconnect: false },
      { id: 'positive-source-boundaries', cut: null, disconnect: false },
      { id: 'positive-parent-shell', cut: null, disconnect: false },
      { id: 'positive-jobs', cut: null, disconnect: false },
      { id: 'positive-job-completion', cut: null, disconnect: false },
      { id: 'positive-file-chain', cut: null, disconnect: false },
      { id: 'display-geometry', cut: null, disconnect: false },
      { id: 'ordinary-input', cut: null, disconnect: false },
      { id: 'raw-no-sftp', cut: null, disconnect: false },
      { id: 'raw-unapproved-shell', cut: null, disconnect: false },
      { id: 'raw-resource-mismatch', cut: null, disconnect: false },
      { id: 'before-key-control-eof', cut: 'before-accept', disconnect: false },
      { id: 'after-key-control-eof', cut: 'key', disconnect: false },
      { id: 'crash-before-key', cut: 'before-accept', disconnect: false },
      { id: 'crash-after-key', cut: 'key', disconnect: false },
      ...['default', 'small', 'custom', 'empty', 'unset'].map(variant => ({ id: `history-${variant}`, cut: null, disconnect: false })),
      ...['input-in-progress', 'input-complete', 'intent', 'armed', 'after-accept'].flatMap(cut =>
        ['stop', 'cancel', 'takeover'].map(action => ({ id: `${cut}-${action}`, cut, disconnect: false }))),
    ] });
    for (const { id, cut } of listing.cases) {
      expect(parseSshRecoveryArgs(['--list-cases', '--case', id]).cases).toHaveLength(1);
      expect(macSubmissionControlMode(id)).toEqual({ scenario: id, cut: cut ?? undefined });
    }
  });

  it('rejects missing, unknown and ambiguous arguments before a live launch', () => {
    expect(() => parseSshRecoveryArgs([])).toThrow(/--fixture/);
    expect(() => parseSshRecoveryArgs(['--fixture', 'fixture.json'])).toThrow(/--case/);
    expect(() => parseSshRecoveryArgs(['--list-cases', '--case', 'jobs'])).toThrow(/Unknown/);
    expect(() => parseSshRecoveryArgs(['--list-cases', '--fixture', 'fixture.json'])).toThrow(/does not take/);
    expect(() => parseSshRecoveryArgs(['--list-cases', '--case=before-key-timeout', '--case', 'reconnect-tail'])).toThrow(/once/);
    expect(() => parseSshRecoveryArgs(['--check-fixture', '--case', 'reconnect-tail', '--fixture', 'fixture.json'])).toThrow(/only checks/);
  });

  it('rejects foreign, malformed and missing fixture paths without contacting Docker or SSH', () => {
    const base = resolve(root, 'artifacts/tests/native-input-p2/ssh');
    expect(() => readOwnedZleFixture(root, resolve(root, 'package.json'))).toThrow(/sealed source root/);
    expect(() => readOwnedZleFixture(root, resolve(base, 'foreign/fixture.json'))).toThrow(/exact owner UUID/);
    expect(() => readOwnedZleFixture(root, resolve(base, '00000000-0000-0000-0000-000000000000/fixture.json'))).toThrow(/ENOENT/);
  });

  it('rejects mixed model, fixture or data directory arguments at the actual App runner boundary', () => {
    const directory = resolve(root, 'artifacts/tests/native-input-p2/ssh-recovery');
    const env = { SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR: directory, SHELLSPAN_DATA_DIR: resolve(directory, 'data'),
      SHELLSPAN_LOCAL_HOME: resolve(directory, 'home'), HOME: process.env.HOME };
    const args = { 'native-input-p3-ssh-recovery': 'after-key-timeout', 'native-input-p3-ssh-recovery-fixture': 'fixture.json',
      'native-input-p3': 'zsh', 'no-model': true, 'data-scope': 'com.shellspan.validation.native-input-p3' };
    expect(requireSshRecoveryRunner(args, env)).toBe('after-key-timeout');
    expect(() => requireSshRecoveryRunner({ ...args, model: 'selected' }, env)).toThrow(/no-model/);
    expect(() => requireSshRecoveryRunner({ ...args, 'native-input-p3-ssh-recovery-fixture': undefined }, env)).toThrow(/one fixture/);
    expect(() => requireSshRecoveryRunner(args, { ...env, SHELLSPAN_DATA_DIR: root })).toThrow(/exact data/);
  });
});
