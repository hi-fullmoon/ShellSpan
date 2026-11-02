"""Real ordinary ZLE input with the native case's recorded input/resize cadence.

No adapter, Ctrl-L, source acceptance, fabricated private receipt or ANSI parser.
Only the prelude commands execute; the complete long source remains unsubmitted.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import shlex
import shutil
import signal
import termios
import threading
import time

import pexpect

parser = argparse.ArgumentParser()
parser.add_argument('native_evidence', type=Path)
parser.add_argument('reviewed_core_producer', type=Path)
parser.add_argument('directory', type=Path)
arguments = parser.parse_args()
native = arguments.native_evidence.resolve()
directory = arguments.directory.resolve()
directory.mkdir(parents=True, exist_ok=False)
home = directory / 'home'
home.mkdir()
shutil.copyfile(Path(__file__), directory / 'driver.py')
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
producer = json.loads(arguments.reviewed_core_producer.read_text())
assert producer['sealed'] and producer['unicode9Default'] and not producer['nativeAcceptance']
shell, core = Path(producer['shell']).resolve(), Path(producer['editor']).resolve()
assert shell == Path('/bin/zsh').resolve()
assert sha(shell) == producer['shellSha256']
assert sha(core) == producer['editorSha256']
for name, digest in producer['nativeSourceHashes'].items():
    assert sha(Path(producer['source']) / 'Src/Zle' / name) == digest
input_names = ['geometry.json', 'source-corpus.json', 'control-live.jsonl', 'baseline-prelude.json', 'theme-sources.json', 'result.json']
inputs = {name: sha(native / name) for name in input_names}
native_result = json.loads((native / 'result.json').read_text())
assert native_result['ok'] and native_result['coreSha256'] == producer['editorSha256']
geometry = json.loads((native / 'geometry.json').read_text())
prelude = json.loads((native / 'baseline-prelude.json').read_text())
corpus = json.loads((native / 'source-corpus.json').read_text())
source = geometry['source']
source_bytes = source.encode()
assert hashlib.sha256(source_bytes).hexdigest() == geometry['sourceSha256']
assert not any(value in source_bytes for value in (0, 9, 10, 13))
receipts = [json.loads(line) for line in (native / 'control-live.jsonl').read_text().splitlines()]
for name in ['.zshenv', '.zprofile', '.zshrc', '.zlogin']:
    inputs[f'home/{name}'] = sha(native / 'home' / name)
    shutil.copyfile(native / 'home' / name, home / name)
module_path = core.parents[1]
with (home / '.zshenv').open('a') as file:
    file.write(f'\nmodule_path=({shlex.quote(str(module_path))} $module_path)\nzmodload zsh/zle\n')
# Install the read-only observer in startup configuration, not as a command
# whose echo or clear-screen step would change the history being compared.
with (home / '.zshrc').open('a') as file:
    file.write('''
typeset -gi P3_BASELINE_TICK=0
p3_matched_checkpoint() {
 (( ++P3_BASELINE_TICK ))
 builtin print -rn -- "$BUFFER" > "$HOME/checkpoint-$P3_BASELINE_TICK.bin"
 builtin printf '{"seq":%d,"cursor":%d,"columns":%d,"rows":%d,"budget":%d}' "$P3_BASELINE_TICK" "$CURSOR" "$COLUMNS" "$LINES" "${ZLE_NATIVE_APPEND:-0}" > "$HOME/checkpoint-$P3_BASELINE_TICK.json"
}
zle -N p3_matched_checkpoint
bindkey '^Xg' p3_matched_checkpoint
''')
identity = pwd.getpwuid(os.getuid()).pw_name
environment = {'PATH': os.environ['PATH'], 'HOME': str(home), 'ZDOTDIR': str(home),
               'TERM': 'xterm-256color', 'LC_ALL': 'en_US.UTF-8', 'USER': identity, 'LOGNAME': identity}
child = pexpect.spawn(str(shell), ['-il'], cwd=home, env=environment,
                      dimensions=(geometry['rows'], geometry['columns']), encoding=None, timeout=8)
child.delaybeforesend = None
clock = time.monotonic_ns()
stop_reader = threading.Event()
lock = threading.Lock()
offset = 0
reader_errors = []
raw = (directory / 'raw.bin').open('xb', buffering=0)
live = (directory / 'raw-live.bin').open('xb', buffering=0)
events_file = (directory / 'pty-live-events.jsonl').open('x')

def elapsed_us():
    return (time.monotonic_ns() - clock) // 1000

def collect():
    global offset
    try:
        while not stop_reader.is_set():
            try:
                data = child.read_nonblocking(8192, timeout=0.05)
            except pexpect.TIMEOUT:
                continue
            except pexpect.EOF:
                break
            with lock:
                raw.write(data)
                live.write(data)
                offset += len(data)
                events_file.write(json.dumps({'elapsedMicros': elapsed_us(), 'offset': offset, 'bytes': len(data)}) + '\n')
                events_file.flush()
    except BaseException as error:
        if not stop_reader.is_set():
            reader_errors.append(repr(error))

reader = threading.Thread(target=collect, daemon=True)
reader.start()
tick = 0
resizes = []
append_events = []

def publish(name, value):
    pending = directory / (name + '.pending')
    pending.write_text(json.dumps(value, ensure_ascii=False))
    pending.replace(directory / name)

def checkpoint(expected):
    global tick
    deadline = time.monotonic() + 8
    while termios.tcgetattr(child.child_fd)[3] & termios.ICANON:
        assert time.monotonic() < deadline, 'The actual ordinary editor did not become active'
        time.sleep(0.005)
    tick += 1
    child.send(b'\x18g')
    path = home / f'checkpoint-{tick}.json'
    while True:
        try:
            state = json.loads(path.read_text())
            actual = (home / f'checkpoint-{tick}.bin').read_bytes()
            break
        except (FileNotFoundError, json.JSONDecodeError):
            assert time.monotonic() < deadline, 'The real read-only ZLE widget did not respond'
            time.sleep(0.005)
    assert state['seq'] == tick and state['budget'] == 0
    assert actual == expected, 'The actual ordinary BUFFER differs from the requested source'
    assert state['cursor'] == len(expected.decode()), 'The actual ordinary CURSOR differs from BUFFER end'
    return state

def progress(index):
    selected = [row for row in receipts if row['message'].get('requestId') == f'prepare-{index}'
                and row['message']['payload']['kind'] == 'inputProgress']
    assert selected, f'Actual native input cadence missing for operation {index}'
    return selected

def replay_input(value, index, with_resize=False):
    data = value.encode()
    assert not any(char in data for char in (0, 9, 10, 13))
    steps = progress(index)
    origin = steps[0]['elapsedMicros']
    actions = [(row['elapsedMicros'] - origin, 'append', row['message']['payload']['appliedUtf8Bytes']) for row in steps]
    if with_resize:
        actions += [(event['elapsedMicros'] - origin, 'resize', event['columns']) for event in geometry['resizeEvents']]
    actions.sort(key=lambda item: (item[0], item[1]))
    started = time.monotonic_ns()
    applied = 0
    for target, kind, amount in actions:
        remaining = target / 1_000_000 - (time.monotonic_ns() - started) / 1_000_000_000
        if remaining > 0:
            time.sleep(remaining)
        if kind == 'append':
            assert applied <= amount <= len(data)
            data[:amount].decode()  # The real cadence must not split a UTF-8 code point.
            child.send(data[applied:amount])
            applied = amount
            append_events.append({'index': index, 'elapsedMicros': elapsed_us(), 'appliedUtf8Bytes': applied,
                                  'nativeRelativeMicros': target, 'actualRelativeMicros': (time.monotonic_ns() - started) // 1000})
        else:
            with lock:
                child.setwinsize(geometry['rows'], amount)
                resizes.append({'offset': offset, 'columns': amount, 'elapsedMicros': elapsed_us()})
                publish('geometry-events.json', resizes)
    assert applied == len(data)
    return checkpoint(data)

result = {'scope': 'real ordinary ZLE, recorded native cadence, no adapter or Ctrl-L; only prelude executes',
          'scriptSha256': sha(Path(__file__)),
          'sourceExecuted': False, 'inputs': inputs, 'producer': str(arguments.reviewed_core_producer.resolve()),
          'shellPid': child.pid, 'shellSha256': sha(shell), 'coreSha256': sha(core), 'sourceSha256': geometry['sourceSha256']}
background_pid = None
try:
    checkpoint(b'')
    mapped = __import__('subprocess').check_output(['/usr/sbin/lsof', '-p', str(child.pid), '-Fn'])
    (directory / 'actual-mapped-files.txt').write_bytes(mapped)
    assert str(core).encode() in mapped, 'The reviewed Core was not actually mapped'
    for index, command in enumerate(prelude['ordinaryForegroundSources']):
        assert command == corpus[index]['source']
        replay_input(command, index)
        child.send(b'\r')
        time.sleep(0.025)
        checkpoint(b'')
    body = prelude['backgroundBody']
    assert prelude['nativeBackgroundSource'].endswith(body)
    background = f'({body}) & P3_MATCHED_JOB=$!; builtin print -r -- "$P3_MATCHED_JOB" > "$HOME/background.pid"'
    # Keep the actual prelude duration; its auxiliary PID file necessarily
    # belongs to this new HOME rather than writing into sealed native evidence.
    steps = progress(2)
    time.sleep((steps[-1]['elapsedMicros'] - steps[0]['elapsedMicros']) / 1_000_000)
    child.send(background.encode() + b'\r')
    time.sleep(0.025)
    checkpoint(b'')
    background_pid = int((home / 'background.pid').read_text())
    assert background_pid > 1 and os.getpgid(background_pid) == background_pid
    publish('geometry-live.json', {**geometry, 'kind': 'actual-ordinary-ZLE-recorded-cadence'})
    state = replay_input(source, 3, with_resize=True)
    result.update(ok=True, actualBufferVerified=True, actualCursor=state['cursor'], actualBudget=state['budget'],
                  resizeEvents=resizes, appendEvents=append_events, backgroundPid=background_pid,
                  backgroundDifference=prelude['ordinaryBackgroundDifference'], explicitCtrlL=False,
                  observerInstalledByCommand=False)
    publish('source-confirmed.json', {'sourceSha256': geometry['sourceSha256'], 'elapsedMicros': elapsed_us(), 'rawOffset': offset})
    time.sleep(0.25)
    child.send(b'\x03')
except BaseException as error:
    result.update(ok=False, error=repr(error))
    raise
finally:
    if background_pid:
        try:
            os.killpg(background_pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    stop_reader.set()
    child.close(force=True)
    reader.join(timeout=2)
    result['readerStopped'] = not reader.is_alive()
    result['readerErrors'] = reader_errors
    raw.close()
    live.close()
    events_file.close()
    cleanup_deadline = time.monotonic() + 3
    pending = [child.pid] + ([-background_pid] if background_pid else [])
    while pending and time.monotonic() < cleanup_deadline:
        remaining = []
        for target in pending:
            try:
                os.kill(target, 0)
                remaining.append(target)
            except ProcessLookupError:
                pass
        pending = remaining
        if pending:
            time.sleep(0.01)
    result['cleanupRemaining'] = pending
    assert sha(shell) == producer['shellSha256'] and sha(core) == producer['editorSha256']
    assert sha(Path(__file__)) == result['scriptSha256']
    assert all(sha(native / name) == digest for name, digest in inputs.items())
    publish('geometry.json', {**geometry, 'resizeEvents': resizes, 'kind': 'actual-ordinary-ZLE-recorded-cadence'})
    publish('result.json', result)
assert result['ok'] and result['readerStopped'] and not reader_errors and not pending
print(json.dumps({'directory': str(directory), 'actualBufferVerified': True, 'sourceExecuted': False}))
