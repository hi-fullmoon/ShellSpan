import { readFile } from 'node:fs/promises';
import path from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const protocolRoot = path.join(repositoryRoot, 'protocol/agent/runtime');

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(protocolRoot, relativePath), 'utf8'));
}

describe('terminal execution Phase 0 protocol contract', () => {
  it('validates the normative TSP/1 fixture and its generation fences', async () => {
    const [schema, fixture] = await Promise.all([
      readJson('terminal-protocol-v1.schema.json'),
      readJson('fixtures/terminal-protocol-v1.json'),
    ]);
    const validator = new Ajv2020({ allErrors: true, strict: true });
    expect(validator.validate(schema, fixture), validator.errorsText()).toBe(true);

    expect(new Set(fixture.map(({ type }) => type))).toEqual(new Set([
      'generationLifecycle',
      'rawOutput',
      'integrationState',
      'integrationEvent',
      'commandState',
      'screenSnapshot',
      'lease',
      'terminalInput',
      'commandControl',
    ]));

    for (const generation of [1, 2]) {
      const frames = fixture.filter((frame) =>
        frame.type === 'rawOutput' && frame.terminalGeneration === generation
      );
      let byteOffset = 0;
      frames.forEach((frame, index) => {
        expect(frame.sequence).toBe(index + 1);
        expect(frame.byteOffset).toBe(byteOffset);
        byteOffset += frame.bytes.length;
      });
    }

    const reconnectedOutput = fixture.find((frame) =>
      frame.type === 'rawOutput' && frame.terminalGeneration === 2
    );
    expect(reconnectedOutput).toMatchObject({ sequence: 1, byteOffset: 0 });

    const ready = fixture.find((frame) =>
      frame.type === 'integrationState' && frame.state === 'ready'
    );
    expect(new Set(ready.capabilities)).toEqual(new Set([
      'promptLifecycle',
      'commandLifecycle',
      'exactCommandLine',
      'exitStatus',
      'currentDirectory',
    ]));

    const input = fixture.find((frame) => frame.type === 'terminalInput');
    const commandStart = fixture.find((frame) =>
      frame.type === 'integrationEvent' && frame.event === 'commandStart'
    );
    expect(new TextDecoder().decode(Uint8Array.from(input.bytes)).replace(/\r?\n$/, ''))
      .toBe(commandStart.commandLine);
    expect(commandStart.trust).toBe('cooperativeIntegration');

    const completed = fixture.find((frame) =>
      frame.type === 'commandState' && frame.state === 'completed'
    );
    expect(completed).toMatchObject({ exitCode: 0, reasonCode: 'cooperativeCommandEnd' });
    const uncertain = fixture.find((frame) =>
      frame.type === 'commandState' && frame.state === 'uncertain'
    );
    expect(uncertain).toMatchObject({ effect: 'stateChange' });

    const snapshot = fixture.find((frame) => frame.type === 'screenSnapshot');
    expect(snapshot.content).toHaveLength(snapshot.rows);
    expect(snapshot.cursor.row).toBeLessThan(snapshot.rows);
    expect(snapshot.cursor.column).toBeLessThan(snapshot.columns);
  });

  it('keeps event v5 and exec_command compatibility values valid', async () => {
    const [eventSchema, eventFixtures, toolSchema] = await Promise.all([
      readJson('event-v5.schema.json'),
      readJson('fixtures/event-v5-terminal-compatibility.json'),
      readJson('tool-contract.schema.json'),
    ]);
    const validator = new Ajv2020({ allErrors: true, strict: true });
    const validateEvent = validator.compile(eventSchema);
    for (const event of eventFixtures) {
      expect(validateEvent(event), validator.errorsText(validateEvent.errors)).toBe(true);
    }

    const invalidSurface = structuredClone(eventFixtures.at(-1));
    invalidSurface.data.surface = 'realTerminal';
    expect(validateEvent(invalidSurface)).toBe(false);

    expect(eventSchema.properties.type.enum).toContain('session/execution_surface_changed');
    const changedSurfaces = eventFixtures
      .filter(({ type }) => type === 'session/execution_surface_changed')
      .map(({ data }) => data.surface);
    expect(new Set(changedSurfaces)).toEqual(new Set(['direct', 'boundTerminal']));
    expect(toolSchema.$defs.execCommandArguments.properties.channel.enum)
      .toEqual(['pty', 'direct']);
    expect(toolSchema.$defs.execCommandResultData.properties.channel.enum)
      .toEqual(['pty', 'direct']);

    const validateTool = validator.compile(toolSchema);
    const terminalCall = {
      requestId: 'request-1',
      callId: 'call-1',
      toolName: 'terminal_execute',
      arguments: { command: 'cd /tmp', explanation: 'preserve shell state' },
      target: { kind: 'local', targetId: 'target-1', sessionId: 'transport-1' },
      capabilityId: 'capability-1',
    };
    expect(validateTool(terminalCall), validator.errorsText(validateTool.errors)).toBe(true);
    expect(validateTool({
      ...terminalCall,
      arguments: { ...terminalCall.arguments, channel: 'pty' },
    })).toBe(false);
    expect(validateTool({ ...terminalCall, target: {
      kind: 'remote', targetId: 'target-1', sessionId: 'transport-1',
      profileId: 'profile-1', host: 'host', port: 22, username: 'user',
    } }), validator.errorsText(validateTool.errors)).toBe(true);
    expect(validateTool({
      requestId: 'request-1',
      callId: 'call-1',
      toolName: 'terminal_execute',
      targetId: 'target-1',
      status: 'uncertain',
      summary: 'completion unavailable',
      data: {
        contractVersion: 1,
        channel: 'terminal',
        state: 'uncertain',
        terminalSessionId: 'terminal-1',
        terminalGeneration: 2,
        operationId: 'operation-1',
        commandId: 'command-1',
        commandLine: 'side-effect',
        exitCode: null,
        cwd: null,
        stdout: '',
        stderr: '',
        combinedOutput: '',
        captureStartSequence: 1,
        captureEndSequence: null,
        truncated: false,
        noAutoReplay: true,
      },
      artifacts: [],
      effects: [],
      truncated: false,
    }), validator.errorsText(validateTool.errors)).toBe(true);
  });

  it('reserves every migration flag with an explicit rollback rule', async () => {
    const compatibility = await readFile(
      path.join(protocolRoot, 'terminal-execution-compatibility.md'),
      'utf8',
    );
    for (const flag of [
      'terminal_surface_semantics_v1',
      'terminal_broker_v1',
      'terminal_shell_integration_v1',
      'terminal_execute_v1',
      'terminal_remote_agent_pty_v1',
      'terminal_interactive_tools_v1',
      'terminal_legacy_wrapper_fallback_v1',
    ]) {
      expect(compatibility).toContain(`\`${flag}\``);
    }
    expect(compatibility).toContain('| Rollback rule |');
    expect(compatibility).toMatch(/never reroute or replay an in-flight\/uncertain command/i);
    expect(compatibility).toContain('SHELLSPAN_TERMINAL_BROKER_V1');
    expect(compatibility).toMatch(/absent value is explicitly\s+off/i);
    expect(compatibility).toMatch(/have no\s+frontend mutation IPC/i);
    expect(compatibility).toMatch(/bounded to the 256 most recently closed logical\s+sessions/i);
    expect(compatibility).toMatch(/successful reconnect drops\s+all superseded transport identities/i);
  });

  it('keeps the Phase 3 path wrapper-free and the legacy fallback additive', async () => {
    const [integration, terminalExecute, adapter, callPolicy, modelTools, legacy, manifest] = await Promise.all([
      readFile(path.join(repositoryRoot, 'src-tauri/src/terminal_integration.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/agent_runtime/native/terminal_execute.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/agent_runtime/native_adapter.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/agent_runtime/native/call_policy.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/agent_runtime/model_tools.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/agent_runtime/native/pty.rs'), 'utf8'),
      readJson('built-in-tools.json'),
    ]);
    const terminalExecuteProduction = terminalExecute.split('#[cfg(test)]')[0];
    expect(integration).toContain('ControlEndpoint');
    expect(integration).toContain('libc::mkfifo');
    expect(integration).toContain('foreground commands inherit no control fd');
    expect(integration).toContain('NamedPipeServerStream');
    expect(integration).toContain('add-zsh-hook preexec');
    expect(integration).toContain("trap '__shellspan_preexec' DEBUG");
    expect(terminalExecuteProduction).not.toContain('/bin/sh -c');
    expect(terminalExecuteProduction).not.toContain('BEGIN:');
    expect(terminalExecuteProduction).not.toContain('[Agent]');
    expect(adapter).toContain('TerminalVisibleCommandRoute::TerminalExecute');
    expect(adapter).toContain('TerminalVisibleCommandRoute::LegacyFallback');
    expect(adapter).toContain('TerminalLifecycleTrust::DirectRequired');
    expect(callPolicy).toContain('requires Direct execution for security-sensitive command lifecycle evidence');
    expect(modelTools).toContain('"lifecycleTrust"');
    expect(modelTools).toContain('visible-terminal lifecycle is never security evidence or a sandbox');
    expect(legacy).toContain('build_posix_wrapper');
    expect(legacy).toContain('build_powershell_wrapper');
    expect(manifest.tools.map(({ name }) => name)).toContain('terminal_execute');
    expect(manifest.tools.find(({ name }) => name === 'terminal_execute')).toMatchObject({
      targetKinds: ['local', 'remote'],
      retryPolicy: 'reconcileFirst',
      idempotency: 'conditional',
    });
  });

  it('records Phase 2/3/4 platform evidence without promoting container results', async () => {
    const [roadmap, rfc, matrix, phase2, phase3, phase4, windowsRunner, broker, brokerTests, benchmark, packageJsonText] = await Promise.all([
      readFile(path.join(protocolRoot, 'terminal-execution-roadmap.md'), 'utf8'),
      readFile(path.join(protocolRoot, 'terminal-protocol-rfc.md'), 'utf8'),
      readFile(path.join(protocolRoot, 'terminal-execution-test-matrix.md'), 'utf8'),
      readFile(path.join(protocolRoot, 'terminal-execution-phase-2-acceptance.md'), 'utf8'),
      readFile(path.join(protocolRoot, 'terminal-execution-phase-3-acceptance.md'), 'utf8'),
      readFile(path.join(protocolRoot, 'terminal-execution-phase-4-acceptance.md'), 'utf8'),
      readFile(path.join(repositoryRoot, 'scripts/verify-terminal-broker-windows.mjs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/terminal_broker.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/tests/terminal_broker.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/examples/terminal_transport_baseline.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
    ]);
    const packageJson = JSON.parse(packageJsonText);

    expect(roadmap).toContain('[Phase 2 evidence](./terminal-execution-phase-2-acceptance.md)');
    expect(roadmap).toContain('complete (waived Windows native evidence)');
    const phase3SessionId = '01a0a3a5-747a-7af2-b6ec-392a60141fed';
    expect(roadmap.split(/\r?\n/).filter((line) => line.startsWith('| 3. Local visible command |')))
      .toEqual([
        '| 3. Local visible command | `' + phase3SessionId + '` | **complete (waived Windows native evidence)** | [Phase 3 evidence](./terminal-execution-phase-3-acceptance.md) |',
      ]);
    expect(phase3.split(/\r?\n/).filter((line) => line.startsWith('Session:')))
      .toEqual(['Session: `' + phase3SessionId + '`']);
    expect(roadmap).toContain('[Phase 3 evidence](./terminal-execution-phase-3-acceptance.md)');
    const phase4SessionId = '01a0a461-d04c-7d33-ba24-d2d314c773d8';
    const phase4FinalContinuationId = '01a0a500-3512-7be2-9516-7bfc9813ed66';
    expect(roadmap.split(/\r?\n/).filter((line) => line.startsWith('| 4. Remote real terminal |')))
      .toEqual([
        '| 4. Remote real terminal | `' + phase4SessionId + '`; continuations `01a0a4cf-4ef0-71d2-8845-1ae963c3090a`, `01a0a4f2-3d68-78c3-b6f1-a39b18f6f03d`, `' + phase4FinalContinuationId + '` | **complete — PASS (waived Windows native evidence)** | [Phase 4 evidence](./terminal-execution-phase-4-acceptance.md) |',
      ]);
    expect(phase4).toContain('Original Phase 4 session: `' + phase4SessionId + '`');
    expect(phase4).toContain('Final lifecycle and gate continuation: `' + phase4FinalContinuationId + '`');
    expect(roadmap).toContain('| 5. Interactive operation | not created | **ready — not started**');
    expect(phase4).toContain('**Final gate: PASS. Phase 5 is READY for a separate session');
    expect(phase4).toContain('Native Windows/ConPTY with Windows PowerShell 5.1 and');
    expect(phase4).toContain('**MISSING**, not `PASS`');
    expect(phase4).toContain('`pnpm test:terminal-visible:ssh`');
    expect(phase3).toContain('**PASS for Phase 3 under the explicit 2026-09-15 cooperative-shell RFC');
    expect(phase3).toContain('Phase 4 is **READY for a');
    expect(phase3).toContain('separate session and was not started**');
    expect(phase3).toContain('Active same-UID code');
    expect(phase3).toContain('`lifecycleTrust = directRequired`');
    expect(rfc).toContain('### Amendment decision — 2026-09-15');
    expect(rfc).toContain('generation-bound isolated control plane');
    expect(rfc).toContain('**out-of-scope tampering**');
    expect(rfc).toContain('MUST use Direct execution');
    expect(roadmap).toMatch(/Native Windows\/ConPTY remains\s+\*\*MISSING\*\*, not `PASS`/i);
    expect(roadmap).toMatch(/waiver expires before any\s+Phase 6 default enablement or removal of the legacy wrapper/i);
    expect(matrix).toMatch(/Linux bash and zsh \| \*\*PASS \(VM\/container\)\*\*/);
    expect(matrix).toContain('Overall gate: **PASS for Phase 3 under the 2026-09-15 cooperative-shell RFC');
    expect(matrix).toMatch(/Bare-metal Linux \| \*\*MISSING\*\*/);
    expect(phase2).toContain('macos_bash_pty_broker_preserves_raw_bytes_input_order_and_resize');
    expect(phase2).toMatch(/Linux VM\/container evidence, not bare-metal Linux evidence/);
    expect(phase2).toContain('Phase 2 complete with waived Windows native evidence');
    expect(phase2).toMatch(/temporary Phase 2 gate waiver, not test\s+evidence/i);
    expect(phase2).toMatch(/Windows lane remains \*\*MISSING\*\* and must never be reported as\s+`PASS`/i);
    expect(phase2).toMatch(/Static x86_64\/ARM64 cross-compilation and cfg checks cannot replace\s+that native run/i);
    expect(matrix).toMatch(/temporarily waived for the Phase 2 gate only, not a pass/i);
    expect(matrix).toMatch(/must pass before Phase 6 default enablement or removal of the\s+legacy wrapper/i);
    expect(packageJson.scripts['test:terminal-broker:windows'])
      .toBe('node scripts/verify-terminal-broker-windows.mjs');
    expect(windowsRunner).toContain("process.platform !== 'win32'");
    expect(windowsRunner).toContain('MISSING: native Windows/ConPTY execution is required');
    expect(windowsRunner).toContain("x64: 'x86_64-pc-windows-msvc'");
    expect(windowsRunner).toContain("arm64: 'aarch64-pc-windows-msvc'");
    expect(windowsRunner).toContain('const expectedRustHost = supportedRustHosts[process.arch]');
    expect(windowsRunner).toContain('const actualRustHost =');
    expect(windowsRunner).toContain('actualRustHost !== expectedRustHost');
    expect(windowsRunner).toContain('parsePowerShellVersion');
    expect(windowsRunner).toContain('requires x64 or arm64');
    expect(windowsRunner).not.toContain("process.arch !== 'x64'");
    expect(windowsRunner).toContain("probeVersion('powershell.exe', 'Windows PowerShell')");
    expect(windowsRunner).toContain("probeVersion('pwsh.exe', 'PowerShell 7')");
    expect(windowsRunner).toContain('windows_powershell_5_1_conpty_broker_preserves_raw_bytes_order_and_resize');
    expect(windowsRunner).toContain('windows_powershell_7_conpty_broker_preserves_raw_bytes_order_and_resize');
    expect(windowsRunner.match(/\['--ignored', '--exact'\]/g)).toHaveLength(4);
    expect(windowsRunner).toContain('windows_powershell_5_1_visible_command_integration');
    expect(windowsRunner).toContain('windows_powershell_7_visible_command_integration');
    expect(windowsRunner).toContain("cargoTest('agent_runtime::native::process::tests')");
    expect(windowsRunner).toContain("cargoTest('agent_runtime::native::pty::tests')");
    expect(windowsRunner).toContain("cargoTest('commands::tests')");
    expect(windowsRunner).toContain("cargoExampleTest('terminal_transport_baseline')");
    expect(windowsRunner).toContain('assertCargoTestsRan(output, filter, exactTest)');
    expect(windowsRunner).toContain('runCounts[0] < 1');
    expect(windowsRunner).toContain("args.push('--broker')");
    expect(windowsRunner).toContain('Number.isFinite');
    expect(windowsRunner).toContain('candidate.medianMibPerSecond < baseline.medianMibPerSecond * 0.8');
    expect(windowsRunner).toContain('candidate.p95Ms > 2');
    expect(brokerTests).toContain('assert_eq!(first_receipt.input_sequence, 1)');
    expect(brokerTests).toContain('assert_eq!(second_receipt.input_sequence, 2)');
    expect(brokerTests).toContain('echo-independent payload');
    expect(brokerTests).toContain('assert!(bounded_replay.has_more)');
    expect(benchmark).toContain('SHELLSPAN_BENCH_PAYLOAD_BEGIN:');
    expect(benchmark).toContain('validate_emitted_payload(&output, bytes)');
    expect(matrix).toContain('Native Windows command: `pnpm test:terminal-broker:windows`');
    expect(matrix).toMatch(/x86_64 or arm64 Windows/);
    expect(phase2).toMatch(/MISSING as designed.*exit 2/i);
    expect(phase2).toContain('aarch64-pc-windows-msvc');
    expect(phase2).toContain('Tauri 2.11.5 resolves for the ARM64 target');
    expect(phase2).toMatch(/vendored ConPTY cfg compiles for Windows ARM64/i);
    expect(phase2).toMatch(/two independently admitted writes/i);
    expect(phase2).toMatch(/zero-test filter/i);
    expect(phase2).toMatch(/non-finite benchmark/i);
    expect(phase2).toMatch(/macOS lacks Windows SDK\/MSVC C headers/i);
  });
});
