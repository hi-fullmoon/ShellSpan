import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AgentDiffApproval } from '../agent-diff-approval';

describe('AgentDiffApproval', () => {
  it('shows the exact target and diff before continuing to native approval', () => {
    const approve = vi.fn();
    const reject = vi.fn();
    render(
      <AgentDiffApproval
        preview={{
          toolName: 'apply_patch',
          targetId: 'local-1',
          summary: 'Exact native patch',
          path: 'D:/workspace/config.txt',
          diff: '--- original\n+++ modified\n@@ -1 +1 @@\n-before\n+after\n',
        }}
        onApprove={approve}
        onReject={reject}
      />,
    );

    expect(screen.getByText('D:/workspace/config.txt')).toBeInTheDocument();
    expect(screen.getByText(/\+after/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Continue to native approval/i }));
    fireEvent.click(screen.getByRole('button', { name: /Reject/i }));
    expect(approve).toHaveBeenCalledOnce();
    expect(reject).toHaveBeenCalledOnce();
  });
});
