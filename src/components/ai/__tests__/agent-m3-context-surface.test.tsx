import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentTaskSnapshotV3 } from '@/types/agent-v3';

const mocks = vi.hoisted(() => ({
  rollout: vi.fn(),
  listTasks: vi.fn(),
  getTask: vi.fn(),
  refreshContext: vi.fn(),
  refreshExtensions: vi.fn(),
  compactContext: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  isTauriRuntime: () => true,
  invokeAgentV3RolloutPolicy: mocks.rollout,
  invokeAgentV3ListTasks: mocks.listTasks,
  invokeAgentV3GetTask: mocks.getTask,
  invokeAgentV3RefreshContext: mocks.refreshContext,
  invokeAgentV3RefreshExtensions: mocks.refreshExtensions,
  invokeAgentV3CompactContext: mocks.compactContext,
}));

import { AgentM3ContextSurface } from '@/components/ai/agent-m3-context-surface';

const task: AgentTaskSnapshotV3 = {
  request: {
    contractVersion: 3,
    requestId: 'req-m3',
    userSessionId: 'user-m3',
    taskId: 'task-m3',
    goal: 'Inspect context',
    successCriteria: ['Evidence is visible'],
    targets: [{
      kind: 'local',
      targetId: 'local-m3',
      sessionId: 'session-m3',
      cwd: 'C:/workspace',
    }],
    permissionMode: 'requestApproval',
    sourceContract: 'v3',
  },
  state: 'active',
  sequence: 1,
  results: [],
  processes: [],
  checkpoints: [],
  context: {
    generation: 2,
    fragments: [{
      fragmentId: 'workspace-agents',
      layer: 'workspace',
      sourceKind: 'projectInstruction',
      source: 'AGENTS.md',
      scope: { workspaceRoot: 'C:/workspace', taskId: 'task-m3' },
      priority: 100,
      overrides: [],
      trust: 'projectScoped',
      sensitivity: 'internal',
      instructionEligible: true,
      untrusted: false,
      byteLength: 40,
      estimatedTokens: 10,
      preview: 'Run the smallest relevant test.',
    }],
    artifacts: [{
      artifactId: 'ctx-1',
      kind: 'structuredCompaction',
      mediaType: 'application/json',
      byteLength: 256,
      sha256: 'a'.repeat(64),
      createdAtUnixMs: 1,
    }],
    usage: {
      sourceBytes: 40,
      modelVisibleBytes: 40,
      estimatedInputTokens: 10,
      costReason: 'model pricing unavailable',
    },
    compactionReason: 'manual',
  },
  extensions: {
    generation: 2,
    workspaceLoaded: true,
    skills: [],
    hooks: ['bounded-hook'],
    runbooks: [],
    recentHookEvents: [],
  },
  mcpServers: [{
    id: 'fixture',
    transport: 'stdio',
    enabled: true,
    health: 'configured',
    usesNativeCredentials: true,
    tools: [],
    failureCount: 0,
  }],
  mcpResults: [],
  recovery: {
    disposition: 'safeToResume',
    phase: 'running',
    progressCompleted: 0,
    progressTotal: 0,
    calls: [],
    processes: [],
    recoveryAdvice: 'Fresh native authorization is required.',
    requiresHumanAction: false,
    requiresSessionRebind: false,
  },
  notifications: [],
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rollout.mockResolvedValue({
    stage: 'runtime',
    contractAvailable: true,
    executionContractVersion: 3,
    rollbackContractVersion: 2,
  });
  mocks.listTasks.mockResolvedValue([task]);
});

describe('Agent M3 context and fee viewer', () => {
  it('shows hierarchy, provenance, omission-safe usage, artifacts, and extension state', async () => {
    const user = userEvent.setup();
    render(<AgentM3ContextSurface />);

    expect(await screen.findByText('Context & fee viewer')).toBeInTheDocument();
    expect(screen.getByText(/~10 input tokens/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('AGENTS.md')).toBeInTheDocument();
    expect(screen.getByText('projectInstruction')).toBeInTheDocument();
    expect(screen.getByText(/instruction eligible/)).toBeInTheDocument();
    expect(screen.getByText('1 artifacts')).toBeInTheDocument();
    expect(screen.getByText('1 hooks')).toBeInTheDocument();
    expect(screen.getByText('MCP fixture: configured')).toBeInTheDocument();
    expect(screen.queryByText(/fixture-token/)).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.listTasks).toHaveBeenCalledTimes(1));
  });
});
