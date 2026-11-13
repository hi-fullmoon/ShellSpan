import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const docker = (args, options = {}) => execFileSync('docker', args, {
  encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, ...options,
});

export function inspectSshPeer(fixture) {
  const bash = fixture.shell === 'bash', username = fixture.username;
  const [container] = JSON.parse(docker(['inspect', '--type', 'container', fixture.container]));
  assert(container?.Name === `/${fixture.container}` && container.State.Running
    && container.Config.Labels?.['shellspan.native-input-p2'] === fixture.id
    && container.Image === fixture.imageId, 'Live SSH container ownership or image differs');
  const ports = container.NetworkSettings.Ports?.['22229/tcp'];
  assert(ports?.length === 1 && ports[0].HostIp === '127.0.0.1' && Number(ports[0].HostPort) === fixture.port,
    'Live SSH fixture port binding differs');
  assert(container.Mounts.some(mount => mount.Source === fixture.root && mount.Destination === '/work' && (!bash || !mount.RW)), 'Live SSH fixture source mount differs');
  const key = docker(['exec', fixture.container, 'cat', bash ? '/tmp/nip-sshd/host_key.pub' : '/tmp/p3-sshd/host_key.pub']).trim().split(/\s+/);
  assert(key[0] === 'ssh-ed25519' && createHash('sha256').update(Buffer.from(key[1], 'base64')).digest('hex') === fixture.hostKeySha256,
    'Live SSH fixture host key differs');
  if (typeof fixture.sftpEnabled === 'boolean') {
    const config = docker(['exec', fixture.container, '/usr/sbin/sshd', '-T', '-f', bash ? '/tmp/nip-sshd/sshd_config' : '/tmp/p3-sshd/config']);
    assert.equal(/^subsystem sftp internal-sftp$/m.test(config), fixture.sftpEnabled, 'Effective SSH SFTP configuration differs');
  }
  const shell = docker(['exec', fixture.container, 'getent', 'passwd', username]).trim().split(':');
  const unknownMain = fixture.mainVariant === 'unknown';
  const expected = unknownMain ? (bash ? '/bin/bash' : '/opt/shellspan-unapproved/zsh')
    : (bash ? '/opt/shellspan-native-gnu/gnu-bash-5.3-readline-8.3.6-linux-aarch64-glibc-2.36-native/bash' : '/bin/zsh');
  assert(shell[0] === username && shell[5] === `/home/${username}` && (bash || unknownMain ? shell[6] === expected : ['/bin/zsh', '/usr/bin/zsh'].includes(shell[6])),
    'Live SSH account shell/HOME differs');
  const resolvedShell = docker(['exec', fixture.container, 'readlink', '-f', shell[6]]).trim();
  assert.equal(resolvedShell, docker(['exec', fixture.container, 'readlink', '-f', expected]).trim(),
    'Live SSH login shell does not resolve to the fixture executable path');
  return {
    containerId: container.Id,
    hostKeySha256: fixture.hostKeySha256,
    platform: docker(['exec', fixture.container, 'uname', '-m']).trim(),
    libc: docker(['exec', fixture.container, 'getconf', 'GNU_LIBC_VERSION']).trim(),
    loginShell: shell[6],
    resolvedShell,
    mainSha256: docker(['exec', fixture.container, 'sha256sum', resolvedShell]).split(/\s+/)[0],
  };
}

export const inspectZlePeer = inspectSshPeer;

export function terminateOwnedSshRelay(fixture) {
  inspectSshPeer(fixture);
  const rows = docker(['exec', fixture.container, 'ps', '-eo', 'pid=,euser:16=,args=']).trim().split('\n');
  const relays = rows.flatMap(row => {
    const [pid, user, path, socket, ...extra] = row.trim().split(/\s+/);
    return user === fixture.username && /^\d+$/.test(pid) && /^\/tmp\/\.ss-nip-[a-f0-9]{32}\/relay$/.test(path)
      && socket === `${path.slice(0, -'/relay'.length)}/control` && extra.length === 0 ? [{ pid: Number(pid), path, socket }] : [];
  });
  assert.equal(relays.length, 1, 'Exactly one owned relay may be stopped');
  const [relay] = relays;
  const owned = (...args) => docker(['exec', '--user', fixture.username, fixture.container, ...args]).trim();
  assert.equal(owned('readlink', `/proc/${relay.pid}/exe`), relay.path);
  owned('/bin/kill', '-TERM', String(relay.pid));
  return { ...relay, at: Date.now(), action: 'SIGTERM to independent private relay' };
}

export function inspectLoadedSshResources(fixture, priorRoots) {
  const bash = fixture.shell === 'bash';
  const peer = inspectSshPeer(fixture);
  const resources = resolve(fixture.root, '.artifacts/tests/native-input-p2/resources/native-input');
  const catalogue = JSON.parse(readFileSync(resolve(resources, `${bash ? 'catalogue' : 'editors'}-linux-aarch64-glibc-2.36.json`), 'utf8'));
  const profileId = bash ? 'gnu-bash-5.3-readline-8.3.6-linux-aarch64-glibc-2.36-native' : 'zsh-5.9-zle-5.9-linux-aarch64-glibc-2.36-native';
  const profile = catalogue.profiles.find(entry => (entry.id ?? entry.profile.verifiedProfileId) === profileId);
  assert(profile && peer.mainSha256 === profile.shellSha256 && (bash ? profile.readlineVersion === '8.3.6' : profile.core));
  const run = (...args) => docker(['exec', fixture.container, ...args]).trim();
  const processes = run('ps', '-eo', 'pid=,euser:16=,args=').split('\n');
  const relays = processes.flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(\/tmp\/\.ss-nip-[a-f0-9]{32})\/relay\s+(\/tmp\/\.ss-nip-[a-f0-9]{32})\/control$/);
    return match && match[2] === fixture.username && match[3] === match[4] && !priorRoots.has(match[3]) ? [{ pid: match[1], root: match[3] }] : [];
  });
  assert.equal(relays.length, 1, 'Exactly one new live private relay is required');
  const [{ pid: relayPid, root }] = relays;
  const asOwner = (...args) => docker(['exec', '--user', fixture.username, fixture.container, ...args]).trim();
  const mapped = bash ? ['adapter.so'] : ['scoped/zsh/zle.so', 'ss_nip.so'];
  const shells = processes.flatMap(line => {
    const [pid, user, executable, flag, init, login] = line.trim().split(/\s+/);
    if (user !== fixture.username || ![peer.resolvedShell, peer.loginShell].includes(executable)) return [];
    if (bash ? flag !== '--shellspan-native-init' || init !== `${root}/native-init` || login !== '-il' : flag !== '-il') return [];
    const maps = asOwner('cat', `/proc/${pid}/maps`).split('\n');
    return mapped.every(name => maps.some(entry => entry.endsWith(` ${root}/${name}`))) ? [{ pid, maps: maps.filter(entry => mapped.some(name => entry.endsWith(` ${root}/${name}`))) }] : [];
  });
  assert.equal(shells.length, 1, 'Exactly one pinned shell process must own this native directory and map its editors');
  const [{ pid: shellPid, maps }] = shells;
  // The fixture keeps Docker's default capabilities. Procfs process identity
  // and mappings are read as their owner, without granting SYS_PTRACE.
  const relayExe = asOwner('readlink', `/proc/${relayPid}/exe`), shellExe = asOwner('readlink', `/proc/${shellPid}/exe`);
  assert.equal(relayExe, `${root}/relay`);
  assert.equal(shellExe, peer.resolvedShell);
  assert.equal(run('stat', '-c', '%U %a', root), `${fixture.username} 700`);
  const resourceFiles = bash ? [['adapter.so', '500', profile.module, profile.moduleSha256], ['relay', '500', profile.relay, profile.relaySha256], ['native-init', '600']]
    : [['scoped/zsh/zle.so', '500', profile.core, profile.editorSha256], ['ss_nip.so', '500', profile.module, profile.moduleSha256], ['relay', '500', profile.relay, profile.relaySha256]];
  const files = resourceFiles
    .map(([name, mode, localPath, expected]) => {
      const path = `${root}/${name}`;
      const [owner, actualMode, length] = run('stat', '-c', '%U %a %s', path).split(' ');
      const sha256 = run('sha256sum', path).split(/\s+/)[0];
      assert(owner === fixture.username && actualMode === mode && Number(length) > 0 && /^[a-f0-9]{64}$/.test(sha256));
      if (localPath) {
        const local = resolve(resources, localPath);
        assert.equal(createHash('sha256').update(readFileSync(local)).digest('hex'), expected);
        assert.equal(sha256, expected);
        assert.equal(Number(length), statSync(local).size);
      }
      return { path, owner, mode, length: Number(length), sha256, expected };
    });
  const shellVersion = run(peer.resolvedShell, '--version').split('\n')[0];
  assert.match(shellVersion, bash ? /version 5\.3\.0\(1\)-release/ : /^zsh 5\.9\b/);
  return { root, peer, profileId, shellVersion, readlineVersion: profile.readlineVersion,
    shellPid: Number(shellPid), shellExe, relayPid: Number(relayPid), relayExe, maps, files };
}

export function readSshEffect(fixture) {
  const result = docker(['exec', '--user', fixture.username, fixture.container, '/bin/sh', '-c',
    'file=$1; test ! -L "$file" || exit 2; '
    + 'if test -e "$file"; then test -f "$file" && printf 1 && head -c 4097 "$file"; else printf 0; fi',
    'ssh-effect', `/home/${fixture.username}/phase3-ssh-effects`]);
  if (result === '0') return { text: null, sha256: null };
  assert(result.startsWith('1'), 'Missing remote effect observation');
  const text = result.slice(1);
  assert(Buffer.byteLength(text) <= 4096, 'Remote effect file exceeds evidence bound');
  return { text, sha256: createHash('sha256').update(text).digest('hex') };
}

export function inspectSshScratch(fixture) {
  const home = `/home/${fixture.username}`;
  const asOwner = (...args) => docker(['exec', '--user', fixture.username, fixture.container, ...args]).trim();
  const found = asOwner('find', home, '-mindepth', '4', '-maxdepth', '4', '-type', 'f', '-name', 'phase3-scratch.sh');
  if (!found) return null;
  assert(found.startsWith(`${home}/.shellspan-agent-scratch-`) && /^[-a-zA-Z0-9_/.]+$/.test(found) && found.endsWith('/phase3-scratch.sh'));
  const [owner, mode, length] = asOwner('stat', '-c', '%U %a %s', found).split(' ');
  const sha256 = asOwner('sha256sum', found).split(/\s+/)[0];
  assert.equal(owner, fixture.username);
  return { path: found, owner, mode, length: Number(length), sha256 };
}

export function releaseOldSshTail(fixture) {
  docker(['exec', '--user', fixture.username, fixture.container, '/bin/sh', '-c',
    'set -C; umask 077; : > "$1"', 'ssh-tail', `/home/${fixture.username}/phase3-ssh-tail-release`]);
}

export function provisionZlePeerPassword(fixture, password) {
  docker(['exec', '-i', fixture.container, 'chpasswd'], {
    input: `${fixture.username}:${password}\n`, stdio: ['pipe', 'ignore', 'pipe'],
  });
}

export function cleanZlePeer(fixture) {
  inspectSshPeer(fixture);
  docker(['exec', fixture.container, 'usermod', '-L', fixture.username]);
  docker(['stop', '--timeout', '5', fixture.container]);
  assert.equal(docker(['inspect', '--format', '{{.State.Running}}', fixture.container]).trim(), 'false');
}
