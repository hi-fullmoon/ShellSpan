import { useMemo, type Dispatch, type SetStateAction } from 'react';
import { useLocalStorage } from './useLocalStorage';
import { useAppliedTheme } from './useAppliedTheme';
import { defaultPreferences, normalizePreferences } from '../lib/appHelpers';
import type { AppPreferences } from '../types';

export interface UsePreferencesResult {
  storedPreferences: Partial<AppPreferences>;
  setStoredPreferences: Dispatch<SetStateAction<Partial<AppPreferences>>>;
  preferences: AppPreferences;
  appliedTheme: 'dark' | 'light';
  systemThemeMode: 'dark' | 'light';
}

export function usePreferences(): UsePreferencesResult {
  const [storedPreferences, setStoredPreferences] = useLocalStorage<Partial<AppPreferences>>('termbridge.preferences', defaultPreferences);
  const preferences = useMemo(() => normalizePreferences(storedPreferences), [storedPreferences]);
  const { appliedTheme, systemThemeMode } = useAppliedTheme(preferences.theme);

  return { storedPreferences, setStoredPreferences, preferences, appliedTheme, systemThemeMode };
}
