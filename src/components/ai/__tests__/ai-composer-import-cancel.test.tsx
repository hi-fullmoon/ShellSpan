import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

vi.mock('../workspace/use-document-import', () => ({
  useDocumentImport: () => ({
    busy: true,
    pending: [],
    cancel: vi.fn(),
    addFrom: vi.fn(),
    addFiles: vi.fn(),
    addPaths: vi.fn(),
  }),
}));

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});
afterEach(cleanup);

describe('composer document import', () => {
  it('does not show a separate cancel row before the pending card appears', () => {
    render(<AiComposerSeat phase="active" status="idle" />);
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });
});
