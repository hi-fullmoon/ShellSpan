import { describe, expect, it } from 'vitest';
import {
  assessDocumentContextBudget,
  estimateDraftTokens,
  modelUsableInputTokens,
} from '../document-budget';
import { encodeDocumentMessage } from '../document-message';
import type { AiContextUsage } from '../session-adapter';

describe('document context budget assessment', () => {
  it('returns null when no documents are attached or context window is unknown', () => {
    expect(assessDocumentContextBudget({
      rawDraft: 'x'.repeat(40_000),
      hasDocuments: false,
      contextWindow: 8_192,
    })).toBeNull();

    expect(assessDocumentContextBudget({
      rawDraft: 'x'.repeat(40_000),
      hasDocuments: true,
    })).toBeNull();
  });

  it('matches backend usable input formula and flags oversized drafts on small-context models', () => {
    expect(modelUsableInputTokens({ contextWindow: 8_192 })).toBe(6_144);
    const rawDraft = encodeDocumentMessage('Summarize', [{
      id: 'doc-1',
      name: 'notes.txt',
      size: 30_720,
      text: 'a'.repeat(30_720),
    }]);

    const small = assessDocumentContextBudget({
      rawDraft,
      hasDocuments: true,
      contextWindow: 8_192,
    });
    expect(small).not.toBeNull();
    expect(small?.availableInputTokens).toBe(6_144);
    expect(small?.estimatedTokens).toBe(estimateDraftTokens(rawDraft));
    expect(small?.exceeds).toBe(true);

    const large = assessDocumentContextBudget({
      rawDraft,
      hasDocuments: true,
      contextWindow: 128_000,
    });
    expect(large?.exceeds).toBe(false);
  });

  it('accounts for committed system/tool overhead only when contextUsage matches the active model', () => {
    const rawDraft = encodeDocumentMessage('Check', [{
      id: 'doc-1',
      name: 'notes.txt',
      size: 16_000,
      text: 'b'.repeat(16_000),
    }]);
    const usage: AiContextUsage = {
      contextWindow: 8_192,
      source: 'reported',
      usedTokens: 2_000,
      requestBudget: {
        outputTokens: 1_024,
        safetyTokens: 1_024,
        usableInputTokens: 6_144,
        compactionThresholdTokens: 5_222,
        compactionTargetTokens: 3_686,
      },
      breakdown: {
        systemTokens: 1_500,
        toolsTokens: 1_000,
        messageTokens: 500,
      },
    };

    const matching = assessDocumentContextBudget({
      rawDraft,
      hasDocuments: true,
      contextWindow: 8_192,
      contextUsage: usage,
    });
    expect(matching?.availableInputTokens).toBe(6_144 - 2_500);
    expect(matching?.exceeds).toBe(true);

    // Switching to a larger model must ignore stale 8k breakdown/requestBudget.
    const switched = assessDocumentContextBudget({
      rawDraft,
      hasDocuments: true,
      contextWindow: 128_000,
      contextUsage: usage,
    });
    expect(switched?.availableInputTokens).toBe(modelUsableInputTokens({ contextWindow: 128_000 }));
    expect(switched?.exceeds).toBe(false);
  });

  it('respects explicit requestOutputTokens and maxOutputTokens overrides', () => {
    expect(modelUsableInputTokens({ contextWindow: 16_384, maxOutputTokens: 1_024 })).toBe(
      16_384 - 1_024 - 1_024,
    );
    expect(modelUsableInputTokens({
      contextWindow: 16_384,
      maxOutputTokens: 8_192,
      requestOutputTokens: 4_096,
    })).toBe(16_384 - 4_096 - 1_024);
  });
});
