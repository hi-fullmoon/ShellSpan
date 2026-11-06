import {expect, it} from 'vitest';
import {credentialLifecyclePhases, credentialLifecycleReference, runCredentialLifecycle} from './native-credential-lifecycle-plan';
const reference = credentialLifecycleReference('53ba5934-7830-41a7-8e38-4e5b83c55831');
it('uses normal APIs in order and exports only lifecycle facts', async () => {
  let value: string | undefined;const phases: string[] = [], secret = 'fresh-memory-only-value-for-unit-test';
  const result = await runCredentialLifecycle(reference, {retrieve: async () => value, store: async (_, next) => { value = next; }, delete: async () => { value = undefined; }}, async phase => { phases.push(phase); }, () => secret);
  expect(result.calls).toEqual(['retrieve_profile_password', 'store_profile_password', 'retrieve_profile_password', 'delete_profile_password', 'retrieve_profile_password', 'delete_profile_password', 'retrieve_profile_password']);
  expect(phases).toEqual(credentialLifecyclePhases);expect(value).toBeUndefined();expect(JSON.stringify({result, phases})).not.toContain(secret);
});
it('never overwrites or removes an existing entry, including an empty value', async () => {
  for (const existing of ['', 'unrelated']) {
    let mutations = 0;
    await expect(runCredentialLifecycle(reference, {retrieve: async () => existing, store: async () => { mutations++; }, delete: async () => { mutations++; }}, async () => {}, () => 'unused')).rejects.toThrow('initiallyAbsent');
    expect(mutations).toBe(0);
  }
  expect(() => credentialLifecycleReference('../original')).toThrow('Exact owned credential token');
});
it('cleans only its reserved entry after a failed store or checkpoint and redacts the original error', async () => {
  let value: string | undefined, deletes = 0;const phases: string[] = [];
  await expect(runCredentialLifecycle(reference, {retrieve: async () => value, store: async (_, next) => { value = next;throw Error(next); }, delete: async () => { value = undefined;deletes++; }}, async phase => { phases.push(phase); }, () => 'do-not-export-this-generated-secret-value')).rejects.toThrow('failed at initiallyAbsent');
  expect(value).toBeUndefined();expect(deletes).toBe(1);expect(phases).toEqual(['initiallyAbsent', 'cleanupVerified']);
});
