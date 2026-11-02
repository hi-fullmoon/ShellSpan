"""Paired real PTY experiment; the pure mode loads no adapter at all.

Fixture prompt files and terminal modes synchronize this experiment only.
They never stand in for production execution authorization or receipts.
"""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import termios
import time

sys.dont_write_bytecode = True
from acceptance import Session, ROOT

BACKGROUND = '(for i in 1 2 3 4 5; do printf \'BG_%s\\n\' "$i"; sleep 0.15; done) &\n'
PROMPT_CONFIG = '''
__p0_fixture_prompt() {
  local result=$?
  builtin history -w
  builtin printf '%s\\n' "$result" >> "$HOME/prompt-status"
  builtin printf 'USER_PROMPT\\n'
}
PROMPT_COMMAND=__p0_fixture_prompt
'''


class PureSession(Session):
    """Actual Bash and OS PTY, without dlopen, p0 builtins or control socket."""
    def __init__(self,args,name):
        self.args=args
        self.directory=Path(tempfile.mkdtemp(prefix=name+'-',dir=args.output))
        self.home=self.directory/'home'
        self.home.mkdir()
        self.start=time.monotonic()
        self.timeline=[]
        self.raw=bytearray()
        self.events=[]
        self.columns,self.rows=100,24
        (self.home/'.inputrc').write_text('set editing-mode emacs\nset bell-style none\n')
        rc=f'''export HOME={shlex.quote(self.target(self.home))}
export LC_ALL={shlex.quote(args.locale)}
HISTFILE="$HOME/history"
HISTSIZE=1000
HISTCONTROL=ignoreboth
PS1='\\[\\e[36m\\]P0> \\[\\e[0m\\]'
PS2='CONT> '
printf '%s' "$BASH_VERSION" > "$HOME/runtime-version"
printf '%s' "$BASH" > "$HOME/runtime-executable"
enable -p > "$HOME/enabled-builtins"
{PROMPT_CONFIG}
cd {shlex.quote(self.target(self.directory))}
'''
        (self.directory/'rc').write_text(rc)
        self.pid,self.fd=pty.fork()
        if self.pid==0:
            command=[args.shell,'--noprofile','--rcfile',self.target(self.directory/'rc'),'-i']
            if args.ssh:
                command=['ssh','-tt','-F','/dev/null','-i',args.key,'-o','IdentitiesOnly=yes',
                    '-o','StrictHostKeyChecking=yes','-o',f'UserKnownHostsFile={args.known_hosts}',
                    '-p',str(args.port),'p0@127.0.0.1','exec '+shlex.join(command)]
            os.execvpe(command[0],command,
                dict(PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',HOME=str(self.home),
                     LC_ALL=args.locale,TERM='xterm-256color'))
        self.resize(100,24)

    def pump(self,seconds=0.05):
        if select.select([self.fd],[],[],seconds)[0]:
            try:
                data=os.read(self.fd,65536)
            except OSError:
                data=b''
            if data:
                self.raw.extend(data)
                self.timeline.append(dict(at_ms=int((time.monotonic()-self.start)*1000),
                                          bytes=base64.b64encode(data).decode()))

    def close(self):
        try:
            self.type(b'\x03')
            self.drain(0.1)
            self.type(b'exit\n')
            self.drain(0.2)
        finally:
            done,_=os.waitpid(self.pid,os.WNOHANG)
            if not done:
                os.kill(self.pid,signal.SIGKILL)
                os.waitpid(self.pid,0)
            os.close(self.fd)
            (self.directory/'pty.bin').write_bytes(self.raw)
            (self.directory/'timeline.json').write_text(json.dumps(self.timeline,ensure_ascii=False,indent=2))
            (self.directory/'events.json').write_text('[]\n')


def fixture_ready(session,count):
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
        path=session.home/'prompt-status'
        statuses=path.read_text().splitlines() if path.exists() else []
        modes=termios.tcgetattr(session.fd)
        if len(statuses)>=count and not modes[3]&termios.ICANON:
            session.drain(0.05)
            session.timeline.append(dict(at_ms=int((time.monotonic()-session.start)*1000),
                fixture_ready=dict(prompt_count=count,icanon=False,authority=False)))
            return statuses
        session.pump()
    raise AssertionError('Controlled prompt file / native tty mode did not become ready')


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--shell',required=True)
    parser.add_argument('--bridge',required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--schedule',type=Path,required=True)
    parser.add_argument('--mode',choices=['pure','loaded-user','replace','insert','start-rebase','geometry-rebase','viewport-safe','append-display'],required=True)
    parser.add_argument('--no-resize',action='store_true')
    parser.add_argument('--no-edit',action='store_true')
    parser.add_argument('--interval-ms',type=int,choices=[50,150,350,450],default=150)
    parser.add_argument('--ssh',action='store_true')
    parser.add_argument('--port',type=int)
    parser.add_argument('--key')
    parser.add_argument('--known-hosts')
    args=parser.parse_args()
    args.output=args.output.resolve()
    args.output.mkdir(parents=True,exist_ok=True)
    if (args.output/'native-result.json').exists() or any(args.output.glob('background-resize-unicode-*')):
        raise RuntimeError('Use a new evidence directory; do not merge independent captures')
    args.locale='en_US.UTF-8'
    args.expected_version=None
    args.strategy='insert' if args.mode in ['start-rebase','geometry-rebase','viewport-safe','append-display'] else args.mode
    background=BACKGROUND.replace('sleep 0.15',f'sleep {args.interval_ms/1000:.3f}')
    inputs={}
    for kind in ['shell','bridge']:
        original=Path(getattr(args,kind).replace('/work',str(ROOT),1)) if args.ssh else Path(getattr(args,kind))
        frozen=args.output/('bash' if kind=='shell' else 'bridge.so')
        if kind=='bridge' and args.mode=='pure':
            continue
        shutil.copy2(original,frozen)
        inputs[kind]=dict(original=str(original),sha256=hashlib.sha256(frozen.read_bytes()).hexdigest())
        setattr(args,kind,str(frozen).replace(str(ROOT),'/work',1) if args.ssh else str(frozen))
    schedule=json.loads(args.schedule.read_text())
    source=schedule['source']
    assert ''.join(item['text'] for item in schedule['chunks'])==source
    (args.output/'inputs.json').write_text(json.dumps(dict(inputs=inputs,schedule=schedule,
        mode=args.mode,resize=not args.no_resize,editing=not args.no_edit,
        python=sys.version,uname=list(os.uname()),command=sys.argv,background_command=background),ensure_ascii=False,indent=2))
    session=None
    try:
        session=PureSession(args,'background-resize-unicode-pure') if args.mode=='pure' else Session(
            args,'background-resize-unicode-'+args.mode,user_config=PROMPT_CONFIG)
        fixture_ready(session,1)
        if args.mode=='pure':
            assert 'enable p0' not in (session.home/'enabled-builtins').read_text()
            assert 'enable -f' not in (session.directory/'rc').read_text()
        session.type(background.encode())
        fixture_ready(session,2)
        session.drain(0.2)
        request=None
        session.timeline.append(dict(at_ms=int((time.monotonic()-session.start)*1000),checkpoint='editing-start'))
        if not args.no_edit and args.mode in ['replace','insert','start-rebase','geometry-rebase','viewport-safe','append-display']:
            request=session.prepare(source,start_rebase=args.mode in ['start-rebase','geometry-rebase','viewport-safe'],
                                    geometry_rebase=args.mode in ['geometry-rebase','viewport-safe'],viewport_safe=args.mode=='viewport-safe',
                                    append_display=args.mode=='append-display')
            session.wait('Prepared',request)
        actions=[]
        if not args.no_resize:
            actions.extend((at,'resize',columns) for at,columns in [(0,180),(200,40),(400,32),(600,100)])
        if not args.no_edit and args.mode in ['pure','loaded-user']:
            actions.extend((chunk['at_ms'],'input',chunk['text']) for chunk in schedule['chunks'])
        begin=time.monotonic()
        for at,kind,value in sorted(actions,key=lambda item:(item[0],item[1]!='resize')):
            remaining=begin+at/1000-time.monotonic()
            if remaining>0:
                session.drain(remaining)
            if kind=='resize':
                session.resize(value,24)
            else:
                session.type(value.encode())
                session.timeline.append(dict(at_ms=int((time.monotonic()-session.start)*1000),
                    actual_user_input=base64.b64encode(value.encode()).decode()))
        remaining=begin+1.7-time.monotonic()
        if remaining>0:
            session.drain(remaining)
        if request is not None:
            session.wait('InputConfirmed',request)
        session.timeline.append(dict(at_ms=int((time.monotonic()-session.start)*1000),checkpoint='before-submit'))
        if not args.no_edit:
            if request is not None:
                session.send('commit')
                settled=session.wait('Settled')
                assert settled['details']['exit']==0
            else:
                session.type(b'\n')
            statuses=fixture_ready(session,3)
            assert statuses[-1]=='0',statuses
            assert (session.home/'history').read_bytes().endswith(source.encode()+b'\n') if args.mode in ['pure','loaded-user'] else True
        session.drain(0.4)
        counts={f'BG_{i}':bytes(session.raw).count(f'BG_{i}\r\n'.encode()) for i in range(1,6)}
        assert all(count==1 for count in counts.values()),counts
        session.timeline.append(dict(at_ms=int((time.monotonic()-session.start)*1000),checkpoint='observed-end'))
        result=dict(native='PASS',bridge_loaded=args.mode!='pure',mode=args.mode,
            raw_background_counts=counts,evidence=str(session.directory),preservation='pending browser')
        (args.output/'native-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
        print(json.dumps(result,ensure_ascii=False))
    finally:
        if session:
            session.close()


if __name__=='__main__':
    main()
