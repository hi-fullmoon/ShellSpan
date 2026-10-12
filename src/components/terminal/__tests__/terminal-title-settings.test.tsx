import React from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { TerminalTitleSettings } from '../terminal-title-settings';
import { useProfileStore } from '@/stores/profileStore';

beforeEach(async () => {
  useAppStore.setState({ terminalTabTitleTemplate: '${name}', terminalTabTitleOverrides: {} });
  await initI18n('zh-CN');
});
afterEach(() => {
  cleanup();
  useProfileStore.setState({ profiles: [] });
  useAppStore.setState({ terminalTabTitleTemplate: '${name}', terminalTabTitleOverrides: {} });
});

it('previews deduplication and persists a custom template identical to the preset', () => {
  useProfileStore.setState({ profiles: [{ id: 'profile', name: 'server', host: 'server', port: 22, username: 'root', authMethod: 'password', createdAt: 0, updatedAt: 0 }] });
  useAppStore.getState().setTerminalTabTitleTemplate('${name} · ${host}');
  const view = render(<TerminalTitleSettings profileId="profile" />);
  expect(screen.getByText('预览：server')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '${name} · ${host} ' } });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '${name} · ${host}' } });
  expect(screen.getByText('预览：server · server')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(useAppStore.getState().terminalTabTitleCustomOverrides.profile).toBe(true);
  view.unmount();
  render(<TerminalTitleSettings profileId="profile" />);
  expect(screen.getByText('预览：server · server')).toBeInTheDocument();
  expect(screen.getByLabelText('页签标题模板')).toHaveTextContent('自定义模板');
});

it('pins an inherited template and resumes inheritance when the override is removed', () => {
  render(<TerminalTitleSettings profileId="profile" />);
  const save = screen.getByRole('button', { name: '保存' });
  expect(save).not.toBeDisabled();
  fireEvent.click(save);
  expect(useAppStore.getState().terminalTabTitleOverrides.profile).toBe('${name}');
  expect(save).toBeDisabled();
  act(() => useAppStore.getState().setTerminalTabTitleTemplate('${host}'));
  expect(screen.getByRole('textbox')).toHaveValue('${name}');
  fireEvent.click(screen.getByRole('button', { name: '使用全局默认' }));
  expect(useAppStore.getState().terminalTabTitleOverrides.profile).toBeUndefined();
  expect(screen.getByRole('textbox')).toHaveValue('${host}');
  expect(save).not.toBeDisabled();
});

it('does not allow invalid drafts to be saved as overrides', () => {
  render(<TerminalTitleSettings profileId="profile" />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '${unknown}' } });
  expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  expect(useAppStore.getState().terminalTabTitleOverrides.profile).toBeUndefined();
});
