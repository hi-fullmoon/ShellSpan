import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiImagePreview, AiImagePreviewGroup } from '../workspace/ai-image-preview';
import { Button } from '@/components/ui/button';
import { DialogTrigger } from '@/components/ui/dialog';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

const source = `data:image/png;base64,${readFileSync('src-tauri/icons/32x32.png').toString('base64')}`;
function Image({ name }: { name: string }) {
  return <AiImagePreview source={source} name={name}><DialogTrigger render={<Button />}>{name}</DialogTrigger></AiImagePreview>;
}

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});
afterEach(cleanup);

describe('image gallery navigation', () => {
  it('opens the selected image, switches within its group, resets zoom and restores focus', async () => {
    const user = userEvent.setup();
    render(<><AiImagePreviewGroup><Image name="first.png" /><Image name="second.png" /><Image name="third.png" /></AiImagePreviewGroup>
      <AiImagePreviewGroup><Image name="other-message.png" /></AiImagePreviewGroup></>);
    const trigger = screen.getByRole('button', { name: 'second.png' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'second.png' });
    expect(within(dialog).getByRole('status', { name: 'Image 2 of 3' })).toHaveTextContent('2 / 3');
    fireEvent.load(within(dialog).getByRole('img'));
    await user.click(within(dialog).getByRole('button', { name: 'Zoom in' }));
    expect(within(dialog).getByText('125%')).toBeVisible();
    await user.keyboard('{ArrowRight}');
    expect(dialog).toHaveAccessibleName('third.png');
    expect(within(dialog).getByText('100%')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Next image' })).toBeDisabled();
    await user.keyboard('{ArrowRight}');
    expect(dialog).toHaveAccessibleName('third.png');
    await user.click(within(dialog).getByRole('button', { name: 'Previous image' }));
    await user.keyboard('{ArrowLeft}');
    expect(dialog).toHaveAccessibleName('first.png');
    expect(within(dialog).getByRole('button', { name: 'Previous image' })).toBeDisabled();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('second.png');
  });

  it('allows navigation away from an image decode error and hides controls for one image', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AiImagePreviewGroup><Image name="first.png" /><Image name="second.png" /></AiImagePreviewGroup>);
    await user.click(screen.getByRole('button', { name: 'first.png' }));
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus());
    fireEvent.error(within(dialog).getByRole('img'));
    expect(within(dialog).getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    await user.keyboard('{ArrowRight}');
    expect(dialog).toHaveAccessibleName('second.png');
    await user.keyboard('{Escape}');
    rerender(<AiImagePreviewGroup><Image name="first.png" /></AiImagePreviewGroup>);
    await user.click(screen.getByRole('button', { name: 'first.png' }));
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Next image' })).toBeNull();
  });
});
