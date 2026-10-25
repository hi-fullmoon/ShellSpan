import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [sourceFile, discoveryFile, output] = process.argv.slice(2);
const root = process.cwd();
const relativeOutput = path.relative(root, path.resolve(output)).split(path.sep).join('/');
assert(relativeOutput.startsWith('.phase4-acceptance/') && !fs.existsSync(output));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const source = read(sourceFile);
const discovery = read(discoveryFile);
assert(Array.isArray(discovery) && discovery.length > 0);
const rows = discovery.map(item => {
  assert(item && typeof item.file === 'string' && path.isAbsolute(item.file));
  const relative = path.relative(root, item.file).split(path.sep).join('/');
  assert(relative && !relative.startsWith('../') && !path.isAbsolute(relative));
  const actualSha256 = digest(item.file);
  return { path: relative, actualSha256, frozenSha256: source.source[relative] ?? null };
});
assert.equal(new Set(rows.map(item => item.path)).size, rows.length);
const missing = rows.filter(item => !item.frozenSha256);
const changed = rows.filter(item => item.frozenSha256 && item.actualSha256 !== item.frozenSha256);
const result = {
  kind: 'actual-vitest-discovery-frozen-source-coverage',
  ok: !missing.length && !changed.length,
  testFileCount: rows.length,
  sourceManifestSha256: digest(sourceFile), discoverySha256: digest(discoveryFile),
  missing, changed, tests: rows,
};
fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ ok: result.ok, testFileCount: rows.length, missing: missing.map(item => item.path), changed: changed.map(item => item.path) }));
assert(result.ok, 'Actual discovered test inputs must all match frozen source entries');
