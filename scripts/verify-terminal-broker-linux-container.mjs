import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const image = 'shellspan-terminal-broker-linux:local';
const phase3Only = process.argv.includes('--phase3-only');

function run(command, args) {
  const rendered = [command, ...args].join(' ');
  console.log(`\n> ${rendered}`);
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${rendered} exited with status ${result.status ?? 'unknown'}`);
  }
}

const platform = spawnSync('docker', [
  'info',
  '--format',
  '{{.OSType}}/{{.Architecture}}',
], {
  cwd: repositoryRoot,
  encoding: 'utf8',
});
if (platform.error) throw platform.error;
if (platform.status !== 0) {
  throw new Error('Docker Desktop Linux engine is unavailable');
}
const platformName = platform.stdout.trim();
if (platformName !== 'linux/aarch64' && platformName !== 'linux/arm64') {
  throw new Error(`expected Docker Desktop Linux/aarch64, received ${platformName}`);
}

console.log(`Linux evidence boundary: Docker Desktop VM/container (${platformName}), not bare-metal.`);
run('docker', [
  'build',
  '--platform',
  'linux/arm64',
  '-t',
  image,
  'tests/terminal-broker-linux',
]);
run('docker', [
  'run',
  '--rm',
  '--platform',
  'linux/arm64',
  '--mount',
  `type=bind,source=${repositoryRoot},target=/workspace,readonly`,
  ...(phase3Only ? ['--env', 'SHELLSPAN_LINUX_ACCEPTANCE_MODE=phase3-only'] : []),
  image,
]);
