import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { supportedRustHosts } from '../verify-terminal-broker-macos.mjs';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

describe('macOS terminal rollout runner', () => {
  it('requires an architecture-matched native Darwin toolchain', () => {
    expect(supportedRustHosts).toEqual({
      x64: 'x86_64-apple-darwin',
      arm64: 'aarch64-apple-darwin',
    });
  });

  it('keeps both native shells and every rollout phase in the consolidated gate', async () => {
    const runner = await readFile(
      path.join(repositoryRoot, 'scripts/verify-terminal-broker-macos.mjs'),
      'utf8',
    );
    expect(runner).toContain("process.platform !== 'darwin'");
    expect(runner).toContain("'/bin/bash'");
    expect(runner).toContain("'/bin/zsh'");
    expect(runner).toContain('macos_bash_pty_broker_preserves_raw_bytes_input_order_and_resize');
    expect(runner).toContain('macos_zsh_pty_broker_preserves_raw_bytes_input_order_and_resize');
    expect(runner).toContain('macos_native_bash_visible_commands_preserve_shell_state_and_raw_display');
    expect(runner).toContain('macos_native_zsh_visible_commands_preserve_shell_state_and_raw_display');
    expect(runner).toContain('macos_bash_interactive_terminal_operation');
    expect(runner).toContain('macos_zsh_interactive_terminal_operation');
    expect(runner).toContain("'--test-threads=1'");
    expect(runner).toContain("verifyBenchmarkRound(round, control, broker, 'macOS')");
  });
});
