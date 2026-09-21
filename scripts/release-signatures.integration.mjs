import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { verifyUpdaterSignature } from './publish-release.mjs';

test('real minisign signatures accept original bytes and reject tampering or another key', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shellspan-signature-test-'));
  try {
    const file = path.join(directory, 'release-notes.mjs');
    await writeFile(file, await readFile(new URL('./release-notes.mjs', import.meta.url)));
    const secret = path.join(directory, 'secret.key');
    const pub = path.join(directory, 'public.key');
    execFileSync('minisign', ['-G', '-W', '-s', secret, '-p', pub], { stdio: 'pipe' });
    execFileSync('minisign', ['-Sm', file, '-s', secret], { stdio: 'pipe' });
    const signature = (await readFile(`${file}.minisig`)).toString('base64');
    const publicKey = (await readFile(pub)).toString('base64');
    await verifyUpdaterSignature(file, signature, publicKey);
    const otherSecret = path.join(directory, 'other.key');
    const otherPublic = path.join(directory, 'other.pub');
    execFileSync('minisign', ['-G', '-W', '-s', otherSecret, '-p', otherPublic], { stdio: 'pipe' });
    await assert.rejects(verifyUpdaterSignature(file, signature, (await readFile(otherPublic)).toString('base64')));
    await writeFile(file, '\n// modified after signing\n', { flag: 'a' });
    await assert.rejects(verifyUpdaterSignature(file, signature, publicKey));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
