"""Real ordinary Linux PTYs, stock/scoped-default Core. No NIP or model."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

import pexpect

owner=Path(__file__).resolve().parents[3]
fixture=json.loads(Path(sys.argv[1]).read_text())
container=fixture['container']
assert container=='shellspan-nip-p3-'+fixture['id']
assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "shellspan.native-input-p3"}}',container],text=True).strip()==fixture['id']
root=Path(fixture['root'])
producer=json.loads((root/'artifacts/tests/native-input/acceptance/scoped-linux-producer.json').read_text())
directory=owner/'artifacts/tests/native-input/acceptance/scoped-linux-baseline'/str(uuid.uuid4())
directory.mkdir(parents=True)
resource_root=root/'artifacts/tests/native-input/integration/resources/native-input'
catalogue=json.loads((resource_root/'editors-linux-aarch64-glibc-2.36.json').read_text())
core=resource_root/catalogue['profiles'][0].get('core','scoped-core/linux-aarch64-glibc-2.36/zsh/zle.so')
assert hashlib.sha256(core.read_bytes()).hexdigest()==producer['coreSha256']
source="typeset P3_ORDINARY='父Shell-é-👩🏽‍💻'; printf '%s%s\\n' P3-ORDINARY- EXECUTED"
draft="printf '%s' '普通编辑-父Shell-é-👩🏽‍💻'"
results=[]
for scoped in [False,True]:
    home=directory/('scoped-default' if scoped else 'stock')
    home.mkdir()
    remote='/tmp/p3-ordinary-'+uuid.uuid4().hex
    nonce=uuid.uuid4().hex
    marker=('\x1b]0;P3_BASELINE_'+nonce+'\x07').encode()
    rc="PROMPT='P3-BASE> '\nHISTFILE=$HOME/history\nHISTSIZE=100\nSAVEHIST=100\n"
    rc+="p3_checkpoint() { builtin print -rn -- \"$BUFFER\" > $HOME/buffer; builtin printf '{\"cursor\":%d,\"columns\":%d,\"rows\":%d,\"budget\":%d}\\n' \"$CURSOR\" \"$COLUMNS\" \"$LINES\" \"${ZLE_NATIVE_APPEND:-0}\" > $HOME/observed.json; builtin printf '\\e]0;P3_BASELINE_"+nonce+"\\a'; }\nzle -N p3_checkpoint\nbindkey '^Xg' p3_checkpoint\n"
    (home/'.zshrc').write_text(rc)
    if scoped:
        (home/'.zshenv').write_text("local -a prior=(\"${module_path[@]}\")\nif builtin zmodload -e zsh/zle; then builtin zmodload -u zsh/zle || return 1; fi\nmodule_path=(\"$HOME/modules\" \"${prior[@]}\")\nbuiltin zmodload zsh/zle || return 1\nmodule_path=(\"${prior[@]}\")\nunset prior\n")
    subprocess.run(['docker','exec',container,'mkdir','-p',remote+'/modules/zsh'],check=True)
    subprocess.run(['docker','cp',str(home)+'/.',container+':'+remote],check=True,stdout=subprocess.DEVNULL)
    if scoped:
        subprocess.run(['docker','cp',str(core),container+':'+remote+'/modules/zsh/zle.so'],check=True,stdout=subprocess.DEVNULL)
    subprocess.run(['docker','exec',container,'chown','-R','nativeZle:nativeZle',remote],check=True)
    subprocess.run(['docker','exec',container,'chmod','700',remote],check=True)
    child=pexpect.spawn('docker',['exec','-it','-u','nativeZle','-w',remote,'-e','HOME='+remote,'-e','ZDOTDIR='+remote,'-e','TERM=xterm-256color','-e','LC_ALL=en_US.UTF-8',container,'/bin/zsh','-il'],dimensions=(30,100),timeout=8,encoding=None)
    child.delaybeforesend=0
    trace=(home/'raw.bin').open('xb',buffering=0)
    child.logfile_read=trace
    result={'scopedDefault':scoped,'ok':False,'nativeAcceptance':False}
    def read(name):
        return subprocess.check_output(['docker','exec',container,'cat',remote+'/'+name])
    try:
        child.expect_exact(b'P3-BASE> ')
        child.expect_exact(b'\x1b[?2004h')
        child.send(source.encode()+b'\r')
        child.expect_exact(b'P3-ORDINARY-EXECUTED')
        child.expect_exact(b'\x1b[?2004h')
        child.send(b'false\r')
        child.expect_exact(b'\x1b[?2004h')
        child.send(b"[[ $? == 1 ]] && printf '%s%s\\n' P3-STATUS- ONE\r")
        child.expect_exact(b'P3-STATUS-ONE')
        child.expect_exact(b'\x1b[?2004h')
        child.send(draft.encode()+b'\x18g')
        child.expect_exact(marker)
        assert read('buffer')==draft.encode()
        observed=json.loads(read('observed.json'))
        assert observed=={'cursor':len(draft),'columns':100,'rows':30,'budget':0}
        child.sendcontrol('c')
        child.expect_exact(b'\x1b[?2004h')
        child.send(b'\x18g')
        child.expect_exact(marker)
        assert read('buffer')==b''
        after=json.loads(read('observed.json'))
        assert after['budget']==0 and after['cursor']==0
        child.send(b"[[ $P3_ORDINARY == '"+'父Shell-é-👩🏽‍💻'.encode()+b"' ]] && printf '%s%s\\n' P3-USER- RESTORED\r")
        child.expect_exact(b'P3-USER-RESTORED')
        child.expect_exact(b'\x1b[?2004h')
        child.send(b'exit\r')
        child.expect(pexpect.EOF)
        result.update(ok=True,observed=observed,afterCtrlC=after,sourceExecuted=True,draftExecuted=False,globalUnicodeRetained=True,previousStatusOne=True)
    except BaseException as error:
        result['failureType']=type(error).__name__
        raise
    finally:
        child.logfile_read=None
        child.close(force=True)
        trace.close()
        result['remoteOwnedDirectory']=remote
        (home/'result.json').write_text(json.dumps(result,indent=2))
        results.append(result)
        (directory/'result.json').write_text(json.dumps({'kind':'real-ordinary-Linux-stock-and-scoped-default-control','producer':producer,'results':results,'noNipOrModelProof':True},indent=2))
assert len(results)==2 and all(value['ok'] for value in results)
assert hashlib.sha256(core.read_bytes()).hexdigest()==producer['coreSha256']
print(json.dumps({'directory':str(directory),'cases':len(results),'ok':True}))
