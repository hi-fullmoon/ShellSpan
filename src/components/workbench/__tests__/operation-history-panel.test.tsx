import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OperationHistoryPanel } from '../operation-history-panel';
import type { OperationHistoryEvent } from '@/types/operation-history';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  settings: vi.fn(),
  retention: vi.fn(),
  clear: vi.fn(),
  export: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/lib/operation-history', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/operation-history')>();
  return {
    ...actual,
    listOperationHistory: mocks.list,
    getOperationHistorySettings: mocks.settings,
    setOperationHistoryRetention: mocks.retention,
    clearOperationHistory: mocks.clear,
    exportOperationHistory: mocks.export,
  };
});

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({
    toast: mocks.toast,
    info: mocks.toast,
    success: mocks.toast,
    error: mocks.toast,
  }),
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, variables?: Record<string, string | number>) => variables
      ? `${key}:${Object.values(variables).join(':')}`
      : key,
  }),
}));

const events: OperationHistoryEvent[] = [
  {
    eventId: 'event-started',
    taskId: 'run-1',
    operationId: 'step-1',
    occurredAt: 1_000,
    category: 'runbook',
    action: 'executeRunbookStep',
    eventKind: 'approved',
    status: 'running',
    risk: 'stateChange',
    subjectId: 'reload-service',
    targets: [{
      kind: 'remote',
      profileId: 'profile-1',
      host: 'example.test',
      port: 22,
      username: 'operator',
    }],
    evidence: [{ operationId: 'precheck-1', kind: 'runbookStep', observedAt: 900 }],
  },
  {
    eventId: 'event-finished',
    taskId: 'run-1',
    operationId: 'step-1',
    occurredAt: 2_000,
    category: 'runbook',
    action: 'executeRunbookStep',
    eventKind: 'completed',
    status: 'succeeded',
    risk: 'stateChange',
    subjectId: 'reload-service',
    targets: [{
      kind: 'remote',
      profileId: 'profile-1',
      host: 'example.test',
      port: 22,
      username: 'operator',
    }],
    commandPreview: 'systemctl reload nginx',
    evidence: [{ operationId: 'precheck-1', kind: 'runbookStep', observedAt: 900 }],
    exitCode: 0,
  },
];

describe('OperationHistoryPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({ events, totalTasks: 1, truncated: false });
    mocks.settings.mockResolvedValue({ retentionDays: 90, defaultLocalOnly: true });
    mocks.retention.mockResolvedValue(0);
    mocks.clear.mockResolvedValue(2);
    mocks.export.mockResolvedValue('C:/exports/history.md');
  });

  it('renders task summaries and a traceable detail timeline without raw output', async () => {
    render(<OperationHistoryPanel />);

    expect(await screen.findByText('operationHistory.action.executeRunbookStep')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'operationHistory.title' });
    expect(within(table).getByRole('columnheader', { name: 'operationHistory.action' })).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText((content) => content.includes('operator@example.test:22'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'operationHistory.viewDetails' }));

    expect(await screen.findByText('systemctl reload nginx')).toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass(
      'max-h-[min(720px,calc(100vh-2rem))]',
      'gap-0',
      'overflow-hidden',
      'p-0',
    );
    const timelineContent = dialog.querySelector<HTMLElement>('[data-slot="operation-history-timeline-content"]');
    expect(timelineContent).toHaveClass('overflow-y-auto', 'px-6', 'py-4');
    expect(screen.getAllByText(/precheck-1/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('step-1').length).toBeGreaterThan(0);
    expect(screen.queryByText(/raw high-sensitive output/)).not.toBeInTheDocument();
  });

  it('exports the current filtered view in both redacted formats', async () => {
    render(<OperationHistoryPanel />);
    await screen.findByText('operationHistory.action.executeRunbookStep');

    fireEvent.click(screen.getByRole('button', { name: /Markdown/ }));
    await waitFor(() => expect(mocks.export).toHaveBeenCalledWith('markdown', expect.any(Object)));
    expect(mocks.toast).toHaveBeenCalledWith(
      'operationHistory.exported:C:/exports/history.md',
    );
  });

  it('requires confirmation before clearing all local history', async () => {
    render(<OperationHistoryPanel />);
    await screen.findByText('operationHistory.action.executeRunbookStep');

    fireEvent.click(screen.getByRole('button', { name: 'operationHistory.clear' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveClass('max-h-[min(720px,calc(100vh-2rem))]', 'overflow-hidden');
    const confirm = within(dialog).getByRole('button', { name: 'operationHistory.clearConfirm' });
    expect(confirm).toHaveClass('bg-destructive');
    fireEvent.click(confirm);

    await waitFor(() => expect(mocks.clear).toHaveBeenCalledOnce());
    expect(mocks.toast).toHaveBeenCalledWith('operationHistory.cleared:2');
  });
});
