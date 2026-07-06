import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppSection, Locale, ThemeMode } from '@/types';

interface AppPreferences {
  theme: ThemeMode;
  locale: Locale;
}

interface AppState extends AppPreferences {
  activeSection: AppSection;
  setActiveSection: (section: AppSection) => void;
  setTheme: (theme: ThemeMode) => void;
  setLocale: (locale: Locale) => void;
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
      };
    }
  } catch {
    // ignore
  }
  return {
    theme: 'system',
    locale: 'zh-CN',
  };
}

const initial = readInitialPreferences();

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      ...initial,
      activeSection: 'workbench',
      setActiveSection: (section) => set({ activeSection: section }),
      setTheme: (theme) => set({ theme }),
      setLocale: (locale) => set({ locale }),
    }),
    {
      name: STORAGE_KEY,
      partialize: (state) => ({
        theme: state.theme,
        locale: state.locale,
      }),
    },
  ),
);
