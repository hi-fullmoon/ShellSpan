import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { stat, readFile } from 'node:fs/promises';
import { resolve, isAbsolute, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import draft7 from 'ajv/dist/refs/json-schema-draft-07.json' with { type: 'json' };

// The actual native backend initializes its own empty schema first. Import only
// the validated secret-free route document, never user DDL or other data.
const [sourcePath, directory] = process.argv.slice(2);
assert(sourcePath && directory && isAbsolute(directory));
const destination = join(resolve(directory), 'shellspan-main.db');
assert((await stat(destination)).isFile(), 'Actual native data initialization must complete first');
const source = new DatabaseSync(sourcePath, { readOnly: true });
try {
  const row = source.prepare('SELECT value FROM preferences WHERE key = ?').get('llm.routes.v1');
  assert(row && typeof row.value === 'string', 'Source has no route document');
  const document = JSON.parse(row.value);
  const validator = new Ajv2020({ allErrors: true, strict: true });
  validator.addMetaSchema(draft7);
  validator.addSchema(JSON.parse(await readFile(new URL('../../protocol/llm/catalog.schema.json', import.meta.url), 'utf8')));
  const validate = validator.compile(JSON.parse(await readFile(new URL('../../protocol/llm/routes.schema.json', import.meta.url), 'utf8')));
  assert(validate(document), 'Route document failed the complete repository schema; no data imported');
  assert(document.defaultSelection && Array.isArray(document.routes));
  for (const route of document.routes) {
    const url = new URL(route.baseUrl);
    assert(!url.username && !url.password && !url.search && !url.hash, 'Route URL is not secret-free');
    assert(route.auth && ['none', 'keychain'].includes(route.auth.kind));
    assert(Object.keys(route.auth).every(key => ['kind', 'reference'].includes(key)), 'Unexpected route authentication field');
  }
  const target = new DatabaseSync(destination);
  try {
    target.exec('BEGIN');
    assert.deepEqual(target.prepare('SELECT version FROM schema_version').all().map(value=>value.version),[1]);
    const existing=target.prepare('SELECT value FROM preferences WHERE key=?').get('llm.routes.v1');
    assert(existing && JSON.parse(existing.value).routes.length===0,'Independent native route store must be empty');
    assert.equal(target.prepare('UPDATE preferences SET value=? WHERE key=? AND value=?').run(row.value,'llm.routes.v1',existing.value).changes,1);
    target.exec('COMMIT');
    assert.equal(target.prepare('SELECT count(*) AS count FROM preferences').get().count, 1);
  } finally { target.close(); }
  console.log(JSON.stringify({ destination, routeCount: document.routes.length,
    defaultSelection: document.defaultSelection, secretsRead: false, userSettingsCopied: false }));
} finally { source.close(); }
