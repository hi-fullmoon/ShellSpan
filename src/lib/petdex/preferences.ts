import type { PetdexCategories } from '@/types';

export const DEFAULT_PETDEX_CATEGORIES: PetdexCategories = { ssh: true, sftp: true, ai: false };

export interface PetdexConfiguration {
  enabled: boolean;
  categories: PetdexCategories;
}

export interface PetdexConfigurationPatch {
  enabled?: boolean;
  categories?: Partial<PetdexCategories>;
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
