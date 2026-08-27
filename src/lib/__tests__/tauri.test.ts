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
  invokeAgentGetSnapshot,
  invokeAgentPause,
  invokeAgentSendMessage,
  invokeAgentStart,
  invokeCancelRunbookStep,
  invokeCancelDeployment,
  invokeCancelRollback,
  invokeExecuteDeployment,
  invokeExecuteRollback,
  invokeReviewDeploymentExecution,
  invokeReviewRollbackExecution,
  invokeCancelRemoteFileRead,
  invokeExecuteRunbookStep,
  invokeStoreKeyCredential,
  invokeListKeyCredentials,
  invokeListRemoteDirectory,
  invokeOpenRemoteFile,
  invokePreflightConnection,
  invokePreviewRemoteFile,
  invokeTrustHost,
} from '@/lib/tauri';
import { makeAgentActionResult, makeAgentSnapshot } from '@/test/agent-fixtures';
import type { ConnectionProfile } from '@/types';
import type {
  RunbookStepExecutionRequest,
  RunbookStepExecutionResult,
} from '@/types/runbook';
import type {
  DeploymentExecutionRequestV2,
  DeploymentExecutionResultV2,
  DeploymentExecutionReviewRequestV2,
  DeploymentExecutionReviewV2,
  RollbackExecutionRequestV2,
  RollbackExecutionResultV2,
  RollbackExecutionReviewRequestV2,
  RollbackExecutionReviewV2,
} from '@/types/deployment-runbook';

beforeEach(() => {
  invokeMock.mockReset();
  loggerErrorMock.mockReset();
});

describe('Agent v1 narrow IPC contract', () => {
  it('uses only the six typed Agent command envelopes and strictly decodes results', async () => {
    const startRequest = {
      schemaVersion: 1 as const,
      clientRequestId: 'request-1',
      goal: 'Inspect disk pressure.',
      profileId: 'profile-1',
      providerId: 'provider-1',
    };
    const actionRequest = {
      schemaVersion: 1 as const,
      runId: 'run-1',
      clientActionId: 'action-1',
    };
    const messageRequest = { ...actionRequest, message: 'Also inspect inode pressure.' };
    const startResult = { schemaVersion: 1, runId: 'run-1', acceptedAt: 1_000 };
    invokeMock
      .mockResolvedValueOnce(startResult)
      .mockResolvedValueOnce(makeAgentSnapshot())
      .mockResolvedValueOnce(makeAgentActionResult('pause'))
      .mockResolvedValueOnce(makeAgentActionResult('sendMessage'));

    await expect(invokeAgentStart(startRequest)).resolves.toEqual(startResult);
    await expect(invokeAgentGetSnapshot({ schemaVersion: 1, runId: 'run-1' }))
      .resolves.toEqual(makeAgentSnapshot());
    await expect(invokeAgentPause(actionRequest)).resolves.toMatchObject({ action: 'pause' });
    await expect(invokeAgentSendMessage(messageRequest))
      .resolves.toMatchObject({ action: 'sendMessage' });

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'agent_start',
      'agent_get_snapshot',
      'agent_pause',
      'agent_send_message',
    ]);
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'agent_start', { request: startRequest });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'agent_send_message', {
      request: messageRequest,
    });
  });

  it('rejects expanded backend result envelopes', async () => {
    invokeMock.mockResolvedValueOnce({
      schemaVersion: 1,
      runId: 'run-1',
      acceptedAt: 1_000,
      rawOutput: 'must not cross IPC',
    });

    await expect(invokeAgentStart({
      schemaVersion: 1,
      clientRequestId: 'request-1',
      goal: 'Inspect only.',
      profileId: 'profile-1',
      providerId: 'provider-1',
    })).rejects.toThrow(/unknown field/);
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
      { id: 'key-1', label: 'My Key', keyType: 'rsa', kind: 'keyfile', service: 'com.termbridge.key' },
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

describe('runbook execution IPC contract', () => {
  const request: RunbookStepExecutionRequest = {
    operationId: 'runbook:step-1',
    runId: 'runbook-run:1',
    sourceDigest: 'fnv1a-12345678',
    runbookText: '{"schemaVersion":1}',
    itemId: 'check',
    itemKind: 'precheck',
    profileId: 'profile-1',
    authorized: true,
    approvedRisk: 'readOnly',
    variableValues: { SERVICE: 'nginx' },
    evidenceReferences: [{ operationId: 'preflight-1', kind: 'connectionPreflight' }],
    timeoutMs: 10_000,
    connection: {
      host: 'server.example.com',
      port: 22,
      username: 'operator',
      authMethod: 'password',
      password: 'target-password',
      jumpHost: {
        host: 'jump.example.com',
        port: 2222,
        username: 'jump-operator',
        authMethod: 'password',
        password: 'jump-password',
      },
    },
  };

  it('passes the reviewed request under the native request envelope and returns the result unchanged', async () => {
    const result: RunbookStepExecutionResult = {
      operationId: request.operationId,
      runId: request.runId,
      runbookId: 'baseline-runbook',
      sourceDigest: request.sourceDigest,
      itemId: request.itemId,
      itemKind: request.itemKind,
      profileId: request.profileId,
      status: 'success',
      risk: 'readOnly',
      commandPreview: 'uname -s',
      startedAt: 1_000,
      completedAt: 1_250,
      source: {
        kind: 'sshRunbook',
        profileId: request.profileId,
        host: request.connection.host,
        port: request.connection.port,
        username: request.connection.username,
      },
      exitCode: 0,
      expectedMatched: true,
      stdout: 'Linux\n',
    };
    invokeMock.mockResolvedValueOnce(result);

    await expect(invokeExecuteRunbookStep(request, {
      taskId: request.runId,
      commandPreview: result.commandPreview,
    })).resolves.toBe(result);

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith('execute_runbook_step', { request });
  });

  it('sends cancellation as the existing operation-id-only command', async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await invokeCancelRunbookStep(request.operationId);

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith('cancel_runbook_step', {
      operationId: request.operationId,
    });
  });
});

describe('Deployment Runbook v2 narrow IPC contract', () => {
  const reviewRequest: DeploymentExecutionReviewRequestV2 = {
    operationId: 'deployment:ipc',
    runbookText: '{"schemaVersion":2}',
    profileId: 'profile-1',
    connection: {
      host: 'server.example.com',
      port: 22,
      username: 'operator',
      authMethod: 'password',
      password: 'secret',
    },
    policy: {
      artifactTimeoutSeconds: 30,
      maxArtifactBytes: 10_485_760,
      maxExpandedBytes: 52_428_800,
      maxArchiveEntries: 1_000,
      totalTimeoutSeconds: 600,
    },
  };
  const review: DeploymentExecutionReviewV2 = {
    schemaVersion: 2,
    reviewId: 'deployment-review:ipc',
    operationId: reviewRequest.operationId,
    normalizedRunbookText: '{}\n',
    documentDigest: 'sha256-v1:document',
    planDigest: 'sha256-v1:plan',
    deploymentId: 'release-1',
    applicationId: 'app',
    environment: 'production',
    version: '1.0.0',
    artifactDigests: [],
    declaredRisk: 'stateChange',
    target: {
      profileId: reviewRequest.profileId,
      host: reviewRequest.connection.host,
      port: reviewRequest.connection.port,
      username: reviewRequest.connection.username,
      authMethod: reviewRequest.connection.authMethod,
      identityDigest: 'sha256-v1:target',
    },
    policy: reviewRequest.policy,
    actions: [],
    reviewedAt: 1,
    expiresAt: 2,
  };
  const request: DeploymentExecutionRequestV2 = {
    operationId: review.operationId,
    runbookText: reviewRequest.runbookText,
    profileId: reviewRequest.profileId,
    connection: reviewRequest.connection,
    approval: {
      reviewId: review.reviewId,
      operationId: review.operationId,
      documentDigest: review.documentDigest,
      planDigest: review.planDigest,
      targetDigest: review.target.identityDigest,
      approvedRisk: review.declaredRisk,
      authorized: true,
      destructiveConfirmed: false,
    },
  };
  const result: DeploymentExecutionResultV2 = {
    schemaVersion: 2,
    operationId: review.operationId,
    reviewId: review.reviewId,
    documentDigest: review.documentDigest,
    planDigest: review.planDigest,
    deploymentId: review.deploymentId,
    version: review.version,
    target: review.target,
    phase: 'succeeded',
    startedAt: 1,
    completedAt: 2,
    actions: [],
    healthChecks: [],
    rollbackSnapshot: {
      strategy: 'reactivatePreviousRelease',
      newRelease: '/srv/app/releases/release-1',
      releasesDirectory: '/srv/app/releases',
      activeSymlink: '/srv/app/current',
      activationChanged: true,
    },
  };

  it('uses only review, execute, and operation-id cancellation envelopes', async () => {
    invokeMock.mockResolvedValueOnce(review).mockResolvedValueOnce(result).mockResolvedValueOnce(undefined);

    await expect(invokeReviewDeploymentExecution(reviewRequest)).resolves.toBe(review);
    await expect(invokeExecuteDeployment(request, review)).resolves.toBe(result);
    await invokeCancelDeployment(request.operationId);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'review_deployment_execution', { request: reviewRequest });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'execute_deployment', { request });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'cancel_deployment', {
      operationId: request.operationId,
    });
  });

  it('fails closed when the backend returns a late or cross-target result', async () => {
    invokeMock.mockResolvedValueOnce({
      ...result,
      target: { ...result.target, identityDigest: 'sha256-v1:late-target' },
    });
    await expect(invokeExecuteDeployment(request, review)).rejects.toThrow(/identity does not match/);
  });
});

describe('Deployment Runbook v2 separate rollback IPC contract', () => {
  const reviewRequest: RollbackExecutionReviewRequestV2 = {
    operationId: 'rollback:ipc',
    sourceOperationId: 'deployment:source',
    profileId: 'profile-1',
    connection: {
      host: 'server.example.com',
      port: 22,
      username: 'operator',
      authMethod: 'password',
      password: 'secret',
    },
    totalTimeoutSeconds: 600,
  };
  const review: RollbackExecutionReviewV2 = {
    schemaVersion: 2,
    reviewId: 'rollback-review:ipc',
    operationId: reviewRequest.operationId,
    sourceOperationId: reviewRequest.sourceOperationId,
    sourceReviewId: 'deployment-review:source',
    sourcePhase: 'succeeded',
    documentDigest: 'sha256-v1:document',
    planDigest: 'sha256-v1:rollback-plan',
    deploymentId: 'release-2',
    applicationId: 'app',
    environment: 'production',
    version: '2.0.0',
    currentRelease: '/srv/app/releases/release-2',
    previousRelease: '/srv/app/releases/release-1',
    releasesDirectory: '/srv/app/releases',
    activeSymlink: '/srv/app/current',
    snapshotCapturedAt: 1,
    declaredRisk: 'stateChange',
    target: {
      profileId: reviewRequest.profileId,
      host: reviewRequest.connection.host,
      port: reviewRequest.connection.port,
      username: reviewRequest.connection.username,
      authMethod: reviewRequest.connection.authMethod,
      identityDigest: 'sha256-v1:target',
    },
    totalTimeoutSeconds: reviewRequest.totalTimeoutSeconds,
    actions: [],
    reviewedAt: 1,
    expiresAt: 2,
  };
  const request: RollbackExecutionRequestV2 = {
    operationId: review.operationId,
    profileId: reviewRequest.profileId,
    connection: reviewRequest.connection,
    approval: {
      reviewId: review.reviewId,
      operationId: review.operationId,
      sourceOperationId: review.sourceOperationId,
      documentDigest: review.documentDigest,
      planDigest: review.planDigest,
      targetDigest: review.target.identityDigest,
      currentRelease: review.currentRelease,
      previousRelease: review.previousRelease,
      approvedRisk: review.declaredRisk,
      authorized: true,
      destructiveConfirmed: false,
    },
  };
  const result: RollbackExecutionResultV2 = {
    schemaVersion: 2,
    operationId: review.operationId,
    reviewId: review.reviewId,
    sourceOperationId: review.sourceOperationId,
    documentDigest: review.documentDigest,
    planDigest: review.planDigest,
    deploymentId: review.deploymentId,
    version: review.version,
    target: review.target,
    phase: 'succeeded',
    startedAt: 1,
    completedAt: 2,
    actions: [],
    healthEvidence: [],
    reactivation: {
      currentRelease: review.currentRelease,
      previousRelease: review.previousRelease,
      releasesDirectory: review.releasesDirectory,
      activeSymlink: review.activeSymlink,
      activationChanged: true,
      changedAt: 2,
    },
  };

  it('does not accept caller-provided document, path, command, or action fields', async () => {
    invokeMock.mockResolvedValueOnce(review).mockResolvedValueOnce(result).mockResolvedValueOnce(undefined);

    await expect(invokeReviewRollbackExecution(reviewRequest)).resolves.toBe(review);
    await expect(invokeExecuteRollback(request, review)).resolves.toBe(result);
    await invokeCancelRollback(request.operationId);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'review_rollback_execution', { request: reviewRequest });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'execute_rollback', { request });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'cancel_rollback', {
      operationId: request.operationId,
    });
  });

  it('rejects a late cross-release rollback result', async () => {
    invokeMock.mockResolvedValueOnce({
      ...result,
      reactivation: { ...result.reactivation, currentRelease: '/srv/app/releases/release-3' },
    });
    await expect(invokeExecuteRollback(request, review)).rejects.toThrow(/separate review/);
  });
});
