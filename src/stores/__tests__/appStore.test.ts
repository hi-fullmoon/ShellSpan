import { describe, expect, it, beforeEach } from 'vitest';
import { useAppStore } from '../appStore';

const initialState = useAppStore.getState();

describe('appStore', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true);
  });

  it('defaults to workbench section', () => {
    expect(useAppStore.getState().activeSection).toBe('workbench');
  });

  it('sets active section', () => {
    useAppStore.getState().setActiveSection('terminal');
    expect(useAppStore.getState().activeSection).toBe('terminal');
  });

  it('defaults to connections workbench tab', () => {
    expect(useAppStore.getState().activeWorkbenchTab).toBe('connections');
  });

  it('sets active workbench tab', () => {
    useAppStore.getState().setActiveWorkbenchTab('settings');
    expect(useAppStore.getState().activeWorkbenchTab).toBe('settings');
  });
});
