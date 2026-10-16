export type ApprovalDecision = 'approve' | 'reject';

export interface ApprovalDecisionRequest {
  readonly context: object;
  readonly key: string;
  readonly decision: ApprovalDecision;
}

/** Owns the synchronous admission lock as well as failure ownership. */
export class ApprovalDecisionGuard {
  private request: ApprovalDecisionRequest | null = null;

  begin(context: object, key: string, decision: ApprovalDecision): ApprovalDecisionRequest | null {
    if (this.request?.context === context && this.request.key === key) return null;
    const request = { context, key, decision };
    this.request = request;
    return request;
  }

  fail(request: ApprovalDecisionRequest, context: object, key: string | null): boolean {
    if (this.request !== request || request.context !== context || request.key !== key) return false;
    this.request = null;
    return true;
  }

  reset(): void { this.request = null; }
}
