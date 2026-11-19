import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {lstatSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve, sep} from 'node:path';
export const credentialLifecyclePhases = ['initiallyAbsent', 'stored', 'roundtripVerified', 'deleted', 'absenceVerified', 'deletedAgain', 'finalAbsenceVerified'];
export function credentialLifecycleWindowOptions(enabled) { return {visible: !enabled, focus: !enabled}; }
export function createCredentialLifecycleWitness(directory, token) {
  assert(isAbsolute(directory) && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(token), 'Exact owned credential evidence/token required');
  const artifacts = resolve(import.meta.dirname, '../../../artifacts/tests');assert(resolve(directory).toLowerCase().startsWith(artifacts.toLowerCase() + sep), 'Credential witness must remain in owned test artifacts');
  for (let cursor = resolve(directory);; cursor = dirname(cursor)) { const info = lstatSync(cursor);assert(info.isDirectory() && !info.isSymbolicLink(), 'Invalid owned credential evidence ancestor');if (cursor.toLowerCase() === artifacts.toLowerCase()) break;assert(dirname(cursor) !== cursor, 'Credential witness ancestor escaped'); }
  const reference = 'native-e07-' + token, file = join(resolve(directory), 'data/shellspan-main.db'), checkpoints = [];
  writeFileSync(join(directory, 'credential-reservation.json'), JSON.stringify({version: 1, reference, service: 'com.shellspan.dev.profile-password', metadataService: 'com.shellspan.profile-password', reservedOnly: true, normalCreateApi: 'store_profile_password', secretReceived: false}, null, 2), {flag: 'wx', mode: 0o600});
  return {
    reference,
    accept(value) {
      assert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2 && value.reference === reference && typeof value.phase === 'string', 'Invalid owned credential checkpoint');
      const recovery = value.phase === 'cleanupVerified';
      assert(recovery ? checkpoints.length > 0 && !checkpoints.some(x => x.phase === 'finalAbsenceVerified' || x.phase === 'cleanupVerified') : value.phase === credentialLifecyclePhases[checkpoints.length], 'Credential API checkpoint order changed');
      const parent = lstatSync(dirname(file)), info = lstatSync(file);assert(parent.isDirectory() && !parent.isSymbolicLink() && info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'Invalid owned credential metadata database');
      const database = new DatabaseSync(file, {readOnly: true});let rows, routes, pending;
      try { rows = database.prepare('SELECT id,kind,service FROM key_credentials').all();routes = JSON.parse(database.prepare("SELECT value FROM preferences WHERE key='llm.routes.v1'").get().value);pending = database.prepare("SELECT count(*) AS count FROM preferences WHERE key LIKE 'llm.pendingCredential.%'").get().count; } finally { database.close(); }
      assert(routes.routes.length === 0 && !routes.defaultSelection && pending === 0, 'Owned credential App unexpectedly imported route references');
      const exists = ['stored', 'roundtripVerified'].includes(value.phase);
      assert.equal(rows.length, exists ? 1 : 0, 'Normal API credential metadata state differs');
      if (exists) assert(rows[0].id === reference && rows[0].service === 'com.shellspan.profile-password' && rows[0].kind === 'password', 'Unexpected credential metadata identity');
      const record = {phase: value.phase, reference, metadata: rows.map(row => ({...row})), routeCount: 0, pendingCredentialCount: 0, observedAt: new Date().toISOString(), secretReceived: false};checkpoints.push(record);
      writeFileSync(join(directory, 'credential-checkpoint-' + String(checkpoints.length).padStart(2, '0') + '.json'), JSON.stringify(record, null, 2), {flag: 'wx', mode: 0o600});
      if (value.phase === 'finalAbsenceVerified' || recovery) writeFileSync(join(directory, 'credential-api-audit.json'), JSON.stringify({reference, checkpoints, complete: !recovery, cleanupVerified: true, actualDatabase: file, secretReceived: false, secretExported: false}, null, 2), {flag: 'wx', mode: 0o600});
      return {accepted: true};
    },
  };
}
