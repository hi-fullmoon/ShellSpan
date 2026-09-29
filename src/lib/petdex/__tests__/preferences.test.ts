import { describe, expect, it } from 'vitest';
import { DEFAULT_PETDEX_CATEGORIES, normalizePetdexCategories, resolvePetdexConfiguration } from '../preferences';
import zh from '@/locales/zh-CN';
import en from '@/locales/en-US';

describe('Petdex category preferences', () => {
  it('composes sparse updates against acknowledgements without losing other categories', () => {
    const initial = { enabled: false, categories: DEFAULT_PETDEX_CATEGORIES };
    const aiConfirmed = resolvePetdexConfiguration(initial, { categories: { ai: true } });
    expect(aiConfirmed).toEqual({ enabled: false, categories: { ssh: true, sftp: true, ai: true } });
    const sshRejected = resolvePetdexConfiguration(aiConfirmed, { categories: { ssh: false } });
    expect(sshRejected.categories.ssh).toBe(false);
    // A rejected request is not an acknowledgement. The next queued patch
    // resolves against aiConfirmed and preserves its successful AI choice.
    const sftpConfirmed = resolvePetdexConfiguration(aiConfirmed, { categories: { sftp: false } });
    expect(sftpConfirmed).toEqual({ enabled: false, categories: { ssh: true, sftp: false, ai: true } });
    expect(resolvePetdexConfiguration(sftpConfirmed, { enabled: true }))
      .toEqual({ enabled: true, categories: { ssh: true, sftp: false, ai: true } });
    expect(initial).toEqual({ enabled: false, categories: { ssh: true, sftp: true, ai: false } });
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
