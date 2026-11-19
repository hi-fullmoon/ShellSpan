"""Actual ordinary Zsh baseline for its empty-command PTY capture interval."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shlex
import uuid
import pexpect

parser=argparse.ArgumentParser()
parser.add_argument('directory')
parser.add_argument('columns',type=int)
parser.add_argument('rows',type=int)
arguments=parser.parse_args()
assert 16<=arguments.columns<=500 and 5<=arguments.rows<=200
directory=Path(arguments.directory).resolve()
directory.mkdir(parents=True,exist_ok=False)
home=directory/'home'
home.mkdir()
(home/'.zshrc').write_text("PROMPT='%F{cyan}P3 %n@%m %~%f %# '\nHISTFILE=$HOME/history\nHISTSIZE=1000\nSAVEHIST=1000\nsetopt interactivecomments\n")
nonce=uuid.uuid4().hex
start=f'\x1b]0;P3_REF_START_{nonce}\x07'.encode()
end=f'\x1b]0;P3_REF_END_{nonce}\x07'.encode()
status=directory/'status.txt'
options=directory/'options.txt'
setup=("typeset P3_REFERENCE_ACTIVE=0; "
       f"__p3_reference_preexec() {{ P3_REFERENCE_ACTIVE=1; builtin printf '\\e]0;P3_REF_START_{nonce}\\a'; }}; "
       f"__p3_reference_precmd() {{ local code=$?; if (( P3_REFERENCE_ACTIVE )); then builtin print -rn -- \"$code\" > {shlex.quote(str(status))}; builtin printf '\\e]0;P3_REF_END_{nonce}\\a'; fi; return $code; }}; "
       "preexec_functions+=(__p3_reference_preexec); precmd_functions+=(__p3_reference_precmd); "
       f"builtin print -r -- \"$options[promptsp] $options[promptcr]\" > {shlex.quote(str(options))}; builtin printf '%s%s\\n' P3_REF_READY_ {nonce}")
child=pexpect.spawn('/bin/zsh',['-il'],cwd=home,env={**os.environ,'HOME':str(home),'ZDOTDIR':str(home),'TERM':'xterm-256color','LC_ALL':'en_US.UTF-8'},dimensions=(arguments.rows,arguments.columns),timeout=8,encoding=None)
raw=io.BytesIO()
child.logfile_read=raw
try:
 child.expect_exact(b'P3 ')
 child.send(setup.encode()+b'\r')
 child.expect_exact(('P3_REF_READY_'+nonce).encode())
 child.send(b'(exit 7)\r')
 child.expect_exact(end)
 data=raw.getvalue()
 assert data.count(start)==1 and data.count(end)==1
 captured=data[data.index(start)+len(start):data.index(end)]
 assert status.read_text()=='7' and options.read_text().strip()=='on on'
 assert b'(exit 7)' not in captured
 (directory/'raw.bin').write_bytes(data)
 (directory/'captured.bin').write_bytes(captured)
 (directory/'result.json').write_text(json.dumps({'kind':'actual-ordinary-zsh-empty-command-capture','columns':arguments.columns,'rows':arguments.rows,'command':'(exit 7)','exitCode':7,'promptSp':True,'promptCr':True,'capturedSha256':hashlib.sha256(captured).hexdigest(),'scriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},indent=2))
finally:
 child.logfile_read=None
 child.close(force=True)
