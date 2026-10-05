import type { PetdexCategories } from '@/types';
import type { Locale } from '@/types';
import type { PetdexMessagePreferences } from './message-preferences';

export const DEFAULT_PETDEX_CATEGORIES: PetdexCategories = { ssh: true, sftp: true, ai: false };

export interface PetdexConfiguration {
  enabled: boolean;
  categories: PetdexCategories;
}

export interface PetdexConfigurationPatch extends Partial<PetdexMessagePreferences> {
  locale?: Locale;
  enabled?: boolean;
  categories?: Partial<PetdexCategories>;
}

export function resolvePetdexSettings(confirmed: import('./messages').PetdexSettings, patch: PetdexConfigurationPatch): import('./messages').PetdexSettings {
  return { ...confirmed, ...patch, categories: { ...confirmed.categories, ...patch.categories } };
}

export function resolvePetdexConfiguration(confirmed: PetdexConfiguration, patch: PetdexConfigurationPatch): PetdexConfiguration {
  return {
    enabled: patch.enabled ?? confirmed.enabled,
    categories: { ...confirmed.categories, ...patch.categories },
  };
}

export function normalizePetdexCategories(value: unknown): PetdexCategories {
  const categories = value && typeof value === 'object' ? value : {};
  return {
    ssh: 'ssh' in categories && typeof categories.ssh === 'boolean' ? categories.ssh : true,
    sftp: 'sftp' in categories && typeof categories.sftp === 'boolean' ? categories.sftp : true,
    ai: 'ai' in categories && typeof categories.ai === 'boolean' ? categories.ai : false,
  };
}
