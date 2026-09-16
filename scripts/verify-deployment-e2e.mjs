import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const compose = ['compose', '-f', 'tests/deployment-e2e/compose.yml', '-p', 'shellspan-deployment-e2e'];
const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'shellspan-deployment-e2e-'));
const imageArchive = path.join(temporaryRoot, 'fixture-images.tar');

function run(command, args, options = {}) {
  const rendered = [command, ...args].join(' ');
  console.log(`\n> ${rendered}`);
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${rendered} exited with status ${result.status ?? 'unknown'}`);
  }
  return result;
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
}

function buildFixtureImage(tag, status) {
  run(docker, [
    'buildx', 'build',
    '--platform', 'linux/arm64',
    '--load',
    '--quiet',
    '--build-arg', `HEALTH_STATUS=${status}`,
    '-t', `shellspan/deployment-e2e:${tag}`,
    'tests/deployment-e2e/app',
  ]);
  return output(docker, ['image', 'inspect', '--format', '{{.Id}}', `shellspan/deployment-e2e:${tag}`]);
}

let fixtureStarted = false;
try {
  run(docker, ['build', '--quiet', '-t', 'shellspan-deployment-e2e:local', 'tests/deployment-e2e']);
  run(docker, [...compose, 'up', '-d', '--wait']);
  fixtureStarted = true;
  buildFixtureImage('fixture-healthy', 200);
  buildFixtureImage('fixture-unhealthy', 503);
  const tags = [
    ['fixture-healthy', 'fixture-nginx-fail'],
    ['fixture-healthy', 'fixture-nginx-success'],
    ['fixture-healthy', 'fixture-mismatch'],
    ['fixture-healthy', 'fixture-cancel'],
    ['fixture-healthy', 'fixture-lock'],
    ['fixture-unhealthy', 'fixture-unhealthy-rollback-fail'],
  ];
  for (const [source, target] of tags) {
    run(docker, ['tag', `shellspan/deployment-e2e:${source}`, `shellspan/deployment-e2e:${target}`]);
  }
  run(docker, [
    'save', '--output', imageArchive,
    ...['fixture-healthy', 'fixture-unhealthy', ...tags.map(([, target]) => target)]
      .map((tag) => `shellspan/deployment-e2e:${tag}`),
  ]);
  const environment = {
    ...process.env,
    SHELLSPAN_E2E_SSH_FIXTURE: '1',
    SHELLSPAN_E2E_SSH_HOST: '127.0.0.1',
    SHELLSPAN_E2E_SSH_PORT: '22224',
    SHELLSPAN_E2E_SSH_USERNAME: 'shellspan',
    SHELLSPAN_E2E_SSH_PASSWORD: 'shellspan-deployment-e2e',
    SHELLSPAN_DEPLOYMENT_E2E_ROOT: '/srv/shellspan-deployment',
    SHELLSPAN_DEPLOYMENT_E2E_IMAGE_ARCHIVE: imageArchive,
    SHELLSPAN_DEPLOYMENT_E2E_COMPOSE: path.join(repositoryRoot, 'tests/deployment-e2e/app/compose.yaml'),
  };
  run(cargo, [
    'test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml',
    'isolated_deployment_', '--lib', '--', '--ignored', '--nocapture', '--test-threads=1',
  ], { env: environment });
  console.log('\nDeployment Phase 8 isolated SSH, SFTP, detached runner, and DinD gate passed.');
} finally {
  if (fixtureStarted) run(docker, [...compose, 'down', '--volumes']);
  for (const file of [imageArchive]) {
    try { unlinkSync(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  try { rmdirSync(temporaryRoot); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}
