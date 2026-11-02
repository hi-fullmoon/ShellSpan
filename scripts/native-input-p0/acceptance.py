"""Real Bash/PTY acceptance. No mocked producer, shell or receipt.

Only throwaway rc/inputrc/home and local files under the ignored evidence root
are used. SSH mode uses the same harness through a disposable loopback sshd.
"""
import argparse
import base64
import codecs
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shlex
import signal
import shutil
import socket
import struct
import subprocess
import tempfile
import termios
import time
import traceback

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / '.native-input-p0'


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


class Session:
    def __init__(self, args, name, user_config='', columns=100):
        self.args = args
        self.directory = Path(tempfile.mkdtemp(prefix=f'{name}-', dir=args.output))
        self.events = []
        self.timeline = []
        self.raw = bytearray()
        self.pending = ''
        self.decoder = codecs.getincrementaldecoder('utf-8')()
        self.counter = 0
        self.lease = 1
        self.start = time.monotonic()
        self.socket_dir = tempfile.TemporaryDirectory(prefix='ss-p0-')
        local_socket = str(Path(self.socket_dir.name) / 'control')
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(local_socket)
        os.chmod(local_socket, 0o600)
        self.listener.listen(1)
        self.listener.setblocking(False)
        self.control = None
        self.columns = columns
        self.rows = 24
        self.plan = None
        self.submitted = False
        self.editor_ready = False
        self.home = self.directory / 'home'
        self.home.mkdir()
        (self.home / '.inputrc').write_text('set editing-mode emacs\nset bell-style none\n')
        target_dir = self.target(self.directory)
        control_socket = local_socket if not args.ssh else f'/tmp/p0-{self.directory.name}.sock'
        rc = f'''export HOME={shlex.quote(self.target(self.home))}
export LC_ALL={shlex.quote(args.locale)}
HISTFILE="$HOME/history"
HISTSIZE=1000
HISTCONTROL=ignoreboth
PROMPT_COMMAND='printf "USER_PROMPT\\n"'
PS1='\\[\\e[36m\\]P0> \\[\\e[0m\\]'
PS2='CONT> '
{user_config}
printf '%s' "$BASH_VERSION" > "$HOME/runtime-version"
printf '%s' "$BASH" > "$HOME/runtime-executable"
enable -f {shlex.quote(args.bridge)} p0 p0_result p0_begin p0_child_closed
p0 {shlex.quote(control_socket)} "$(trap -p INT)"
__p0_user_prompt_command=$PROMPT_COMMAND
PROMPT_COMMAND='p0_result "$?" "$PWD"; builtin eval -- "$__p0_user_prompt_command"'
cd {shlex.quote(target_dir)}
'''
        (self.directory / 'rc').write_text(rc)
        command = [args.shell, '--noprofile', '--rcfile', f'{target_dir}/rc', '-i']
        if args.ssh:
            command = ['ssh', '-tt', '-F', '/dev/null', '-i', args.key,
                       '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
                       '-o', f'UserKnownHostsFile={args.known_hosts}',
                       '-o', 'ExitOnForwardFailure=yes', '-p', str(args.port),
                       '-R', f'{control_socket}:{local_socket}', 'p0@127.0.0.1',
                       'exec ' + shlex.join(command)]
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            # No host credentials, startup files, env secrets or command history.
            env = {'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
                   'HOME': str(self.home), 'TERM': 'xterm-256color', 'LC_ALL': args.locale}
            os.execvpe(command[0], command, env)
        self.resize(columns, 24)
        try:
            self.wait('Capabilities', timeout=15)
            self.wait('Prompt')
            self.wait('EditorReady')
            inspect = self.send('inspect')
            self.wait('EditorState', inspect)
            if getattr(args,'expected_version',None):
                assert (self.home/'runtime-version').read_text().startswith(args.expected_version+'.'), (self.home/'runtime-version').read_text()
        except Exception:
            self.close()
            raise

    def target(self, path):
        value = str(path)
        return value.replace(str(ROOT), '/work', 1) if self.args.ssh else value

    def resize(self, columns, rows):
        self.columns, self.rows = columns, rows
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        self.timeline.append({'at_ms': int((time.monotonic()-self.start)*1000),
                              'resize': [columns, rows]})

    def pump(self, seconds=0.05):
        handles = [self.fd, self.control or self.listener]
        ready, _, _ = select.select(handles, [], [], seconds)
        if self.fd in ready:
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                data = b''
            if data:
                self.raw.extend(data)
                self.timeline.append({'at_ms': int((time.monotonic()-self.start)*1000),
                                      'bytes': base64.b64encode(data).decode()})
        if self.listener in ready:
            self.control, _ = self.listener.accept()
            self.control.setblocking(False)
        if self.control in ready:
            data = self.control.recv(65536)
            if not data:
                self.timeline.append({'at_ms':int((time.monotonic()-self.start)*1000),'control_eof':True})
                self.control.close()
                self.control=None
            if data:
                self.pending += self.decoder.decode(data)
                decoder = json.JSONDecoder()
                while self.pending.strip():
                    self.pending = self.pending.lstrip()
                    try:
                        event, consumed = decoder.raw_decode(self.pending)
                    except json.JSONDecodeError:
                        break
                    self.pending = self.pending[consumed:]
                    event['received_ms'] = int((time.monotonic()-self.start)*1000)
                    event['pty_offset_at_receive'] = len(self.raw)
                    self.events.append(event)
                    if event['event']=='Settled':
                        self.submitted=False
                    if event['event']=='Prompt':
                        self.editor_ready=False
                    if event['event']=='EditorReady':
                        self.editor_ready=True
                    self.timeline.append({'at_ms': event['received_ms'], 'event': event})

    def drain(self, seconds=0.3):
        end = time.monotonic()+seconds
        while time.monotonic() < end:
            self.pump(min(0.05, max(0, end-time.monotonic())))

    def wait(self, event, request=None, after=0, timeout=8):
        end = time.monotonic()+timeout
        while time.monotonic() < end:
            for item in self.events[after:]:
                if item['event'] == event and (request is None or item['request'] == request):
                    return item
            self.pump()
        raise AssertionError(f'{event} request={request} timed out; events={self.events[-6:]}; tail={bytes(self.raw[-500:])!r}')

    def send(self, action, identity=None, fragment=False, delay_payload=0, **overrides):
        if not self.submitted:
            deadline=time.monotonic()+5
            while not self.editor_ready and time.monotonic()<deadline:
                self.pump()
            assert self.editor_ready, 'No native editor-ready receipt; never send a service key into a foreground program'
        self.counter += 1
        if action=='inspect':
            identity=dict(operation='observation',revision=1,source_digest='',plan_digest='')
        identity = identity or self.plan or dict(operation='no-draft', revision=1,
                                         source_digest='', plan_digest='')
        request = dict(request=self.counter, generation=1, lease=self.lease,
                       expires_ms=int(time.time()*1000)+10000, action=action, **identity)
        request.update(overrides)
        data = json.dumps(request, ensure_ascii=False).encode()
        if not self.submitted:
            self.type(b'\x18\x1e')
            if delay_payload:
                self.drain(delay_payload)
        def write_remaining(payload):
            remaining=memoryview(payload)
            deadline=time.monotonic()+5
            while remaining:
                try:
                    count=self.control.send(remaining)
                    assert count>0
                    remaining=remaining[count:]
                except BlockingIOError:
                    assert time.monotonic()<deadline, 'bounded private transport backpressure'
                    self.pump(0.01)
        if fragment:
            for start in range(0, len(data), 31):
                write_remaining(data[start:start+31])
                self.pump(0.002)
        else:
            write_remaining(data)
        self.timeline.append({'at_ms': int((time.monotonic()-self.start)*1000),
                              'request': {'request': request['request'], 'action': action,
                                          'operation': request['operation']}})
        if action == 'commit':
            end = time.monotonic()+5
            while time.monotonic() < end:
                matching = [x for x in self.events if x['request']==self.counter and x['event'] in ['CommitArmed','Rejected']]
                if matching:
                    if matching[0]['event']=='CommitArmed':
                        self.submitted=True
                        self.editor_ready=False
                        self.type(b'\x18a')
                    break
                self.pump()
            else:
                raise AssertionError('CommitArmed/Rejected not received; never resend executable input')
        return self.counter

    def prepare(self, source, reduced=False, fragment=False, **overrides):
        helper = ARTIFACTS / f'build-{os.uname().sysname.lower()}' / 'debug/p0-plan'
        submission = json.loads(subprocess.check_output([str(helper)], input=source.encode()))['plan']
        self.plan = dict(operation=f'op-{self.counter+1}', revision=1,
                         source_digest=sha(source), plan_digest=sha(submission))
        fields=dict(source=source,plan=submission,reduced=reduced,fragment=fragment,
                    insertion=getattr(self.args,'strategy','replace')=='insert' or getattr(self.args,'display_profile','legacy') in ['preserve','append'],
                    start_rebase=getattr(self.args,'display_profile','legacy')=='preserve',
                    geometry_rebase=getattr(self.args,'display_profile','legacy')=='preserve',
                    viewport_safe=getattr(self.args,'display_profile','legacy')=='preserve',
                    append_display=getattr(self.args,'display_profile','legacy')=='append')
        fields.update(overrides)
        request = self.send('prepare', **fields)
        return request

    def run(self, source, reduced=True):
        prepared = self.prepare(source, reduced)
        self.wait('InputConfirmed', prepared)
        request = self.send('commit')
        return self.wait('Settled', after=next(i for i,x in enumerate(self.events)
                                             if x['event']=='Prepared' and x['request']==prepared)), request

    def type(self, data):
        os.write(self.fd, data)

    def close_control(self):
        self.control.shutdown(socket.SHUT_RDWR)
        self.control.close()
        self.control = None

    def close(self):
        try:
            self.drain(0.2)
            if not hasattr(self,'reaped_status'):
                try:
                    self.type(b'\x03')
                    self.drain(0.1)
                    self.type(b'exit\n')
                    self.drain(0.3)
                except OSError as error:
                    if error.errno!=errno.EIO:
                        raise
        finally:
            already_reaped=hasattr(self,'reaped_status')
            if not already_reaped:
                try:
                    os.kill(self.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            os.close(self.fd)
            if not already_reaped:
                deadline = time.monotonic()+1
                while time.monotonic() < deadline:
                    done, _ = os.waitpid(self.pid, os.WNOHANG)
                    if done:
                        break
                    time.sleep(0.02)
                else:
                    os.kill(self.pid, signal.SIGKILL)
                    os.waitpid(self.pid, 0)
            if self.control:
                self.control.close()
            self.listener.close()
            self.socket_dir.cleanup()
            (self.directory / 'pty.bin').write_bytes(self.raw)
            (self.directory / 'timeline.json').write_text(json.dumps(self.timeline, ensure_ascii=False, indent=2))
            (self.directory / 'events.json').write_text(json.dumps(self.events, ensure_ascii=False, indent=2))


def exercise(args, name, body, results, **options):
    if args.case and not any(name.startswith(value) for value in args.case):
        return
    session = None
    try:
        session = Session(args, name, **options)
        body(session)
        results.append(dict(case=name, result='PASS', evidence=str(session.directory.relative_to(ROOT))))
    except Exception:
        results.append(dict(case=name, result='FAIL', evidence=str(session.directory.relative_to(ROOT)) if session else None,
                            error=traceback.format_exc()))
    finally:
        if session:
            session.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--shell', required=True)
    parser.add_argument('--bridge', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--locale', default='en_US.UTF-8')
    parser.add_argument('--ssh', action='store_true')
    parser.add_argument('--port', type=int, default=22229)
    parser.add_argument('--key')
    parser.add_argument('--known-hosts')
    parser.add_argument('--case', action='append', default=[])
    parser.add_argument('--expected-version')
    parser.add_argument('--strategy',choices=['replace','insert'],default='replace')
    parser.add_argument('--display-profile',choices=['legacy','preserve','append'],default='legacy')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    # Never run a loaded module or executable from a mutable build output.
    # Every environment gets immutable, hash-addressable acceptance inputs.
    inputs={}
    for kind in ['shell','bridge']:
        original=getattr(args,kind)
        source_path=Path(original.replace('/work',str(ROOT),1)) if args.ssh else Path(original)
        frozen=args.output/('bash' if kind=='shell' else 'bridge.so')
        shutil.copy2(source_path,frozen)
        inputs[kind]={'original':original,'frozen':str(frozen),'sha256':hashlib.sha256(frozen.read_bytes()).hexdigest()}
        target=str(frozen.resolve()).replace(str(ROOT),'/work',1) if args.ssh else str(frozen.resolve())
        setattr(args,kind,target)
    sources={str(path.relative_to(ROOT)):hashlib.sha256(path.read_bytes()).hexdigest()
             for path in Path(__file__).resolve().parent.rglob('*') if path.is_file() and '__pycache__' not in path.parts}
    args.output.joinpath('suite-inputs.json').write_text(json.dumps({'inputs':inputs,'observed_sources':sources,
        'python':sys.version if 'sys' in globals() else os.sys.version,'command':os.sys.argv},indent=2))
    manifest=ARTIFACTS/f'artifact-manifest-{"linux" if args.ssh else os.uname().sysname.lower()}.json'
    if manifest.exists():
        shutil.copy2(manifest,args.output/'build-inputs.json')
    results = []

    def scripts(s):
        for source in ["printf 'SHORT_OK\\n'", "printf '%s\\n' '中文 é 👩‍💻 ! tab\tend'",
                       "value=first\nprintf '%s\\n' \"$value\"\nvalue=last",
                       "printf '%s\\n' '" + '长脚本 é 👩‍💻 ' * 170 + "'"]:
            prepared = s.prepare(source, fragment=True)
            confirmed = s.wait('InputConfirmed', prepared)
            assert confirmed['details']['source_digest'] == sha(source)
            assert confirmed['details']['elapsed_ms'] <= 1750, confirmed
            s.drain(0.2)
            boundary = len(s.raw)
            request = s.send('commit')
            after=len(s.events)
            s.wait('SubmissionAccepted', request)
            settled = s.wait('Settled', after=after)
            assert settled['details']['exit'] == 0, settled
            s.drain()
            assert b'builtin eval --' not in s.raw[boundary:], bytes(s.raw[boundary:])
        # A program printing the same envelope is genuine output, kept verbatim.
        helper=ARTIFACTS/f'build-{os.uname().sysname.lower()}'/'debug/p0-plan'
        printed_plan=json.loads(subprocess.check_output([str(helper)],input=b"printf 'USER_OUTPUT\\n'"))['plan']
        s.run("printf '%s\\n' "+shlex.quote(printed_plan))
        s.drain()
        assert printed_plan.encode() in s.raw
    exercise(args, 'source-binding-native-submit', scripts, results)

    def state(s):
        s.run("cd home\nexport P0_VALUE=persisted\np0_function() { printf 'FUNCTION_OK\\n'; }\nalias p0_alias='printf ALIAS_OK\\\\n'")
        settled, _ = s.run("printf '%s\\n' \"$P0_VALUE\"\np0_function\np0_alias\ndeclare -p P0_VALUE\nfalse")
        assert settled['details']['exit'] == 1
        settled, _ = s.run("printf 'PRIOR:%s\\n' \"$?\"; declare P0_TOP=top; local P0_ILLEGAL=x; printf 'TOP:%s\\n' \"${FUNCNAME[*]}\"; false")
        assert settled['details']['exit'] == 1
        assert settled['details']['cwd'].endswith('/home')
        s.drain()
        assert b'PRIOR:1' in s.raw and b'TOP:\r\n' in s.raw and b'local: can only be used in a function' in s.raw
        s.run("printf 'SAVED:%s\\n' \"$P0_TOP\"; trap 'printf TRAP_OK\\\\n' USR1; kill -USR1 $$")
        s.drain()
        assert b'SAVED:top' in s.raw and b'TRAP_OK' in s.raw
        s.run('history -w')
        history = (s.home / 'history').read_text()
        assert 'builtin eval --' in history  # Current contract exposes envelope history.
        s.run("printf 'CONFIG:%s:%s\\n' \"$HISTCONTROL\" \"$(bind -v | head -1)\"")
        s.drain()
        assert b'CONFIG:ignoreboth:' in s.raw and b'USER_PROMPT' in s.raw
    exercise(args, 'parent-state-history-user-config', state, results)

    def config(s):
        settled,_=s.run("printf 'LOCALE:%s\\n' \"$LC_ALL\"; shopt -q extglob; printf 'OPTION:%s\\n' \"$?\"; printf 'HISTORY:%s\\n' \"$HISTCONTROL\"")
        assert settled['details']['exit']==0
        s.drain()
        assert b'LOCALE:en_US.UTF-8\r\n' in s.raw
        assert b'OPTION:0\r\n' in s.raw and b'HISTORY:ignoredups\r\n' in s.raw
        assert b'USER_CUSTOM_PROMPT\r\n' in s.raw
    exercise(args,'readonly-locale-user-prompt-options',config,results,
             user_config="readonly LC_ALL; shopt -s extglob; HISTCONTROL=ignoredups; PROMPT_COMMAND='printf USER_CUSTOM_PROMPT\\\\n'")

    def descriptors(s):
        python="import os,stat; print('SOCKETS:'+str(sum(stat.S_ISSOCK(os.fstat(fd).st_mode) for fd in range(3,128) if os.path.exists('/dev/fd/'+str(fd)))))"
        s.run("p0_child_closed; printf 'PARENT_CONTROL:%s\\n' \"$?\"; (p0_child_closed); printf 'CHILD_CONTROL:%s\\n' \"$?\"; python3 -c "+shlex.quote(python))
        s.drain()
        assert b'PARENT_CONTROL:1\r\n' in s.raw and b'CHILD_CONTROL:0\r\n' in s.raw
        assert b'SOCKETS:0\r\n' in s.raw
    exercise(args,'control-descriptor-inheritance',descriptors,results)

    def idle(s):
        probe=s.send('inspect',delay_payload=0.2)
        s.wait('EditorState',probe)
        after=len(s.events)
        s.drain(5.2)
        assert not any(event['event']=='ControlLost' for event in s.events[after:])
        probe=s.send('inspect')
        assert s.wait('EditorState',probe)['details']['line']==''
    exercise(args,'native-hook-teardown-idle',idle,results)

    def unload(s):
        # Restore the fixture's own prompt first, then remove all module
        # builtins and launch a genuine external child in the same Bash.
        s.type(b'PROMPT_COMMAND=$__p0_user_prompt_command; enable -d p0 p0_result p0_begin p0_child_closed; /usr/bin/true; printf unloaded > unload-effect; exit 7\n')
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            done,status=os.waitpid(s.pid,os.WNOHANG)
            if done:
                s.reaped_status=status
                assert os.WIFEXITED(status) and os.WEXITSTATUS(status)==7,status
                break
            s.pump()
        else:
            raise AssertionError('unloaded shell did not exit')
        assert (s.directory/'unload-effect').read_text()=='unloaded'
    exercise(args,'module-deactivation-native-child',unload,results)

    for phase in ['before', 'typing', 'confirmed', 'race-cancel-first', 'race-commit-first', 'running']:
        for action in ['cancel', 'takeover']:
            def cancel(s, phase=phase, action=action):
                native_interrupts = {130}
                if phase == 'race-commit-first':
                    # Establish this build's own top-level builtin SIGINT
                    # result. Bash 4.1's throw_to_top_level uses oldStatus|128;
                    # do not turn that genuine status into a synthetic 130.
                    after = len(s.events)
                    s.type(b"printf 'PARENT_READY\\n'; while :; do :; done\n")
                    end=time.monotonic()+3
                    while b'PARENT_READY\r\n' not in s.raw and time.monotonic()<end:
                        s.pump()
                    assert b'PARENT_READY\r\n' in s.raw
                    s.type(b'\x03')
                    baseline=s.wait('Prompt',after=after)
                    native_interrupts.add(baseline['details']['exit'])
                    # Also measure a genuine external foreground command.
                    after_external=len(s.events)
                    s.type(b'sleep 5\n')
                    s.drain(0.15)
                    s.type(b'\x03')
                    external=s.wait('Prompt',after=after_external)
                    native_interrupts.add(external['details']['exit'])
                    assert external['details']['exit']==130
                    s.directory.joinpath('signal-baseline.json').write_text(json.dumps({'builtin':baseline,'external':external},indent=2))
                    s.drain(0.1)
                if phase == 'before':
                    request = s.send(action)
                    cleared=s.wait('DraftCleared', request)
                    s.lease=cleared['lease']
                    late=s.prepare('printf effect >> effect',operation='no-draft')
                    s.wait('Rejected',late)
                    assert not (s.directory / 'effect').exists()
                    return
                prepared = s.prepare("printf effect >> effect; sleep 5; printf tail >> tail")
                s.wait('Prepared', prepared)
                if phase == 'typing':
                    s.drain(0.4)
                else:
                    s.wait('InputConfirmed', prepared)
                after = len(s.events)
                if phase in ['race-commit-first', 'running']:
                    commit = s.send('commit')
                    s.wait('SubmissionAccepted', commit)
                    if phase == 'running':
                        s.drain(0.3)
                    stop = s.send(action)
                    # Real Ctrl-C: never inject another editor control into the program.
                    s.type(b'\x03')
                    settled = s.wait('Settled', after=after)
                    assert settled['details']['exit'] in native_interrupts, (settled,native_interrupts)
                    s.drain()
                    if (s.directory / 'effect').exists():
                        effect=(s.directory/'effect').read_bytes()
                        assert b'effect'.startswith(effect), effect
                    if phase == 'running':
                        assert (s.directory / 'effect').read_text()=='effect'
                    assert not (s.directory / 'tail').exists()
                    # The queued request is rejected after prompt settlement;
                    # no late native submission can occur.
                    s.drain()
                    inspect=s.send('inspect')
                    s.wait('EditorState',inspect)
                    assert any(x['request']==stop and x['event'] in ['Rejected','RecoveryRequired'] for x in s.events)
                else:
                    stop = s.send(action)
                    late = s.send('commit') if phase == 'race-cancel-first' else None
                    cleared = s.wait('DraftCleared', stop)
                    if action == 'takeover':
                        s.lease = cleared['lease']
                    if late:
                        s.wait('Rejected', late)
                    s.type(b'\x18a')  # A real late executable chord is inert.
                    s.drain(0.1)
                    assert not (s.directory / 'effect').exists()
                    s.type(b"printf 'USER_RESTORED\\n'\n")
                    s.drain()
                    assert b'USER_RESTORED\r\n' in s.raw
                assert len([x for x in s.events[after:] if x['event']=='SubmissionAccepted']) <= 1
            exercise(args, f'{action}-{phase}', cancel, results)

    def stale(s):
        prepared = s.prepare("printf effect >> effect", reduced=True)
        s.wait('InputConfirmed', prepared)
        for fields in [dict(generation=2), dict(lease=2), dict(revision=2), dict(plan_digest='wrong'), dict(expires_ms=1)]:
            request = s.send('commit', **fields)
            s.wait('Rejected', request)
        stop = s.send('takeover')
        cleared = s.wait('DraftCleared', stop)
        # The genuine earlier InputConfirmed remains in the receiver queue;
        # it grants no authority after this native lease revocation.
        request = s.send('commit')
        s.wait('Rejected', request)
        s.lease = cleared['lease']
        assert not (s.directory / 'effect').exists()
    exercise(args, 'stale-identity-late-confirmation', stale, results)

    def reduced(s):
        prepared = s.prepare("printf 'REDUCED_OK\\n'", reduced=True)
        confirmed = s.wait('InputConfirmed', prepared)
        assert confirmed['details']['elapsed_ms'] < 350
        s.send('commit')
        settled = s.wait('Settled')
        assert settled['details']['exit']==0
        request = s.send('commit')
        s.wait('Rejected', request)
        s.drain()
        assert bytes(s.raw).count(b'REDUCED_OK\r\n') == 1
    exercise(args, 'reduced-motion-once', reduced, results)

    def draft(s):
        s.type(b'USER_DRAFT')
        s.drain()
        request = s.prepare('printf NOT_EXECUTED')
        s.wait('Rejected', request)
        cancelled=s.send('cancel')
        preserved=s.wait('DraftCleared',cancelled)
        assert preserved['details']['user_draft_preserved']
        query=s.send('inspect')
        assert s.wait('EditorState',query)['details']['line']=='USER_DRAFT'
        s.type(b'\x03')
        s.drain()
        assert b'USER_DRAFT' in s.raw and b'NOT_EXECUTED' not in s.raw
    exercise(args, 'existing-user-draft', draft, results)

    def binding(s):
        request=s.prepare("printf effect >> effect",reduced=True,plan='true',plan_digest=sha('true'))
        s.wait('Rejected',request)
        assert not (s.directory/'effect').exists()
        request=s.prepare("printf effect >> effect",reduced=True,expires_ms=int(time.time()*1000)+400)
        s.wait('InputConfirmed',request)
        s.wait('Expired',request)
        request=s.send('commit')
        s.wait('Rejected',request)
        s.type(b'\x18a')
        s.drain()
        assert not (s.directory/'effect').exists()
    exercise(args,'binding-timeout-native-clear',binding,results)

    for change in ['append','cursor']:
        def altered_editor(s,change=change):
            source='printf effect >> effect'
            request=s.prepare(source,reduced=True)
            s.wait('InputConfirmed',request)
            s.type(b'x' if change=='append' else b'\x02')
            s.drain(0.1)
            inspect=s.send('inspect')
            observed=s.wait('EditorState',inspect)['details']
            if change=='append':
                assert observed['line']==source+'x'
            else:
                assert observed['line']==source and observed['point_utf8_bytes']<len(source)
            commit=s.send('commit')
            s.wait('Rejected',commit)
            cancel=s.send('cancel')
            s.wait('RecoveryRequired',cancel)
            s.type(b'\x18a')
            s.drain(0.1)
            assert not (s.directory/'effect').exists()
        exercise(args,f'changed-editor-{change}-no-execute',altered_editor,results)

    for stage in ['typing', 'confirmed', 'partial-json', 'submitted']:
        def eof(s, stage=stage):
            if stage == 'partial-json':
                s.type(b'\x18\x1e')
                s.drain(0.1)
                s.control.sendall(b'{"request":')
            else:
                prepared = s.prepare("printf effect >> effect; sleep 0.4; printf done >> done", reduced=stage != 'typing')
                s.wait('Prepared', prepared)
                if stage != 'typing':
                    s.wait('InputConfirmed', prepared)
                else:
                    s.drain(0.3)
                if stage == 'submitted':
                    request = s.send('commit')
                    s.wait('SubmissionAccepted', request)
            s.close_control()
            s.drain(0.9)
            if stage == 'submitted':
                assert (s.directory / 'effect').read_text() == 'effect'
                # No trusted end delivered over the closed endpoint: uncertain.
                assert not any(x['event']=='Settled' for x in s.events)
            else:
                assert not (s.directory / 'effect').exists()
                s.type(b"printf 'EOF_USER_OK\\n'\n")
                s.drain()
                assert b'EOF_USER_OK\r\n' in s.raw
        exercise(args, f'control-eof-{stage}', eof, results)

    def background(s):
        # User background output; native baseline uses exactly the same shell
        # and terminal. No output filtering or repaint text is introduced.
        s.type(b"(for i in 1 2 3 4 5; do printf 'BG_%s\\n' \"$i\"; sleep 0.15; done) &\n")
        s.drain(0.2)
        source = "printf '%s\\n' '" + '中文 é 👩‍💻 resize ' * 35 + "'"
        request = s.prepare(source)
        s.wait('Prepared', request)
        for columns in [180, 40, 32, 100]:
            s.resize(columns, 24)
            s.drain(0.2)
        s.wait('InputConfirmed', request)
        s.send('commit')
        settled = s.wait('Settled')
        assert settled['details']['exit']==0
        s.drain()
        for i in range(1,6):
            assert f'BG_{i}\r\n'.encode() in s.raw, f'missing BG_{i}'
        assert b'builtin eval --' not in s.raw
    exercise(args, 'background-resize-unicode', background, results)

    # A native user edit provides the real geometry baseline, independently of
    # the adapter's buffer replacement. The browser compares public xterm state.
    geometries=[(columns,size,repeats) for size,repeats in [('normal',6),('oversize',270)]
                for columns in [32,40,100,180]]
    for columns,size,repeats in geometries:
        source = "printf '%s\\n' '" + '中文 é 👩‍💻 width ' * repeats + "'"
        for mode in ['user', 'bridge']:
            def geometry(s, mode=mode, source=source, size=size):
                if mode == 'user':
                    for start in range(0, len(source), 16):
                        s.type(source[start:start+16].encode())
                        s.drain(0.02)
                    query = s.send('inspect')
                    state = s.wait('EditorState', query)
                    assert state['details']['line'] == source
                else:
                    request = s.prepare(source)
                    s.wait('InputConfirmed', request)
                s.drain(0.2)
                # A genuine endpoint receipt tags a capture boundary. It does
                # not invent any PTY bytes or editor acknowledgements.
                query = s.send('inspect')
                s.wait('EditorState', query)
                s.drain(0.1)
                s.timeline.append({'at_ms': int((time.monotonic()-s.start)*1000), 'checkpoint':'geometry'})
                s.directory.joinpath('geometry.json').write_text(json.dumps({'source':source,'mode':mode,'columns':s.columns,'size':size,'display_profile':args.display_profile}))
            exercise(args, f'geometry-{columns}-{size}-{mode}', geometry, results, columns=columns)

    args.output.joinpath('results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
    failures = [r for r in results if r['result']!='PASS']
    for failure in failures:
        print(failure['case'], failure['error'])
    print(f'{args.shell} {"SSH" if args.ssh else "local"}: {len(results)-len(failures)}/{len(results)} passed; {args.output}')
    return bool(failures)


if __name__ == '__main__':
    raise SystemExit(main())
