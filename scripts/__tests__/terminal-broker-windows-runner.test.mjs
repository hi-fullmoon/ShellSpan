import { describe, expect, it } from 'vitest';

import {
  assertBenchmarkShape,
  assertCargoTestsRan,
  assertCommandSucceeded,
  classifyPowerShellAvailability,
  parseBenchmark,
  parsePowerShellVersion,
  parseRustHost,
  supportedRustHosts,
  verifyBenchmarkRound,
} from '../verify-terminal-broker-windows.mjs';

const throughputRows = [
  'local_pty_single\t10.000\t12.000\t200.00\t5',
  'local_pty_multi\t20.000\t24.000\t400.00\t5',
];
const latencyRows = [
  'local_worker_legacy_16ms_first_byte\t8.000\t16.000\t17.000\t41',
  'local_worker_event_first_byte\t0.100\t0.200\t0.300\t41',
  'local_worker_legacy_16ms_low_frequency_burst\t8.000\t16.000\t17.000\t41',
  'local_worker_event_low_frequency_burst\t0.100\t0.200\t0.300\t41',
];

function benchmarkOutput(profile, rows = [...throughputRows, ...latencyRows]) {
  return [
    `terminal_transport_baseline bytes_per_session=2097152 repetitions=5 multi_sessions=4 profile=${profile}`,
    ...rows,
  ].join('\n');
}

describe('Windows Phase 2 acceptance runner fail-closed contracts', () => {
  it('maps both accepted process architectures to an exact Rust host tuple', () => {
    expect(supportedRustHosts).toEqual({
      x64: 'x86_64-pc-windows-msvc',
      arm64: 'aarch64-pc-windows-msvc',
    });
    expect(parseRustHost('rustc 1.95.0\nhost: aarch64-pc-windows-msvc\n')).toBe(
      'aarch64-pc-windows-msvc',
    );
    expect(parseRustHost('host: x86_64-pc-windows-msvc-extra\n')).not.toBe(
      supportedRustHosts.x64,
    );
    expect(parseRustHost('host: one\nhost: two\n')).toBeNull();
  });

  it('rejects missing or malformed PowerShell versions instead of accepting NaN', () => {
    expect(parsePowerShellVersion('5.1.26100.1')).toEqual([5, 1, 26100, 1]);
    expect(parsePowerShellVersion('7.5.3')).toEqual([7, 5, 3, 0]);
    expect(parsePowerShellVersion('7.preview')).toBeNull();
    expect(parsePowerShellVersion('NaN')).toBeNull();
    expect(parsePowerShellVersion('')).toBeNull();
    expect(classifyPowerShellAvailability(null, null)).toEqual({
      hasWindowsPowerShell51: false,
      hasPowerShell7: false,
    });
    expect(classifyPowerShellAvailability('5.1.26100.1', 'NaN')).toEqual({
      hasWindowsPowerShell51: true,
      hasPowerShell7: false,
    });
  });

  it('turns any command spawn or exit failure into a thrown acceptance failure', () => {
    expect(() =>
      assertCommandSucceeded({ error: new Error('missing executable'), status: null }, 'cargo'),
    ).toThrow(/missing executable/);
    expect(() => assertCommandSucceeded({ status: 1 }, 'cargo test')).toThrow(
      /exited with status 1/,
    );
    expect(() => assertCommandSucceeded({ status: 0 }, 'cargo test')).not.toThrow();
  });

  it('rejects zero-test filters and requires the exact ignored test to pass', () => {
    expect(() =>
      assertCargoTestsRan('running 0 tests\ntest result: ok.', 'missing'),
    ).toThrow(/did not execute/);

    const exact = 'terminal_broker::tests::windows_exact';
    const passed = `running 1 test\ntest ${exact} ... ok\ntest result: ok.`;
    expect(() => assertCargoTestsRan(passed, exact, exact)).not.toThrow();
    expect(() =>
      assertCargoTestsRan('running 1 test\ntest another ... ok', exact, exact),
    ).toThrow(/was not reported as passed/);
  });

  it('rejects missing, duplicate, malformed, non-finite, and wrong-profile benchmark data', () => {
    const control = parseBenchmark(benchmarkOutput('release-baseline'));
    expect(() => assertBenchmarkShape(control, false)).not.toThrow();

    expect(() =>
      assertBenchmarkShape(
        parseBenchmark(benchmarkOutput('release-baseline', throughputRows.slice(0, 1))),
        false,
      ),
    ).toThrow(/omitted local_pty_multi/);
    expect(() =>
      parseBenchmark(
        benchmarkOutput('release-baseline', [
          ...throughputRows,
          throughputRows[0],
          ...latencyRows,
        ]),
      ),
    ).toThrow(/duplicate benchmark row/);
    expect(() =>
      parseBenchmark(
        benchmarkOutput('release-baseline').replace('200.00', 'NaN'),
      ),
    ).toThrow(/is invalid: NaN/);
    expect(() => assertBenchmarkShape(control, true)).toThrow(/configuration\/profile mismatch/);
  });

  it('keeps throughput and event-latency thresholds fail-closed', () => {
    const control = parseBenchmark(benchmarkOutput('release-baseline'));
    const broker = parseBenchmark(benchmarkOutput('release-broker-shadow'));
    expect(() => verifyBenchmarkRound(1, control, broker)).not.toThrow();

    broker.throughput.get('local_pty_single').medianMibPerSecond = Number.NaN;
    expect(() => verifyBenchmarkRound(1, control, broker)).toThrow(/not finite/);
  });
});
