# Stage 0 real-terminal attack fixture

This directory is an isolated research fixture. It does not install a ShellSpan integration or change the application's execution route. Its deliberately unsafe dispatcher treats the first byte-exact in-band start/end pair for a UUID nonce and expected increasing sequence as completion, then writes a second, harmless Agent line. A "PASS forged start+end" result means **the proposed trust boundary failed**: the line was consumed by the still-running sourced script.

The Bash, zsh and PowerShell attack scripts run in the current interactive shell (source / dot-source). They read the nonce and sequence from that shell, emit matching OSC frames, and then block on terminal stdin. The driver reads raw bytes from an actual PTY, immediately writes the next line on end, and requires GATE_CONSUMED:<line> from the script. It does not use prompt text or quiet output as proof of completion. The UUID is intentionally insufficient as authentication.

Requirements: Rust/Cargo; Python 3 for REPL and raw-mode probes; Windows 10+ ConPTY and PowerShell 7 for pwsh or Windows PowerShell 5.1 for powershell51; WSL distro named Ubuntu for wsl-bash; Docker for the SSH targets. The SSH image installs Bash, zsh, Python and OpenSSH. Port 22337 is bound to loopback; GATE_SSH_PORT can override it in the driver if the container mapping changes.

From the repository root on Windows, run:

    cargo fmt --manifest-path tests/agent-direct-shell-gate/Cargo.toml -- --check
    cargo run --manifest-path tests/agent-direct-shell-gate/Cargo.toml -- pwsh
    cargo run --manifest-path tests/agent-direct-shell-gate/Cargo.toml -- powershell51
    cargo run --manifest-path tests/agent-direct-shell-gate/Cargo.toml -- wsl-bash
    docker build -t shellspan-agent-direct-gate:local tests/agent-direct-shell-gate
    docker run --rm -d --name shellspan-agent-direct-gate-stage0 -p 127.0.0.1:22337:22 shellspan-agent-direct-gate:local
    cargo run --manifest-path tests/agent-direct-shell-gate/Cargo.toml -- ssh-bash
    cargo run --manifest-path tests/agent-direct-shell-gate/Cargo.toml -- ssh-zsh
    docker stop shellspan-agent-direct-gate-stage0

On a native macOS/Linux host, install Bash, zsh, Python 3 and Rust first, then run these **unverified on this development machine** local PTY targets:

    cargo run --manifest-path tests/agent-direct-shell-gate/Cargo.toml -- local-bash
    cargo run --manifest-path tests/agent-direct-shell-gate/Cargo.toml -- local-zsh

The driver also observes same-shell directory/alias/function/variable state, true/false status, Ctrl-C and exit 9. The PowerShell target records cmdlet, native, pipeline, exception and PSReadLine behavior. The raw-input probes intentionally write into a Python REPL, a Python raw-mode terminal program, a hidden Bash password read and a nested SSH password prompt. These demonstrate why an unverified "looks like a prompt" state cannot authorize a write. They are not tests of an implemented pre-write rejection mechanism.

The OSC namespace here is an experimental stand-in for the design's in-band control frames; no V2 parser or hook has been added to production. The fixture's Bash/zsh/PowerShell hook setup is a candidate used to exercise shell behavior, not a validated adapter. A fixture line beginning "FAIL candidate ..." is an observed adapter defect even when the attack experiment itself completes.
