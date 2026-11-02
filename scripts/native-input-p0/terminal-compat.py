"""Actual PTY terminal test program and isolated native-edit/TUI captures.

The fixture pipes synchronize IO only, never shell execution authority or
native integration receipts. Expected assertions are separate library oracles.
"""
import argparse
import base64
import json
import importlib.util
import os
from pathlib import Path
import pty
import select
import struct
import fcntl
import termios
import time
import tty
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parents[2]
ESC='\x1b'


def scenarios():
    return [
        dict(name='pending-wrap',cols=8,rows=4,scrollback=20,steps=[
            dict(write='abcdefgh',checkpoint='before'),dict(resize=[4,4],checkpoint='narrow'),
            dict(write='Z',checkpoint='after',copy='abcdefghZ')]),
        dict(name='non-end-cursor',cols=12,rows=4,scrollback=20,steps=[
            dict(write='abcdefghijkl'+ESC+'[3D',checkpoint='before'),
            dict(resize=[6,4],checkpoint='narrow',sameCell='before'),
            dict(write='X',checkpoint='after',copy='abcdefghXjkl')]),
        dict(name='non-end-wide-combining',cols=16,rows=5,scrollback=30,steps=[
            dict(write='A中é👩‍💻BCDEFGHIJKLMNOP'+ESC+'[1;4H',checkpoint='before'),
            dict(resize=[8,5],checkpoint='narrow',sameCell='before'),
            dict(resize=[24,5],checkpoint='wide',sameCell='before')]),
        dict(name='rows-and-columns',cols=20,rows=6,scrollback=50,steps=[
            dict(write='0123456789'*9,checkpoint='before'),
            dict(resize=[8,3],checkpoint='small'),dict(resize=[25,7],checkpoint='large'),
            dict(write='X',checkpoint='after',copy='0123456789'*9+'X')]),
        dict(name='active-line-scrollback-trim',cols=12,rows=4,scrollback=2,steps=[
            dict(write='0123'*30,checkpoint='before'),dict(resize=[4,4],checkpoint='trimmed'),
            dict(write='X',checkpoint='after',copy=('0123'*30)[-20:]+'X')]),
        dict(name='history-trim-above-cursor',cols=12,rows=4,scrollback=2,steps=[
            dict(write=''.join(f'ROW_{i}\r\n' for i in range(15))+'cursorABCDE'+ESC+'[5D',checkpoint='before'),
            dict(resize=[6,4],checkpoint='narrow',sameCell='before'),
            dict(resize=[18,4],checkpoint='wide',sameCell='before')]),
        dict(name='saved-cursor',cols=12,rows=5,scrollback=20,steps=[
            dict(write='abc'+ESC+'7defghijk',checkpoint='before'),
            dict(resize=[6,5],checkpoint='narrow'),
            dict(write=ESC+'8',checkpoint='restored',cursor=[3,0]),
            dict(write='X',checkpoint='after',copy='abcXefghijk')]),
        dict(name='saved-scrollback-cursor',cols=12,rows=4,scrollback=30,steps=[
            dict(write='ROW\r\n'*8+'abc'+ESC+'7defghijk',checkpoint='before'),
            dict(resize=[6,4],checkpoint='narrow'),
            dict(write=ESC+'8',checkpoint='restored',cursor=[3,2]),
            dict(write='X',checkpoint='after',copy='ROW\n'*8+'abcXefghijk')]),
        dict(name='scroll-region',cols=12,rows=6,scrollback=20,steps=[
            dict(write=ESC+'[2;4r'+ESC+'[2;1H'+'region-ABCDEFGHIJ'+ESC+'P$qr'+ESC+'\\',checkpoint='before'),
            dict(resize=[6,6],checkpoint='narrow'),
            dict(write=ESC+'P$qr'+ESC+'\\',checkpoint='region-query',reply=ESC+'P1$r1;6r'+ESC+'\\'),
            dict(write=ESC+'[r'+ESC+'[6;1Hend',checkpoint='after')]),
        dict(name='alternate-screen',cols=12,rows=5,scrollback=20,steps=[
            dict(write='NORMAL'+ESC+'[?1049h'+ESC+'[2;3H'+'ALT中é👩‍💻',checkpoint='alternate',buffer='alternate'),
            dict(resize=[6,3],checkpoint='narrow',buffer='alternate'),
            dict(resize=[18,7],checkpoint='wide',buffer='alternate'),
            dict(write=ESC+'[?1049l',checkpoint='normal',buffer='normal')]),
        dict(name='tabs-newlines-boundary',cols=16,rows=5,scrollback=30,steps=[
            dict(write='A\tB\r\n中é👩‍💻END',checkpoint='before',firstCells=['A','','','','','','','','B']),
            dict(resize=[8,5],checkpoint='narrow',copy='A       B\n中é👩‍💻END',firstCells=['A','','','','','','','','B']),
            dict(resize=[32,5],checkpoint='wide',copy='A       B\n中é👩‍💻END'),
            dict(write='X',checkpoint='after',copy='A       B\n中é👩‍💻ENDX')]),
        dict(name='repeated-reflow',cols=12,rows=5,scrollback=40,steps=[
            dict(write='a中é👩‍💻b-'*8,checkpoint='before'),
            *[dict(resize=[cols,5],checkpoint=f'resize-{i}',copy='a中é👩‍💻b-'*8) for i,cols in enumerate([8,20,6,32,12,7,24,8,12])],
            dict(write='X',checkpoint='after',copy='a中é👩‍💻b-'*8+'X')]),
        dict(name='nonpending-boundary',cols=12,rows=5,scrollback=20,steps=[
            dict(write='abcdefghijklmnop'+ESC+'[1;7H',checkpoint='before'),
            dict(resize=[6,5],checkpoint='narrow',sameCell='before'),
            dict(write='X',checkpoint='after',copy='abcdefXhijklmnop')]),
        dict(name='tab-arrives-after-resize',cols=16,rows=5,scrollback=20,steps=[
            dict(write='A',checkpoint='before'),dict(resize=[4,5],checkpoint='resized'),
            dict(write='\tB',checkpoint='tab-at-four-cols',copy='A  B',firstCells=['A','','','B']),
            dict(resize=[16,5],checkpoint='wide',copy='A  B',firstCells=['A','','','B'])]),
        dict(name='custom-tab-stop',cols=16,rows=5,scrollback=20,steps=[
            dict(write=ESC+'[4G'+ESC+'H\rA\tB',checkpoint='custom',copy='A  B',firstCells=['A','','','B']),
            dict(resize=[6,5],checkpoint='narrow',copy='A  B',firstCells=['A','','','B'])]),
    ]


def capture(case,out):
    directory=out/case['name']
    directory.mkdir()
    # Separate kernel pipes carry only the fixture's go/printed synchronization.
    reader,writer=os.pipe()
    ack_reader,ack_writer=os.pipe()
    pid,fd=pty.fork()
    if pid==0:
        os.close(writer);os.close(ack_reader)
        tty.setraw(0)
        try:
            for step in case['steps']:
                if 'write' in step:
                    if os.read(reader,1)!=b'w': os._exit(2)
                    payload=step['write'].encode()
                    while payload:
                        count=os.write(1,payload)
                        payload=payload[count:]
                    os.write(ack_writer,b'd')
            if os.read(reader,1)!=b'q': os._exit(3)
        finally:
            os._exit(0)
    os.close(reader);os.close(ack_writer)
    frames=[];raw=bytearray();start=time.monotonic()
    def drain(seconds=0.04):
        until=time.monotonic()+seconds
        while time.monotonic()<until:
            if select.select([fd],[],[],0.005)[0]:
                try: data=os.read(fd,65536)
                except OSError: break
                if not data: break
                raw.extend(data);frames.append(dict(at_ms=int((time.monotonic()-start)*1000),bytes=base64.b64encode(data).decode()))
    try:
        fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',case['rows'],case['cols'],0,0))
        frames.append(dict(resize=[case['cols'],case['rows']]))
        for step in case['steps']:
            if 'write' in step:
                os.write(writer,b'w')
                assert select.select([ack_reader],[],[],3)[0], 'real emitter timeout'
                assert os.read(ack_reader,1)==b'd'
                drain()
            if 'resize' in step:
                cols,rows=step['resize']
                fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0))
                frames.append(dict(resize=[cols,rows]));drain()
            frames.append(dict(checkpoint=step['checkpoint'],oracle={key:value for key,value in step.items() if key not in ['write','resize','checkpoint']}))
        os.write(writer,b'q')
        _,status=os.waitpid(pid,0)
        assert os.WIFEXITED(status) and os.WEXITSTATUS(status)==0,status
    finally:
        os.close(fd);os.close(writer);os.close(ack_reader)
    (directory/'pty.bin').write_bytes(raw)
    (directory/'timeline.json').write_text(json.dumps(frames,ensure_ascii=False,indent=2))
    (directory/'scenario.json').write_text(json.dumps(case,ensure_ascii=False,indent=2))


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--native',action='store_true')
    parser.add_argument('--shell',default=str(ROOT/'.artifacts/tests/native-input-p0/append-full-gate/bash'))
    args=parser.parse_args()
    args.output.mkdir(parents=True)
    cases=scenarios()
    for case in cases: capture(case,args.output)
    names=[c['name'] for c in cases]
    if args.native:
        names.extend(capture_native(args))
    (args.output/'manifest.json').write_text(json.dumps(dict(kind='real PTY terminal-program capture; not shell-integration receipts',cases=names,uname=list(os.uname())),indent=2))
    print(args.output)


def capture_native(args):
    spec=importlib.util.spec_from_file_location('background_causality',Path(__file__).with_name('background-causality.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    options=SimpleNamespace(output=args.output.resolve(),shell=str(Path(args.shell).resolve()),ssh=False,locale='en_US.UTF-8')
    def checkpoint(name,**oracle):
        session.timeline.append(dict(checkpoint=name,oracle=oracle))
    def save_case(name,cols,rows):
        (session.directory/'scenario.json').write_text(json.dumps(dict(name=name,cols=cols,rows=rows,scrollback=100)))
        return session.directory.name
    native=[]
    for name,prefix in [('native-edit','native_中é👩‍💻_'),('native-edit-ascii','native_')]:
        session=module.PureSession(options,name)
        try:
            module.fixture_ready(session,1)
            source="printf '%s\\n' '"+prefix+"abcdefghij'"
            session.type(source.encode())
            draft='USER_PROMPT\nP0> '+source
            edited="USER_PROMPT\nP0> printf '%s\\n' '"+prefix+"abcdefQij'"
            check_false=name=='native-edit-ascii'
            def visual(text,cols):
                line=text.split('\n',1)[1]
                return ['USER_PROMPT',*[line[i:i+cols] for i in range(0,len(line),cols)]]
            session.drain(0.1);checkpoint('draft',copy=draft,checkFalse=check_false)
            session.resize(32,12);session.drain(0.1);checkpoint('narrow',copy=draft,checkFalse=check_false)
            session.type((ESC+'[D').encode()*4+b'\x7fQ'+(ESC+'[3~').encode())
            session.type(b'\x01\x05');session.drain(0.1)
            checkpoint('edited',copy=edited,checkFalse=check_false,**(dict(visualRows=visual(edited,32)) if check_false else {}))
            session.resize(100,24);session.drain(0.1);checkpoint('wide',copy=edited,checkFalse=check_false)
            session.type(b' > "$HOME/native-result"\n')
            module.fixture_ready(session,2)
            expected=prefix+'abcdefQij\n'
            actual=(session.home/'native-result').read_text()
            assert actual==expected,repr(actual)
            checkpoint('submitted')
            (session.directory/'native-result.json').write_text(json.dumps(dict(result='PASS',actual=actual,
                authority='actual Bash command result in private fixture HOME; not integration receipt')))
            native.append(save_case(name,100,24))
        finally:session.close()
    # A real installed editor, using a private file and no user config or save.
    directory=args.output/'vim-tui';directory.mkdir()
    fixture=directory/'fixture.txt';fixture.write_text('中é👩‍💻 terminal compatibility\nsecond line\nthird line\n')
    pid,fd=pty.fork()
    if pid==0:
        fcntl.ioctl(0,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
        os.execve('/usr/bin/vim',['vim','-Nu','NONE','-n','-i','NONE','-M',str(fixture.resolve())],
                  dict(PATH='/usr/bin:/bin',HOME=str(directory.resolve()),TERM='xterm-256color',LC_ALL='en_US.UTF-8'))
    frames=[dict(resize=[80,24])];raw=bytearray()
    def drain(seconds):
        until=time.monotonic()+seconds
        while time.monotonic()<until:
            if select.select([fd],[],[],0.01)[0]:
                try:data=os.read(fd,65536)
                except OSError:break
                if data:
                    raw.extend(data);frames.append(dict(bytes=base64.b64encode(data).decode()))
    try:
        drain(0.4)
        assert b'\x1b[?1049h' in raw,'Vim did not enter actual alternate screen'
        frames.append(dict(checkpoint='alternate',oracle=dict(buffer='alternate')))
        for cols,rows in [(32,10),(100,30),(40,12),(80,24)]:
            fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0))
            frames.append(dict(resize=[cols,rows]));drain(0.15)
            os.write(fd,b'j0l');drain(0.1)
            frames.append(dict(checkpoint=f'{cols}x{rows}',oracle=dict(buffer='alternate')))
        os.write(fd,b':q!\r');drain(0.2)
        _,status=os.waitpid(pid,0)
        assert os.WIFEXITED(status) and os.WEXITSTATUS(status)==0,status
        frames.append(dict(checkpoint='returned',oracle=dict(buffer='normal')))
    finally:
        os.close(fd)
    (directory/'pty.bin').write_bytes(raw)
    (directory/'timeline.json').write_text(json.dumps(frames,indent=2))
    (directory/'scenario.json').write_text(json.dumps(dict(name='vim-tui',cols=80,rows=24,scrollback=100)))
    return [*native,'vim-tui']


if __name__=='__main__': main()
