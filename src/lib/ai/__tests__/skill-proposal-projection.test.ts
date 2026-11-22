import { describe, expect, it } from 'vitest';
import { projectSkillProposals } from '../skill-proposal-projection';
import type { AgentSessionEvent } from '@/types/agent-session';
import type { PreparedSkillProposal, SkillProposalIdentity } from '@/types/agent-skill';

const identity: SkillProposalIdentity = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  stepId: 'step-1',
  requestId: 'req-1',
  callId: 'call-1',
  proposalId: 'prop-1',
};

const proposal: PreparedSkillProposal = {
  mode: 'create',
  scope: 'user',
  workspaceAllowed: false,
  name: 'deploy-orders',
  description: 'Deploy orders service safely',
  instructions: '# Deploy Orders\n1. Check health\n',
  userInvocable: true,
  disableModelInvocation: true,
  summary: 'Captured deploy checklist',
  overwritesBuiltin: false,
  shadowedByWorkspace: false,
  validationIssues: [],
};

const base = {
  version: 5 as const,
  sessionId: 'session-1',
  timeUnixMs: 1_700_000_000_000,
  turnId: 'turn-1',
  stepId: 'step-1',
};

describe('projectSkillProposals', () => {
  it('projects pending, resolved, and cancelled skill proposals', () => {
    const requested: AgentSessionEvent = {
      ...base,
      seq: 1,
      type: 'skill/proposal_requested',
      data: {
        identity,
        proposal,
        provider: { routeId: 'r1', modelId: 'm1' },
      },
    };
    const pending = projectSkillProposals([requested]);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe('pending');
    expect(pending[0]?.proposal.name).toBe('deploy-orders');

    const resolved: AgentSessionEvent = {
      ...base,
      seq: 2,
      type: 'skill/proposal_resolved',
      data: {
        resolution: {
          identity,
          clientOperationId: 'op-save',
          action: 'save',
          saved: {
            scope: 'user',
            name: 'deploy-orders',
            relativePath: 'user/deploy-orders/SKILL.md',
            fileHash: 'a'.repeat(64),
            editedByUser: false,
          },
        },
        fingerprint: 'b'.repeat(64),
      },
    };
    const afterResolve = projectSkillProposals([requested, resolved]);
    expect(afterResolve[0]?.status).toBe('resolved');
    expect(afterResolve[0]?.resolution?.action).toBe('save');

    const cancelled: AgentSessionEvent = {
      ...base,
      seq: 2,
      type: 'skill/proposal_cancelled',
      data: { identity },
    };
    const afterCancel = projectSkillProposals([requested, cancelled]);
    expect(afterCancel[0]?.status).toBe('cancelled');
  });
});
