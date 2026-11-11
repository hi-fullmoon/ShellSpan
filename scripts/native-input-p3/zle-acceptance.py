"""Real system-Zsh/ZLE producer checks; receipts come only from its socket.

This fixture owns its HOME, history, process group and private control directory.
No frontend or control receipt is synthesized as execution evidence.
"""
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import signal
import socket
import struct
import sys
import termios
import time
import uuid

root = Path(__file__).resolve().parents[2]
directory = root / '.artifacts/tests/native-input-p3/zle' / str(uuid.uuid4())
home = directory / 'home'
home.mkdir(parents=True, mode=0o700)
sockpath = f'/tmp/ss-p3-{uuid.uuid4().hex[:16]}'
listener = socket.socket(socket.AF_UNIX)
listener.bind(sockpath)
os.chmod(sockpath, 0o600)
listener.listen(1)
listener.setblocking(False)
module = root / '.artifacts/tests/native-input-p3/ss_nip.so'
profile = {'shell': 'zsh', 'shellVersion': '5.9', 'editor': 'zle', 'editorVersion': '5.9',
           'editorNumericVersion': 509, 'adapterVersion': '1',
           'verifiedProfileId': 'zsh-5.9-zle-5.9-macos-arm64-native'}
quote = lambda value: "'" + str(value).replace("'", "'\\''") + "'"
(home / '.zshrc').write_text(
    "HISTFILE=$HOME/history\nHISTSIZE=100\nSAVEHIST=100\n"
    "PROMPT='%F{blue}P3-ZLE>%f '\nsetopt interactivecomments\n"
    "__shellspan_nip_parser=/bin/zsh\n"
    f"module_path=({quote(module.parent)} $module_path)\nzmodload ss_nip\n"
    f"builtin ss_nip open {quote(sockpath)} {quote(json.dumps(profile, separators=(',', ':')))} 1 || return\n"
    f"source {quote(root / 'src-tauri/native-input-editors/zle.zsh')}\n")
raw = bytearray()
messages = []
control_raw = bytearray()
pending = bytearray()
peer = None
pid, master = pty.fork()
if pid == 0:
    os.chdir(home)
    os.execve('/bin/zsh', ['/bin/zsh', '-il'], {**os.environ, 'HOME': str(home),
              'ZDOTDIR': str(home), 'TERM': 'xterm-256color',
              'LC_ALL': 'en_US.UTF-8' if sys.platform == 'darwin' else 'C.UTF-8'})

def resize(cols):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 30, cols, 0, 0))

def pump(predicate, timeout=6):
    global peer
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        watched = [master, peer if peer else listener]
        ready, _, _ = select.select(watched, [], [], 0.02)
        if listener in ready:
            peer, _ = listener.accept()
            peer.setblocking(False)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    raise EOFError('Actual shell PTY closed') from error
                raise
            if not data:
                raise EOFError('Actual shell PTY EOF')
            raw.extend(data)
        if peer and peer in ready:
            data = peer.recv(65536)
            if not data:
                raise EOFError('Actual native control EOF')
            control_raw.extend(data)
            pending.extend(data)
            while b'\n' in pending:
                line, _, rest = pending.partition(b'\n')
                pending[:] = rest
                messages.append(json.loads(line))
    raise TimeoutError('Actual native boundary missing: ' + json.dumps(messages[-3:]))

def send(value):
    peer.setblocking(True)
    peer.sendall(json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode() + b'\n')
    peer.setblocking(False)

def request(identity, payload):
    value = {'protocol': 'shellspan.native-input', 'requestId': uuid.uuid4().hex,
             'identity': identity, 'payload': payload}
    send(value)
    return value

def receipt(value, kind):
    return next((v for v in messages if v.get('requestId') == value['requestId']
                 and v['payload']['kind'] == kind), None)

def begin(source, index, reduced=False):
    identity = {'terminalSessionId': 'p3-zle', 'terminalGeneration': 1, 'leaseId': f'lease-{index}',
                'leaseGeneration': index, 'agentSessionId': 'p3-agent', 'taskId': 'p3-task',
                'operationId': f'p3-op-{index}', 'commandId': f'p3-command-{index}', 'sourceRevision': 1}
    digest = hashlib.sha256(source.encode()).hexdigest()
    plan_digest = hashlib.sha256(json.dumps([digest, source], separators=(',', ':'),
                                ensure_ascii=False).encode()).hexdigest()
    value = request(identity, {'kind': 'prepareInput', 'source': source, 'sourceDigest': digest,
                  'plan': source, 'planDigest': plan_digest, 'budgetMs': 5000, 'reducedMotion': reduced})
    return identity, value, digest, plan_digest

results = []
try:
    resize(100)
    pump(lambda: peer is not None)
    probe = {'protocol': 'shellspan.native-input', 'requestId': 'probe',
             'connection': {'terminalSessionId': 'p3-zle', 'terminalGeneration': 1, 'controlId': 'p3-control'},
             'payload': {'kind': 'probe'}}
    send(probe)
    pump(lambda: receipt(probe, 'capabilities'))
    assert receipt(probe, 'capabilities')['payload']['nativeInline']
    for index, cols in enumerate([32, 40, 100, 180], 1):
        resize(cols)
        source = "P3_PARENT='父Shell-é-👩🏽‍💻'; printf 'P3-REAL-%s\\n' \"$P3_PARENT\""
        identity, prepare, digest, plan_digest = begin(source, index)
        pump(lambda: receipt(prepare, 'inputConfirmed'))
        proof = receipt(prepare, 'inputConfirmed')['payload']
        assert proof['utf8Bytes'] == proof['cursorUtf8Bytes'] == proof['endUtf8Bytes'] == len(source.encode())
        commit = request(identity, {'kind': 'commit', 'sourceDigest': digest, 'planDigest': plan_digest})
        pump(lambda: receipt(commit, 'commitArmed'))
        os.write(master, b'\x18\x1d')
        pump(lambda: receipt(prepare, 'settled'))
        assert receipt(prepare, 'started')
        assert receipt(prepare, 'settled')['payload']['exitCode'] == 0
        results.append({'columns': cols, 'proof': proof, 'realStarted': True, 'realSettled': True})
    identity, prepare, _, _ = begin("printf 'MUST_NOT_EXECUTE\\n'", 5)
    pump(lambda: receipt(prepare, 'inputProgress'))
    cancel = request(identity, {'kind': 'cancelDraft'})
    pump(lambda: receipt(cancel, 'draftCleared'))
    assert receipt(cancel, 'draftCleared')['payload']['editorEmpty']
    os.write(master, b'\r')
    # The ordinary next user command reads state established by the real parent.
    os.write(master, b'printf "P3-PARENT-READ:%s\\n" "$P3_PARENT"\r')
    ready_before = sum(v['payload']['kind'] == 'editorReady' for v in messages)
    pump(lambda: 'P3-PARENT-READ:父Shell-é-👩🏽‍💻'.encode() in raw)
    pump(lambda: sum(v['payload']['kind'] == 'editorReady' for v in messages) > ready_before)
    os.write(master, b'exit\r')
    try:
        pump(lambda: False)
    except EOFError:
        pass
    _, status = os.waitpid(pid, 0)
    pid = None
    assert os.waitstatus_to_exitcode(status) == 0
    result = {'ok': True, 'checks': results, 'cancel': True, 'parentState': True,
              'profile': profile, 'sourceSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'shellSha256': hashlib.sha256(Path('/bin/zsh').read_bytes()).hexdigest(),
              'moduleSha256': hashlib.sha256(module.read_bytes()).hexdigest()}
    (directory / 'result.json').write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print(json.dumps({'directory': str(directory), 'ok': True, 'realSubmissions': 4}))
except BaseException as error:
    (directory / 'failure.json').write_text(json.dumps({'type': type(error).__name__, 'message': str(error)}))
    raise
finally:
    (directory / 'raw.bin').write_bytes(raw)
    (directory / 'control.jsonl').write_bytes(control_raw)
    if pid is not None:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(master)
    if peer:
        peer.close()
    listener.close()
    os.unlink(sockpath)
