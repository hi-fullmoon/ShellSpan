import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

describe('Terminal Execution Phase 4 remote SSH contracts', () => {
  it('ships remote visible commands separately from remote interactive tools', async () => {
    const [broker, adapter, runtime, commands, models, manifest] = await Promise.all([
      readFile(path.join(repositoryRoot, 'src-tauri/src/terminal_broker.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/agent_runtime/native_adapter.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/agent_runtime/native/runtime.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/commands.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/models.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'protocol/agent/runtime/built-in-tools.json'), 'utf8'),
    ]);
    expect(broker).toContain('SHELLSPAN_TERMINAL_REMOTE_BOUND_TERMINAL_V1');
    expect(broker).toContain('TERMINAL_REMOTE_BOUND_TERMINAL_DEFAULT_ENABLED: bool =');
    expect(broker).toContain('SHELLSPAN_TERMINAL_REMOTE_INTERACTIVE_TOOLS_V1');
    expect(broker).toContain('TERMINAL_REMOTE_INTERACTIVE_TOOLS_DEFAULT_ENABLED: bool = false');
    expect(broker).not.toContain('TERMINAL_REMOTE_BOUND_TERMINAL_DISABLED');
    expect(broker).not.toContain('TERMINAL_BROKER_AGENT_SSH_CANDIDATE_NOT_READY');
    expect(broker).not.toContain('attach_agent_ssh_candidate_transport');
    expect(broker).not.toContain('promote_agent_ssh_candidate_transport');
    expect(broker).not.toContain('abort_agent_ssh_candidate_transport');
    expect(broker).not.toContain('agent_pty_owner');
    expect(broker).not.toContain('TERMINAL_EXECUTE_REQUIRES_DEDICATED_AGENT_SSH_PTY');
    expect(adapter).not.toContain('ensure_remote_agent_terminal');
    expect(adapter).not.toContain('create_agent_remote_terminal_blocking');
    expect(adapter).not.toContain('agent_remote_terminal(');
    expect(commands).not.toContain('terminal-agent-remote-session-created');
    expect(commands).not.toContain('AGENT_REMOTE_TERMINAL_CREATED_EVENT');
    expect(commands).not.toContain('create_agent_remote_terminal_blocking');
    expect(models).not.toContain('AgentRemoteTerminalBinding');
    expect(models).not.toContain('agent_remote_owners');
    expect(models).not.toContain('latest_agent_remote');
    expect(adapter).toContain('TERMINAL_REMOTE_INTERACTIVE_TOOLS_DISABLED');
    expect(adapter).toContain('remote_interactive_tools_rollout');
    expect(runtime).toContain('AgentToolTargetNative::Remote');
    expect(JSON.parse(manifest).tools.find(({ name }) => name === 'terminal_execute'))
      .toMatchObject({ targetKinds: ['local', 'remote'] });
    expect(JSON.parse(manifest).tools.find(({ name }) => name === 'probe_http'))
      .toMatchObject({ targetKinds: ['local', 'remote'] });
  });

  it('runs real isolated SSH PTYs, unsupported-shell evidence, and Direct regression', async () => {
    const [runner, session, sessionTests, compose, dockerfile] = await Promise.all([
      readFile(path.join(repositoryRoot, 'scripts/verify-terminal-remote-ssh.mjs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/session.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/tests/session.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'tests/ssh-e2e/compose.yml'), 'utf8'),
      readFile(path.join(repositoryRoot, 'tests/ssh-e2e/Dockerfile'), 'utf8'),
    ]);
    expect(runner).toContain("docker, ['build'");
    expect(runner).toContain('ordinary_ssh_bash_prepares_integration_with_compatible_startup');
    expect(runner).toContain('ordinary_ssh_zsh_prepares_integration_with_compatible_startup');
    expect(runner).toContain('isolated_ssh_probe_reaches_only_the_remote_loopback_service');
    expect(runner).toContain('remote_control_failure_cleans_files_without_blocking_the_user_shell');
    expect(runner).toContain('remote_bound_terminal_bash_reuses_source_shell_acceptance');
    expect(runner).toContain('remote_bound_terminal_zsh_reuses_source_shell_smoke');
    expect(runner).toContain('ordinary_ssh_unsupported_shell_is_unavailable_without_a_second_transport');
    expect(runner).toContain('ordinary_ssh_without_sftp_falls_back_to_a_usable_shell');
    expect(runner).toContain('remote_integration_scope_cleans_resources_after_post_prepare_failure');
    expect(runner).toContain('isolated_ssh_sftp_end_to_end_reviewed_execution_uname');
    expect(sessionTests).toContain('.request_pty("xterm-256color"');
    expect(sessionTests).toContain('.start_shell(&mut shell_channel)');
    expect(session).toContain('exec env HOME={} {} -il');
    expect(session).toContain('ZDOTDIR=');
    expect(session).toContain('.shellspan-terminal-integration-');
    expect(session).toContain('RemoteSshShellIntegration::prepare');
    expect(session).toContain('TerminalIntegrationStreamDecoder');
    expect(compose).toContain('127.0.0.1:22222:22');
    expect(compose).toContain('127.0.0.1:22224:22');
    expect(dockerfile).toContain('/bin/bash');
    expect(dockerfile).toContain('/bin/zsh');
  });
});
