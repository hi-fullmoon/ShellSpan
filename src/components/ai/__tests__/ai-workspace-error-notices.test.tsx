import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AiWorkspaceErrorNotices } from '../workspace/ai-workspace-error-notices';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';

afterEach(cleanup);

describe('localized workspace errors', () => {
  it.each(['zh-CN', 'en-US'] as const)('renders image errors in %s without changing diagnostics or drafts', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const message = 'IMAGE_MODEL_UNSUPPORTED: image input is not enabled for this model';
    const error = { kind: 'unknown' as const, message, retryable: true };
    const state = createAiComposerState({
      phase: 'error', lastError: error,
      failedDrafts: [{ id: 'failed-image', content: message, mode: 'nextTurn', error }],
    });
    render(<AiWorkspaceErrorNotices composerState={state} />);
    expect(screen.getByText(t('ai.workspace.images.error.model'))).toBeVisible();
    expect(state.lastError?.message).toBe(message);
    // User-authored draft content is not treated as an error code.
    expect(screen.getByText(message)).toBeVisible();
  });
});
