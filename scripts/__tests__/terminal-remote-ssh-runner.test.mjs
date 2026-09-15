import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

describe('Terminal Execution Phase 4 remote SSH contracts', () => {
  it('keeps the remote flag default-off, dependency-gated, and Agent-owned', async () => {
    const [broker, adapter, runtime, manifest] = await Promise.all([
      readFile(path.join(repositoryRoot, 'src-tauri/src/terminal_broker.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/agent_runtime/native_adapter.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/agent_runtime/native/runtime.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'protocol/agent/runtime/built-in-tools.json'), 'utf8'),
    ]);
    expect(broker).toContain('SHELLSPAN_TERMINAL_REMOTE_AGENT_PTY_V1');
    expect(broker).toContain('TERMINAL_REMOTE_AGENT_PTY_DISABLED');
    expect(broker).toContain('record.agent_pty_owner.is_some()');
    expect(broker).toContain('TERMINAL_EXECUTE_REQUIRES_DEDICATED_AGENT_SSH_PTY');
    expect(adapter.indexOf('issue_prepared_authorization(&prepared, approved)'))
      .toBeLessThan(adapter.indexOf('self.ensure_remote_agent_terminal('));
    expect(runtime).toContain('AgentToolTargetNative::Remote');
    expect(JSON.parse(manifest).tools.find(({ name }) => name === 'terminal_execute'))
      .toMatchObject({ targetKinds: ['local', 'remote'] });
  });

  it('runs real isolated SSH PTYs, unsupported-shell evidence, and Direct regression', async () => {
    const [runner, session, compose, dockerfile] = await Promise.all([
      readFile(path.join(repositoryRoot, 'scripts/verify-terminal-remote-ssh.mjs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/session.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'tests/ssh-e2e/compose.yml'), 'utf8'),
      readFile(path.join(repositoryRoot, 'tests/ssh-e2e/Dockerfile'), 'utf8'),
    ]);
    expect(runner).toContain("docker, ['build'");
    expect(runner).toContain('remote_agent_ssh_pty_bash_phase4_acceptance');
    expect(runner).toContain('remote_agent_ssh_pty_zsh_phase4_state_smoke');
    expect(runner).toContain('remote_agent_ssh_pty_unsupported_shell_is_unavailable');
    expect(runner).toContain('isolated_ssh_sftp_end_to_end_reviewed_execution_uname');
    expect(session).toContain('.request_pty("xterm-256color"');
    expect(session).toContain('.start_shell(&mut shell_channel)');
    expect(session).toContain('--noprofile --rcfile');
    expect(session).toContain('ZDOTDIR=');
    expect(session).toContain('RemoteSshShellIntegration::prepare');
    expect(session).toContain('TerminalIntegrationStreamDecoder');
    expect(compose).toContain('127.0.0.1:22222:22');
    expect(dockerfile).toContain('/bin/bash');
    expect(dockerfile).toContain('/bin/zsh');
  });
});
