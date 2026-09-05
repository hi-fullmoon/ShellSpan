import { create } from 'zustand';
import {
  invokeListRecentProfiles,
  invokeTouchRecentProfile,
  invokeRemoveRecentProfile,
} from '@/lib/ipc/tauri';
import { createLogger } from '@/lib/logger';
import { safeInvoke } from '@/lib/utils';

const logger = createLogger('recentProfilesStore');
const MAX_RECENT_PROFILES = 10;

interface RecentProfilesState {
  recentIds: string[];
  initialized: boolean;
  hydrateFromDb: () => Promise<void>;
  touchProfile: (id: string) => void;
  removeProfile: (id: string) => void;
}

export const useRecentProfilesStore = create<RecentProfilesState>()((set, _get) => ({
  recentIds: [],
  initialized: false,

  hydrateFromDb: async () => {
    try {
      const ids = await invokeListRecentProfiles();
      set({ recentIds: ids, initialized: true });
      logger.info(`loaded ${ids.length} recent profiles from database`);
    } catch (error) {
      logger.error('failed to hydrate recent profiles from database', error);
      set({ initialized: true });
    }
  },

  touchProfile: (id) => {
    set((state) => {
      const filtered = state.recentIds.filter((recentId) => recentId !== id);
      return {
        recentIds: [id, ...filtered].slice(0, MAX_RECENT_PROFILES),
      };
    });
    // Write-through to database (fire-and-forget)
    safeInvoke(invokeTouchRecentProfile, id);
  },

  removeProfile: (id) => {
    set((state) => ({
      recentIds: state.recentIds.filter((recentId) => recentId !== id),
    }));
    // Write-through to database (fire-and-forget)
    safeInvoke(invokeRemoveRecentProfile, id);
  },
}));
