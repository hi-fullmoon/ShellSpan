import { describe, expect, it } from 'vitest';
import { DEFAULT_PETDEX_CATEGORIES, normalizePetdexCategories, resolvePetdexSettings } from '../preferences';
import { DEFAULT_PETDEX_MESSAGE_PREFERENCES } from '../message-preferences';
import zh from '@/locales/zh-CN';
import en from '@/locales/en-US';

describe('Petdex category preferences', () => {
  it('composes sparse updates against acknowledgements without losing other categories', () => {
    const initial = {
      enabled: false,
      categories: DEFAULT_PETDEX_CATEGORIES,
      ...DEFAULT_PETDEX_MESSAGE_PREFERENCES,
      locale: 'zh-CN' as const,
    };
    const aiConfirmed = resolvePetdexSettings(initial, { categories: { ai: true } });
    expect(aiConfirmed.categories).toEqual({ ssh: true, sftp: true, ai: true });
    const sshRejected = resolvePetdexSettings(aiConfirmed, { categories: { ssh: false } });
    expect(sshRejected.categories.ssh).toBe(false);
    // A rejected request is not an acknowledgement. The next queued patch
    // resolves against aiConfirmed and preserves its successful AI choice.
    const sftpConfirmed = resolvePetdexSettings(aiConfirmed, { categories: { sftp: false } });
    expect(sftpConfirmed.categories).toEqual({ ssh: true, sftp: false, ai: true });
    expect(resolvePetdexSettings(sftpConfirmed, { enabled: true }))
      .toEqual({ ...sftpConfirmed, enabled: true });
    expect(initial.categories).toEqual({ ssh: true, sftp: true, ai: false });
  });
  it('migrates missing and invalid categories without opting into AI', () => {
    for (const value of [undefined, null, false, {}, { ssh: 'false', ai: 1 }]) {
      expect(normalizePetdexCategories(value)).toEqual(DEFAULT_PETDEX_CATEGORIES);
    }
    expect(normalizePetdexCategories({ ssh: false, ai: true })).toEqual({ ssh: false, sftp: true, ai: true });
    expect(normalizePetdexCategories({ ssh: false, sftp: false, ai: true, deployment: true }))
      .toEqual({ ssh: false, sftp: false, ai: true });
  });

  it('provides human-readable category names in both locales', () => {
    for (const category of ['ssh', 'sftp', 'ai'] as const) {
      const key = `settings.experimental.petdex.category.${category}` as const;
      expect(zh[key]).toBeTruthy();
      expect(en[key]).toBeTruthy();
      expect(zh[key]).not.toBe(category);
      expect(en[key]).not.toBe(category);
    }
  });
});
