'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { stripTypeScriptTypes } = require('node:module');

(async () => {
  assert.equal(process.argv.length, 2);
  assert.equal(process.version, 'v26.5.0');
  assert.equal(path.resolve(process.env.SSPA_FIXTURE).toLowerCase(), __dirname.toLowerCase());
  assert.equal(path.resolve(process.cwd()).toLowerCase(), path.join(__dirname, 'output').toLowerCase());
  const sourcePath = path.join(__dirname, 'terminal-output-buffer.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  let sourceWriteRejected = false;
  try {
    const handle = fs.openSync(sourcePath, 'r+');
    fs.closeSync(handle);
  } catch (error) {
    sourceWriteRejected = ['EACCES', 'EPERM', 'EBUSY'].includes(error.code);
  }
  assert.equal(sourceWriteRejected, true);
  const built = stripTypeScriptTypes(source, { mode: 'strip' });
  const buildPath = path.join(process.cwd(), 'terminal-output-buffer.mjs');
  fs.writeFileSync(buildPath, built, { flag: 'wx' });
  assert.equal(fs.readFileSync(buildPath, 'utf8'), built);
  const m = await import(pathToFileURL(buildPath).href);
  const checks = [];
  assert.equal(m.renderTerminalText(m.stripAnsi('\u001b[31mprogress 10%\rprogress 90%\u001b[0m\n')), 'progress 90%');
  checks.push('ansi_redraw');
  m.appendTerminalOutput('fixed-one', 'first\npassword=owned-test-value\nthird\n');
  assert.equal(m.getRecentTerminalOutput('fixed-one', 2), 'password=[REDACTED]\nthird');
  checks.push('redacted_recent_lines');
  const first = m.getRecentTerminalOutputSnapshot('fixed-one', 20);
  assert.equal(m.getRecentTerminalOutputSnapshot('fixed-one', 20), first);
  m.appendTerminalOutput('fixed-one', 'next\n');
  const second = m.getRecentTerminalOutputSnapshot('fixed-one', 20);
  assert.notEqual(second, first);
  assert.ok(second.version > first.version);
  assert.equal(second.content, 'first\npassword=[REDACTED]\nthird\nnext');
  checks.push('snapshot_cache');
  m.rebindTerminalOutput('fixed-one', 'fixed-two');
  assert.equal(m.getRecentTerminalOutput('fixed-one', 20), '');
  assert.equal(m.getRecentTerminalOutput('fixed-two', 20), second.content);
  checks.push('session_rebind');
  m.clearTerminalOutput('fixed-two');
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), source);
  const hash = text => createHash('sha256').update(text).digest('hex');
  fs.writeFileSync(path.join(process.cwd(), 'node-project-result.json'), JSON.stringify({
    version: 1, node_version: process.version,
    source_sha256: hash(source), build_sha256: hash(built),
    source_write_rejected: sourceWriteRejected, checks,
  }), { flag: 'wx' });
  process.exitCode = 73;
})().catch(error => {
  process.stderr.write(String(error.message).slice(0, 2048));
  process.exitCode = 74;
});
