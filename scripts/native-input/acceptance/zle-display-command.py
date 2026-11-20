"""Verify command-block boundaries from the pinned local Zsh and a real PTY."""

import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shlex
import shutil
import signal
import socket
import struct
import tempfile
import termios
import time
import uuid


ROOT = Path(__file__).resolve().parents[3]
ARTIFACTS = ROOT / 'artifacts/tests/native-input'
RESOURCES = ARTIFACTS / 'integration/resources/native-input'
PROFILE = 'zsh-5.9-zle-5.9-macos-arm64-native'


def verify(home, control):
    catalogue = json.loads((RESOURCES / 'editors-macos-arm64.json').read_text())
    artifact = next(item for item in catalogue['profiles']
                    if item['profile']['verifiedProfileId'] == PROFILE)
    shell = RESOURCES / artifact['shell']
    module = RESOURCES / artifact['module']
    scoped = control / 'scoped'
    (scoped / 'zsh').mkdir(parents=True, mode=0o700)
    shutil.copy2(RESOURCES / artifact['core'], scoped / 'zsh/zle.so')
    socket_path = control / 'control'
    quote = lambda path: shlex.quote(str(path))
    (home / '.zshenv').write_text(
        f'module_path=({quote(scoped)} $module_path)\nbuiltin zmodload zsh/zle\n')
    (home / '.zshrc').write_text(
        "PROMPT='ShellSpan> '\n"
        f'__shellspan_nip_parser={quote(shell)}\n'
        f'module_path=({quote(module.parent)} $module_path)\nbuiltin zmodload ss_nip\n'
        f"builtin ss_nip open {quote(socket_path)} {quote(json.dumps(artifact['profile']))} 1 || return\n"
        f'builtin source {quote(ROOT / "src-tauri/native-input-editors/zle.zsh")}\n')
    with socket.socket(socket.AF_UNIX) as listener:
        listener.bind(str(socket_path))
        os.chmod(socket_path, 0o600)
        listener.listen(1)
        listener.settimeout(6)
        pid, master = pty.fork()
        if pid == 0:
            os.chdir(home)
            os.execve(shell, [str(shell), '-il'], {
                **os.environ, 'HOME': str(home), 'ZDOTDIR': str(home),
                'TERM': 'xterm-256color', 'LC_ALL': 'en_US.UTF-8',
            })
        try:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
            peer, _ = listener.accept()
            with peer:
                return assert_display_command(master, peer, home)
        finally:
            os.close(master)
            if os.waitpid(pid, os.WNOHANG)[0] == 0:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)


def assert_display_command(master, peer, home):
    connection = {'terminalSessionId': 'zle-display', 'terminalGeneration': 1, 'controlId': 'zle-control'}
    probe = {'protocol': 'shellspan.native-input', 'requestId': 'zle-probe',
             'connection': connection, 'payload': {'kind': 'probe'}}
    peer.sendall((json.dumps(probe) + '\n').encode())
    events, raw, messages = bytearray(), bytearray(), []

    def pump(until):
        deadline = time.monotonic() + 6
        while not until():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('Timed out waiting for the native Zsh command display boundary')
            readable, _, _ = select.select([master, peer], [], [], remaining)
            if master in readable:
                raw.extend(os.read(master, 65536))
            if peer in readable:
                chunk = peer.recv(65536)
                if not chunk:
                    raise EOFError('Zsh closed its private control channel')
                events.extend(chunk)
                lines = events.split(b'\n')
                events[:] = lines.pop()
                messages.extend(json.loads(line) for line in lines if line)

    pump(lambda: any(frame['payload']['kind'] == 'editorReady' for frame in messages))
    start_at = len(raw)
    os.write(master, b"printf '%s\\n' 'SHELLSPAN-BLOCK-OUTPUT'; (exit 7)\r")
    reports = lambda: [frame for frame in messages if frame['payload']['kind'] == 'displayCommand']
    pump(lambda: len(reports()) == 2)
    started, finished = reports()
    assert started['connection'] == finished['connection'] == connection
    start, end = started['payload'], finished['payload']
    assert start['exitCode'] is None and end['exitCode'] == 7
    assert start['commandId'] == end['commandId']
    assert Path(start['cwd']).samefile(home) and Path(end['cwd']).samefile(home)
    begins = f"\x1b]133;C;ShellSpan={start['commandId']}\x07".encode()
    ends = f"\x1b]133;D;7;ShellSpan={end['commandId']}\x07".encode()
    pump(lambda: ends in raw[start_at:])
    command = raw[start_at:]
    assert command.index(begins) < command.index(b'SHELLSPAN-BLOCK-OUTPUT', command.index(begins)) < command.index(ends)
    os.write(master, b'exit 0\r')
    return {'commandId': start['commandId'], 'exitCode': end['exitCode'], 'matchingOutputBoundaries': True}


if __name__ == '__main__':
    home = ARTIFACTS / 'acceptance/zle-command-display' / str(uuid.uuid4())
    home.mkdir(parents=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix='ss-zle-display-', dir='/tmp') as control:
        result = verify(home, Path(control))
    (home / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
