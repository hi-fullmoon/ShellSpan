"""Display-only native user edit, with no loadable bridge or execution.

The known fixture prompt synchronizes a screenshot capture only; it never
authorizes an Agent command or supplies execution/completion evidence.
"""
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import tempfile
import termios
import time

ROOT=Path(__file__).resolve().parents[2]
output=ROOT/'.native-input-p0/pure-baseline'
output.mkdir(exist_ok=True)
source="printf '%s\\n' '"+'中文 é 👩‍💻 width '*6+"'"
for columns in [32,40,100,180]:
    directory=Path(tempfile.mkdtemp(prefix=f'geometry-{columns}-user-',dir=output))
    (directory/'.inputrc').write_text('set editing-mode emacs\nset bell-style none\n')
    (directory/'rc').write_text("PS1='\\[\\e[36m\\]P0> \\[\\e[0m\\]'\nPROMPT_COMMAND='printf \"USER_PROMPT\\n\"'\n")
    start=time.monotonic()
    pid,fd=pty.fork()
    if pid==0:
        os.execve('/opt/homebrew/bin/bash',['bash','--noprofile','--rcfile',str(directory/'rc'),'-i'],
                  dict(PATH='/usr/bin:/bin',HOME=str(directory),TERM='xterm-256color',LC_ALL='en_US.UTF-8'))
    fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',24,columns,0,0))
    frames=[{'resize':[columns,24]}]
    raw=bytearray()
    def drain(seconds):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            if select.select([fd],[],[],0.02)[0]:
                try: data=os.read(fd,65536)
                except OSError: break
                if not data: break
                raw.extend(data)
                frames.append({'at_ms':int((time.monotonic()-start)*1000),'bytes':base64.b64encode(data).decode()})
    try:
        drain(0.3)
        for start_char in range(0,len(source),16):
            os.write(fd,source[start_char:start_char+16].encode())
            drain(0.02)
        drain(0.3)
        frames.append({'checkpoint':'geometry'})
        (directory/'pty.bin').write_bytes(raw)
        (directory/'timeline.json').write_text(json.dumps(frames,indent=2))
        (directory/'geometry.json').write_text(json.dumps(dict(source=source,columns=columns,mode='user')))
    finally:
        os.kill(pid,signal.SIGKILL)
        os.close(fd)
        os.waitpid(pid,0)
print(output)
