import { describe, expect, it } from 'vitest';
import resources from '@/locales/petdex-messages.json';
import en from '@/locales/en-US';
import zh from '@/locales/zh-CN';
import { DEFAULT_PETDEX_MESSAGE_PREFERENCES, normalizePetdexMessagePreferences, petdexDetailsAllowed } from '../message-preferences';

describe('Petdex shared content contract', () => {
  it('uses the exact same finite resources in both application locales', () => {
    expect(Object.keys(resources['en-US']).sort()).toEqual(Object.keys(resources['zh-CN']).sort());
    for (const [locale, dictionary] of [['en-US', en], ['zh-CN', zh]] as const) {
      for (const [key, value] of Object.entries(resources[locale])) {
        expect(dictionary[key as keyof typeof dictionary]).toBe(value);
        expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(200);
        expect(value).not.toMatch(/["\\\u0000-\u001f\u007f]/u);
      }
    }
    expect(en['petdex.message.readFile']).not.toBe(en['petdex.message.tool']);
    expect(zh['petdex.message.crossCopy']).not.toBe(zh['petdex.message.copy']);
  });

  it('defaults both independent preferences off and requires all gates for details', () => {
    for (const value of [undefined, null, {}, true, { petdexMessagesEnabled: 'true', petdexMessageDetailsEnabled: 1 }]) {
      expect(normalizePetdexMessagePreferences(value)).toEqual(DEFAULT_PETDEX_MESSAGE_PREFERENCES);
    }
    for (const enabled of [false, true]) {
      for (const messages of [false, true]) {
        for (const details of [false, true]) {
          const preferences = normalizePetdexMessagePreferences({ petdexMessagesEnabled: messages, petdexMessageDetailsEnabled: details });
          expect(petdexDetailsAllowed(enabled, preferences)).toBe(enabled && messages && details);
        }
      }
    }
  });
});
