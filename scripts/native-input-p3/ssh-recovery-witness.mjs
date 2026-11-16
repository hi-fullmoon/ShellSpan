import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { attachMacSubmissionWitness } from './mac-submission.mjs';
import { inspectLoadedSshResources, inspectSshScratch, readSshEffect, releaseOldSshTail, terminateOwnedSshRelay } from './ssh-recovery-fixture.mjs';
import { sshNativeCases } from './ssh-recovery-cases.mjs';

// A byte-transparent loopback forwarder. It can only sever sockets it opened
// to the inspected fixture. SSH, host key, relay, PTY and receipts stay real.
export async function openSshRecoveryForwarder(fixture) {
  const pairs = new Set();
  let opened = 0;
  const server = createServer(client => {
    const upstream = connect({ host: '127.0.0.1', port: fixture.port });
    const pair = { id: ++opened, client, upstream };
    pairs.add(pair);
    for (const [socket, other] of [[client, upstream], [upstream, client]]) {
      socket.on('error', () => other.destroy());
      socket.on('close', () => { other.destroy(); pairs.delete(pair); });
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    connectionCount: () => opened,
    disconnect() {
      const ids = [];
      for (const pair of pairs) {
        if (pair.client.destroyed || pair.upstream.destroyed) continue;
        ids.push(pair.id);
        pair.client.resetAndDestroy();
        pair.upstream.destroy();
      }
      assert(ids.length > 0, 'No actual SSH connection was severed');
      return { at: Date.now(), socketIds: ids };
    },
    async close() {
      for (const pair of pairs) { pair.client.destroy(); pair.upstream.destroy(); }
      await new Promise(resolve => server.close(resolve));
    },
  };
}

export function attachSshRecoveryWitness(vite, { token, directory, id, fixture, getForwarder, manifest }) {
  const plan = sshNativeCases[id];
  attachMacSubmissionWitness(vite, token, directory, { cut: plan.cut ?? undefined, scenario: id });
  const completed = new Set();
  const loadedRoots = new Set();
  const restart = id === 'crash-restart';
  const save = (name, value) => writeFile(resolve(directory, `${name}.json`), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  vite.middlewares.use(`/__zle-ssh-recovery/${token}`, (request, response) => {
    void (async () => {
      const route = request.url;
      let value;
      if (request.method === 'GET' && route === '/effect') value = readSshEffect(fixture);
      else if (request.method === 'GET' && route === '/scratch' && id === 'positive-file-chain') value = inspectSshScratch(fixture);
      else if (request.method === 'GET' && route === '/restart-prior' && restart) {
        value = JSON.parse(await readFile(resolve(directory, 'ssh-crash-prior.json'), 'utf8'));
      }
      else if (request.method === 'POST' && route === '/loaded-resources' && fixture.sftpEnabled !== false) {
        assert(loadedRoots.size < 3, 'Unexpected additional native generation');
        value = inspectLoadedSshResources(fixture, loadedRoots);
        await save(`${restart ? 'restart-' : ''}loaded-resources-${loadedRoots.size + 1}`, value);
        loadedRoots.add(value.root);
      } else if (request.method === 'GET' && route === '/trace') {
        const prior = restart ? JSON.parse(await readFile(resolve(directory, 'ssh-crash-prior.json'), 'utf8')) : null;
        const files = (await readdir(directory)).filter(name => /^native-control-trace-\d+-[a-f0-9-]{36}\.jsonl$/.test(name)
          && resolve(directory, name) !== prior?.cut.trace);
        assert(files.length <= 1, 'Ambiguous actual App trace');
        if (!files.length) value = [];
        else {
          const path = resolve(directory, files[0]), info = await lstat(path);
          assert(info.isFile() && info.size <= 64 * 1024 * 1024 && (info.mode & 0o777) === 0o600);
          const text = await readFile(path, 'utf8');
          value = text.split('\n').slice(0, -1).map(line => JSON.parse(line)).filter(event =>
            /^(?:ssh-|cut-|accept-key-|intent-record-|input-progress-observed$)/.test(event.event));
        }
      } else {
        assert(request.method === 'POST' && !completed.has(route));
        if (route === '/crash' && ['crash-before-key', 'crash-after-key'].includes(id)) {
          const names = await readdir(directory);
          const original = JSON.parse(await readFile(resolve(directory, 'native-webview-evidence.json'), 'utf8'));
          const cuts = names.filter(name => /^submission-cut-\d+-[a-f0-9-]{36}\.json$/.test(name));
          assert.equal(cuts.length, 1);
          const cut = JSON.parse(await readFile(resolve(directory, cuts[0]), 'utf8'));
          assert.equal(cut.cut, plan.cut);
          assert.deepEqual(original.records.cut, cut);
          assert.equal(original.records.id, cut.identity.agentSessionId);
          assert.equal(original.records.approval.sessionId, cut.identity.agentSessionId);
          const matching = [];
          for (const name of names.filter(name => /^native-image-\d+-[a-f0-9-]{36}-process\.json$/.test(name))) {
            const process = JSON.parse(await readFile(resolve(directory, name), 'utf8'));
            if (process.frozenManifest === manifest && process.appPid === cut.pid) matching.push({ name, process });
          }
          assert.equal(matching.length, 1, 'Exact signed App process for the crash cut is missing');
          const [{ name, process: image }] = matching;
          const signing = JSON.parse(await readFile(resolve(directory, name.replace('-process.json', '.json')), 'utf8'));
          assert.equal(signing.frozenManifest, manifest);
          assert(image.executable.startsWith(`${directory}/.shellspan-dev-`));
          const pid = String(image.appPid), command = execFileSync('/bin/ps', ['-p', pid, '-o', 'comm='], { encoding: 'utf8' }).trim();
          const started = execFileSync('/bin/ps', ['-p', pid, '-o', 'lstart='], { encoding: 'utf8' }).trim();
          assert.equal(command, image.executable);
          assert(started && createHash('sha256').update(await readFile(image.executable)).digest('hex') === signing.binarySha256);
          completed.add(route);
          await save('ssh-crash-signal-request', { cut, pid, command, started, sha256: signing.binarySha256, signal: 'SIGKILL' });
          // Keep each field in its own invocation: macOS ps shortens the
          // command column when a second column follows it.
          const confirmedCommand = execFileSync('/bin/ps', ['-p', pid, '-o', 'comm='], { encoding: 'utf8' }).trim();
          const confirmedStart = execFileSync('/bin/ps', ['-p', pid, '-o', 'lstart='], { encoding: 'utf8' }).trim();
          assert(confirmedCommand === command && confirmedStart === started, 'Crash target changed after verification');
          process.kill(image.appPid, 'SIGKILL');
          value = { cut, pid: image.appPid, signal: 'SIGKILL', syscallAccepted: true, imageRecord: name, at: Date.now() };
          await save('ssh-crash-signal', value);
        } else if ((route === '/disconnect' && plan.disconnect) || (route === '/control-eof' && id.endsWith('-control-eof'))) {
          const files = (await readdir(directory)).filter(name => /^submission-cut-\d+-[a-f0-9-]{36}\.json$/.test(name));
          assert.equal(files.length, 1, 'Disconnect requires the actual submission cut');
          const cut = JSON.parse(await readFile(resolve(directory, files[0]), 'utf8'));
          assert.equal(cut.cut, plan.cut);
          completed.add(route);
          const controlOnly = route === '/control-eof';
          value = { ...(controlOnly ? terminateOwnedSshRelay(fixture) : getForwarder().disconnect()), cut };
          await save(controlOnly ? 'ssh-private-relay-terminated' : 'ssh-sockets-severed', value);
        } else if (route === '/release-tail' && ['reconnect-tail', 'display-geometry', 'positive-job-completion'].includes(id)) {
          completed.add(route);
          releaseOldSshTail(fixture);
          value = { at: Date.now(), released: true };
          await save('old-tail-release', value);
        } else throw new Error('Unsupported owned SSH observation/action');
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(value));
    })().catch(error => response.writeHead(500).end(String(error)));
  });
}
