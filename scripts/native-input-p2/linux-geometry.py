"""Real Linux target geometry using formal NIP modules and production glue.

This is target-component evidence. Actual SSH SessionManager normal/fault
transport evidence is collected separately by app.mjs; no app receipt is faked.
"""
import codecs
import contextlib
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import shutil
import socket
import sys
import termios
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('real_pty_harness', ROOT / 'scripts/native-input-p0/acceptance.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


class NativeGeometry(base.Session):
    def __init__(self, item):
        self.item = item
        self.directory = Path(item['linuxDirectory'])
        self.raw, self.pending, self.events, self.timeline = bytearray(), bytearray(), [], []
        self.start = time.monotonic()
        self.accept_keys = 0
        self.control = None
        self.socket_dir = contextlib.ExitStack()
        path = Path(item['socket'])
        path.parent.mkdir(mode=0o700)
        # Fresh 0700 scope created above; only this controlled component and
        # production helpers can have created runtime status files in it.
        self.socket_dir.callback(shutil.rmtree, path.parent)
        # Session.close calls cleanup on its owned temporary socket scope.
        self.socket_dir.cleanup = self.socket_dir.close
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(str(path))
        os.chmod(path, 0o600)
        self.listener.listen(1)
        self.listener.setblocking(False)
        self.home = self.directory / 'home'
        self.home.mkdir(mode=0o700)
        (self.home / '.inputrc').write_text('set editing-mode emacs\nset bell-style none\nset convert-meta off\nset input-meta on\n')
        (self.home / '.bash_profile').write_text("PS1='NIP-LINUX> '\n")
        for key in ['shell', 'module']:
            assert hashlib.sha256(Path(item[key]).read_bytes()).hexdigest() == item[key + 'Sha256'], 'Formal producer artifact changed'
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            env = {'PATH': '/usr/bin:/bin', 'HOME': str(self.home), 'TERM': 'xterm-256color', 'LC_ALL': 'en_US.UTF-8', 'SHELLSPAN_NATIVE_INPUT_PROTOCOL': '1'}
            os.execve(item['shell'], [item['shell'], '--shellspan-native-init', str(self.directory / 'native-init'), '-il'], env)
        self.resize(item['columns'], item['rows'])
        self.until(lambda: self.control is not None, 'Real module did not connect')
        # Match production initialization: the initial private probe needs no
        # keyboard wake. Sending a service chord before Readline prepares the
        # tty would itself echo control characters into real terminal history.
        self.send(item['probe'], wake=False)
        capabilities = self.wait_frame('capabilities')
        assert capabilities['payload']['profile']['verifiedProfileId'] == item['profile']
        assert all(capabilities['payload'][key] for key in ['nativeInline', 'sourceEcho', 'atomicHandoff', 'completeProof', 'draftClear', 'inbandDisplay', 'editorEmpty'])
        self.until(lambda: not (termios.tcgetattr(self.fd)[3] & termios.ICANON), 'Actual Readline tty input mode did not initialize')

    def pump(self, seconds=0.02):
        handles = [self.fd, self.control or self.listener]
        ready, _, _ = select.select(handles, [], [], seconds)
        if self.fd in ready:
            try:
                data = os.read(self.fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b''
            self.raw.extend(data)
        if self.listener in ready:
            self.control, _ = self.listener.accept()
            self.control.setblocking(False)
        if self.control in ready:
            data = self.control.recv(65536)
            if not data:
                self.control.close()
                self.control = None
                return
            with (self.directory / 'control.bin').open('ab') as trace:
                trace.write(data)
            self.pending.extend(data)
            assert len(self.pending) <= 131072
            while b'\n' in self.pending:
                line, _, remaining = self.pending.partition(b'\n')
                self.pending = bytearray(remaining)
                event = json.loads(line)
                if 'identity' in event:
                    assert event['identity'] in self.item.get('validIdentities', [self.item['prepare']['identity']]), 'Native operation identity changed'
                if 'connection' in event:
                    assert event['connection'] == self.item['probe']['connection'], 'Native connection generation changed'
                self.events.append(event)

    def type(self, data):
        count = os.write(self.fd, data)
        assert count == len(data), 'Physical PTY input was not fully accepted'
        if data == b'\x18a':
            self.accept_keys += 1

    def until(self, predicate, diagnostic):
        deadline = time.monotonic() + 5
        while not predicate():
            assert time.monotonic() < deadline, diagnostic
            self.pump()

    def send(self, value, wake=True):
        self.control.setblocking(True)
        self.control.settimeout(1)
        self.control.sendall(json.dumps(value, ensure_ascii=False).encode() + b'\n')
        self.control.setblocking(False)
        if wake:
            self.type(b'\x18\x1e')

    def wait_frame(self, kind, operation=None):
        matches = lambda event: event['payload']['kind'] == kind and (operation is None or event.get('identity', {}).get('operationId') == operation)
        self.until(lambda: any(matches(event) for event in self.events), f'Actual {kind} receipt missing')
        return next(event for event in self.events if matches(event))

    def progress(self, previous):
        on = b'\x1b]1337;SetUserVar=ShellSpanNativeInput=MQ==\x07'
        source = self.item['source'].encode()
        observed = None

        def partial():
            nonlocal observed
            start = self.raw.find(on)
            if start < 0:
                return False
            data = bytes(self.raw[start + len(on):])
            decoder = codecs.getincrementaldecoder('utf-8')('strict')
            prefix = decoder.decode(data, final=False).encode()
            if previous < len(prefix) < len(source):
                assert source.startswith(prefix), 'Target changed the actual source prefix'
                observed = (len(prefix), len(self.raw))
                return True
            return False
        self.until(partial, 'Real Linux partial input did not advance at the actual PTY size')
        return observed


if sys.argv[1] == '--widget':
    inputs = Path(sys.argv[2])
    results = []
    for item in json.loads(inputs.read_text()):
        with contextlib.ExitStack() as cleanup:
            session = NativeGeometry(item)
            cleanup.callback(session.close)
            launch_op = item['prepare']['identity']['operationId']
            session.send(item['prepare'])
            session.wait_frame('inputConfirmed', launch_op)
            session.send(item['arm'])
            session.wait_frame('commitArmed', launch_op)
            session.type(b'\x18a')
            session.wait_frame('settled', launch_op)
            session.until(lambda: any(event['payload']['kind'] == 'jobObservation' and event['payload']['handle'] == item['handle'] and event['payload']['state'] == 'running' for event in session.events), 'Actual background job was not registered')
            session.until(lambda: any(event['payload']['kind'] == 'editorReady' and (event['payload'].get('afterCommand') or {}).get('operationId') == launch_op for event in session.events), 'Actual parent editor did not return after launch')
            for step in ['normal', 'fault']:
                request = item[step]
                operation = request['prepare']['identity']['operationId']
                session.send(request['prepare'])
                proof = session.wait_frame('controlInputConfirmed', operation)['payload']
                assert proof['editorEmpty'] and proof['planDigest'] == request['prepare']['payload']['planDigest']
                if step == 'fault':
                    fifo = item['socket'] + '.job.' + item['handle'] + '.running'
                    Path(fifo).unlink(missing_ok=True)
                    os.mkfifo(fifo, 0o600)
                    writer = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
                    cleanup.callback(os.close, writer)
                    cleanup.callback(Path(fifo).unlink, missing_ok=True)
                session.send(request['arm'])
                session.wait_frame('commitArmed', operation)
                session.type(b'\x18a')
                session.wait_frame('started', operation)
                if step == 'normal':
                    session.wait_frame('settled', operation)
                    session.until(lambda: any(event['payload']['kind'] == 'editorReady' and (event['payload'].get('afterCommand') or {}).get('operationId') == operation for event in session.events), 'Actual parent editor did not return after private poll')
                else:
                    offset = len(session.raw)
                    session.until(lambda: b'BG_PACKET\r\nBG_ERROR\r\n' in session.raw[offset:], 'Cookie sink muted real background output')
                    session.control.shutdown(socket.SHUT_RDWR)
                    session.control.close()
                    session.control = None
                    session.type(b'\x03')
            offset = len(session.raw)
            session.type(b"printf '%s%s\\n' USER_ RESTORED; printf '%s%s\\n' ERROR_ RESTORED >&2; (printf '%s%s\\n' CHILD_ RESTORED); builtin kill %1")
            session.until(lambda: b'kill %1' in session.raw[offset:], 'Next physical user input lost its echo after control EOF/INT')
            session.type(b'\r')
            for marker in [b'USER_RESTORED\r\n', b'ERROR_RESTORED\r\n', b'CHILD_RESTORED\r\n']:
                session.until(lambda marker=marker: marker in session.raw[offset:], 'Real parent/child stdout or stderr disappeared')
            offset = len(session.raw)
            session.type(b"printf '%s%s\\n' FOREGROUND_ READY; /bin/sleep 30\r")
            def foreground_ready():
                group = os.tcgetpgrp(session.fd)
                if group <= 0 or group == session.pid or b'FOREGROUND_READY\r\n' not in session.raw[offset:]:
                    return False
                try:
                    return Path(os.readlink(f'/proc/{group}/exe')).resolve() == Path('/bin/sleep').resolve()
                except FileNotFoundError:
                    return False
            # A new foreground PGID alone can precede exec and the child's
            # reset of inherited signal dispositions. Observe the actual
            # expected process image, rather than delaying or resending INT.
            session.until(foreground_ready, 'Actual sleep process did not start in the foreground PTY')
            group = os.tcgetpgrp(session.fd)
            (session.directory / 'foreground-before-interrupt.status').write_text(Path(f'/proc/{group}/status').read_text())
            session.type(b'\x03')
            session.until(lambda: os.tcgetpgrp(session.fd) == session.pid, 'Following foreground Ctrl-C did not stop the program')
            offset = len(session.raw)
            session.type(b"printf 'FOLLOWING_STATUS=%s\\n' \"$?\"; builtin trap -p INT; printf '%s%s\\n' DEFAULT_INT_ RESTORED\r")
            session.until(lambda: b'FOLLOWING_STATUS=130\r\n' in session.raw[offset:] and b'DEFAULT_INT_RESTORED\r\n' in session.raw[offset:], 'Original INT status/echo was not restored')
            assert b'trap --' not in session.raw[offset:]
            results.append({'version': item['version'], 'profile': item['profile'], 'moduleSha256': item['moduleSha256'], 'normalPrivateControl': True, 'actualControlEofAndPhysicalInterrupt': True, 'physicalUserEcho': True, 'parentChildAndBackgroundOutput': True, 'followingForegroundInterruptStatus': 130, 'hostDirectory': item['hostDirectory']})
    summary = inputs.with_name('widget-summary.json')
    summary.write_text(json.dumps(results, indent=2))
    print(json.dumps({'result': 'PASS', 'scope': 'actual Linux default-signal/cookie target component, no backend recovery override', 'builds': len(results)}))
    sys.exit(0)

inputs = Path(sys.argv[1])
entries, results = json.loads(inputs.read_text()), []
assert len(entries) == 12
for item in entries:
    with contextlib.ExitStack() as cleanup:
        session = NativeGeometry(item)
        cleanup.callback(session.close)
        session.send(item['prepare'])
        before, first_offset = session.progress(item['columns'] * 8)
        changed = 40 if item['columns'] == 32 else 32
        session.resize(changed, item['rows'])
        after, second_offset = session.progress(before)
        assert second_offset > first_offset
        session.resize(item['columns'], item['rows'])
        proof = session.wait_frame('inputConfirmed')['payload']
        source_bytes = item['source'].encode()
        assert proof['utf8Bytes'] == proof['cursorUtf8Bytes'] == proof['endUtf8Bytes'] == len(source_bytes)
        assert proof['sourceDigest'] == item['prepare']['payload']['sourceDigest'] and proof['planDigest'] == item['prepare']['payload']['planDigest']
        session.until(lambda: session.raw.endswith(source_bytes[-32:]), 'Real Linux source echo incomplete')
        (session.directory / 'typed-pty.bin').write_bytes(session.raw)
        metadata = {'target': 'linux-aarch64-glibc-2.36', 'version': item['version'], 'profile': item['profile'], 'moduleSha256': item['moduleSha256'], 'shellSha256': item['shellSha256'], 'columns': item['columns'], 'rows': item['rows'], 'size': 'oversize', 'source': item['source'], 'directory': item['hostDirectory'], 'actualResize': True, 'fullInputConfirmed': True, 'prefixBeforeFirstResize': source_bytes[:before].decode(), 'resizeEvents': [{'offset': first_offset, 'columns': changed, 'appliedUtf8Bytes': before}, {'offset': second_offset, 'columns': item['columns'], 'appliedUtf8Bytes': after}], 'actualCompleteProof': proof}
        session.send(item['arm'])
        session.wait_frame('commitArmed')
        session.type(b'\x18a')
        settled = session.wait_frame('settled')
        assert settled['payload']['exitCode'] == 0
        expected = ('中文 é 👩‍💻 width ' * 200 + '\r\n').encode()
        session.until(lambda: expected in session.raw, 'Real Linux program output missing after independent private Settled')
        assert session.accept_keys == 1
        assert sum(event['payload']['kind'] == 'submissionAccepted' for event in session.events) == 1
        assert bytes(session.raw).count(expected) == 1, 'Source executed more than once'
        metadata['nativeAcceptKeys'] = session.accept_keys
        (session.directory / 'geometry.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2))
        results.append(metadata)
summary = inputs.with_name('geometry-summary.json')
summary.write_text(json.dumps(results, ensure_ascii=False, indent=2))
host_summary = Path(entries[0]['hostDirectory']).parent / 'geometry-summary.json'
(ROOT / '.artifacts/tests/native-input-p2/latest-linux-geometry.json').write_text(json.dumps({'summary': str(host_summary)}))
print(json.dumps({'scope': 'actual formal Linux target PTYs, not app transport simulation', 'result': 'PASS', 'cases': len(results), 'summary': str(host_summary)}))
