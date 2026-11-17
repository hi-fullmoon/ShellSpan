import {expect, it} from 'vitest';
import fs from 'node:fs';import p from 'node:path';import {randomUUID} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import {credentialLifecyclePhases, credentialLifecycleWindowOptions, createCredentialLifecycleWitness} from '../native-input-p3/credential-lifecycle.mjs';
function fixture() {
  const base = p.resolve(import.meta.dirname, '../../artifacts/tests/credential-lifecycle');fs.mkdirSync(base, {recursive: true});const directory = fs.mkdtempSync(p.join(base, 'case-'));fs.mkdirSync(p.join(directory, 'data'));
  const database = new DatabaseSync(p.join(directory, 'data/shellspan-main.db'));database.exec('CREATE TABLE key_credentials(id TEXT,kind TEXT,service TEXT);CREATE TABLE preferences(key TEXT,value TEXT)');database.prepare('INSERT INTO preferences VALUES(?,?)').run('llm.routes.v1', JSON.stringify({routes: []}));
  return {directory, database, witness: createCredentialLifecycleWitness(directory, randomUUID())};
}
it('keeps API-only validation hidden without changing ordinary acceptance visibility', () => {
  expect(credentialLifecycleWindowOptions(true)).toEqual({visible: false, focus: false});
  expect(credentialLifecycleWindowOptions(false)).toEqual({visible: true, focus: true});
});
it('requires each normal API metadata checkpoint and records only safe fields', () => {
  const {directory, database, witness} = fixture();
  try {
    for (const phase of credentialLifecyclePhases) {
      if (phase === 'stored') database.prepare('INSERT INTO key_credentials VALUES(?,?,?)').run(witness.reference, 'password', 'com.shellspan.profile-password');
      if (phase === 'deleted') database.exec('DELETE FROM key_credentials');
      expect(witness.accept({reference: witness.reference, phase})).toEqual({accepted: true});
    }
    const audit = JSON.parse(fs.readFileSync(p.join(directory, 'credential-api-audit.json'), 'utf8'));
    expect(audit.complete && audit.cleanupVerified).toBe(true);expect(audit.checkpoints).toHaveLength(7);expect(audit.secretReceived).toBe(false);
  } finally { database.close(); }
});
it('refuses foreign references, secret-bearing payloads, out-of-order and unexpected metadata', () => {
  const {database, witness} = fixture();
  try {
    expect(() => witness.accept({reference: 'original-user-ref', phase: 'initiallyAbsent'})).toThrow('Invalid owned credential checkpoint');
    expect(() => witness.accept({reference: witness.reference, phase: 'initiallyAbsent', password: 'never persist this'})).toThrow('Invalid owned credential checkpoint');
    expect(() => witness.accept({reference: witness.reference, phase: 'stored'})).toThrow('order changed');
    database.prepare('INSERT INTO key_credentials VALUES(?,?,?)').run('unrelated', 'password', 'com.shellspan.profile-password');
    expect(() => witness.accept({reference: witness.reference, phase: 'initiallyAbsent'})).toThrow('metadata state differs');
  } finally { database.close(); }
});
