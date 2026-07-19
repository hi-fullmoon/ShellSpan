import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppSection, Locale, ThemeMode, WorkbenchTab } from '@/types';

interface AppPreferences {
  theme: ThemeMode;
  locale: Locale;
  startupUpdateCheck: boolean;
}

interface AppState extends AppPreferences {
  activeSection: AppSection;
  activeWorkbenchTab: WorkbenchTab;
  setActiveSection: (section: AppSection) => void;
  setActiveWorkbenchTab: (tab: WorkbenchTab) => void;
  setTheme: (theme: ThemeMode) => void;
  setLocale: (locale: Locale) => void;
  setStartupUpdateCheck: (enabled: boolean) => void;
}

const STORAGE_KEY = 'termbridge.preferences';

function readInitialPreferences(): AppPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppPreferences>;
      return {
        theme: parsed.theme ?? 'system',
        locale: parsed.locale ?? 'zh-CN',
        startupUpdateCheck: parsed.startupUpdateCheck ?? true,
      };
    }
  } catch {
    // ignore
  }
  return {
    theme: 'system',
    locale: 'zh-CN',
    startupUpdateCheck: true,
  };
}

const initial = readInitialPreferences();

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      ...initial,
      activeSection: 'workbench',
      activeWorkbenchTab: 'connections',
      setActiveSection: (section) => set({ activeSection: section }),
      setActiveWorkbenchTab: (activeWorkbenchTab) => set({ activeWorkbenchTab }),
      setTheme: (theme) => set({ theme }),
      setLocale: (locale) => set({ locale }),
      setStartupUpdateCheck: (startupUpdateCheck) => set({ startupUpdateCheck }),
    }),
    {
      name: STORAGE_KEY,
      partialize: (state) => ({
        theme: state.theme,
        locale: state.locale,
        startupUpdateCheck: state.startupUpdateCheck,
      }),
    },
  ),
);
