import { describe, expect, it, beforeEach, vi } from 'vitest';
import { useRecentProfilesStore } from '../recentProfilesStore';

vi.mock('@/lib/ipc/tauri', () => ({
  invokeListRecentProfiles: vi.fn().mockResolvedValue([]),
  invokeTouchRecentProfile: vi.fn().mockResolvedValue(undefined),
  invokeRemoveRecentProfile: vi.fn().mockResolvedValue(undefined),
}));

const initial = useRecentProfilesStore.getState();

describe('useRecentProfilesStore', () => {
  beforeEach(() => {
    useRecentProfilesStore.setState(initial, true);
  });

  it('starts with empty recentIds', () => {
    expect(useRecentProfilesStore.getState().recentIds).toEqual([]);
  });

  it('adds a profile id when touched', () => {
    useRecentProfilesStore.getState().touchProfile('p1');
    expect(useRecentProfilesStore.getState().recentIds).toEqual(['p1']);
  });

  it('moves an existing id to the front when touched', () => {
    useRecentProfilesStore.getState().touchProfile('p1');
    useRecentProfilesStore.getState().touchProfile('p2');
    useRecentProfilesStore.getState().touchProfile('p1');
    expect(useRecentProfilesStore.getState().recentIds).toEqual(['p1', 'p2']);
  });

  it('caps the list at 10 entries', () => {
    for (let i = 1; i <= 12; i += 1) {
      useRecentProfilesStore.getState().touchProfile(`p${i}`);
    }
    const ids = useRecentProfilesStore.getState().recentIds;
    expect(ids).toHaveLength(10);
    expect(ids[0]).toBe('p12');
    expect(ids[9]).toBe('p3');
  });

  it('removes a profile id', () => {
    useRecentProfilesStore.getState().touchProfile('p1');
    useRecentProfilesStore.getState().touchProfile('p2');
    useRecentProfilesStore.getState().removeProfile('p1');
    expect(useRecentProfilesStore.getState().recentIds).toEqual(['p2']);
  });
});
