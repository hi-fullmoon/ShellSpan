import { describe, expect, it } from 'vitest';
import { ApprovalDecisionGuard } from '../approval-decision';

describe('ApprovalDecisionGuard', () => {
  it.each(['approve', 'reject'] as const)('blocks repeated and opposite decisions synchronously during %s', decision => {
    const guard = new ApprovalDecisionGuard();
    const context = {};
    expect(guard.begin(context, 'approval', decision)).not.toBeNull();
    expect(guard.begin(context, 'approval', 'approve')).toBeNull();
    expect(guard.begin(context, 'approval', 'reject')).toBeNull();
  });

  it('allows retry after the current request fails and ignores an older attempt', () => {
    const guard = new ApprovalDecisionGuard();
    const context = {};
    const first = guard.begin(context, 'approval', 'approve')!;
    expect(guard.fail(first, context, 'approval')).toBe(true);
    const retry = guard.begin(context, 'approval', 'reject')!;
    expect(guard.fail(first, context, 'approval')).toBe(false);
    expect(guard.begin(context, 'approval', 'approve')).toBeNull();
    expect(guard.fail(retry, context, 'approval')).toBe(true);
  });

  it.each(['session', 'approval', 'visit'] as const)('ignores delayed failure after changing %s', change => {
    const guard = new ApprovalDecisionGuard();
    const context = {};
    const first = guard.begin(context, 'approval', 'approve')!;
    const nextContext = change === 'approval' ? context : {};
    const nextKey = change === 'visit' ? 'approval' : 'next-approval';
    expect(guard.fail(first, nextContext, nextKey)).toBe(false);
    const next = guard.begin(nextContext, nextKey, 'reject')!;
    expect(guard.fail(first, nextContext, nextKey)).toBe(false);
    expect(guard.begin(nextContext, nextKey, 'approve')).toBeNull();
    expect(guard.fail(next, nextContext, nextKey)).toBe(true);
  });

  it('ignores failure after approval disappears and after leaving and returning to the same approval', () => {
    const guard = new ApprovalDecisionGuard();
    const context = {};
    const first = guard.begin(context, 'approval', 'approve')!;
    expect(guard.fail(first, context, null)).toBe(false);
    guard.reset();
    const returned = guard.begin(context, 'approval', 'reject')!;
    expect(guard.fail(first, context, 'approval')).toBe(false);
    expect(guard.begin(context, 'approval', 'approve')).toBeNull();
    expect(guard.fail(returned, context, 'approval')).toBe(true);
  });

  it('invalidates in-flight requests on cleanup', () => {
    const guard = new ApprovalDecisionGuard();
    const context = {};
    const request = guard.begin(context, 'approval', 'approve')!;
    guard.reset();
    expect(guard.fail(request, context, 'approval')).toBe(false);
  });
});
