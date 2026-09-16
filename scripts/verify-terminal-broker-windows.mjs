import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cargo = 'cargo.exe';
const benchmarkBytes = 2_097_152;
const benchmarkRepetitions = 5;
const benchmarkSessions = 4;
const benchmarkLatencySamples = 41;
const throughputScenarios = ['local_pty_single', 'local_pty_multi'];
const latencyScenarios = [
  'local_worker_legacy_16ms_first_byte',
  'local_worker_event_first_byte',
  'local_worker_legacy_16ms_low_frequency_burst',
  'local_worker_event_low_frequency_burst',
];

export const supportedRustHosts = Object.freeze({
  x64: 'x86_64-pc-windows-msvc',
  arm64: 'aarch64-pc-windows-msvc',
});

function execute(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, CARGO_TERM_COLOR: 'never' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function render(command, args) {
  return [command, ...args].join(' ');
}

export function assertCommandSucceeded(result, rendered) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${rendered} exited with status ${result.status ?? 'unknown'}`);
  }
}

function run(command, args) {
  const rendered = render(command, args);
  console.log(`\n> ${rendered}`);
  const result = execute(command, args);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assertCommandSucceeded(result, rendered);
  return result.stdout;
}

function probeVersion(command, label) {
  const result = execute(command, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '$PSVersionTable.PSVersion.ToString()',
  ]);
  if (result.error || result.status !== 0) {
    console.error(`MISSING: ${label} (${command}) is not installed or runnable.`);
    return null;
  }
  const version = result.stdout.trim();
  console.log(`${label}: ${version}`);
  return version;
}

export function parseRustHost(output) {
  const hosts = output
    .split(/\r?\n/)
    .map((line) => line.match(/^host:\s+(\S+)\s*$/)?.[1])
    .filter(Boolean);
  return hosts.length === 1 ? hosts[0] : null;
}

export function parsePowerShellVersion(output) {
  const match = output.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!match) return null;
  return match.slice(1).map((component) => Number(component ?? 0));
}

export function classifyPowerShellAvailability(windowsPowerShell, powerShell7) {
  const windowsPowerShellVersion = windowsPowerShell
    ? parsePowerShellVersion(windowsPowerShell)
    : null;
  const powerShell7Version = powerShell7 ? parsePowerShellVersion(powerShell7) : null;
  const hasWindowsPowerShell51 =
    windowsPowerShellVersion?.[0] === 5 && windowsPowerShellVersion[1] === 1;
  const hasPowerShell7 = powerShell7Version !== null && powerShell7Version[0] >= 7;
  return { hasWindowsPowerShell51, hasPowerShell7 };
}

export function assertCargoTestsRan(output, filter, exactTest = null) {
  const runCounts = [...output.matchAll(/^running (\d+) tests?\r?$/gm)].map((match) =>
    Number(match[1]),
  );
  if (runCounts.length !== 1 || runCounts[0] < 1) {
    throw new Error(
      `cargo test filter ${filter} did not execute a non-empty single libtest harness`,
    );
  }
  if (exactTest) {
    if (runCounts[0] !== 1) {
      throw new Error(`exact cargo test ${exactTest} executed ${runCounts[0]} tests`);
    }
    const passed = output
      .split(/\r?\n/)
      .some((line) => line.trim() === `test ${exactTest} ... ok`);
    if (!passed) throw new Error(`exact cargo test ${exactTest} was not reported as passed`);
  }
}

function cargoTest(filter, testArgs = [], exactTest = null) {
  const output = run(cargo, [
    'test',
    '--locked',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    filter,
    '--lib',
    '--',
    ...testArgs,
    '--nocapture',
  ]);
  assertCargoTestsRan(output, filter, exactTest);
}

function cargoExampleTest(example) {
  const output = run(cargo, [
    'test',
    '--locked',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--example',
    example,
    '--',
    '--nocapture',
  ]);
  assertCargoTestsRan(output, `--example ${example}`);
}

function finiteNumber(value, field, { positive = false, integer = false } = {}) {
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    (positive ? parsed <= 0 : parsed < 0) ||
    (integer && !Number.isInteger(parsed))
  ) {
    throw new Error(`benchmark field ${field} is invalid: ${value}`);
  }
  return parsed;
}

export function parseBenchmark(output) {
  const headers = [
    ...output.matchAll(
      /^terminal_transport_baseline bytes_per_session=(\d+) repetitions=(\d+) multi_sessions=(\d+) profile=(\S+)\r?$/gm,
    ),
  ];
  if (headers.length !== 1) {
    throw new Error('benchmark output omitted or duplicated its configuration header');
  }
  const throughput = new Map();
  const latency = new Map();
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split('\t');
    if (fields[0].startsWith('local_pty_')) {
      if (fields.length !== 5) throw new Error(`malformed benchmark row: ${line}`);
      if (throughput.has(fields[0])) throw new Error(`duplicate benchmark row: ${fields[0]}`);
      const medianMs = finiteNumber(fields[1], `${fields[0]}.median_ms`, { positive: true });
      const p95Ms = finiteNumber(fields[2], `${fields[0]}.p95_ms`, { positive: true });
      if (p95Ms < medianMs) throw new Error(`benchmark ${fields[0]} p95 is below its median`);
      throughput.set(fields[0], {
        medianMs,
        p95Ms,
        medianMibPerSecond: finiteNumber(fields[3], `${fields[0]}.median_mib_per_s`, {
          positive: true,
        }),
        repetitions: finiteNumber(fields[4], `${fields[0]}.repetitions`, {
          positive: true,
          integer: true,
        }),
      });
    }
    if (fields[0].startsWith('local_worker_')) {
      if (fields.length !== 5) throw new Error(`malformed benchmark row: ${line}`);
      if (latency.has(fields[0])) throw new Error(`duplicate benchmark row: ${fields[0]}`);
      const medianMs = finiteNumber(fields[1], `${fields[0]}.median_ms`);
      const p95Ms = finiteNumber(fields[2], `${fields[0]}.p95_ms`);
      const maxMs = finiteNumber(fields[3], `${fields[0]}.max_ms`);
      if (p95Ms < medianMs || maxMs < p95Ms) {
        throw new Error(`benchmark ${fields[0]} latency percentiles are inconsistent`);
      }
      latency.set(fields[0], {
        medianMs,
        p95Ms,
        maxMs,
        samples: finiteNumber(fields[4], `${fields[0]}.samples`, {
          positive: true,
          integer: true,
        }),
      });
    }
  }
  return {
    bytes: Number(headers[0][1]),
    repetitions: Number(headers[0][2]),
    sessions: Number(headers[0][3]),
    profile: headers[0][4],
    throughput,
    latency,
  };
}

export function assertBenchmarkShape(result, broker) {
  const expectedProfile = broker ? 'release-broker-shadow' : 'release-baseline';
  if (
    result.bytes !== benchmarkBytes ||
    result.repetitions !== benchmarkRepetitions ||
    result.sessions !== benchmarkSessions ||
    result.profile !== expectedProfile
  ) {
    throw new Error(`benchmark configuration/profile mismatch for ${expectedProfile}`);
  }
  for (const scenario of throughputScenarios) {
    const metric = result.throughput.get(scenario);
    if (!metric) throw new Error(`benchmark omitted ${scenario}`);
    if (
      !Number.isFinite(metric.medianMs) ||
      !Number.isFinite(metric.p95Ms) ||
      !Number.isFinite(metric.medianMibPerSecond)
    ) {
      throw new Error(`benchmark ${scenario} metric is not finite`);
    }
    if (
      metric.medianMs <= 0 ||
      metric.p95Ms < metric.medianMs ||
      metric.medianMibPerSecond <= 0
    ) {
      throw new Error(`benchmark ${scenario} metric is invalid`);
    }
    if (metric.repetitions !== benchmarkRepetitions) {
      throw new Error(`benchmark ${scenario} reported the wrong repetition count`);
    }
  }
  for (const scenario of latencyScenarios) {
    const metric = result.latency.get(scenario);
    if (!metric) throw new Error(`benchmark omitted ${scenario}`);
    if (
      !Number.isFinite(metric.medianMs) ||
      !Number.isFinite(metric.p95Ms) ||
      !Number.isFinite(metric.maxMs)
    ) {
      throw new Error(`benchmark ${scenario} metric is not finite`);
    }
    if (metric.medianMs < 0 || metric.p95Ms < metric.medianMs || metric.maxMs < metric.p95Ms) {
      throw new Error(`benchmark ${scenario} metric is invalid`);
    }
    if (metric.samples !== benchmarkLatencySamples) {
      throw new Error(`benchmark ${scenario} reported the wrong sample count`);
    }
  }
}

function benchmark(broker) {
  const args = [
    'run',
    '--locked',
    '--release',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--example',
    'terminal_transport_baseline',
    '--',
    '--bytes',
    String(benchmarkBytes),
    '--repetitions',
    String(benchmarkRepetitions),
    '--sessions',
    String(benchmarkSessions),
  ];
  if (broker) args.push('--broker');
  const result = parseBenchmark(run(cargo, args));
  assertBenchmarkShape(result, broker);
  return result;
}

export function verifyBenchmarkRound(round, control, broker, platformLabel = 'Windows') {
  assertBenchmarkShape(control, false);
  assertBenchmarkShape(broker, true);
  for (const scenario of throughputScenarios) {
    const baseline = control.throughput.get(scenario);
    const candidate = broker.throughput.get(scenario);
    if (!baseline || !candidate) {
      throw new Error(`benchmark round ${round} omitted ${scenario}`);
    }
    if (candidate.medianMibPerSecond < baseline.medianMibPerSecond * 0.8) {
      throw new Error(
        `benchmark round ${round} ${scenario} throughput regressed more than 20%`,
      );
    }
    const allowedP95Increase = Math.max(baseline.p95Ms * 0.25, 5);
    if (candidate.p95Ms > baseline.p95Ms + allowedP95Increase) {
      throw new Error(
        `benchmark round ${round} ${scenario} p95 exceeded the Phase 0 threshold`,
      );
    }
  }

  for (const scenario of [
    'local_worker_event_first_byte',
    'local_worker_event_low_frequency_burst',
  ]) {
    const candidate = broker.latency.get(scenario);
    if (!candidate) throw new Error(`benchmark round ${round} omitted ${scenario}`);
    if (candidate.p95Ms > 2) {
      throw new Error(`benchmark round ${round} ${scenario} p95 exceeded 2 ms`);
    }
  }
  console.log(`${platformLabel} broker benchmark round ${round}: PASS`);
}

export function main() {
  if (process.platform !== 'win32') {
    console.error(
      `MISSING: native Windows/ConPTY execution is required; current platform is ${process.platform}/${process.arch}.`,
    );
    process.exit(2);
  }

  const expectedRustHost = supportedRustHosts[process.arch];
  if (!expectedRustHost) {
    console.error(
      `MISSING: the accepted Windows lane requires x64 or arm64; current architecture is ${process.arch}.`,
    );
    process.exit(2);
  }

  const rustc = execute('rustc.exe', ['-vV']);
  const actualRustHost = rustc.error || rustc.status !== 0 ? null : parseRustHost(rustc.stdout);
  if (actualRustHost !== expectedRustHost) {
    console.error(
      `MISSING: ${expectedRustHost} Rust host toolchain is required for Windows ${process.arch}; received ${actualRustHost ?? 'none'}.`,
    );
    process.exit(2);
  }
  process.stdout.write(rustc.stdout);

  const missing = [];
  const windowsPowerShell = probeVersion('powershell.exe', 'Windows PowerShell');
  const powerShell7 = probeVersion('pwsh.exe', 'PowerShell 7');
  const { hasWindowsPowerShell51, hasPowerShell7 } = classifyPowerShellAvailability(
    windowsPowerShell,
    powerShell7,
  );
  if (!hasWindowsPowerShell51) {
    missing.push('Windows PowerShell 5.1');
    console.error(
      `MISSING: expected Windows PowerShell 5.1, received ${windowsPowerShell ?? 'none'}.`,
    );
  }
  if (!hasPowerShell7) {
    missing.push('PowerShell 7');
    console.error(
      `MISSING: expected PowerShell 7 or newer, received ${powerShell7 ?? 'none'}.`,
    );
  }

  run(cargo, ['fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--all', '--', '--check']);
  run(cargo, ['check', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--all-targets']);
  cargoExampleTest('terminal_transport_baseline');
  cargoTest('terminal_broker::tests');
  cargoTest('agent_runtime::native::terminal_execute::tests');
  cargoTest('terminal_integration::tests');
  cargoTest('agent_runtime::native::terminal_lease::tests');
  cargoTest('agent_runtime::native::terminal_interactive::tests');
  cargoTest('agent_runtime::native::runtime::tests');
  cargoTest('agent_runtime::recovery::tests');
  cargoTest('session::tests');

  if (hasWindowsPowerShell51) {
    const testName =
      'terminal_broker::tests::windows_powershell_5_1_conpty_broker_preserves_raw_bytes_order_and_resize';
    cargoTest(testName, ['--ignored', '--exact'], testName);
    const integrationTest =
      'terminal_integration::tests::windows_powershell_5_1_visible_command_integration';
    cargoTest(integrationTest, ['--ignored', '--exact'], integrationTest);
    const interactiveTest =
      'agent_runtime::native::terminal_interactive::tests::windows_powershell_5_1_interactive_terminal_operation';
    cargoTest(interactiveTest, ['--ignored', '--exact'], interactiveTest);
    cargoTest('agent_runtime::native::process::tests');
    cargoTest('agent_runtime::native::pty::tests');
    cargoTest('commands::tests');
    run(cargo, [
      'test',
      '--locked',
      '--manifest-path',
      'src-tauri/Cargo.toml',
      '--',
      '--test-threads=1',
    ]);
  } else {
    console.error('MISSING: direct/compatibility/full Windows suites require Windows PowerShell 5.1.');
  }

  if (hasPowerShell7) {
    const testName =
      'terminal_broker::tests::windows_powershell_7_conpty_broker_preserves_raw_bytes_order_and_resize';
    cargoTest(testName, ['--ignored', '--exact'], testName);
    const integrationTest =
      'terminal_integration::tests::windows_powershell_7_visible_command_integration';
    cargoTest(integrationTest, ['--ignored', '--exact'], integrationTest);
    const interactiveTest =
      'agent_runtime::native::terminal_interactive::tests::windows_powershell_7_interactive_terminal_operation';
    cargoTest(interactiveTest, ['--ignored', '--exact'], interactiveTest);
  }

  for (let round = 1; round <= 2; round += 1) {
    console.log(`\nWindows broker benchmark round ${round}`);
    const control = benchmark(false);
    const broker = benchmark(true);
    verifyBenchmarkRound(round, control, broker);
  }

  if (missing.length > 0) {
    console.error(`Windows Phase 6 acceptance: MISSING — ${missing.join(', ')}.`);
    process.exit(2);
  }

  console.log('Windows Phase 2/3/5/6 native ConPTY and rollout acceptance: PASS.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
