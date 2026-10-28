import { expect, it } from 'vitest';
import { modelDefinitionOf, type ResolvedModel } from '../provider-contract';
import models from '../../../../protocol/llm/fixtures/resolved-models.json';

const minimax = models.find(entry => entry.provider.model === 'MiniMax-M3')!.resolved as ResolvedModel;

it.each([
  [16_000, 8_192],
  [64_000, 8_192],
  [180_000, 8_192],
  [312_000, 32_768],
  [1_000_000, 65_536],
])('preserves the configured %i context and %i request budget through model copies', (contextWindow, requestOutputTokens) => {
  const resolved = { ...minimax, contextWindow, requestOutputTokens };
  const definition = modelDefinitionOf(resolved);
  const reloaded = JSON.parse(JSON.stringify(definition));
  expect(reloaded).toMatchObject({ contextWindow, maxOutputTokens: 131_072, requestOutputTokens });
  expect(reloaded).not.toHaveProperty('routeId');
  expect(reloaded).not.toHaveProperty('catalogVersion');
  expect(reloaded).not.toHaveProperty('capacityPolicy');
  expect(modelDefinitionOf(reloaded)).toEqual(definition);
  expect(resolved.requestOutputTokens).toBe(requestOutputTokens);
});

it('preserves the absence of a request override in legacy definitions', () => {
  const definition = modelDefinitionOf(minimax);
  expect(definition).not.toHaveProperty('requestOutputTokens');
  expect(definition.maxOutputTokens).toBe(minimax.maxOutputTokens);
});
