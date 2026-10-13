import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TransferProgress } from '../transfer-progress';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { cancelQueuedPathOperation, runPathOperation, useTransferStore, type TransferOperation } from '@/stores/transferStore';

describe('compact transfer queue with the real scheduler', () => {
  it.each([
    { locale: 'zh-CN' as const, expand: '展开任务队列', collapse: '收起任务队列', waiting: '2 等待', remove: '移除' },
    { locale: 'en-US' as const, expand: 'Expand task queue', collapse: 'Collapse task queue', waiting: '2 waiting', remove: 'Remove' },
  ])('preserves queued tasks through keyboard expansion and removal ($locale)', async ({ locale, expand, collapse, waiting, remove }) => {
    useTransferStore.setState({ operations: [] });
    useAppStore.setState({ locale });
    await initI18n(locale);
    const user = userEvent.setup();
    const scopes = [{ connectionId: `layout-${locale}`, paths: ['/queue-layout'] }];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const executed: string[] = [];
    const tasks: Promise<void | undefined>[] = [];
    const enqueue = (name: string) => {
      const operationId = `${locale}-${name}`;
      const operation: TransferOperation = {
        operationId, kind: 'upload', pathScopes: scopes, currentPath: name,
        totalBytes: 0, processedBytes: 0, totalSteps: 0, completedSteps: 0,
        cancel: async () => {
          cancelQueuedPathOperation(operationId);
          useTransferStore.getState().removeOperation(operationId);
        },
      };
      tasks.push(runPathOperation(scopes, async () => {
        executed.push(name);
        useTransferStore.getState().addOperation({ ...operation, status: 'running' });
        await gate;
        useTransferStore.getState().markOperationCompleted(operationId);
      }, {
        queueKey: operationId,
        onQueued: () => useTransferStore.getState().addOperation({ ...operation, pathScopes: undefined, status: 'pending' }),
      }));
    };

    try {
      enqueue('active');
      await Promise.resolve();
      enqueue('first-waiting');
      enqueue('second-waiting');
      render(<TransferProgress />);
      expect(screen.getByText('active')).toBeInTheDocument();
      expect(screen.queryByText('first-waiting')).not.toBeInTheDocument();
      const toggle = screen.getByRole('button', { name: expand });
      expect(toggle).toHaveTextContent(waiting);
      expect(toggle).toHaveClass('hover:bg-accent', 'focus-visible:ring-2', 'h-6');
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      const queue = document.getElementById(toggle.getAttribute('aria-controls')!);
      expect(queue).toHaveClass('max-h-64', 'overflow-y-auto');
      expect(queue).not.toHaveClass('border-t');
      expect(queue).not.toBeVisible();

      toggle.focus();
      await user.keyboard('{Enter}');
      expect(screen.getByRole('button', { name: collapse })).toHaveAttribute('aria-expanded', 'true');
      expect(queue).toBeVisible();
      const row = screen.getByText('first-waiting').closest('[data-slot="transfer-task-row"]')!;
      expect(row).toHaveClass('min-h-8', 'flex-wrap');
      for (const taskRow of document.querySelectorAll('[data-slot="transfer-task-row"]')) {
        expect(taskRow).toHaveClass('border-b', 'border-app-border/50', 'last:border-b-0');
      }
      await user.click(within(row as HTMLElement).getByRole('button', { name: remove }));
      expect(screen.queryByText('first-waiting')).not.toBeInTheDocument();
      expect(useTransferStore.getState().operations.filter((op) => op.status === 'pending')).toHaveLength(1);
      await user.click(screen.getByRole('button', { name: collapse }));
      expect(screen.queryByText('second-waiting')).not.toBeInTheDocument();
      expect(useTransferStore.getState().operations).toHaveLength(2);
      await act(async () => {
        release();
        await Promise.all(tasks);
      });
      await waitFor(() => expect(executed).toEqual(['active', 'second-waiting']));
    } finally {
      release();
      await Promise.all(tasks);
      useTransferStore.setState({ operations: [] });
    }
  });
});

describe('transfer queue task transitions', () => {
  const operation = (operationId: string, status: TransferOperation['status']): TransferOperation => ({
    operationId, kind: 'remote-copy', currentPath: operationId, status,
    totalBytes: 0, processedBytes: 0, totalSteps: 0, completedSteps: 0,
  });

  it('keeps the current task when another starts and keeps toggle focus when the current task ends', async () => {
    await initI18n('zh-CN');
    useAppStore.setState({ locale: 'zh-CN' });
    useTransferStore.setState({ operations: [] });
    useTransferStore.getState().addOperation(operation('first', 'running'));
    render(<TransferProgress />);
    act(() => {
      useTransferStore.getState().addOperation(operation('second', 'running'));
      useTransferStore.getState().addOperation(operation('third', 'pending'));
    });
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.queryByText('second')).not.toBeInTheDocument();
    const user = userEvent.setup();
    const toggle = screen.getByRole('button', { name: '展开任务队列' });
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveFocus();
    act(() => useTransferStore.getState().markOperationCompleted('first'));
    expect(screen.getByText('second').closest('[data-slot="transfer-task-row"]')).toBe(document.querySelector('[data-slot="transfer-task-row"]'));
    expect(screen.getByRole('button', { name: '收起任务队列' })).toHaveFocus();
    expect(screen.getByText('third')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(screen.queryByText('third')).not.toBeInTheDocument();
    act(() => useTransferStore.setState({ operations: [] }));
  });

  it('retains a cancelling task and allows closing it only after cancellation finishes', async () => {
    await initI18n('zh-CN');
    useAppStore.setState({ locale: 'zh-CN' });
    useTransferStore.setState({ operations: [operation('first', 'running')] });
    render(<TransferProgress />);
    expect(screen.queryByRole('button', { name: '关闭' })).not.toBeInTheDocument();
    act(() => {
      useTransferStore.setState((state) => ({ operations: state.operations.map((op) => ({ ...op, status: 'cancelling' })) }));
      useTransferStore.getState().addOperation(operation('second', 'running'));
    });
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('正在取消')).toBeInTheDocument();
    expect(screen.queryByText('second')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '关闭' })).not.toBeInTheDocument();
    act(() => useTransferStore.getState().markOperationCancelled('first'));
    await userEvent.setup().click(screen.getByRole('button', { name: '展开任务队列' }));
    expect(screen.getByText('已撤销')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: '关闭' }));
    expect(useTransferStore.getState().operations.map((op) => op.operationId)).toEqual(['second']);
    act(() => useTransferStore.setState({ operations: [] }));
  });

  it('shows the oldest pending task ahead of finished tasks and removes a queued scheduler request without a cancel callback', async () => {
    await initI18n('zh-CN');
    useAppStore.setState({ locale: 'zh-CN' });
    useTransferStore.setState({ operations: [] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const scope = [{ connectionId: 'pending-removal', paths: ['/queued-task'] }];
    const executed: string[] = [];
    const first = runPathOperation(scope, () => gate);
    const queued = runPathOperation(scope, () => { executed.push('oldest'); }, {
      queueKey: 'oldest',
      onQueued: () => useTransferStore.getState().addOperation(operation('oldest', 'pending')),
    });
    useTransferStore.getState().addOperation(operation('newest', 'pending'));
    useTransferStore.getState().addOperation(operation('finished', 'completed'));
    render(<TransferProgress />);
    expect(screen.getByText('oldest')).toBeInTheDocument();
    expect(screen.queryByText('finished')).not.toBeInTheDocument();
    try {
      await userEvent.setup().click(screen.getByRole('button', { name: '移除' }));
      expect(screen.getByText('newest')).toBeInTheDocument();
      expect(useTransferStore.getState().operations.some((op) => op.operationId === 'oldest')).toBe(false);
    } finally {
      await act(async () => { release(); await Promise.all([first, queued]); });
      act(() => useTransferStore.setState({ operations: [] }));
    }
    expect(executed).toEqual([]);
  });

  it('shows completed cancellation for deletes instead of leaving them in the cancelling state', async () => {
    await initI18n('zh-CN');
    useAppStore.setState({ locale: 'zh-CN' });
    useTransferStore.setState({ operations: [{ ...operation('delete', 'cancelled'), kind: 'delete' }] });
    render(<TransferProgress />);
    expect(screen.getByText('已撤销')).toBeInTheDocument();
    expect(screen.queryByText('正在撤销')).not.toBeInTheDocument();
    act(() => useTransferStore.setState({ operations: [] }));
  });

  it('does not cancel the next task if the current task completes while its cancel button is pressed', async () => {
    await initI18n('zh-CN');
    useAppStore.setState({ locale: 'zh-CN' });
    useTransferStore.setState({ operations: [] });
    const cancelled: string[] = [];
    const cancellable = (id: string): TransferOperation => ({
      ...operation(id, 'running'),
      cancel: async () => {
        cancelled.push(id);
        useTransferStore.getState().markOperationCancelled(id);
      },
    });
    useTransferStore.getState().addOperation(cancellable('first'));
    render(<TransferProgress />);
    act(() => useTransferStore.getState().addOperation(cancellable('second')));
    const user = userEvent.setup();
    const cancel = screen.getByRole('button', { name: '取消' });
    await user.pointer({ target: cancel, keys: '[MouseLeft>]' });
    act(() => useTransferStore.getState().markOperationCompleted('first'));
    expect(screen.getByText('second')).toBeInTheDocument();
    await user.pointer({ target: screen.getByRole('button', { name: '取消' }), keys: '[/MouseLeft]' });
    expect(cancelled).toEqual([]);
    expect(useTransferStore.getState().operations.find((op) => op.operationId === 'second')?.status).toBe('running');
    act(() => useTransferStore.setState({ operations: [] }));
  });
});
