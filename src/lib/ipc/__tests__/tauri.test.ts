import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const loggerErrorMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: loggerErrorMock,
    warn: vi.fn(),
  }),
}));

import {
  buildRemoteConnectionRequest,
  buildSessionCreateRequest,
  invokeBuildDeploymentArtifact,
  invokeApproveDeploymentPlan,
  invokeCancelDeploymentArtifactBuild,
  invokeCancelDeploymentArtifactTransfer,
  invokeCancelDeploymentRemoteRunner,
  invokeCreateAgentRuntimeSession,
  invokeCreateDeploymentPlan,
  invokeCancelDeploymentPreflight,
  invokeDeploymentPreflight,
  invokeDeploymentArtifactSourceSnapshot,
  invokeCancelDeploymentReconciliationObservation,
  invokeDeploymentReconcile,
  invokeDeploymentReconciliationBinding,
  invokeDeploymentRuntimeCapabilities,
  invokeDeploymentStartupRecovery,
  invokeTransferDeploymentArtifact,
  invokeCreateLocalSession,
  invokeGetDeploymentPlan,
  invokeGetDeploymentRunDetail,
  invokeExportDeploymentRunAudit,
  invokeListDeploymentRunEventsBefore,
  invokeListDeploymentRunPage,
  invokeClaimDeploymentNotifications,
  invokeShowDeploymentNotification,
  invokeRejectDeploymentPlan,
  invokeRequestDeploymentApproval,
  invokeRunDeploymentRemote,
  invokeGetTerminalBrokerSnapshot,
  invokeGetAiRouteApiKey,
  invokeAgentTerminalLeaseReady,
  invokeTakeoverAgentTerminal,
  invokeCancelRemoteFileRead,
  invokeStoreKeyCredential,
  invokeListKeyCredentials,
  invokeListRemoteDirectory,
  invokeOpenRemoteFile,
  invokePreflightConnection,
  invokePreviewRemoteFile,
  invokeTrustHost,
} from '@/lib/ipc/tauri';
import type { ConnectionProfile } from '@/types';

beforeEach(() => {
  invokeMock.mockReset();
  loggerErrorMock.mockReset();
});

describe('deployment plan serialization', () => {
  it('reads the native deployment rollout before admitting new work', async () => {
    invokeMock.mockResolvedValue({ admissionsEnabled: true });

    await invokeDeploymentRuntimeCapabilities();

    expect(invokeMock).toHaveBeenCalledWith('deployment_runtime_capabilities', undefined);
  });

  it('uses bounded history, detail, event, and notification receipt wire shapes', async () => {
    invokeMock.mockResolvedValue({});

    await invokeListDeploymentRunPage('workflow-1', '100:run-1', 20);
    await invokeGetDeploymentRunDetail('run-2', 100);
    await invokeExportDeploymentRunAudit('run-2');
    await invokeListDeploymentRunEventsBefore('run-2', 41, 25);
    await invokeClaimDeploymentNotifications(10);
    await invokeShowDeploymentNotification({
      runId: 'run-2',
      title: 'Deployment failed',
      body: 'Open run run-2',
      openLabel: 'Open run',
    });

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'list_deployment_run_page', {
      workflowId: 'workflow-1', cursor: '100:run-1', limit: 20,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'get_deployment_run_detail', {
      id: 'run-2', eventLimit: 100,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'export_deployment_run_audit', {
      runId: 'run-2',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'list_deployment_run_events_before', {
      runId: 'run-2', beforeSequence: 41, limit: 25,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, 'claim_deployment_notifications', { limit: 10 });
    expect(invokeMock).toHaveBeenNthCalledWith(6, 'show_deployment_notification', {
      input: {
        runId: 'run-2',
        title: 'Deployment failed',
        body: 'Open run run-2',
        openLabel: 'Open run',
      },
    });
  });

  it('uses the frozen startup recovery and reconciliation wire shapes', async () => {
    invokeMock.mockResolvedValue({});
    const input = {
      operationId: 'deployment-reconciliation:fixture',
      planId: `plan-${'c'.repeat(64)}`,
      planDigest: 'c'.repeat(64),
      runId: 'run-1',
      expectedRunRevision: 9,
      artifactTransferOperationId: 'deployment-artifact-transfer:fixture',
      remoteStagingIdentity: `deployment-staging-v1:${'a'.repeat(64)}:${'b'.repeat(64)}`,
    };

    await invokeDeploymentStartupRecovery();
    await invokeDeploymentReconciliationBinding(input.runId);
    await invokeDeploymentReconcile(input);
    await invokeCancelDeploymentReconciliationObservation(input.operationId);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'deployment_startup_recovery', undefined);
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'deployment_reconciliation_binding', {
      runId: input.runId,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'deployment_reconcile', { input });
    expect(invokeMock).toHaveBeenNthCalledWith(
      4,
      'deployment_cancel_reconciliation_observation',
      { operationId: input.operationId },
    );
  });

  it('uses the typed pure-data create and query wire shapes', async () => {
    invokeMock.mockResolvedValue({});
    const input = {
      workflowId: 'workflow-1',
      expectedRevision: 3,
      sourceRunId: null,
      operationKind: 'deploy' as const,
      triggerKind: 'manual' as const,
      artifactReference: `deployment-artifact-v1:${'d'.repeat(64)}:${'e'.repeat(64)}`,
      sourceRevision: {
        revision: 'a'.repeat(40),
        dirty: false,
      },
      target: {
        profileId: 'profile-1',
        profileUpdatedAt: 7,
        host: 'example.test',
        port: 22,
        username: 'deploy',
        authMethod: 'password' as const,
        jumpHost: null,
      },
      currentRelease: null,
      targetRelease: {
        releaseId: 'release-next',
        artifactDigestSha256: 'b'.repeat(64),
      },
      rollbackRelease: null,
      preflight: {
        checkedAt: 1_000,
        checks: [{
          code: 'data-ready',
          outcome: 'passed' as const,
          summary: 'Preflight data is ready',
        }],
      },
      ttlSeconds: 600,
    };

    await invokeCreateDeploymentPlan(input);
    await invokeGetDeploymentPlan(`plan-${'c'.repeat(64)}`);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'create_deployment_plan', { input });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'get_deployment_plan', {
      planId: `plan-${'c'.repeat(64)}`,
    });
  });

  it('uses the fixed deployment preflight and cancellation wire shapes', async () => {
    invokeMock.mockResolvedValue({});
    const input = {
      operationId: 'deployment-preflight:fixture',
      workflowId: 'workflow-1',
      expectedRevision: 3,
      artifactReference: `deployment-artifact-v1:${'a'.repeat(64)}:${'b'.repeat(64)}`,
      ttlSeconds: 600,
      timeoutMs: 30_000,
    };

    await invokeDeploymentPreflight(input);
    await invokeCancelDeploymentPreflight(input.operationId);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'deployment_preflight', { input });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'deployment_cancel_preflight', {
      operationId: input.operationId,
    });
  });

  it('uses typed source snapshot, artifact build, and cancellation wire shapes', async () => {
    invokeMock.mockResolvedValue({});
    const snapshot = { workflowId: 'workflow-1', expectedRevision: 3 };
    const input = {
      operationId: 'deployment-artifact-build:fixture',
      ...snapshot,
      sourceRevision: { revision: 'a'.repeat(40), dirty: false },
      builderKind: 'dockerBuildx' as const,
      timeoutMs: 900_000,
    };

    await invokeDeploymentArtifactSourceSnapshot(snapshot);
    await invokeBuildDeploymentArtifact(input);
    await invokeCancelDeploymentArtifactBuild(input.operationId);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'deployment_artifact_source_snapshot', { input: snapshot });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'deployment_build_artifact', { input });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'deployment_cancel_artifact_build', {
      operationId: input.operationId,
    });
  });

  it('uses the closed artifact transfer and operation-scoped cancellation wire shapes', async () => {
    invokeMock.mockResolvedValue({});
    const input = {
      operationId: 'deployment-artifact-transfer:fixture',
      planId: `plan-${'c'.repeat(64)}`,
      planDigest: 'c'.repeat(64),
      workflowId: 'workflow-1',
      workflowRevision: 3,
      artifactReference: `deployment-artifact-v1:${'a'.repeat(64)}:${'b'.repeat(64)}`,
      sourceRevision: { revision: 'd'.repeat(40), dirty: false },
      target: {
        profileId: 'profile-1',
        profileUpdatedAt: 7,
        host: 'example.test',
        port: 22,
        username: 'deploy',
        authMethod: 'password' as const,
        jumpHost: null,
      },
      remoteRoot: '/srv/api',
      releaseId: 'release-next',
      releaseDigestSha256: 'e'.repeat(64),
      timeoutMs: 3_600_000,
    };

    await invokeTransferDeploymentArtifact(input);
    await invokeCancelDeploymentArtifactTransfer(input.operationId);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'deployment_transfer_artifact', { input });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'deployment_cancel_artifact_transfer', {
      operationId: input.operationId,
    });
  });

  it('binds native approval decisions and remote execution to exact run identities', async () => {
    invokeMock.mockResolvedValue({});
    const approval = {
      planId: `plan-${'c'.repeat(64)}`,
      planDigest: 'c'.repeat(64),
      runId: 'run-1',
      runRevision: 2,
      expiresAt: 123_000,
    };
    await invokeRequestDeploymentApproval(approval);
    await invokeApproveDeploymentPlan(approval);
    await invokeRejectDeploymentPlan(approval);

    const runner = {
      operationId: 'deployment-remote-runner:fixture',
      planId: approval.planId,
      planDigest: approval.planDigest,
      runId: approval.runId,
      runRevision: 3,
      planExpiresAt: approval.expiresAt,
      workflowId: 'workflow-1',
      workflowRevision: 1,
      artifactReference: `deployment-artifact-v1:${'a'.repeat(64)}:${'b'.repeat(64)}`,
      artifactTransferOperationId: 'deployment-artifact-transfer:fixture',
      sourceRevision: { revision: 'd'.repeat(40), dirty: false },
      target: {
        profileId: 'profile-1',
        profileUpdatedAt: 7,
        host: 'example.test',
        port: 22,
        username: 'deploy',
        authMethod: 'password' as const,
        jumpHost: null,
      },
      remoteRoot: '/srv/api',
      releaseId: 'release-next',
      releaseDigestSha256: 'e'.repeat(64),
      remoteStagingIdentity: `deployment-staging-v1:${'a'.repeat(64)}:${'b'.repeat(64)}`,
      timeoutMs: 60_000,
    };
    await invokeRunDeploymentRemote(runner);
    await invokeCancelDeploymentRemoteRunner({
      operationId: runner.operationId,
      planId: runner.planId,
      planDigest: runner.planDigest,
      runId: runner.runId,
    });

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'request_deployment_approval', { input: approval });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'approve_deployment_plan', { input: approval });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'reject_deployment_plan', { input: approval });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'deployment_run_remote', { input: runner });
    expect(invokeMock).toHaveBeenNthCalledWith(5, 'deployment_cancel_remote_runner', {
      input: expect.objectContaining({ operationId: runner.operationId, runId: runner.runId }),
    });
  });
});

describe('AI route credentials', () => {
  it('requests a saved API key by route id', async () => {
    invokeMock.mockResolvedValue('stored-secret');

    await expect(invokeGetAiRouteApiKey('route-kimi')).resolves.toBe('stored-secret');

    expect(invokeMock).toHaveBeenCalledWith('ai_get_route_api_key', {
      routeId: 'route-kimi',
    });
  });
});

describe('remote directory supersession', () => {
  const request = {
    host: 'server.example.com',
    port: 22,
    username: 'root',
    authMethod: 'password' as const,
    requestKey: 'epoch:pane:remote',
    requestId: 2,
  };

  it('does not log an expected stale directory request as an IPC failure', async () => {
    const superseded = {
      type: 'Other',
      payload: { message: 'remote directory request superseded' },
    };
    invokeMock.mockRejectedValueOnce(superseded);

    await expect(invokeListRemoteDirectory(request)).rejects.toBe(superseded);

    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it('continues to log real directory failures', async () => {
    const failure = {
      type: 'Other',
      payload: { message: 'permission denied' },
    };
    invokeMock.mockRejectedValueOnce(failure);

    await expect(invokeListRemoteDirectory(request)).rejects.toBe(failure);

    expect(loggerErrorMock).toHaveBeenCalledOnce();
  });
});

describe('remote file read cancellation', () => {
  const request = {
    host: 'server.example.com',
    port: 22,
    username: 'root',
    authMethod: 'password' as const,
    path: '/var/log/large.log',
    operationId: 'remote-preview-test',
  };

  it('does not log an expected open or preview cancellation as an IPC failure', async () => {
    const cancelled = {
      type: 'Other',
      payload: { message: 'remote file read cancelled' },
    };
    invokeMock.mockRejectedValue(cancelled);

    await expect(invokeOpenRemoteFile(request)).rejects.toBe(cancelled);
    await expect(invokePreviewRemoteFile(request)).rejects.toBe(cancelled);

    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it('keeps real remote file read failures visible and sends idempotent cancellation', async () => {
    const failure = {
      type: 'Other',
      payload: { message: 'permission denied' },
    };
    invokeMock.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);

    await expect(invokePreviewRemoteFile(request)).rejects.toBe(failure);
    await invokeCancelRemoteFileRead(request.operationId);

    expect(loggerErrorMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenLastCalledWith('cancel_remote_file_read', {
      operationId: request.operationId,
    });
  });
});

describe('keychain kind serialization', () => {
  it('sends keyFile as lowercase keyfile to the backend', async () => {
    invokeMock.mockResolvedValue(undefined);

    await invokeStoreKeyCredential({
      id: 'key-1',
      label: 'My Key',
      kind: 'keyFile',
      privateKey: 'private-key-data',
    });

    expect(invokeMock).toHaveBeenCalledWith('store_key_credential', {
      request: {
        id: 'key-1',
        label: 'My Key',
        kind: 'keyfile',
        privateKey: 'private-key-data',
      },
    });
  });

  it('maps lowercase keyfile from the backend to keyFile', async () => {
    invokeMock.mockResolvedValue([
      { id: 'key-1', label: 'My Key', keyType: 'rsa', kind: 'keyfile', service: 'com.shellspan.key' },
    ]);

    const result = await invokeListKeyCredentials();

    expect(result[0].kind).toBe('keyFile');
  });
});

describe('host key trust serialization', () => {
  it('binds trust to the fingerprint shown by the confirmation prompt', async () => {
    invokeMock.mockResolvedValue(undefined);

    await invokeTrustHost(
      'server.example.com',
      2222,
      'ED25519 SHA256:confirmed',
    );

    expect(invokeMock).toHaveBeenCalledWith('trust_host', {
      request: {
        host: 'server.example.com',
        port: 2222,
        expectedFingerprint: 'ED25519 SHA256:confirmed',
      },
    });
  });
});

describe('Agent Session execution surface serialization', () => {
  it('passes the frozen execution surface through the IPC request unchanged', async () => {
    invokeMock.mockResolvedValue({});
    const request = {
      sessionId: 'agent-visible',
      taskId: 'task-visible',
      goal: 'Show command execution',
      permissionMode: 'requestApproval' as const,
      executionSurface: 'boundTerminal' as const,
    };

    await invokeCreateAgentRuntimeSession(request);

    expect(invokeMock).toHaveBeenCalledWith('agent_runtime_create_session', { request });
  });
});

describe('Agent terminal lease control serialization', () => {
  const input = {
    sessionId: 'terminal-1',
    agentSessionId: 'agent-1',
    operationId: 'operation-1',
  };

  it('binds ready and takeover commands to the same operation identity', async () => {
    invokeMock.mockResolvedValue(true);

    await expect(invokeAgentTerminalLeaseReady(input)).resolves.toBe(true);
    await expect(invokeTakeoverAgentTerminal(input)).resolves.toBe(true);

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      'agent_runtime_terminal_lease_ready',
      { input },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      'agent_runtime_takeover_terminal',
      { input },
    );
  });
});

describe('connection request serialization', () => {
  const passwordProfile: ConnectionProfile = {
    id: 'p1',
    name: 'Server',
    host: 'h',
    port: 22,
    username: 'u',
    authMethod: 'password',
    password: 'secret',
    keychainKeyId: 'password-key',
    jumpHost: {
      host: 'jump',
      port: 22,
      username: 'ju',
      authMethod: 'password',
      password: 'jump-secret',
      keychainKeyId: 'jump-password-key',
    },
    createdAt: 0,
    updatedAt: 0,
  };

  it('omits keychain ids for password-authenticated session requests', () => {
    const request = buildSessionCreateRequest(passwordProfile, 120, 30);

    expect(request.keychainKeyId).toBeUndefined();
    expect(request.jumpHost?.keychainKeyId).toBeUndefined();
    expect(request.password).toBe('secret');
  });

  it('omits keychain ids for password-authenticated remote requests', () => {
    const request = buildRemoteConnectionRequest(passwordProfile);

    expect(request.keychainKeyId).toBeUndefined();
    expect(request.jumpHost?.keychainKeyId).toBeUndefined();
    expect(request.password).toBe('secret');
  });

  it('keeps keychain ids for key-authenticated requests', () => {
    const keyProfile: ConnectionProfile = {
      ...passwordProfile,
      authMethod: 'key',
      password: undefined,
      keychainKeyId: 'key-1',
      jumpHost: {
        ...passwordProfile.jumpHost!,
        authMethod: 'key',
        password: undefined,
        keychainKeyId: 'jump-key-1',
      },
    };

    const request = buildSessionCreateRequest(keyProfile, 120, 30);

    expect(request.keychainKeyId).toBe('key-1');
    expect(request.jumpHost?.keychainKeyId).toBe('jump-key-1');
  });

  it('carries only the ephemeral predecessor transport during reconnect', async () => {
    const request = buildSessionCreateRequest(
      passwordProfile,
      100,
      40,
      'transport-before-reconnect',
    );
    expect(request.replacesSessionId).toBe('transport-before-reconnect');

    invokeMock.mockResolvedValue({
      sessionId: 'transport-after-reconnect',
      title: 'Local',
      host: 'local',
      port: 0,
      username: 'tester',
      terminalSessionId: 'terminal-stable',
      terminalGeneration: 2,
    });
    await invokeCreateLocalSession(100, 40, 'transport-before-reconnect');
    expect(invokeMock).toHaveBeenCalledWith('create_local_session', {
      cols: 100,
      rows: 40,
      replacesSessionId: 'transport-before-reconnect',
    });
  });

  it('exposes broker rollout and counters through a read-only IPC command', async () => {
    invokeMock.mockResolvedValue({
      rollout: {
        name: 'terminal_broker_v1',
        enabled: false,
        defaultEnabled: false,
        source: 'default',
        persisted: false,
        mode: 'cooperative',
        rollback: 'disableDependentFlagsThenCloseBrokerGenerations',
      },
      remoteBoundTerminalRollout: {
        name: 'terminal_remote_bound_terminal_v1',
        enabled: true,
        requested: true,
        defaultEnabled: true,
        prerequisiteSatisfied: true,
        source: 'environment',
        persisted: false,
        rollback: 'releaseAgentLeasesAndMarkIncompleteCommandsUncertain',
      },
      counters: {
        integrationReady: 3,
        lifecycleMatched: 12,
        uncertainty: 1,
        timeout: 2,
        takeover: 1,
        truncation: 1,
        backpressure: 1,
        transportLatencySamples: 8,
        transportLatencyTotalMicros: 80,
        transportLatencyMaxMicros: 20,
      },
    });

    const snapshot = await invokeGetTerminalBrokerSnapshot('transport-1');

    expect(snapshot.rollout.enabled).toBe(false);
    expect(snapshot.remoteBoundTerminalRollout).toEqual(expect.objectContaining({
      name: 'terminal_remote_bound_terminal_v1',
      enabled: true,
      persisted: false,
    }));
    expect(snapshot.counters).toEqual(expect.objectContaining({
      integrationReady: 3,
      transportLatencySamples: 8,
    }));
    expect(invokeMock).toHaveBeenCalledWith('get_terminal_broker_snapshot', {
      sessionId: 'transport-1',
    });
  });

  it('wraps connection preflight fields for the native command', async () => {
    invokeMock.mockResolvedValue({
      operationId: 'connection-preflight-test',
      status: 'passed',
      checkedAt: 1,
      steps: [],
    });

    await invokePreflightConnection({
      operationId: 'connection-preflight-test',
      host: 'server.example.com',
      port: 22,
      username: 'root',
      authMethod: 'password',
      password: 'secret',
    });

    expect(invokeMock).toHaveBeenCalledWith('preflight_connection', {
      request: {
        operationId: 'connection-preflight-test',
        host: 'server.example.com',
        port: 22,
        username: 'root',
        authMethod: 'password',
        password: 'secret',
      },
    });
  });
});
