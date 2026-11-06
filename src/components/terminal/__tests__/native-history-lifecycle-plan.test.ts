import {expect, it} from 'vitest';
import {expectedMemoryHistory, expectedPersistedHistory, matchesHistoryFingerprints, matchesHistoryLifecycleArguments, nativeHistoryLifecycleGoal, nativeHistoryLifecyclePlan} from './native-history-lifecycle-plan';

const token = '8cc5e5e7-818b-4124-8878-6f61cf95e701';
it('plans five distinct Unicode commands, two read-only probes and a cancelled draft in a fresh namespace', () => {
  const plan = nativeHistoryLifecyclePlan(token);
  expect(plan.accepted).toHaveLength(5);
  expect(new Set(plan.accepted.map(x => x.source)).size).toBe(5);
  expect(plan.initialProbe).toContain('GetHistoryItems()');
  expect(plan.initialProbe).toContain(plan.initialMarker);
  expect(plan.finalProbe).toContain(plan.finalMarker);
  expect(plan.initialProbe).not.toBe(plan.finalProbe);
  expect(plan.draft.source).toHaveLength(2048);
  expect(plan.draft.source).toContain(`draft-${token}.txt`);
  for (const {source} of plan.accepted) {
    expect(source).toContain('历史记录');
    expect(nativeHistoryLifecycleGoal(source)).toContain(`~~~sh\n${source}\n~~~`);
    expect(matchesHistoryLifecycleArguments({command: source}, source)).toBe(true);
    for (const args of [{command: source + '\n'}, {command: source, background: true}, {command: source, lifecycleTrust: 'other'}, {command: source, input: 'replacement'}]) {
      expect(matchesHistoryLifecycleArguments(args, source)).toBe(false);
    }
  }
  expect(() => nativeHistoryLifecyclePlan('../old')).toThrow('Owned history lifecycle token');
});

it('keeps maximum three in memory while incremental disk retains exact accepted sources and ordinary exit', () => {
  const seeds = ['seed-a', 'seed-b'];
  const accepted = ['initial', 'one', 'two', 'three', 'four', 'five', 'final'];
  expect(expectedMemoryHistory(seeds, accepted, 3)).toEqual(['four', 'five', 'final']);
  expect(expectedPersistedHistory(seeds, accepted, 'SaveIncrementally', false)).toEqual([...seeds, ...accepted]);
  expect(expectedPersistedHistory(seeds, accepted, 'SaveIncrementally', true)).toEqual([...seeds, ...accepted, 'exit']);
  expect(expectedPersistedHistory(seeds, accepted, 'SaveAtExit', false)).toEqual(seeds);
  expect(expectedPersistedHistory(seeds, accepted, 'SaveAtExit', true)).toEqual([...seeds, ...accepted, 'exit']);
  expect(expectedPersistedHistory([], accepted, 'SaveNothing', true)).toEqual([]);
  expect(() => expectedMemoryHistory([], accepted, 0)).toThrow('Actual positive history maximum');
});

it('matches public history by exact ordered fingerprints regardless of JSON object property order', () => {
  const expected = [{sha256: 'first', bytes: 29}, {sha256: 'second', bytes: 31}];
  expect(matchesHistoryFingerprints([{bytes: 29, sha256: 'first'}, {bytes: 31, sha256: 'second'}], expected)).toBe(true);
  expect(matchesHistoryFingerprints([...expected].reverse(), expected)).toBe(false);
  expect(matchesHistoryFingerprints([{sha256: 'first', bytes: 30}, expected[1]], expected)).toBe(false);
});
