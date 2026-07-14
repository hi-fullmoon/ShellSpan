import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const MAX_RECENT_PROFILES = 10;
const STORAGE_KEY = 'termbridge.recentProfiles';

interface RecentProfilesState {
  recentIds: string[];
  touchProfile: (id: string) => void;
  removeProfile: (id: string) => void;
}

export const useRecentProfilesStore = create<RecentProfilesState>()(
  persist(
    (set) => ({
      recentIds: [],
      touchProfile: (id) =>
        set((state) => {
          const filtered = state.recentIds.filter((recentId) => recentId !== id);
          return {
            recentIds: [id, ...filtered].slice(0, MAX_RECENT_PROFILES),
          };
        }),
      removeProfile: (id) =>
        set((state) => ({
          recentIds: state.recentIds.filter((recentId) => recentId !== id),
        })),
    }),
    {
      name: STORAGE_KEY,
      partialize: (state) => ({ recentIds: state.recentIds }),
    },
  ),
);
