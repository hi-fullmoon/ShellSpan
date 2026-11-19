"""Compare real ordinary foreground interruption with/without the ZLE provider.

This is a component signal regression, not Broker or GUI acceptance.
"""
import errno
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import signal
import socket
import subprocess
import time
import uuid

root = Path(__file__).resolve().parents[3]
directory = root / 'artifacts/tests/native-input-p3/signals' / str(uuid.uuid4())
directory.mkdir(parents=True)
profile = {'shell': 'zsh', 'shellVersion': '5.9', 'editor': 'zle', 'editorVersion': '5.9',
           'editorNumericVersion': 509, 'adapterVersion': '1',
           'verifiedProfileId': 'zsh-5.9-zle-5.9-macos-arm64-native'}
quote = lambda value: "'" + str(value).replace("'", "'\\''") + "'"
results = []
for native in [False, True]:
    home = directory / ('native' if native else 'baseline')
    home.mkdir()
    sockpath = '/tmp/p3-signal-' + uuid.uuid4().hex[:16]
    server = socket.socket(socket.AF_UNIX)
    server.bind(sockpath)
    os.chmod(sockpath, 0o600)
    server.listen(1)
    peer = None
    rc = "PROMPT='P3-SIGNAL> '\n"
    if native:
        rc += (f"module_path=({quote(root / 'artifacts/tests/native-input-p3')} $module_path)\nzmodload ss_nip\n"
               f"builtin ss_nip open {quote(sockpath)} {quote(json.dumps(profile))} 1 || return\n"
               f"source {quote(root / 'src-tauri/native-input-editors/zle.zsh')}\n")
    (home / '.zshrc').write_text(rc)
    raw = bytearray()
    pid, master = pty.fork()
    if pid == 0:
        os.execve('/bin/zsh', ['/bin/zsh', '-il'], {**os.environ, 'HOME': str(home),
                  'ZDOTDIR': str(home), 'TERM': 'xterm-256color', 'LC_ALL': 'en_US.UTF-8'})

    def pump(predicate):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if predicate():
                return
            watched = [master]
            if native and peer is None:
                watched.append(server)
            ready, _, _ = select.select(watched, [], [], 0.01)
            if server in ready:
                return 'connect'
            if master in ready:
                try:
                    value = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        raise EOFError('Real Zsh exited') from error
                    raise
                if not value:
                    raise EOFError('Real PTY closed')
                raw.extend(value)
        raise TimeoutError('Real foreground interruption did not return to the editor')

    outcome = {'native': native, 'ok': False}
    try:
        if native:
            assert pump(lambda: False) == 'connect'
            peer, _ = server.accept()
        pump(lambda: b'P3-SIGNAL>' in raw)
        before = raw.count(b'P3-SIGNAL>')
        os.write(master, b'sleep 30\r')
        pump(lambda: os.tcgetpgrp(master) != pid)
        group = os.tcgetpgrp(master)
        (home / 'before-interrupt.txt').write_bytes(subprocess.check_output(
            ['/bin/ps', '-p', f'{pid},{group}', '-o', 'pid,ppid,pgid,blocked,pending,stat,wchan,comm']))
        os.write(master, b'\x03')
        pump(lambda: raw.count(b'P3-SIGNAL>') > before)
        os.write(master, b'printf "%s%s\\n" P3-USER- RESTORED\r')
        pump(lambda: b'P3-USER-RESTORED' in raw)
        assert b'P3-USER-RESTORED' in raw
        outcome['ok'] = True
    except Exception as error:
        outcome['error'] = str(error)
        (home / 'failure-processes.txt').write_bytes(subprocess.run(
            ['/bin/ps', '-p', f'{pid},{os.tcgetpgrp(master)}', '-o', 'pid,ppid,pgid,blocked,pending,stat,wchan,comm'],
            stdout=subprocess.PIPE, check=False).stdout)
    finally:
        (home / 'raw.bin').write_bytes(raw)
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        os.close(master)
        if peer:
            peer.close()
        server.close()
        os.unlink(sockpath)
        results.append(outcome)
(directory / 'result.json').write_text(json.dumps({'checks': results,
    'scriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'shellSha256': hashlib.sha256(Path('/bin/zsh').read_bytes()).hexdigest(),
    'moduleSha256': hashlib.sha256((root / 'artifacts/tests/native-input-p3/ss_nip.so').read_bytes()).hexdigest()}, indent=2))
print(json.dumps({'directory': str(directory), 'checks': results}))
assert all(value['ok'] for value in results)
