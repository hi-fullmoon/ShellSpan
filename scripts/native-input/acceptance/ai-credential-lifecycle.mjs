import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstatSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve, sep} from 'node:path';
import {createHash} from 'node:crypto';
const run = promisify(execFile), uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
function objectWithKeys(value, keys) { assert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'Invalid safe AI credential checkpoint'); }
export function createAiCredentialWitness({mode, directory, token, runId, originalPath, workspace}) {
  assert(['provision', 'verify-absence'].includes(mode) && uuid.test(token) && uuid.test(runId) && isAbsolute(directory) && isAbsolute(originalPath), 'Exact owned AI credential context required');
  const artifacts = resolve(workspace, 'artifacts/tests');assert(resolve(directory).toLowerCase().startsWith(artifacts.toLowerCase() + sep));
  for (let cursor = resolve(directory);; cursor = dirname(cursor)) { const info = lstatSync(cursor);assert(info.isDirectory() && !info.isSymbolicLink());if (cursor.toLowerCase() === artifacts.toLowerCase()) break;assert(cursor !== dirname(cursor)); }
  const file = join(directory, 'data/shellspan-main.db'), routeId = 'e07-ai-' + runId;
  const read = name => { const path = join(directory, name), info = lstatSync(path);assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size < 131072);return JSON.parse(readFileSync(path, 'utf8')); };
  const write = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2), {flag: 'wx', mode: 0o600});
  function metadata() {
    const info = lstatSync(file), parent = lstatSync(dirname(file));assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && parent.isDirectory() && !parent.isSymbolicLink());
    const db = new DatabaseSync(file, {readOnly: true});let raw, pending, keys;
    try { raw = db.prepare("SELECT value FROM preferences WHERE key='llm.routes.v1'").get().value;pending = db.prepare("SELECT key,value FROM preferences WHERE key LIKE 'llm.pendingCredential.%'").all();keys = db.prepare('SELECT id FROM key_credentials').all(); } finally { db.close(); }
    assert.equal(keys.length, 0);assert.equal(pending.length, 0);return {document: JSON.parse(raw), documentSha256: digest(raw), pending: 0, keyMetadata: 0};
  }
  let stage = 'new', expectedReference;
  function ownedRoute(value) {
    const document = value.document;assert(document.routes.length === 1 && !document.defaultSelection);const route = document.routes[0];
    assert(route.id === routeId && route.adapterId === 'chat-completions' && route.presetId === 'minimax' && route.baseUrl === 'https://api.minimaxi.com' && route.auth.kind === 'keychain');objectWithKeys(route.auth, ['kind', 'reference']);assert(typeof route.auth.reference === 'string' && route.auth.reference.startsWith('llm-') && uuid.test(route.auth.reference.slice(4)));return route;
  }
  if (mode === 'verify-absence') {
    const receipt = read('credential-ownership.json'), baseline = read('credential-baseline.json'), recovered = read('credential-recovery.json'), deleted = read('credential-os-delete.json');
    assert(receipt.runId === runId && receipt.createdBy === 'ai_save_routes' && receipt.service === 'com.shellspan.dev.ai-provider' && baseline.runId === runId && baseline.empty && recovered.runId === runId && recovered.references.length === 1 && recovered.references[0].reference === receipt.reference && recovered.references[0].committed && recovered.references[0].normalApiReceipt);
    assert(deleted.operation === 'delete' && deleted.runId === runId && deleted.reference === receipt.reference && deleted.presentAfter === false && deleted.secretRead === false);expectedReference = receipt.reference;assert.equal(ownedRoute(metadata()).auth.reference, expectedReference);
  }
  return {async handle(action, body) {
    if (action === 'config') { objectWithKeys(body, []);assert.equal(stage, 'new');stage = 'configured';return {mode, runId, routeId, expectedReference}; }
    if (action === 'baseline' && mode === 'provision') {
      objectWithKeys(body, []);assert.equal(stage, 'configured');const before = metadata();assert(before.document.routes.length === 0 && !before.document.defaultSelection);
      const output = await run(process.execPath, [join(workspace, 'scripts/native-input/acceptance/credential-ownership.mjs'), 'baseline', directory, runId, originalPath], {cwd: workspace, windowsHide: true, timeout: 20000, maxBuffer: 16384});write('credential-baseline-command.json', {exitCode: 0, result: JSON.parse(output.stdout)});stage = 'baseline';return {accepted: true};
    }
    if (action === 'receipt' && mode === 'provision') {
      objectWithKeys(body, ['reference', 'readbackMatches']);assert.equal(stage, 'baseline');const after = metadata(), route = ownedRoute(after), baseline = read('credential-baseline.json');assert(body.readbackMatches === true && body.reference === route.auth.reference && !baseline.originalReferences.includes(body.reference));
      write('credential-ownership.json', {version: 1, runId, reference: body.reference, service: 'com.shellspan.dev.ai-provider', createdBy: 'ai_save_routes'});
      write('ai-credential-provision-audit.json', {runId, routeId, reference: body.reference, readbackMatches: true, actualCommittedDocumentSha256: after.documentSha256, documentRevision: after.document.revision, routeRevision: route.revision, pendingCredentialCount: 0, keyCredentialMetadataCount: 0, normalCreateApi: 'ai_save_routes', normalReadApi: 'ai_get_route_api_key', secretReceived: false});stage = 'stored';return {accepted: true};
    }
    if (action === 'absence' && mode === 'verify-absence') {
      objectWithKeys(body, ['reference', 'missing']);assert.equal(stage, 'configured');assert(body.reference === expectedReference && body.missing === true);assert.equal(ownedRoute(metadata()).auth.reference, expectedReference);
      write('ai-credential-normal-api-absence.json', {runId, reference: expectedReference, command: 'ai_get_route_api_key', error: 'MISSING_CREDENTIAL', missing: true, secretReceived: false});stage = 'absent';return {accepted: true};
    }
    if (action === 'cleared' && mode === 'verify-absence') {
      objectWithKeys(body, ['reference']);assert.equal(stage, 'absent');assert.equal(body.reference, expectedReference);const after = metadata();assert(after.document.routes.length === 0 && !after.document.defaultSelection);
      write('ai-credential-metadata-cleared.json', {runId, reference: expectedReference, routes: 0, pendingCredentialCount: 0, keyCredentialMetadataCount: 0, actualDocumentSha256: after.documentSha256, normalApi: 'ai_save_routes', secretReceived: false});stage = 'cleared';return {accepted: true};
    }
    throw Error('AI credential phase/action rejected');
  }};
}
export function attachAiCredentialLifecycle(server, options) {
  const witness = createAiCredentialWitness(options);
  server.middlewares.use(`/__native-e07-ai-credential/${options.token}`, async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end();return; }
    const chunks = [];let length = 0;
    try {
      for await (const chunk of request) { length += chunk.length;assert(length <= 4096);chunks.push(chunk); }
      const bytes = Buffer.concat(chunks);let body;try { body = JSON.parse(bytes.toString('utf8')); } finally { bytes.fill(0); }
      const action = new URL(request.url, 'http://127.0.0.1').pathname.slice(1), result = await witness.handle(action, body);response.setHeader('Content-Type', 'application/json');response.end(JSON.stringify(result));
    } catch { response.writeHead(500).end('Owned AI credential metadata checkpoint refused'); }
    finally { for (const chunk of chunks) chunk.fill(0); }
  });
}
