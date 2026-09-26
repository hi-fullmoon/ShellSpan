import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

afterEach(() => {
  cleanup();
  useAppStore.getState().setProfileName('');
});

it.each([
  ['zh-CN', 'terminal', '你想完成什么任务？', '小明，你想完成什么任务？'],
  ['en-US', 'terminal', 'What would you like to accomplish?', '小明, what would you like to accomplish?'],
  ['zh-CN', 'workbench', '有什么想问的？', '小明，有什么想问的？'],
  ['en-US', 'workbench', 'What would you like to ask?', '小明, what would you like to ask?'],
] as const)('updates the %s %s welcome title when the configured nickname changes', async (locale, scope, plain, personalized) => {
  useAppStore.setState({ locale, profileName: '' });
  await initI18n(locale);
  render(<AiWorkspaceRoot scope={scope} view={null} />);
  expect(screen.getByText(plain)).toBeVisible();

  act(() => useAppStore.getState().setProfileName('  小明  '));
  expect(screen.getByText(personalized)).toBeVisible();
  expect(screen.queryByText(plain)).not.toBeInTheDocument();

  act(() => useAppStore.getState().setProfileName('   '));
  expect(screen.getByText(plain)).toBeVisible();
  expect(screen.queryByText(personalized)).not.toBeInTheDocument();
});
