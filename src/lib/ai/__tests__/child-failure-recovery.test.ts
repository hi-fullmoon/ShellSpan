import { describe, expect, it } from 'vitest';
import Ajv from 'ajv/dist/2020.js';
import schema from '../../../../protocol/agent/runtime/event-v5.schema.json';
import { latestFailureRecovery, modelRetryConfirmation } from '../failure-recovery';
import {
  childAdmittedEvents, childFailureRecordedAt, recordedChildAdmittedView, recordedChildFailureView,
} from '@/test/fixtures/child-recovery-recording';

describe('recorded child failure recovery', () => {
  it('offers recovery after completed tools while retaining their results and plan', () => {
    const before = recordedChildFailureView();
    expect(before.snapshot.value.ended).toBe(true);
    expect(before.snapshot.value.childFailureRecovery?.retryable).toBe(true);
    expect(latestFailureRecovery(before, childFailureRecordedAt)).toEqual({ kind: 'retry', turnId: 'failure-turn' });
    const after = recordedChildAdmittedView();
    expect(after.snapshot.value.ended).toBe(false);
    expect(after.snapshot.value.header).toEqual(before.snapshot.value.header);
    expect(after.snapshot.value.surface).toEqual(before.snapshot.value.surface);
    expect(after.snapshot.value.task.plan).toEqual(before.snapshot.value.task.plan);
    expect(after.inbox).toHaveLength(1);
    expect(after.inbox[0]).toMatchObject({ clientSubmissionId: 'child-retry-failure-turn', source: 'runtime', state: 'queued', paused: false });
    expect(after.committedOperationIds).toContain('child-retry-failure-turn');
    expect(modelRetryConfirmation(before, 'failure-turn')(after)).toBe(true);
    expect(latestFailureRecovery(after, childFailureRecordedAt)).toBeNull();
    expect(after.nodes.filter(node => node.kind === 'userMessage')).toHaveLength(before.nodes.filter(node => node.kind === 'userMessage').length);
  });

  it('hides recovery when the native eligibility is missing or the deadline has passed', () => {
    const before = recordedChildFailureView();
    expect(latestFailureRecovery({ ...before, snapshot: { ...before.snapshot,
      value: { ...before.snapshot.value, childFailureRecovery: undefined } } }, childFailureRecordedAt)).toBeNull();
    expect(latestFailureRecovery({ ...before, status: 'cancelled' }, childFailureRecordedAt)).toBeNull();
    expect(latestFailureRecovery({ ...before, snapshot: { ...before.snapshot,
      value: { ...before.snapshot.value, uncertainNativeEffects: true } } }, childFailureRecordedAt)).toBeNull();
    const { createdAtUnixMs, subagent } = before.snapshot.value.header;
    expect(latestFailureRecovery(before, createdAtUnixMs + subagent!.budget.timeoutMs)).toBeNull();
  });

  it('validates the real recovery event against the wire schema and admits exactly once', () => {
    const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);
    for (const event of childAdmittedEvents) {
      expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    }
    const recovery = childAdmittedEvents.filter(event => event.type === 'subagent/recovery_started');
    expect(recovery).toHaveLength(1);
    expect(recovery[0].type === 'subagent/recovery_started' && recovery[0].data.message.messageId).toBe('child-retry-failure-turn');
  });
});
