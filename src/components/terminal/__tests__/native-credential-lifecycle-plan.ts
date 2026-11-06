export const credentialLifecyclePhases = ['initiallyAbsent', 'stored', 'roundtripVerified', 'deleted', 'absenceVerified', 'deletedAgain', 'finalAbsenceVerified'] as const;
export type CredentialLifecyclePhase = typeof credentialLifecyclePhases[number] | 'cleanupVerified';
export function credentialLifecycleReference(token: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(token)) throw Error('Exact owned credential token required');
  return 'native-e07-' + token;
}
export interface CredentialLifecycleApi {
  retrieve(reference: string): Promise<string | undefined>;
  store(reference: string, value: string): Promise<void>;
  delete(reference: string): Promise<void>;
}
export async function runCredentialLifecycle(reference: string, api: CredentialLifecycleApi, checkpoint: (phase: CredentialLifecyclePhase) => Promise<void>, generate: () => string) {
  if (credentialLifecycleReference(reference.slice('native-e07-'.length)) !== reference) throw Error('Owned E07 reference required');
  let phase: CredentialLifecyclePhase = 'initiallyAbsent', mayOwn = false, secret: string | undefined;
  const calls: string[] = [];
  const retrieve = () => { calls.push('retrieve_profile_password'); return api.retrieve(reference); };
  const remove = () => { calls.push('delete_profile_password'); return api.delete(reference); };
  try {
    if (await retrieve() !== undefined) throw Error('Reference already exists');
    await checkpoint(phase);mayOwn = true;
    secret = generate();if (secret.length < 32) throw Error('Ephemeral value generation failed');
    calls.push('store_profile_password');await api.store(reference, secret);phase = 'stored';await checkpoint(phase);
    if (await retrieve() !== secret) throw Error('Normal API roundtrip differs');
    phase = 'roundtripVerified';await checkpoint(phase);secret = undefined;
    await remove();phase = 'deleted';await checkpoint(phase);
    if (await retrieve() !== undefined) throw Error('Normal API did not remove the reference');
    phase = 'absenceVerified';await checkpoint(phase);
    await remove();phase = 'deletedAgain';await checkpoint(phase);
    if (await retrieve() !== undefined) throw Error('Normal API absence did not remain stable');
    phase = 'finalAbsenceVerified';await checkpoint(phase);mayOwn = false;
    return {reference, calls, phases: [...credentialLifecyclePhases], initiallyAbsent: true, roundtripMatches: true, deletedTwice: true, finalAbsenceVerified: true, secretExported: false};
  } catch {
    if (mayOwn) {
      try { await remove();if (await retrieve() !== undefined) throw Error('Cleanup incomplete');await checkpoint('cleanupVerified'); }
      catch { throw Error('E07 credential lifecycle failed at ' + phase + '; owned normal API cleanup not confirmed'); }
    }
    throw Error('E07 credential lifecycle failed at ' + phase);
  } finally { secret = undefined; }
}
