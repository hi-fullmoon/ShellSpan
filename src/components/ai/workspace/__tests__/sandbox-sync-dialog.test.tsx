import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as tauri from '@/lib/ipc/tauri';
import { SandboxSyncDialog } from '../sandbox-sync-dialog';

describe('SandboxSyncDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('stays hidden when the sandbox session has no imported source baseline', async () => {
    vi.spyOn(tauri, 'invokeSandboxDiff').mockResolvedValue(null);
    const { container } = render(<SandboxSyncDialog sessionId="session-blank" />);
    await waitFor(() => expect(tauri.invokeSandboxDiff).toHaveBeenCalledWith('session-blank'));
    expect(container).toBeEmptyDOMElement();
  });

  it('displays changes, disables conflicted items, and applies selected paths', async () => {
    const user = userEvent.setup();
    const diffSpy = vi.spyOn(tauri, 'invokeSandboxDiff').mockResolvedValue({
      sourceRoot: '/Users/demo/project',
      totalChanges: 2,
      conflictCount: 1,
      changes: [
        { path: 'src/app.ts', kind: 'modified', conflict: false, sandboxSize: 42, sourceSize: 40 },
        { path: 'README.md', kind: 'modified', conflict: true, sandboxSize: 12, sourceSize: 14 },
      ],
    });
    const applySpy = vi.spyOn(tauri, 'invokeSandboxApply').mockResolvedValue({
      applied: ['src/app.ts'],
      skippedConflicts: [],
      errors: [],
    });
    const fileDiffSpy = vi.spyOn(tauri, 'invokeSandboxFileDiff').mockResolvedValue({
      path: 'src/app.ts',
      isBinary: false,
      truncated: false,
      unifiedDiff: '@@ -1 +1 @@\n-export const v = 1;\n+export const v = 2;\n',
    });

    render(<SandboxSyncDialog sessionId="session-imported" />);
    const trigger = await screen.findByRole('button', { name: /2/ });
    await user.click(trigger);

    const fileRowButton = await screen.findByRole('button', { name: /src\/app\.ts/ });
    expect(screen.getByText('README.md')).toBeInTheDocument();

    await user.click(fileRowButton);
    await waitFor(() => expect(fileDiffSpy).toHaveBeenCalledWith('session-imported', 'src/app.ts'));
    expect(await screen.findByText('+export const v = 2;')).toBeInTheDocument();

    const applyButton = screen.getByRole('button', { name: /回写 \(1\)|Apply \(1\)/i });
    await user.click(applyButton);

    await waitFor(() => {
      expect(applySpy).toHaveBeenCalledWith({
        sessionId: 'session-imported',
        paths: ['src/app.ts'],
        allowOverwriteConflicts: false,
      });
    });
    expect(diffSpy).toHaveBeenCalledTimes(3);
  });

  it('allows explicitly opting in to overwrite conflicted files and displays apply error details', async () => {
    const user = userEvent.setup();
    vi.spyOn(tauri, 'invokeSandboxDiff').mockResolvedValue({
      sourceRoot: '/Users/demo/project',
      totalChanges: 1,
      conflictCount: 1,
      changes: [
        { path: 'README.md', kind: 'modified', conflict: true, sandboxSize: 12, sourceSize: 14 },
      ],
    });
    const applySpy = vi.spyOn(tauri, 'invokeSandboxApply').mockResolvedValue({
      applied: [],
      skippedConflicts: [],
      errors: ['README.md: permission denied'],
    });

    render(<SandboxSyncDialog sessionId="session-conflict" />);
    await user.click(await screen.findByRole('button', { name: /1/ }));

    const readmeCheckbox = await screen.findByRole('checkbox', { name: 'README.md' });
    expect(readmeCheckbox).toHaveAttribute('aria-disabled', 'true');

    const overwriteToggle = screen.getByRole('checkbox', {
      name: /允许覆盖存在外部修改的冲突文件|Allow overwriting conflicted files/i,
    });
    await user.click(overwriteToggle);
    expect(readmeCheckbox).not.toHaveAttribute('aria-disabled', 'true');

    await user.click(readmeCheckbox);
    await user.click(screen.getByRole('button', { name: /回写 \(1\)|Apply \(1\)/i }));

    await waitFor(() => {
      expect(applySpy).toHaveBeenCalledWith({
        sessionId: 'session-conflict',
        paths: ['README.md'],
        allowOverwriteConflicts: true,
      });
    });
    expect(await screen.findByText('README.md: permission denied')).toBeInTheDocument();
  });

  it('shows skipped import count, supports select-all toggle, and refreshes on signal or peer update', async () => {
    const user = userEvent.setup();
    const diffSpy = vi.spyOn(tauri, 'invokeSandboxDiff').mockResolvedValue({
      sourceRoot: '/Users/demo/project',
      totalChanges: 2,
      conflictCount: 0,
      skippedCount: 14,
      changes: [
        { path: 'a.ts', kind: 'added', conflict: false, sandboxSize: 10 },
        { path: 'b.ts', kind: 'modified', conflict: false, sandboxSize: 20, sourceSize: 18 },
      ],
    });

    const { rerender } = render(
      <SandboxSyncDialog sessionId="session-sync" refreshEnabled refreshSignal={1} />,
    );
    await user.click(await screen.findByRole('button', { name: /2/ }));
    expect(await screen.findByTestId('sandbox-sync-skipped-hint')).toHaveTextContent('14');

    const toggleAll = screen.getByRole('button', { name: /取消全选|Clear/i });
    await user.click(toggleAll);
    expect(screen.getByRole('button', { name: /回写 \(0\)|Apply \(0\)/i })).toBeDisabled();

    const selectAll = screen.getByRole('button', { name: /全选|Select all/i });
    await user.click(selectAll);
    expect(screen.getByRole('button', { name: /回写 \(2\)|Apply \(2\)/i })).toBeEnabled();

    const callsBeforeSignal = diffSpy.mock.calls.length;
    rerender(<SandboxSyncDialog sessionId="session-sync" refreshEnabled refreshSignal={2} />);
    await waitFor(() => expect(diffSpy.mock.calls.length).toBeGreaterThan(callsBeforeSignal));
  });

  it('confirms and discards selected sandbox changes without touching source files', async () => {
    const user = userEvent.setup();
    vi.spyOn(tauri, 'invokeSandboxDiff').mockResolvedValue({
      sourceRoot: '/Users/demo/project',
      totalChanges: 1,
      conflictCount: 0,
      skippedCount: 0,
      changes: [
        { path: 'src/app.ts', kind: 'modified', conflict: false, sandboxSize: 42, sourceSize: 40 },
      ],
    });
    const discardSpy = vi.spyOn(tauri, 'invokeSandboxDiscard').mockResolvedValue({
      discarded: ['src/app.ts'],
      errors: [],
    });

    render(<SandboxSyncDialog sessionId="session-discard" />);
    await user.click(await screen.findByRole('button', { name: /1/ }));

    await user.click(screen.getByRole('button', { name: /丢弃所选 \(1\)|Discard \(1\)/i }));
    await user.click(await screen.findByRole('button', { name: /确认丢弃|^Discard$/i }));

    await waitFor(() => {
      expect(discardSpy).toHaveBeenCalledWith({
        sessionId: 'session-discard',
        paths: ['src/app.ts'],
      });
    });
  });
});
