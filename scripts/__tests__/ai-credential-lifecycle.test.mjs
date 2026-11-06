import {expect, it} from 'vitest';
import fs from 'node:fs';import p from 'node:path';import {randomUUID} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {createAiCredentialWitness} from '../native-input-p3/ai-credential-lifecycle.mjs';
const workspace = p.resolve(import.meta.dirname, '../..');
function fixture() {
  const base = p.join(workspace, '.artifacts/tests/ai-credential-lifecycle');fs.mkdirSync(base, {recursive: true});const directory = fs.mkdtempSync(p.join(base, 'case-'));fs.mkdirSync(p.join(directory, 'data'));
  const originalPath = p.join(directory, 'original.db'), file = p.join(directory, 'data/shellspan-main.db');
  for (const path of [originalPath, file]) { const db = new DatabaseSync(path);db.exec('CREATE TABLE preferences(key TEXT,value TEXT);CREATE TABLE key_credentials(id TEXT)');db.prepare('INSERT INTO preferences VALUES(?,?)').run('llm.routes.v1', JSON.stringify({schemaVersion: 1, revision: 1, routes: []}));db.close(); }
  const runId = randomUUID();return {directory, originalPath, file, runId, token: randomUUID(), workspace};
}
it('requires an empty exclusive baseline and matches the committed normal API reference without secret payloads', async () => {
  const options = fixture(), witness = createAiCredentialWitness({...options, mode: 'provision'});
  expect((await witness.handle('config', {})).routeId).toBe('e07-ai-' + options.runId);await witness.handle('baseline', {});
  const reference = 'llm-' + randomUUID(), db = new DatabaseSync(options.file);db.prepare("UPDATE preferences SET value=? WHERE key='llm.routes.v1'").run(JSON.stringify({schemaVersion: 1, revision: 2, routes: [{id: 'e07-ai-' + options.runId, revision: 1, adapterId: 'chat-completions', presetId: 'minimax', baseUrl: 'https://api.minimaxi.com', auth: {kind: 'keychain', reference}}]}));db.close();
  await expect(witness.handle('receipt', {reference, readbackMatches: true, secret: 'never persist this'})).rejects.toThrow('Invalid safe AI');
  await expect(witness.handle('receipt', {reference: 'llm-' + randomUUID(), readbackMatches: true})).rejects.toThrow();
  await witness.handle('receipt', {reference, readbackMatches: true});
  const receipt = JSON.parse(fs.readFileSync(p.join(options.directory, 'credential-ownership.json'), 'utf8'));expect(receipt.createdBy).toBe('ai_save_routes');expect(receipt.reference).toBe(reference);
});
it('refuses absence validation without original ownership, independent deletion and matching committed metadata', () => {
  const options = fixture();expect(() => createAiCredentialWitness({...options, mode: 'verify-absence'})).toThrow();
});
it('binds absence to the owned committed reference, a deletion receipt and normal metadata cleanup order', async () => {
  const options = fixture(), provision = createAiCredentialWitness({...options, mode: 'provision'}), reference = 'llm-' + randomUUID();await provision.handle('config', {});await provision.handle('baseline', {});
  let db = new DatabaseSync(options.file);db.prepare("UPDATE preferences SET value=? WHERE key='llm.routes.v1'").run(JSON.stringify({schemaVersion: 1, revision: 2, routes: [{id: 'e07-ai-' + options.runId, revision: 1, adapterId: 'chat-completions', presetId: 'minimax', baseUrl: 'https://api.minimaxi.com', auth: {kind: 'keychain', reference}}]}));db.close();await provision.handle('receipt', {reference, readbackMatches: true});
  execFileSync(process.execPath, [p.join(workspace, 'scripts/native-input-p3/credential-ownership.mjs'), 'recover', options.directory, options.runId, options.originalPath], {cwd: workspace, windowsHide: true, stdio: 'pipe'});
  fs.writeFileSync(p.join(options.directory, 'credential-os-delete.json'), JSON.stringify({operation: 'delete', runId: options.runId, reference, presentAfter: false, secretRead: false}), {flag: 'wx'});
  const verify = createAiCredentialWitness({...options, mode: 'verify-absence'});expect((await verify.handle('config', {})).expectedReference).toBe(reference);
  await expect(verify.handle('cleared', {reference})).rejects.toThrow();await verify.handle('absence', {reference, missing: true});
  db = new DatabaseSync(options.file);db.prepare("UPDATE preferences SET value=? WHERE key='llm.routes.v1'").run(JSON.stringify({schemaVersion: 1, revision: 3, routes: []}));db.close();await verify.handle('cleared', {reference});
  expect(JSON.parse(fs.readFileSync(p.join(options.directory, 'ai-credential-metadata-cleared.json'), 'utf8')).routes).toBe(0);
});
