import {expect, it} from 'vitest';
import {assertOwnedAiReference, isMissingAiCredential, ownedAiCredentialRoute} from './native-ai-credential-plan';
it('defines one non-networking credential setup route without a user reference or model selection', () => {
  const route = ownedAiCredentialRoute('cf418c75-c5cf-4d19-8a82-68e58e4086ce');
  expect(route.auth).toEqual({kind: 'none'});expect(route.id).toBe('e07-ai-cf418c75-c5cf-4d19-8a82-68e58e4086ce');expect(route.defaults).toBeUndefined();expect(route.models).toBeUndefined();expect(route.adapterId).toBe('chat-completions');
  expect(() => ownedAiCredentialRoute('../original')).toThrow('Owned AI credential run ID');
});
it('requires an exact missing-credential result and a generated UUID reference', () => {
  expect(isMissingAiCredential('MISSING_CREDENTIAL')).toBe(true);expect(isMissingAiCredential(Error('MISSING_CREDENTIAL'))).toBe(true);
  for (const error of ['UNKNOWN_ROUTE: route', 'prefix MISSING_CREDENTIAL', Error('different error')]) expect(isMissingAiCredential(error)).toBe(false);
  expect(() => assertOwnedAiReference('llm-cf418c75-c5cf-4d19-8a82-68e58e4086ce')).not.toThrow();expect(() => assertOwnedAiReference('original')).toThrow('Generated owned AI');
});
