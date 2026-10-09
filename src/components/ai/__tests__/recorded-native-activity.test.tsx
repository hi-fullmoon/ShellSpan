import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectAgentActivity } from '@/lib/ai/agent-session-projection';
import type { AgentSessionEvent } from '@/types/agent-session';

const fixture = process.env.SHELLSPAN_STAGE2_ACTIVITY_FIXTURE;
describe.skipIf(!fixture)('actual child background cancellation recording', () => {
  it('does not present a durably cancelled detached child as running', () => {
    const directory = join(resolve(fixture!), 'fixture/agent-runtime/sessions-v5');
    const pages = readdirSync(directory).filter(name => name.endsWith('.jsonl')).map(name => (
      readFileSync(join(directory, name), 'utf8').trim().split('\n').map(line => JSON.parse(line) as AgentSessionEvent)
    ));
    const parent = pages.find(page => page.some(event => event.type === 'subagent/detached' && event.data.reason === 'cancelCascade'));
    if (!parent) throw new Error('Actual Wry cancelCascade recording required');
    const cancelledIds = parent.flatMap(event => event.type === 'subagent/detached' && event.data.reason === 'cancelCascade' ? [event.data.childSessionId] : []);
    const projection = projectAgentActivity(parent);
    for (const id of cancelledIds) {
      expect(projection.agents.find(child => child.sessionId === id)?.status).toBe('cancelled');
      const child = pages.find(page => page[0]?.sessionId === id);
      expect(child?.some(event => event.type === 'session/ended' && event.data.status === 'cancelled')).toBe(true);
    }
  });
});
