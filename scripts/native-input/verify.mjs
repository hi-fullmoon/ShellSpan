import { repositoryRoot } from './verification-steps.mjs';

const lanes = new Map([
  ['prototype', async () => (await import('./prototype/verification.mjs')).verifyPrototype],
  ['display', async () => (await import('./prototype/verification.mjs')).verifyDisplay],
  ['protocol', async () => (await import('./protocol/verification.mjs')).verifyProtocol],
  ['integration', async () => (await import('./integration/verification.mjs')).verifyIntegration],
]);
const usage = `Usage: node scripts/native-input/verify.mjs <lane> [options]

  prototype    GNU Bash prototype; --upstream, --browser-only, --native-only, --ssh
  display      Installed xterm and native captures; --copy-only or --inband-only
               --captures, --copy-captures, --compat-captures,
               --geometry-captures and --commit-capture accept capture paths
  protocol     NIP producer and runtime; --schema-only validates existing captures
  integration  Bash/Readline application integration; --components-only or --fixture <file>

Platform-specific entry points and prerequisites: scripts/native-input/README.md`;

const [lane, ...args] = process.argv.slice(2);
const load = lanes.get(lane);
if (!lane || lane === '--help' || lane === '-h' || (load && args.length === 1 && ['--help', '-h'].includes(args[0]))) {
  console.log(usage);
} else if (!load) {
  console.error(`Unknown native input verification lane: ${lane}\n${usage}`);
  process.exitCode = 1;
} else {
  process.chdir(repositoryRoot);
  const verify = await load();
  process.exitCode = await verify(args) ?? 0;
}
