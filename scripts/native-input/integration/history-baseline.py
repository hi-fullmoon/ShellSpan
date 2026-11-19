"""Observe stock pinned Bash history at a real PTY; no native adapter loaded."""
import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import signal
import sys
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('version', choices=['4.1', '4.4', '5.3'])
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
readline = {'4.1': '6.0', '4.4': '7.0', '5.3': '8.3.6'}[args.version]
target = 'macos-arm64' if sys.platform == 'darwin' else 'linux-aarch64-glibc-2.36'
manifest = json.loads((root / 'artifacts/tests/native-input/integration/producers' /
    f'gnu-bash-{args.version}-readline-{readline}-{target}-native/manifest.json').read_text())
directory = root / 'artifacts/tests/native-input/integration/history-baseline' / str(uuid.uuid4())
home = directory / 'home'
home.mkdir(parents=True, mode=0o700)
(home / '.bash_profile').write_text("HISTSIZE=2\nPS1='HISTORY_BASELINE> '\nbind -x '\"\\C-xh\":builtin history'\n")
pid, master = pty.fork()
if pid == 0:
    os.chdir(home)
    os.execve(manifest['shell'], [manifest['shell'], '-il'], {
        **os.environ, 'HOME': str(home), 'TERM': 'xterm-256color', 'LC_ALL': 'en_US.UTF-8' if sys.platform == 'darwin' else 'C.UTF-8'})
raw = bytearray()

def pump(until=None, timeout=10):
    deadline = time.monotonic() + timeout
    start = len(raw)
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.05)
        if not ready:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                return False
            raise
        if not chunk:
            return False
        raw.extend(chunk)
        if until and until in raw[start:]:
            return True
    raise TimeoutError('Actual baseline PTY did not reach the expected boundary')

try:
    assert pump(b'HISTORY_BASELINE> ')
    os.write(master, b'true\r')
    assert pump(b'HISTORY_BASELINE> ')
    os.write(master, b'builtin history -s KEEP_USER_A; builtin history -s KEEP_USER_B; builtin history -a; builtin history; (exit 7)\r')
    assert pump(b'HISTORY_BASELINE> ')
    history = home / '.bash_history'
    before = history.read_bytes() if history.exists() else None
    os.write(master, b'\x18h')
    assert pump(b'HISTORY_BASELINE> ')
    os.write(master, b'\x04')
    pump()
    waited, status = os.waitpid(pid, 0)
    assert waited == pid
    pid = None
    after = history.read_bytes() if history.exists() else None
    result = {'version': args.version, 'target': target, 'shell': manifest['shell'],
        'shellSha256': hashlib.sha256(Path(manifest['shell']).read_bytes()).hexdigest(),
        'scriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'nativeAdapterLoaded': False,
        'beforeExists': before is not None, 'before': before.decode() if before is not None else None,
        'afterExists': after is not None, 'after': after.decode() if after is not None else None,
        'exitStatus': os.waitstatus_to_exitcode(status)}
    (directory / 'raw.bin').write_bytes(raw)
    (directory / 'result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({'directory': str(directory), **result}))
finally:
    os.close(master)
    if pid is not None:
        os.kill(pid, signal.SIGTERM)
        os.waitpid(pid, 0)
