"""Real isolated native windows; uses the shared production exit handler."""
import json
import os
import signal
import shutil
from pathlib import Path
import subprocess
import tempfile
import time
import sys

binary = Path(sys.argv[1]).resolve()
results = []
for mode in ['quit', 'restart', 'quit-active', 'restart-active', 'quit-debt']:
    directory = tempfile.mkdtemp(prefix=f'shellspan-gui-{mode}-', dir='/tmp')
    settled = False
    try:
        root = Path(directory).resolve()
        with (root.parent / f'{root.name}.log').open('w') as log:
            process = subprocess.Popen([str(binary), '--gui-lifecycle-check', str(root), mode], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            settled = False
            try:
                process.wait(timeout=20)
                deadline = time.monotonic() + 20
                while True:
                    events = json.loads((root / 'gui-events.json').read_text())
                    started = [event['pid'] for event in events if event['event'] == 'started']
                    exited = [event['pid'] for event in events if event['event'] == 'exit']
                    if len(started) == (2 if mode.startswith('restart') else 1) and set(started) <= set(exited):
                        break
                    if time.monotonic() >= deadline:
                        raise RuntimeError(f'GUI {mode} did not settle: {events}')
                    time.sleep(.05)
                if mode.startswith('restart') and len(set(started)) != 2:
                    raise RuntimeError('Restart did not create a new native process')
                if process.returncode != 0:
                    raise RuntimeError(f'GUI {mode} exited unsuccessfully: {process.returncode}')
                result = {'mode': mode, 'startedPids': started, 'exitPids': exited, 'eventCount': len(events)}
                if '-' in mode:
                    status = subprocess.run([str(binary), '--gui-lifecycle-check', str(root), 'status'], check=True, capture_output=True, text=True, timeout=10)
                    pending = json.loads(status.stdout)['pending']
                    if pending != (1 if mode == 'quit-debt' else 0):
                        raise RuntimeError(f'GUI cleanup state mismatch: {pending}')
                    resource = json.loads((root / 'resource.json').read_text())
                    if 'containerId' in resource:
                        listed = subprocess.run(['docker', 'container', 'ls', '--all', '--no-trunc', '--filter', f'id={resource["containerId"]}', '--format', '{{.ID}}'], check=True, capture_output=True, text=True, timeout=10)
                        if listed.stdout.strip():
                            raise RuntimeError('Owned GUI resource was not removed')
                    result['pending'] = pending
                    if pending:
                        result['retainedFixtureRoot'] = str(root)
                results.append(result)
                settled = True
                print(json.dumps(result))
            finally:
                if not settled:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    if process.poll() is None:
                        process.wait(timeout=5)
    finally:
        if mode != 'quit-debt' and settled:
            shutil.rmtree(directory)
if len(sys.argv) > 2:
    Path(sys.argv[2]).write_text(json.dumps(results, indent=2) + '\n')
