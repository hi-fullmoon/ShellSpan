import type { AiContextUsage } from './session-adapter';

export interface DocumentBudgetModel {
  readonly contextWindow: number;
  readonly maxOutputTokens?: number;
  readonly requestOutputTokens?: number;
}

export interface DocumentContextBudgetAssessment {
  readonly exceeds: boolean;
  readonly estimatedTokens: number;
  readonly availableInputTokens: number;
  readonly contextWindow: number;
}

/** Mirrors `llm::catalog::model_input_token_budget` and `requestOutputTokenBudget`. */
export function modelUsableInputTokens(
  model: DocumentBudgetModel,
  committedUsableInputTokens?: number,
): number | undefined {
  if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) return undefined;
  if (
    committedUsableInputTokens !== undefined
    && Number.isFinite(committedUsableInputTokens)
    && committedUsableInputTokens > 0
  ) {
    return committedUsableInputTokens;
  }
  const outputCap = Math.min(16_384, Math.max(1, Math.floor(model.contextWindow / 8)));
  const outputReserve = model.requestOutputTokens
    ?? (model.maxOutputTokens !== undefined ? Math.min(model.maxOutputTokens, outputCap) : outputCap);
  const safetyReserve = Math.max(1_024, Math.floor(model.contextWindow / 20));
  const usable = model.contextWindow - outputReserve - safetyReserve;
  return usable >= 2 ? usable : undefined;
}

/** Mirrors `agent_runtime::budget`: conservative 4 bytes/token + per-message framing reserve. */
export function estimateDraftTokens(rawMessage: string): number {
  const bytes = new TextEncoder().encode(rawMessage).byteLength;
  return Math.ceil(bytes / 4) + 8;
}

/** Pre-send check for composer drafts containing document attachments.
 * Prevents oversized document messages from entering durable history when the
 * selected model's context window cannot fit them. */
export function assessDocumentContextBudget(input: {
  readonly rawDraft: string;
  readonly hasDocuments: boolean;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly requestOutputTokens?: number;
  readonly contextUsage?: AiContextUsage;
}): DocumentContextBudgetAssessment | null {
  if (!input.hasDocuments) return null;
  const contextWindow = input.contextWindow ?? input.contextUsage?.contextWindow;
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  const sameModelUsage = input.contextUsage?.contextWindow === contextWindow ? input.contextUsage : undefined;
  const usableInputTokens = modelUsableInputTokens(
    {
      contextWindow,
      maxOutputTokens: input.maxOutputTokens,
      requestOutputTokens: input.requestOutputTokens,
    },
    sameModelUsage?.requestBudget?.usableInputTokens,
  );
  if (usableInputTokens === undefined) return null;
  const fixedOverhead = sameModelUsage?.breakdown
    ? sameModelUsage.breakdown.systemTokens + sameModelUsage.breakdown.toolsTokens
    : 0;
  const availableInputTokens = Math.max(0, usableInputTokens - fixedOverhead);
  const estimatedTokens = estimateDraftTokens(input.rawDraft);
  return {
    exceeds: estimatedTokens > availableInputTokens,
    estimatedTokens,
    availableInputTokens,
    contextWindow,
  };
}
