import React from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { TerminalTitleSettings } from '../terminal-title-settings';
import { useProfileStore } from '@/stores/profileStore';
import { useTerminalStore } from '@/stores/terminalStore';

beforeEach(async () => {
  useAppStore.setState({ terminalTabTitleTemplate: '${name}', terminalTabTitleOverrides: {} });
  await initI18n('zh-CN');
});
afterEach(() => {
  cleanup();
  useTerminalStore.setState({ sessions: [], activeSessionId: null });
  useProfileStore.setState({ profiles: [] });
  useAppStore.setState({ terminalTabTitleTemplate: '${name}', terminalTabTitleOverrides: {} });
});

it('keeps preview and session titles consistent after the configured host changes', () => {
  const profile = { id: 'profile', name: '', host: 'old.example.com', port: 22, username: 'root', authMethod: 'password' as const, createdAt: 0, updatedAt: 0 };
  useProfileStore.setState({ profiles: [profile] });
  useAppStore.getState().setTerminalTabTitleTemplate('${name} · ${host}');
  useTerminalStore.getState().addSession({ sessionId: 'connected', title: profile.host, host: profile.host, port: 22, username: 'root' }, profile.id);
  render(<TerminalTitleSettings profileId={profile.id} />);
  act(() => useProfileStore.setState({ profiles: [{ ...profile, host: 'new.example.com' }] }));
  expect(useTerminalStore.getState().sessions[0].title).toBe('old.example.com');
  expect(screen.getByText('预览：old.example.com')).toBeInTheDocument();
  act(() => useProfileStore.setState({ profiles: [{ ...profile, name: 'Production', host: 'new.example.com' }] }));
  expect(useTerminalStore.getState().sessions[0].title).toBe('Production · old.example.com');
  expect(screen.getByText('预览：Production · old.example.com')).toBeInTheDocument();
  act(() => useTerminalStore.setState({ sessions: [] }));
  expect(screen.getByText('预览：Production · new.example.com')).toBeInTheDocument();
});

it('previews deduplication and persists a custom template identical to the preset', () => {
  useProfileStore.setState({ profiles: [{ id: 'profile', name: 'server', host: 'server', port: 22, username: 'root', authMethod: 'password', createdAt: 0, updatedAt: 0 }] });
  useAppStore.getState().setTerminalTabTitleTemplate('${name} · ${host}');
  const view = render(<TerminalTitleSettings profileId="profile" />);
  expect(screen.getByText('预览：server')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '${name} · ${host} ' } });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '${name} · ${host}' } });
  expect(screen.getByText('预览：server · server')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument();
  expect(useAppStore.getState().terminalTabTitleCustomOverrides.profile).toBe(true);
  view.unmount();
  render(<TerminalTitleSettings profileId="profile" />);
  expect(screen.getByText('预览：server · server')).toBeInTheDocument();
  expect(screen.getByLabelText('页签标题模板')).toHaveTextContent('自定义模板');
});

it('pins an inherited template and resumes inheritance when the override is removed', () => {
  render(<TerminalTitleSettings profileId="profile" />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '${name} custom' } });
  expect(useAppStore.getState().terminalTabTitleOverrides.profile).toBe('${name} custom');
  act(() => useAppStore.getState().setTerminalTabTitleTemplate('${host}'));
  expect(screen.getByRole('textbox')).toHaveValue('${name} custom');
  fireEvent.click(screen.getByRole('button', { name: '使用全局默认' }));
  expect(useAppStore.getState().terminalTabTitleOverrides.profile).toBeUndefined();
  expect(screen.getByRole('textbox')).toHaveValue('${host}');
  expect(screen.getByRole('button', { name: '使用全局默认' })).toBeDisabled();
});

it('does not allow invalid drafts to be saved as overrides', () => {
  render(<TerminalTitleSettings profileId="profile" />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '${unknown}' } });
  expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
  expect(useAppStore.getState().terminalTabTitleOverrides.profile).toBeUndefined();
});

it('saves valid global edits immediately and preserves the last valid value during invalid edits', () => {
  render(<TerminalTitleSettings />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '${host} custom' } });
  expect(useAppStore.getState().terminalTabTitleTemplate).toBe('${host} custom');
  expect(useAppStore.getState().terminalTabTitleCustom).toBe(true);
  fireEvent.change(input, { target: { value: '${unknown}' } });
  expect(input).toHaveValue('${unknown}');
  expect(useAppStore.getState().terminalTabTitleTemplate).toBe('${host} custom');
  fireEvent.change(input, { target: { value: '${name}' } });
  expect(useAppStore.getState().terminalTabTitleTemplate).toBe('${name}');
  expect(useAppStore.getState().terminalTabTitleCustom).toBe(true);
  expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument();
});
