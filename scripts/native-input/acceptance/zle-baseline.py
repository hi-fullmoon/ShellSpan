"""Explicit ordinary Zsh/ZLE baseline, private HOME, no adapter/source accept."""
import hashlib
import argparse
import io
import json
import os
from pathlib import Path
import shlex
import sys
import threading
import subprocess
import termios
import time
import uuid
import pexpect

parser=argparse.ArgumentParser()
parser.add_argument('evidence')
parser.add_argument('--print-eight-bit',action='store_true')
parser.add_argument('--combining-chars',action='store_true')
parser.add_argument('--shell',default='/bin/zsh')
parser.add_argument('--module-path')
parser.add_argument('--reviewed-core-producer')
parser.add_argument('--dynamic',action='store_true')
parser.add_argument('--columns',type=int,choices=[32,40,100,180])
arguments=parser.parse_args()
executable=Path(arguments.shell).resolve()
evidence=Path(arguments.evidence).resolve()
entry=json.loads((evidence/'geometry.json').read_text())
if arguments.columns:
    entry['columns']=arguments.columns
source=entry['source']
print_eight_bit=arguments.print_eight_bit
combining_chars=arguments.combining_chars
directory=evidence/'ordinary-zle-baseline'/str(uuid.uuid4())
directory.mkdir(parents=True)
home=directory/'home'
home.mkdir()
module_path=Path(arguments.module_path).resolve() if arguments.module_path else None
producer=None
if arguments.reviewed_core_producer:
    assert not module_path
    producer=json.loads(Path(arguments.reviewed_core_producer).resolve().read_text())
    assert producer['unicode9Default'] and not producer['nativeAcceptance'] and not producer['productionChanges']
    if producer.get('pinSha256'):
        recipe_root=Path(__file__).resolve().parents[3]
        pin_path=recipe_root/'scripts/dependency-builds/zsh/pin.json'
        pin=json.loads(pin_path.read_text())
        assert hashlib.sha256(pin_path.read_bytes()).hexdigest()==producer['pinSha256']
        patch=recipe_root/pin['patch']
        assert hashlib.sha256(patch.read_bytes()).hexdigest()==pin['patchSha256']==producer['patchSha256']
        assert producer['nativeSourceHashes']==pin['sourceHashes']
        result=json.loads((Path(producer['directory'])/'result.json').read_text())
        assert result['ok'] and not result['sourceOnly'] and result['inputs']['pinSha256']==producer['pinSha256']
    else:
        assert producer['sealed']
    assert executable==Path(producer['shell']).resolve()==Path('/bin/zsh').resolve()
    assert hashlib.sha256(executable.read_bytes()).hexdigest()==producer['shellSha256']
    assert hashlib.sha256(Path(producer['editor']).read_bytes()).hexdigest()==producer['editorSha256']
    for name,digest in producer['nativeSourceHashes'].items():
        assert hashlib.sha256((Path(producer['source'])/'Src/Zle'/name).read_bytes()).hexdigest()==digest
    module_path=Path(producer['editor']).resolve().parents[1]
module_status=directory/'actual-module-status'
if module_path:
    assert producer or executable!=Path('/bin/zsh').resolve(), 'A different system module requires its own ABI review before any experiment'
    assert (module_path/'zsh/zle.so').is_file()
    (home/'.zshenv').write_text(f'module_path=({shlex.quote(str(module_path))} $module_path)\nzmodload zsh/zle\nbuiltin print -r -- $? > {shlex.quote(str(module_status))}\n')
(home/'.zshrc').write_text("PROMPT='%F{blue}P3-NATIVE>%f '\nHISTFILE=$HOME/history\nHISTSIZE=100\nSAVEHIST=100\nsetopt interactivecomments\n"+('setopt print_eight_bit\n' if print_eight_bit else '')+('setopt combining_chars\n' if combining_chars else ''))
checkpoint=directory/'actual-buffer'
cursor=directory/'actual-cursor'
budget=directory/'actual-budget'
options=directory/'actual-options'
nonce=uuid.uuid4().hex
marker=f'\x1b]0;P3_BASELINE_{nonce}\x07'.encode()
setup=(f"__p3_baseline_checkpoint() {{ zle -R; builtin print -rn -- \"$BUFFER\" > {shlex.quote(str(checkpoint))}; "
       f"builtin print -rn -- \"$CURSOR $COLUMNS $LINES\" > {shlex.quote(str(cursor))}; builtin print -rn -- \"${{ZLE_NATIVE_APPEND:-0}}\" > {shlex.quote(str(budget))}; builtin printf '\\e]0;P3_BASELINE_{nonce}\\a'; }}; "
       "zle -N __p3_baseline_checkpoint; bindkey '^X^A' __p3_baseline_checkpoint; bindkey '^X^V' quoted-insert; "
       "bindkey -s '^Xn' '^X^V^J'; bindkey -s '^Xt' '^X^V^I'; bindkey -s '^Xr' '^X^V^M'; "
       f"builtin print -r -- \"$options[combiningchars] $options[printeightbit]\" > {shlex.quote(str(options))}; builtin printf '%s%s\\n' P3_BASELINE_READY_ {nonce}")
child=pexpect.spawn(str(executable),['-il'],cwd=home,env={**os.environ,'HOME':str(home),'ZDOTDIR':str(home),
    'TERM':'xterm-256color','LC_ALL':'en_US.UTF-8'},dimensions=(entry['rows'],entry['columns']),timeout=8,encoding=None)
startup_deadline=time.monotonic()+8
class Trace:
    def __init__(self):
        self.lock=threading.Lock()
        self.file=(directory/'raw.bin').open('xb',buffering=0)
        self.live=(directory/'raw-live.bin').open('xb',buffering=0)
        self.offset=0
    def write(self,data):
        with self.lock:
            self.file.write(data)
            self.live.write(data)
            self.offset+=len(data)
    def flush(self):
        self.file.flush()
        self.live.flush()
    def close(self):
        self.file.close()
        self.live.close()
trace=Trace()
child.logfile_read=trace
resize_events=[]
def publish(name,value):
    pending=directory/(name+'.pending')
    pending.write_text(json.dumps(value))
    pending.replace(directory/name)
def send_and_expect(payload,expected):
    errors=[]
    def send_all():
        try:
            offset=0
            while offset<len(payload):
                count=child.send(payload[offset:])
                if count<=0:
                    raise EOFError('Actual PTY input stopped before the owned payload ended')
                offset+=count
        except BaseException as error:
            errors.append(type(error).__name__)
    writer=threading.Thread(target=send_all,daemon=True)
    writer.start()
    child.expect_exact(expected)
    writer.join(timeout=1)
    assert not writer.is_alive() and not errors
phase='waiting-first-prompt'
try:
    child.expect_exact(b'P3-NATIVE>')
    if module_path:
        assert module_status.read_text().strip()=='0', 'The actual paired ZLE module did not load'
    if producer:
        mapped=subprocess.run(['/usr/sbin/lsof','-p',str(child.pid),'-Fn'],stdout=subprocess.PIPE,check=True).stdout
        (directory/'actual-mapped-files.txt').write_bytes(mapped)
        assert str(Path(producer['editor']).resolve()).encode() in mapped
    while termios.tcgetattr(child.child_fd)[3]&termios.ICANON:
        assert time.monotonic()<startup_deadline, 'The actual editor did not enter its native terminal mode'
        time.sleep(0.005)
    phase='installing-observer'
    send_and_expect(setup.encode()+b'\r',('P3_BASELINE_READY_'+nonce).encode())
    phase='unaccepted-source-input'
    keys={'\n':'\x18n','\t':'\x18t','\r':'\x18r'}
    if arguments.dynamic:
        prefix=source[:entry['columns']+40]
        assert prefix.isascii(), 'The before-resize checkpoint uses the same ASCII prefix as the native case'
        publish('geometry-live.json',{'source':source,'sourceSha256':hashlib.sha256(source.encode()).hexdigest(),
            'prefixBeforeFirstResize':prefix,'columns':entry['columns'],'rows':entry['rows']})
        send_and_expect(b'\x0c'+prefix.encode()+b'\x18\x01',marker)
        assert checkpoint.read_bytes()==prefix.encode()
        deadline=time.monotonic()+5
        while not (directory/'wrapped-ready.json').exists():
            assert time.monotonic()<deadline, 'Live public xterm did not observe an ordinary wrapped prefix'
            time.sleep(0.005)
        wrapped=json.loads((directory/'wrapped-ready.json').read_text())
        assert wrapped['sourceSha256']==hashlib.sha256(source.encode()).hexdigest() and wrapped['wrapped']
        errors=[]
        def continue_input():
            try:
                tail=source[len(prefix):]
                widths=[32,180,40,100,32,180,40]
                for offset in range(0,len(tail),24):
                    if offset//24<len(widths):
                        with trace.lock:
                            columns=widths[offset//24]
                            child.setwinsize(entry['rows'],columns)
                            resize_events.append({'offset':trace.offset,'columns':columns})
                            publish('geometry-events.json',resize_events)
                    child.send(''.join(keys.get(char,char) for char in tail[offset:offset+24]).encode())
                    time.sleep(0.02)
                child.send(b'\x18\x01')
            except BaseException as error:
                errors.append(type(error).__name__)
        writer=threading.Thread(target=continue_input,daemon=True)
        writer.start()
        child.expect_exact(marker)
        writer.join(timeout=1)
        assert not writer.is_alive() and not errors
    else:
        literal=b'\x0c'+''.join(keys.get(char,char) for char in source).encode()+b'\x18\x01'
        send_and_expect(literal,marker)
    child.logfile_read=None
    actual=checkpoint.read_bytes()
    assert actual==source.encode()
    actual_cursor,actual_columns,actual_rows=map(int,cursor.read_text().split())
    assert actual_cursor==len(source)
    final_columns=40 if arguments.dynamic else entry['columns']
    assert (actual_rows,actual_columns)==child.getwinsize()==(entry['rows'],final_columns)
    assert budget.read_bytes()==b'0', 'Ordinary editor unexpectedly entered the scoped display budget'
    actual_options=options.read_text().strip().split()
    assert len(actual_options)==2 and all(value in ('on','off') for value in actual_options)
    if producer:
        assert hashlib.sha256(Path(producer['editor']).read_bytes()).hexdigest()==producer['editorSha256']
    (directory/'result.json').write_text(json.dumps({'kind':'real-ordinary-ZLE-no-adapter-no-source-execution',
        'shell':str(executable),'modulePath':str(module_path) if module_path else None,'actualModuleLoaded':module_status.read_text().strip()=='0' if module_path else None,'shellSha256':hashlib.sha256(executable.read_bytes()).hexdigest(),'shellVersion':subprocess.check_output([str(executable),'-f','-c','print -rn -- $ZSH_VERSION'],text=True),'privateFixturePrintEightBit':print_eight_bit,'privateFixtureCombiningChars':combining_chars,'actualCombiningChars':actual_options[0],'actualPrintEightBit':actual_options[1],'columns':entry['columns'],'rows':entry['rows'],'sourceSha256':hashlib.sha256(source.encode()).hexdigest(),
        'actualBufferSha256':hashlib.sha256(actual).hexdigest(),'utf8Bytes':len(actual),'cursorUtf8Bytes':len(actual),'actualColumns':actual_columns,'actualRows':actual_rows,'kernelGeometry':child.getwinsize(),
        'scriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'ok':True,'dynamicGeometry':arguments.dynamic,
        'resizeEvents':resize_events,'sourceExecuted':False,'actualBudget':0,'scopedDefaultCoreProducer':producer},indent=2))
    print(json.dumps({'directory':str(directory),'actualBufferVerified':True,'sourceExecuted':False}))
except BaseException as error:
    (directory/'failure.json').write_text(json.dumps({'phase':phase,'type':type(error).__name__,'sourceExecuted':False}))
    (directory/'failure-process.txt').write_bytes(subprocess.run(['/bin/ps','-p',str(child.pid),'-o','pid,ppid,pgid,tpgid,stat,wchan,comm'],stdout=subprocess.PIPE,check=False).stdout)
    raise
finally:
    child.logfile_read=None
    child.close(force=True)
    trace.close()
