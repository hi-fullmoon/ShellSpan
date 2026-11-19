"""Render approved bytes in a real native editor without accepting/executing them.

Auxiliary layout oracle for the native WebView acceptance, not model execution.
Requires Python 3 and pexpect; SSH fixtures also require the existing Docker CLI.
"""
import hashlib
import io
import json
import os
import re
from pathlib import Path
import shlex
import subprocess
import signal
import sys
import tempfile
import uuid
import pexpect

def terminate(_signal, _frame):
    raise RuntimeError('Native editor layout reference was cancelled')

signal.signal(signal.SIGTERM, terminate)

request = json.loads(Path(sys.argv[1]).read_text())
source = request['acceptedLine']
assert len(source.encode()) <= 32768
assert all((ord(char) >= 32 and not 127 <= ord(char) <= 159) or char in '\n\t\r' for char in source)
assert request['shell'] in ('bash', 'zsh')
assert re.fullmatch(r'\( job-[0-9a-f]{32};\n[\s\S]*\n\) &', source)
columns, rows, prefix = request['columns'], request['rows'], request['prefixColumns']
assert 32 <= columns <= 1000 and 10 <= rows <= 300 and 0 <= prefix < columns
remote = request.get('ssh', False)
container = None
if remote:
    container = subprocess.check_output(['docker', 'compose', '-f', request['compose'], 'ps', '-q', 'ssh'], text=True).strip()
    assert container and all(char in '0123456789abcdef' for char in container)

with tempfile.TemporaryDirectory(prefix='shellspan-editor-layout-') as directory:
    checkpoint = str(Path(directory) / 'buffer')
    remote_directory = f'/tmp/shellspan-editor-layout-{uuid.uuid4().hex}'
    if remote:
        subprocess.run(['docker', 'exec', container, 'mkdir', '-m', '700', remote_directory], check=True)
        checkpoint = f'{remote_directory}/buffer'
    trace = Path(sys.argv[2])
    ready = uuid.uuid4().hex
    ack = f'\x1b]0;LAYOUT_{ready}\x07'.encode()
    if request['shell'] == 'zsh':
        executable, arguments = '/bin/zsh', ['-f', '-i']
        setup = (f"unsetopt prompt_subst prompt_percent; PROMPT={shlex.quote(' ' * prefix)}; RPROMPT=''; "
                 f"__layout_checkpoint() {{ print -rn -- \"$BUFFER\" > {shlex.quote(checkpoint)}; "
                 f"printf '\\033]0;LAYOUT_{ready}\\007'; }}; "
                 "zle -N __layout_checkpoint; bindkey '^X^A' __layout_checkpoint; bindkey '^X^V' quoted-insert; "
                 "bindkey -s '^Xn' '^X^V^J'; bindkey -s '^Xt' '^X^V^I'; bindkey -s '^Xr' '^X^V^M'; ")
    else:
        executable = '/bin/bash' if remote else request['bashExecutable']
        arguments = ['--noprofile', '--norc', '-i']
        setup = (f"shopt -u promptvars; PS1={shlex.quote(' ' * prefix)}; bind 'set bell-style audible'; "
                 f"__layout_checkpoint() {{ printf '%s' \"$READLINE_LINE\" > {shlex.quote(checkpoint)}; "
                 f"printf '\\033]0;LAYOUT_{ready}\\007'; }}; "
                 "bind -x '\"\\C-x\\C-a\":__layout_checkpoint'; bind '\"\\C-x\\C-v\":quoted-insert'; "
                 "bind '\"\\C-xn\":\"\\C-x\\C-v\\C-j\"'; bind '\"\\C-xt\":\"\\C-x\\C-v\\C-i\"'; bind '\"\\C-xr\":\"\\C-x\\C-v\\C-m\"'; ")
    setup += f"printf '%s%s\\n' READY_ {ready}"
    setup = f"printf '%s' \"$$\" > {shlex.quote(checkpoint + '.pid')}; " + setup
    command = executable
    if remote:
        command, arguments = 'docker', ['exec', '-it', '-e', 'TERM=xterm-256color', container, executable, *arguments]
    child = pexpect.spawn(command, arguments, env={**os.environ, 'TERM': 'xterm-256color'},
                          dimensions=(rows, columns), timeout=12, encoding=None)
    try:
        child.expect(rb'[%#$] ')
        child.sendline(setup.encode())
        child.expect_exact(f'READY_{ready}'.encode())
        class BoundedTrace(io.BufferedWriter):
            def write(self, data):
                if self.tell() + len(data) > 2 * 1024 * 1024:
                    raise ValueError('Native layout trace exceeded its bound')
                return super().write(data)

        with BoundedTrace(trace.open('wb', buffering=0)) as stream:
            child.logfile_read = stream
            # Native quoted-insert, never accept-line. BUFFER equality below
            # proves the editor consumed all bytes as data, not as commands.
            keys = {'\n': '\x18n', '\t': '\x18t', '\r': '\x18r'}
            literal = ''.join(keys.get(char, char) for char in source)
            child.send(b'\x0c' + literal.encode() + b'\x0c\x18\x01')
            child.expect_exact(ack)
            if request['shell'] == 'bash':
                # bind-x hides the Readline line while the shell callback runs.
                # Native clear-screen redraws it after return; the following
                # native abort/bell is an input-order barrier, not a sleep.
                child.send(b'\x0c\x07')
                child.expect_exact(b'\x07')
            child.logfile_read = None
        actual = (subprocess.check_output(['docker', 'exec', container, 'cat', checkpoint])
                  if remote else Path(checkpoint).read_bytes())
        assert actual == source.encode(), 'Native editor BUFFER changed the actual accepted source'
        Path(f'{trace}.json').write_text(json.dumps({
            'kind': 'native-editor-layout-only-no-source-execution', 'shell': request['shell'],
            'columns': columns, 'rows': rows, 'prefixColumns': prefix,
            'sourceSha256': hashlib.sha256(source.encode()).hexdigest(),
            'nativeBufferSha256': hashlib.sha256(actual).hexdigest(),
        }, indent=2))
    finally:
        child.logfile_read = None
        try:
            if child.isalive() and remote:
                # Never accept-line, even during cleanup. This PID was written
                # by this exact private exec TTY, not found by process name.
                pid = subprocess.check_output(['docker', 'exec', container, 'cat', checkpoint + '.pid']).decode()
                assert pid.isdecimal() and int(pid) > 1
                subprocess.run(['docker', 'exec', container, 'kill', '-HUP', pid], check=True)
        finally:
            child.close(force=True)
            if remote:
                subprocess.run(['docker', 'exec', container, 'rm', '-r', '--', remote_directory], check=True)
