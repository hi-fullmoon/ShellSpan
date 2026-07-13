import { describe, expect, it, beforeEach } from 'vitest';
import { useAppStore } from './appStore';

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
});
