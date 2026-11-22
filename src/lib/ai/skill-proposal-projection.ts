import type { AgentSessionEvent } from '@/types/agent-session';
import {
  skillProposalKey,
  type AgentSkillProposalView,
} from '@/types/agent-skill';
import { createCommittedEventProjection } from './committed-event-projection';

export function projectSkillProposals(
  events: readonly AgentSessionEvent[],
): readonly AgentSkillProposalView[] {
  const projection = createSkillProposalProjection();
  for (const event of events) projection.apply(event);
  return projection.snapshot();
}

export function createSkillProposalProjector(): (
  events: readonly AgentSessionEvent[],
) => readonly AgentSkillProposalView[] {
  return createCommittedEventProjection(createSkillProposalProjection);
}

export function createSkillProposalProjection() {
  const proposals = new Map<string, AgentSkillProposalView>();
  const apply = (event: AgentSessionEvent): void => {
    if (event.type === 'skill/proposal_requested') {
      proposals.set(skillProposalKey(event.data.identity), {
        identity: event.data.identity,
        proposal: event.data.proposal,
        status: 'pending',
        firstSeq: event.seq,
        lastSeq: event.seq,
        timestamp: new Date(event.timeUnixMs).toISOString(),
      });
    } else if (event.type === 'skill/proposal_resolved') {
      const key = skillProposalKey(event.data.resolution.identity);
      const previous = proposals.get(key);
      if (previous) {
        proposals.set(key, {
          ...previous,
          lastSeq: event.seq,
          status: 'resolved',
          resolution: event.data.resolution,
        });
      }
    } else if (event.type === 'skill/proposal_cancelled') {
      const key = skillProposalKey(event.data.identity);
      const previous = proposals.get(key);
      if (previous) {
        proposals.set(key, {
          ...previous,
          lastSeq: event.seq,
          status: 'cancelled',
        });
      }
    }
  };
  return {
    apply,
    get: (key: string) => proposals.get(key),
    snapshot: () => [...proposals.values()],
  };
}
