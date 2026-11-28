import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiSkillsDialog } from '../ai-skills-dialog';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useToastStore } from '@/stores/toastStore';
import type { ManagedSkillCatalog } from '@/types/agent-skill';

const mocks = vi.hoisted(() => ({
  listManaged: vi.fn<() => Promise<ManagedSkillCatalog>>(),
  saveUser: vi.fn(),
  deleteUser: vi.fn(),
  openDir: vi.fn(),
}));

vi.mock('@/lib/ipc/tauri', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ipc/tauri')>(),
  invokeListManagedSkills: mocks.listManaged,
  invokeSaveUserSkill: mocks.saveUser,
  invokeDeleteUserSkill: mocks.deleteUser,
  invokeOpenUserSkillsDir: mocks.openDir,
}));

const sampleCatalog: ManagedSkillCatalog = {
  userSkillsDir: '/Users/dev/.shellspan/skills',
  userSkillsDirExists: true,
  diagnostics: [],
  skills: [
    {
      name: 'deploy-orders',
      description: 'Deploy orders API safely',
      instructions: '# Deploy Orders\nCheck health.\n',
      origin: 'user',
      relativePath: 'user/deploy-orders/SKILL.md',
      fileHash: 'a'.repeat(64),
      userInvocable: true,
      disableModelInvocation: true,
      overridesBuiltin: false,
    },
    {
      name: 'system-status',
      description: 'Inspect system, CPU, memory, disks and processes',
      instructions: '# System status\nCollect host metrics.\n',
      origin: 'builtin',
      relativePath: 'builtin/system-status.md',
      fileHash: 'b'.repeat(64),
      userInvocable: true,
      disableModelInvocation: false,
      overridesBuiltin: false,
    },
  ],
};

beforeEach(async () => {
  vi.clearAllMocks();
  useToastStore.setState({ toasts: [] });
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
  mocks.listManaged.mockResolvedValue(sampleCatalog);
  mocks.saveUser.mockResolvedValue(sampleCatalog.skills[0]);
  mocks.deleteUser.mockResolvedValue(undefined);
  mocks.openDir.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe('AiSkillsDialog', () => {
  it('renders managed skills, readable filter label, equal-height toolbar, and opens folder', async () => {
    const user = userEvent.setup();
    render(<AiSkillsDialog onOpenChange={vi.fn()} />);

    expect(await screen.findByText('/deploy-orders')).toBeVisible();
    expect(screen.getByText('/system-status')).toBeVisible();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('flex', 'flex-col', 'bg-card', 'sm:rounded-2xl');
    expect(dialog).toHaveTextContent('All skills');
    expect(screen.getByRole('searchbox')).toHaveClass('h-8', 'rounded-lg');
    expect(screen.getByRole('combobox')).toHaveAttribute('data-variant', 'ghost');
    expect(screen.getByRole('button', { name: 'Open folder' })).toHaveAttribute('data-variant', 'soft');
    expect(screen.getByRole('button', { name: 'New skill' }).querySelector('svg')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open folder' }).querySelector('svg')).toBeNull();
    expect(screen.getByText('/deploy-orders').closest('[data-slot="managed-skill-row"]')).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox'), 'orders');
    expect(screen.getByText('/deploy-orders')).toBeVisible();
    expect(screen.queryByText('/system-status')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(mocks.openDir).toHaveBeenCalledTimes(1);
  });

  it('creates a user skill, keeps footer borderless, dispatches update event and shows one toast', async () => {
    const user = userEvent.setup();
    const updatedSpy = vi.fn();
    window.addEventListener('shellspan:skills-updated', updatedSpy);

    try {
      render(<AiSkillsDialog onOpenChange={vi.fn()} />);
      await screen.findByText('/deploy-orders');

      await user.click(screen.getByRole('button', { name: 'New skill' }));
      const dialog = screen.getByRole('dialog');
      expect(dialog.querySelectorAll('[data-slot="dialog-header"]')).toHaveLength(1);
      expect(dialog.querySelector('[data-slot="skill-editor-layout"]')).toHaveClass('@min-[44rem]:grid-cols-[18.5rem_minmax(0,1fr)]');
      expect(dialog.querySelector('[data-slot="skill-editor-meta"]')).not.toBeNull();
      expect(dialog.querySelector('[data-slot="skill-editor-canvas"]')).not.toBeNull();
      expect(screen.getByRole('switch', { name: /Manual \/name invocation only/i })).not.toBeChecked();
      expect(screen.getByRole('switch', { name: /Show in \/ completion menu/i })).toBeChecked();
      const footer = dialog.querySelector('[data-slot="dialog-footer"]');
      expect(footer).not.toBeNull();
      expect(footer).toHaveClass('shrink-0');
      expect(footer?.className).not.toContain('border-t');

      await user.type(screen.getByLabelText('Skill name'), 'restart-nginx');
      expect(dialog.querySelector('[data-slot="dialog-title"]')).toHaveTextContent('/restart-nginx');
      await user.type(screen.getByLabelText('Trigger description'), 'Gracefully reload nginx');
      await user.type(screen.getByLabelText('Skill instructions (Markdown)'), 'Reload nginx safely');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(mocks.saveUser).toHaveBeenCalledTimes(1));
      expect(mocks.saveUser).toHaveBeenCalledWith(expect.objectContaining({
        name: 'restart-nginx',
        description: 'Gracefully reload nginx',
        expectedBaseHash: null,
      }));
      expect(updatedSpy).toHaveBeenCalledTimes(1);
      expect(useToastStore.getState().toasts).toHaveLength(1);
    } finally {
      window.removeEventListener('shellspan:skills-updated', updatedSpy);
    }
  });

  it('shows save failure in contextual alert without duplicating a toast', async () => {
    const user = userEvent.setup();
    mocks.saveUser.mockRejectedValueOnce(new Error('redactionRequired: remove secret'));
    render(<AiSkillsDialog onOpenChange={vi.fn()} />);
    await screen.findByText('/deploy-orders');

    await user.click(screen.getByRole('button', { name: 'Edit skill /deploy-orders' }));
    const footer = screen.getByRole('dialog').querySelector('[data-slot="dialog-footer"]');
    const moveToTrashButton = screen.getByRole('button', { name: 'Move to trash' });
    const saveButton = screen.getByRole('button', { name: 'Save' });
    const backButton = screen.getByRole('button', { name: 'Back to list' });
    expect(footer).toContainElement(moveToTrashButton);
    expect(moveToTrashButton).toHaveAttribute('data-variant', 'destructiveSoft');
    expect(moveToTrashButton.querySelector('svg')).toBeNull();
    expect(saveButton.querySelector('svg')).toBeNull();
    expect(backButton.querySelector('svg')).toBeNull();
    await user.click(saveButton);

    expect(await screen.findByText('redactionRequired: remove secret')).toBeVisible();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('confirms moving a user skill to trash and passes expectedFileHash', async () => {
    const user = userEvent.setup();
    render(<AiSkillsDialog onOpenChange={vi.fn()} />);
    await screen.findByText('/deploy-orders');

    await user.click(screen.getByRole('button', { name: 'Move skill /deploy-orders to trash' }));
    const confirmDialog = await screen.findByRole('alertdialog');
    expect(confirmDialog).toHaveTextContent('system trash');

    await user.click(screen.getByRole('button', { name: 'Move to trash' }));
    await waitFor(() => expect(mocks.deleteUser).toHaveBeenCalledWith({
      name: 'deploy-orders',
      expectedFileHash: 'a'.repeat(64),
    }));
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});
