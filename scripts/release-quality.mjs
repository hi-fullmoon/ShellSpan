import { pathToFileURL } from 'node:url';
import { command, REPOSITORY } from './release-notes.mjs';

const requiredJobs = ['Frontend and Audit', 'Rust (macos)', 'Rust (windows)', 'Isolated SSH/SFTP E2E'];
const api = endpoint => JSON.parse(command('gh', ['api', endpoint]));

export function assertPreparedQuality(meta) {
  if (!Number.isSafeInteger(meta.qualityRunId) || meta.qualityRunId <= 0) {
    throw new Error('Release metadata must record a successful pre-version Quality Gate run');
  }
  return assertQuality(meta.headSha, meta.qualityRunId);
}

export function assertQuality(sha, expectedRunId) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Quality validation requires an exact commit SHA');
  const workflow = api(`repos/${REPOSITORY}/actions/workflows/quality-gate.yml`);
  const pages = JSON.parse(command('gh', ['api', '--paginate', '--slurp',
    `repos/${REPOSITORY}/actions/workflows/quality-gate.yml/runs?head_sha=${sha}&branch=main&per_page=100`]));
  const runs = pages.flatMap(page => page.workflow_runs).filter(run =>
    run.head_sha === sha && run.head_branch === 'main' && run.head_repository?.full_name === REPOSITORY
    && run.workflow_id === workflow.id && ['push', 'workflow_dispatch'].includes(run.event));
  runs.sort((a, b) => b.run_number - a.run_number);
  const run = runs[0];
  if (!run || run.status !== 'completed' || run.conclusion !== 'success'
      || (expectedRunId !== undefined && run.id !== expectedRunId)) {
    throw new Error(`Full Quality Gate has not passed for ${sha}; push main or run pnpm release:validate before preparing a version`);
  }
  const jobPages = JSON.parse(command('gh', ['api', '--paginate', '--slurp',
    `repos/${REPOSITORY}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`]));
  const jobs = jobPages.flatMap(page => page.jobs);
  for (const name of requiredJobs) {
    const matching = jobs.filter(job => job.name === name);
    if (matching.length !== 1 || matching[0].head_sha !== sha || matching[0].status !== 'completed'
        || matching[0].conclusion !== 'success') throw new Error(`Required Quality Gate job did not pass: ${name}`);
  }
  return run.id;
}

export function requestValidation() {
  if (command('git', ['status', '--porcelain'])) throw new Error('Commit pending changes before requesting validation');
  const sha = command('git', ['rev-parse', 'HEAD']);
  const remote = command('git', ['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0];
  if (sha !== remote) throw new Error('Push the final code commit to origin/main before validation');
  command('gh', ['workflow', 'run', 'quality-gate.yml', '--repo', REPOSITORY, '--ref', 'main']);
  console.log(`Requested full Quality Gate for main (${sha}). Wait for success before release:prepare.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'request') requestValidation();
    else console.log(`Validated Quality Gate run ${assertQuality(command('git', ['rev-parse', 'HEAD']))}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
