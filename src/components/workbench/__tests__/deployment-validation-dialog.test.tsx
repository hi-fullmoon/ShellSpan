import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentValidationDialog } from '../deployment-workflow-center';
import { initI18n, t } from '@/locales';

afterEach(cleanup);

describe('deployment validation dialog layout', () => {
  it('sizes to content, pads the scroll body and keeps actions outside it', async () => {
    await initI18n('zh-CN');
    function Preview() {
      const [open, setOpen] = React.useState(true);
      return <DeploymentValidationDialog open={open} onOpenChange={setOpen}
        issues={[]} nodeName={(id) => id} onSelectNode={() => {}}
        validating={false} onValidate={() => {}} />;
    }
    render(<Preview />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('grid-rows-[auto_minmax(0,1fr)_auto]', 'max-h-[min(30rem,calc(100dvh-2rem))]');
    expect([...dialog.classList].some((name) => name.startsWith('h-'))).toBe(false);
    const scroll = dialog.querySelector('[data-slot="scroll-area"]');
    expect(scroll).toHaveClass('min-h-0', 'min-w-0');
    expect(screen.getByRole('alert').parentElement).toHaveClass('p-4');
    const footer = dialog.querySelector('[data-slot="dialog-footer"]');
    expect(footer).toHaveClass('shrink-0');
    expect(footer).not.toHaveClass('border-t');
    expect(footer?.parentElement).toBe(dialog);
    expect(scroll?.contains(footer)).toBe(false);
    expect(dialog.querySelector('[data-slot="dialog-header"]')).toHaveClass('pr-12');
    fireEvent.click(footer!.querySelector('button')!);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps validation disabled while running', async () => {
    await initI18n('zh-CN');
    await act(async () => {
      render(<DeploymentValidationDialog open onOpenChange={() => {}}
        issues={[]} nodeName={(id) => id} onSelectNode={() => {}}
        validating onValidate={() => {}} />);
    });
    expect(screen.getByRole('button', { name: t('deployment.editor.validation.running') })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(t('deployment.editor.validation.running'));
    expect(screen.queryByText(t('deployment.editor.validation.ready'))).toBeNull();
  });

  it('dispatches validation on each click and restores the result after completion', async () => {
    await initI18n('zh-CN');
    let requests = 0;
    const props = { open: true, onOpenChange: () => {}, issues: [], nodeName: (id: string) => id,
      onSelectNode: () => {}, onValidate: () => { requests += 1; } };
    const view = render(<DeploymentValidationDialog {...props} validating={false} />);
    fireEvent.click(screen.getByRole('button', { name: t('deployment.editor.validate') }));
    expect(requests).toBe(1);
    view.rerender(<DeploymentValidationDialog {...props} validating />);
    expect(screen.queryByText(t('deployment.editor.validation.ready'))).toBeNull();
    view.rerender(<DeploymentValidationDialog {...props} validating={false} />);
    expect(screen.getByText(t('deployment.editor.validation.readyDescription'))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: t('deployment.editor.validate') }));
    expect(requests).toBe(2);
  });
});
