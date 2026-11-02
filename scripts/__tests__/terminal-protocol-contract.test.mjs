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
  it('keeps terminal display on the raw transport instead of replaying tool metadata', async () => {
    const controller = await readFile(path.join(repositoryRoot, 'src/components/terminal/terminal-controller-layer.tsx'), 'utf8');
    expect(controller).not.toContain('agent-command-echo');
    expect(controller).not.toContain('appendTerminalOutput');
    expect(controller).not.toContain('controller.write(');
    expect(controller).toContain('controller.suppressUserInput(');
    expect(controller).toContain('listenToAgentRuntimeSession(');
    for (const locale of ['zh-CN', 'en-US']) {
      const source = await readFile(path.join(repositoryRoot, `src/locales/${locale}.ts`), 'utf8');
      expect(source).not.toContain("'terminal.notice.agentDirectCommand'");
      expect(source).not.toContain("'terminal.notice.agentOutputTruncated'");
    }
  });
  it('represents native job uncertainty and shared management output without PID authority', async () => {
    const schema = await readJson('tool-contract.schema.json');
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addSchema(schema);
    const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/nativeJobManagementResultData` });
    const handle = `job-${'a'.repeat(32)}`;
    const job = { processHandle: handle, ownerTargetId: 'host', agentSessionId: 'agent', taskId: 'task', transportSessionId: 'transport', terminalSessionId: 'terminal', terminalGeneration: 1, shell: 'bash', operationId: 'operation', commandLine: 'approved source', submittedCommandLine: 'frozen submission', acceptedCommandLine: null, controlLost: false, nativeActive: null, state: 'uncertain', exitCode: null, observedOutputSequence: 0, observedAtUnixMs: 1000, observationRevision: 0, captureStartSequence: 1, cleanupReason: null, stopRequested: false, launchConfirmed: false };
    const data = { state: 'uncertain', exitCode: null, processHandle: handle, job, waitTimedOut: false, stopRequested: false, managementBlocked: null, waitCancelled: false, outputScope: 'sharedTerminal', stdout: '', stderr: '', noAutoReplay: true };
    expect(validate(data), ajv.errorsText(validate.errors)).toBe(true);
    expect(validate({ ...data, stdout: 'fabricated isolated job log' })).toBe(false);
    expect(validate({ ...data, job: { ...job, pid: 123 } })).toBe(false);
    expect(validate({ ...data, processHandle: '123' })).toBe(false);
    expect(validate({ ...data, outputScope: 'isolatedProcess' })).toBe(false);
  });
  it('keeps native edit checkpoints and shell job control private, bounded and typed', async () => {
    const schema = await readJson('terminal-protocol.schema.json');
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addSchema(schema);
    const editor = ajv.compile({ $ref: `${schema.$id}#/$defs/nativeEditorControlRecord` });
    const job = ajv.compile({ $ref: `${schema.$id}#/$defs/nativeJobControlRecord` });
    for (const value of [['H', '0'], ['H', '1'], ['A', ''], ['L', '1', ''], ['A', "literal '\"\n\r\t"], ['A', 'x'.repeat(32768)]]) {
      expect(editor(value), ajv.errorsText(editor.errors)).toBe(true);
    }
    for (const value of [['H', '2'], ['L', '0', ''], ['L', '1', 'not empty'], ['L', '1'], ['A'], ['A', 'a\0b'], ['A', 'x'.repeat(32769)], ['A', 'buffer', 'extra']]) expect(editor(value)).toBe(false);
    for (const value of [['V', '0'], ['V', '1'], ['W'], ['M', '', 'user draft'], ...['b', 'e', 'p', 's'].map(action => ['M', `${action}${'a'.repeat(64)}`, "literal '\"\n\r\t"])]) {
      expect(editor(value), ajv.errorsText(editor.errors)).toBe(true);
    }
    for (const value of [['V', '2'], ['V', 1], ['M', `x${'a'.repeat(64)}`, ''], ['M', `e${'a'.repeat(63)}`, ''], ['M', '', 'a\0b'], ['M', '', 'x'.repeat(32769)], ['M', '', '', 'extra']]) expect(editor(value)).toBe(false);
    const handle = `job-${'a'.repeat(32)}`;
    for (const value of [['K', '1'], ['B', handle, 'running', '-'], ['B', handle, 'stopped', '-'], ['B', handle, 'settled', '7'], ['F', handle, '-1']]) expect(job(value), ajv.errorsText(job.errors)).toBe(true);
    for (const value of [['B', '123', 'running', '-'], ['B', handle, 'running', '0'], ['B', handle, 'madeUp', '-'], ['F', handle, 'zero']]) expect(job(value)).toBe(false);
    const publicFrames = new Ajv2020({ strict: true }).compile(schema);
    expect(publicFrames([['A', 'buffer']])).toBe(false);
    expect(publicFrames([['V', '1']])).toBe(false);
    expect(editor(['W', 'extra'])).toBe(false);
    expect(publicFrames([['W']])).toBe(false);
    expect(publicFrames([['M', `e${'a'.repeat(64)}`, 'source']])).toBe(false);
    const engine = await readFile(path.join(repositoryRoot, 'src-tauri/src/agent_runtime/native/terminal_execute.rs'), 'utf8');
    expect(engine).toContain('wait_native_checkpoint');
    expect(engine).toContain('require_native_input_recovery');
    const native = await readFile(path.join(repositoryRoot, 'src-tauri/src/terminal_jobs.ps1'), 'utf8');
    const nativeHost = await readFile(
      path.join(repositoryRoot, 'src-tauri/src/terminal_job_host.cs'),
      'utf8',
    );
    expect(nativeHost).toContain('SourceSucceeded = $?');
    expect(nativeHost).toContain('TryStatementAst');
    expect(native).toContain('[ShellSpanJobHost]::InstrumentSource');
    expect(native).toContain('} *>&1 | & $__shellspanStatusSink');
    expect(native).toContain('| Microsoft.PowerShell.Core\\Out-Host');
    expect(native).toContain('ActiveProcesses -eq 0');
    expect(nativeHost).toContain('AssignProcessToJobObject');
    expect(nativeHost).toContain('TerminateJobObject');
    expect(native).not.toContain('Receive-Job');
  });
  it('accepts complete native scripts and advertises their capability without allowing terminal controls', async () => {
    const validator = new Ajv2020({ allErrors: true, strict: true });
    const validate = validator.compile(await readJson('tool-contract.schema.json'));
    const call = { requestId: 'native-request', callId: 'native-call', capabilityId: 'native-capability', toolName: 'terminal_execute',
      target: { kind: 'local', targetId: 'local', sessionId: 'terminal', cwd: '/workspace' },
      arguments: { command: "cat <<'EOF'\nquoted '\"' and\tTab\r\nEOF", explanation: 'Run the approved complete script' } };
    expect(validate(call), validator.errorsText(validate.errors)).toBe(true);
    for (const control of ['\0', '\x03', '\x11', '\x13', '\x1b', '\x7f', '\x85']) {
      expect(validate({ ...call, arguments: { ...call.arguments, command: `printf '${control}'` } })).toBe(false);
    }
    const terminalSchema = await readJson('terminal-protocol.schema.json');
    const fixture = await readJson('fixtures/terminal-protocol.json');
    const frame = fixture.find(({ type, state }) => type === 'integrationState' && state === 'ready');
    const validateTerminal = new Ajv2020({ allErrors: true, strict: true }).compile(terminalSchema);
    expect(validateTerminal([{ ...frame, capabilities: [...frame.capabilities, 'nativeScriptInput'] }]), JSON.stringify(validateTerminal.errors)).toBe(true);
    expect(validateTerminal([{ ...frame, capabilities: [...frame.capabilities, 'unrecognizedInput'] }])).toBe(false);
  });
  it('validates durable terminal reconnect events without accepting process targets or unknown fields', async () => {
    const validator = new Ajv2020({ allErrors: true, strict: true });
    const validate = validator.compile(await readJson('event-v5.schema.json'));
    const event = { version: 5, sessionId: 'agent', seq: 5, timeUnixMs: 1_000,
      type: 'session/terminal_reconnected', data: { previousSessionId: 'old',
        target: { kind: 'remote', targetId: 'terminal-new', sessionId: 'new', host: 'example.com', port: 22, username: 'user', rootPath: '/srv' } } };
    expect(validate(event), validator.errorsText(validate.errors)).toBe(true);
    expect(validate({ ...event, data: { target: event.data.target } })).toBe(false);
    expect(validate({ ...event, data: { ...event.data, approved: true } })).toBe(false);
    expect(validate({ ...event, data: { ...event.data, target: { ...event.data.target, kind: 'process' } } })).toBe(false);
  });
  it('keeps automatic review evidence native-owned and output-only', async () => {
    const validator = new Ajv2020({ allErrors: true, strict: true });
    const validate = validator.compile(await readJson('tool-contract.schema.json'));
    const call = {
      requestId: 'review-request', callId: 'review-call', capabilityId: 'review-capability', toolName: 'exec_command',
      target: { kind: 'local', targetId: 'local', sessionId: 'terminal', cwd: '/workspace' },
      arguments: { command: 'pwd', explanation: 'inspect workspace', channel: 'direct' },
    };
    expect(validate(call), validator.errorsText(validate.errors)).toBe(true);
    expect(validate({ ...call, arguments: { ...call.arguments, approvalReview: 'boundedLocalRead' } })).toBe(false);
    expect(validate({ requestId: call.requestId, callId: call.callId, toolName: call.toolName,
      targetId: 'local', status: 'completed', summary: 'Read completed',
      data: { channel: 'direct', state: 'exited', stdout: '/workspace\n', stderr: '', truncated: false, approvalReview: 'boundedLocalRead' },
    }), validator.errorsText(validate.errors)).toBe(true);
  });
  it('allows only digest-bound local trash calls and reports system recovery', async () => {
    const validator = new Ajv2020({ allErrors: true, strict: true });
    const validate = validator.compile(await readJson('tool-contract.schema.json'));
    const call = {
      requestId: 'trash-request', callId: 'trash-call', capabilityId: 'trash-capability', toolName: 'trash_file',
      target: { kind: 'local', targetId: 'local', sessionId: 'terminal', cwd: '/workspace' },
      arguments: { path: 'old.json', expectedSha256: 'a'.repeat(64) },
    };
    expect(validate(call), validator.errorsText(validate.errors)).toBe(true);
    expect(validate({ ...call, arguments: { path: 'old.json' } })).toBe(false);
    expect(validate({ ...call, arguments: { ...call.arguments, permanent: true } })).toBe(false);
    expect(validate({ ...call, target: { kind: 'remote', targetId: 'remote', sessionId: 'terminal', host: 'localhost', port: 22, username: 'operator' } })).toBe(false);
    expect(validate({ requestId: call.requestId, callId: call.callId, toolName: call.toolName,
      targetId: 'local', status: 'completed', summary: 'Moved to system trash',
      data: { path: '/workspace/old.json', trashed: true, recovery: 'systemTrash' },
    }), validator.errorsText(validate.errors)).toBe(true);
  });
  it('validates the normative TSP/1 fixture and its generation fences', async () => {
    const [schema, fixture] = await Promise.all([
      readJson('terminal-protocol.schema.json'),
      readJson('fixtures/terminal-protocol.json'),
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

    const replayArtifactEvent = {
      version: 5,
      sessionId: 'session-1',
      seq: 8,
      timeUnixMs: 1_000,
      turnId: 'turn-1',
      stepId: 'step-1',
      type: 'assistant/message',
      data: {
        messageId: 'message-1',
        content: [],
        usage: {},
        stopReason: 'stop',
        interrupted: false,
        replay: {
          storage: 'artifact',
          artifact: {
            artifactId: 'artifact-0123456789abcdef0123456789abcdef',
            kind: 'assistant-replay',
            title: 'Private assistant replay metadata',
            mediaType: 'application/vnd.shellspan.agent-replay+zstd',
            sha256: '0'.repeat(64),
            sizeBytes: 300_000,
            sensitivity: 'internal',
            createdAtUnixMs: 1_000,
          },
        },
      },
    };
    expect(validateEvent(replayArtifactEvent), validator.errorsText(validateEvent.errors)).toBe(true);
    replayArtifactEvent.data.replay.artifact.sha256 = 'invalid';
    expect(validateEvent(replayArtifactEvent)).toBe(false);

    const invalidSurface = structuredClone(eventFixtures.at(-1));
    invalidSurface.data.surface = 'realTerminal';
    expect(validateEvent(invalidSurface)).toBe(false);

    expect(eventSchema.properties.type.enum).toContain('session/execution_surface_changed');
    const changedSurfaces = eventFixtures
      .filter(({ type }) => type === 'session/execution_surface_changed')
      .map(({ data }) => data.surface);
    expect(new Set(changedSurfaces)).toEqual(new Set(['direct', 'boundTerminal']));
    expect(toolSchema.$defs.execCommandArguments.properties.channel.const).toBe('direct');
    expect(toolSchema.$defs.execCommandResultData.properties.channel.const).toBe('direct');

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

    const probeCall = {
      requestId: 'request-1',
      callId: 'call-probe',
      toolName: 'probe_http',
      arguments: {
        method: 'post',
        port: 3000,
        path: '/api',
        body: '{"title":"test"}',
        contentType: 'application/json',
      },
      target: { kind: 'local', targetId: 'target-1', sessionId: 'transport-1' },
      capabilityId: 'capability-1',
    };
    expect(validateTool(probeCall), validator.errorsText(validateTool.errors)).toBe(true);
    expect(validateTool({
      ...probeCall,
      arguments: {
        method: 'get', port: 3000, path: '/search',
        body: 'query', contentType: 'text/plain',
      },
    }), validator.errorsText(validateTool.errors)).toBe(true);
    expect(validateTool({
      ...probeCall,
      arguments: { method: 'delete', port: 3000, path: '/api/1' },
      target: {
        kind: 'remote', targetId: 'target-1', sessionId: 'transport-1',
        profileId: 'profile-1', host: 'host', port: 22, username: 'user',
      },
    }), validator.errorsText(validateTool.errors)).toBe(true);
    expect(validateTool({
      ...probeCall,
      arguments: { ...probeCall.arguments, host: 'example.test' },
    })).toBe(false);
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

  it('validates the Phase 5 terminal screen, input, and bounded-wait contracts', async () => {
    const schema = await readJson('tool-contract.schema.json');
    const validator = new Ajv2020({ allErrors: true, strict: true });
    const validate = validator.compile(schema);
    const base = {
      requestId: 'request-interactive',
      callId: 'call-interactive',
      target: { kind: 'local', targetId: 'target-1', sessionId: 'transport-1' },
      capabilityId: 'capability-interactive',
    };
    for (const call of [
      { ...base, toolName: 'read_terminal', arguments: {} },
      { ...base, toolName: 'write_terminal_input', arguments: { inputKind: 'text', text: 'q' } },
      { ...base, toolName: 'write_terminal_input', arguments: { inputKind: 'key', key: 'arrowDown' } },
      { ...base, toolName: 'write_terminal_input', arguments: { inputKind: 'interrupt' } },
      { ...base, toolName: 'wait_terminal', arguments: { afterScreenVersion: 4, timeoutMs: 1000 } },
    ]) {
      expect(validate(call), validator.errorsText(validate.errors)).toBe(true);
    }
    expect(validate({
      ...base,
      toolName: 'write_terminal_input',
      arguments: { inputKind: 'key', key: 'q' },
    })).toBe(false);
    expect(validate({
      ...base,
      toolName: 'write_terminal_input',
      arguments: { inputKind: 'interrupt', text: 'must-not-be-accepted' },
    })).toBe(false);
    expect(validate({ ...base, toolName: 'wait_terminal', arguments: { timeoutMs: 1000 } }))
      .toBe(false);

    expect(validate({
      requestId: 'request-interactive',
      callId: 'call-interactive',
      toolName: 'read_terminal',
      targetId: 'target-1',
      status: 'completed',
      summary: 'screen observed',
      data: {
        contractVersion: 1,
        credentialLikePrompt: false,
        snapshot: {
          protocolVersion: 1,
          terminalSessionId: 'terminal-1',
          terminalGeneration: 1,
          type: 'screenSnapshot',
          screenVersion: 5,
          throughOutputSequence: 4,
          rows: 2,
          columns: 20,
          cursor: { row: 1, column: 3, visible: true },
          activeBuffer: 'alternate',
          title: 'fixture',
          content: ['menu', '> choice'],
        },
      },
      artifacts: [],
      effects: [],
      truncated: false,
    }), validator.errorsText(validate.errors)).toBe(true);
  });

  it('accepts complete scripts on both execution surfaces and rejects terminal controls', async () => {
    const schema = await readJson('tool-contract.schema.json');
    const validator = new Ajv2020({ allErrors: true, strict: true });
    const validate = validator.compile(schema);
    const base = {
      requestId: 'request-script',
      callId: 'call-script',
      target: { kind: 'local', targetId: 'target-1', sessionId: 'transport-1' },
      capabilityId: 'capability-script',
    };
    for (const command of ['pwd\nls', "cat <<'EOF'\nhello\nEOF", 'printf\tvalue']) {
      expect(validate({ ...base, toolName: 'exec_command', arguments: { command, explanation: 'inspect', channel: 'direct' } }), validator.errorsText(validate.errors)).toBe(true);
      expect(validate({ ...base, toolName: 'terminal_execute', arguments: { command, explanation: 'inspect' } })).toBe(true);
    }
    for (const command of ['pwd\u0000', 'pwd\u001b', 'pwd\u0085']) {
      expect(validate({ ...base, toolName: 'exec_command', arguments: { command, explanation: 'inspect', channel: 'direct' } })).toBe(false);
    }
    for (const [size, accepted] of [[65536, true], [131072, true], [131073, false]]) {
      expect(validate({ ...base, toolName: 'write_file', arguments: { path: 'page.html', content: 'x'.repeat(size), precondition: { mustNotExist: true } } })).toBe(accepted);
    }
  });

  it('validates atomic write_file creation, replacement, and result contracts', async () => {
    const schema = await readJson('tool-contract.schema.json');
    const validator = new Ajv2020({ allErrors: true, strict: true });
    const validate = validator.compile(schema);
    const base = {
      requestId: 'request-write',
      callId: 'call-write',
      toolName: 'write_file',
      target: {
        kind: 'local',
        targetId: 'target-1',
        sessionId: 'transport-1',
        cwd: '/workspace',
      },
      capabilityId: 'capability-write',
    };
    expect(validate({
      ...base,
      arguments: {
        path: 'page.html',
        content: '',
        precondition: { mustNotExist: true },
      },
    }), validator.errorsText(validate.errors)).toBe(true);
    expect(validate({
      ...base,
      arguments: {
        path: 'page.html',
        content: 'replacement',
        precondition: { sha256: '0'.repeat(64) },
      },
    }), validator.errorsText(validate.errors)).toBe(true);
    expect(validate({
      ...base,
      arguments: {
        path: 'page.html',
        content: 'unsafe overwrite',
        precondition: { mustNotExist: false },
      },
    })).toBe(false);
    expect(validate({
      ...base,
      arguments: {
        path: 'page.html',
        content: 'preview',
        precondition: { mustNotExist: true },
        dryRun: true,
      },
    })).toBe(false);
    expect(validate({
      requestId: 'request-write',
      callId: 'call-write',
      toolName: 'write_file',
      targetId: 'target-1',
      status: 'completed',
      summary: 'created and verified',
      data: {
        written: true,
        operation: 'create',
        path: '/workspace/page.html',
        byteLength: 15,
        afterSha256: '0'.repeat(64),
        checkpointId: 'checkpoint-1',
        verified: true,
      },
      artifacts: [],
      effects: [],
      truncated: false,
    }), validator.errorsText(validate.errors)).toBe(true);
  });

  it('validates exact edits and retains the native write limit above the advisory budget', async () => {
    const validator = new Ajv2020({ allErrors: true, strict: true });
    const validate = validator.compile(await readJson('tool-contract.schema.json'));
    const base = {
      requestId: 'request-edit', callId: 'call-edit', toolName: 'edit_file',
      target: { kind: 'local', targetId: 'local', sessionId: 'terminal', cwd: '/workspace' },
      capabilityId: 'edit',
    };
    const argumentsValue = {
      path: 'app.js', oldString: 'const data', newString: '',
      precondition: { sha256: '0'.repeat(64) },
    };
    expect(validate({ ...base, arguments: argumentsValue }), validator.errorsText(validate.errors)).toBe(true);
    for (const changes of [
      { oldString: '' }, { precondition: { mustNotExist: true } },
      { replaceAll: true }, { newString: 'x'.repeat(32769) },
    ]) {
      expect(validate({ ...base, arguments: { ...argumentsValue, ...changes } })).toBe(false);
    }
    expect(validate({ ...base, toolName: 'write_file', arguments: {
      path: 'app.js', content: 'x'.repeat(9000), precondition: { sha256: '0'.repeat(64) },
    } }), validator.errorsText(validate.errors)).toBe(true);
  });

  it('reserves every migration flag with an explicit rollback rule', async () => {
    const compatibility = await readFile(
      path.join(protocolRoot, 'terminal-execution-compatibility.md'),
      'utf8',
    );
    for (const flag of [
      'terminal_broker',
      'terminal_shell_integration',
      'terminal_execute',
      'terminal_remote_bound_terminal',
      'terminal_interactive_tools',
      'terminal_remote_interactive_tools',
    ]) {
      expect(compatibility).toContain(`\`${flag}\``);
    }
    expect(compatibility).toContain('| Rollback rule |');
    expect(compatibility).toMatch(/never reroute or replay an in-flight\/uncertain command/i);
    expect(compatibility).toContain('SHELLSPAN_TERMINAL_BROKER');
    expect(compatibility).toContain('SHELLSPAN_TERMINAL_REMOTE_BOUND_TERMINAL');
    expect(compatibility).toContain('SHELLSPAN_TERMINAL_INTERACTIVE_TOOLS');
    expect(compatibility).toContain('SHELLSPAN_TERMINAL_REMOTE_INTERACTIVE_TOOLS');
    expect(compatibility).toMatch(/On\s+Windows and macOS, an absent value is on for broker, integration, execute,\s+remote bound-terminal routing, and local interactive tools/i);
    expect(compatibility).toContain('remoteBoundTerminalRollout');
    expect(compatibility).toMatch(/Remote interactive tools are absent-off on every platform/i);
    expect(compatibility).toMatch(/on Linux those absent values\s+remain off/i);
    expect(compatibility).toMatch(/have no\s+frontend mutation IPC/i);
    expect(compatibility).toMatch(/bounded to the 256 most recently closed logical\s+sessions/i);
    expect(compatibility).toMatch(/successful reconnect drops\s+all superseded transport identities/i);
  });

  it('keeps visible commands cooperative and removes compatibility execution', async () => {
    const [integration, terminalExecute, adapter, callPolicy, modelTools, runtime, broker, manifest] = await Promise.all([
      readFile(path.join(repositoryRoot, 'src-tauri/src/terminal_integration.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/agent_runtime/native/terminal_execute.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/agent_runtime/native_adapter.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/agent_runtime/native/call_policy.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/agent_runtime/model_tools.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/agent_runtime/native/runtime.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/terminal_broker.rs'), 'utf8'),
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
    expect(adapter).toContain('TerminalVisibleCommandRoute::Unavailable');
    expect(adapter).not.toContain('LegacyFallback');
    expect(adapter).toContain('TerminalLifecycleTrust::DirectRequired');
    expect(callPolicy).not.toContain('requires Direct execution for security-sensitive command lifecycle evidence');
    expect(adapter).toContain('TERMINAL_DIRECT_REQUIRED');
    expect(terminalExecute).toContain('TERMINAL_INPUT_UNSUPPORTED');
    expect(integration).toContain('Invoke-ShellSpanNativeSubmit');
    expect(integration).toContain('System.Management.Automation.Language.Parser');
    expect(integration).toContain('__shellspan_accept_native');
    expect(terminalExecute).toContain('job_submission');
    expect(adapter).toContain('"background": background');
    expect(modelTools).toContain('"lifecycleTrust"');
    expect(modelTools).toContain('Cooperative terminal lifecycle is never security evidence or a sandbox');
    expect(runtime).not.toContain('AgentExecutionChannelNative::Pty');
    expect(broker).not.toContain('terminal_legacy_wrapper_fallback');
    expect(broker).toMatch(/TERMINAL_BROKER_DEFAULT_ENABLED: bool =\s+cfg!\(any\(target_os = "macos", target_os = "windows"\)\)/);
    expect(broker).toContain('remote_visible_command_route');
    expect(broker).toContain('TerminalRolloutCountersSnapshot');
    expect(manifest.tools.map(({ name }) => name)).toContain('terminal_execute');
    expect(manifest.tools.find(({ name }) => name === 'terminal_execute')).toMatchObject({
      targetKinds: ['local', 'remote'],
      retryPolicy: 'reconcileFirst',
      idempotency: 'conditional',
    });
    expect(manifest.tools.find(({ name }) => name === 'probe_http')).toMatchObject({
      targetKinds: ['local', 'remote'],
      requiredCapabilities: ['network.loopback.http'],
      retryPolicy: 'never',
    });
  });

});
