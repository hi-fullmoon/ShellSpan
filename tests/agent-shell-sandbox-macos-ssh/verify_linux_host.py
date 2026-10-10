"""Run fixed real-profile native checks; the original application is untouched."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
BINARY = ROOT / 'src-tauri/target/debug/ShellSpan'


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def launch(directory, profile, mode):
    with (directory.parent / f'{directory.name}-{mode}-launcher.log').open('w') as log:
        child = subprocess.Popen([str(BINARY), '--native-host-check', str(directory), profile, mode],
                                 cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        code = child.wait()
    save(directory / f'{mode}-exit.json', {'exitCode': code})
    return code


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--profiles', nargs='+', required=True)
    args = parser.parse_args()
    if not 1 <= len(args.profiles) <= 2:
        parser.error('one or two explicitly selected profiles are required')
    output = args.output.resolve()
    if output.exists() or not output.is_relative_to(ROOT / '.phase4-acceptance'):
        parser.error('a new ignored output directory is required')
    output.mkdir(mode=0o700)
    source_files = [ROOT / f'src-tauri/src/agent_runtime/{name}' for name in
                    ['native_host_check.rs', 'remote_native_check.rs', 'native_remote_recovery_check.rs', 'remote_host.py', 'remote_host.rs',
                     'remote_seatbelt.py', 'remote_seatbelt.rs', 'remote_cleanup.rs',
                     'native/runtime.rs', 'native/remote_seatbelt_process.rs']]
    source_files.extend(ROOT / f'src-tauri/src/{name}' for name in
                        ['connection.rs', 'execution/ssh.rs', 'agent_runtime/native/direct_ownership.rs'])
    hashes = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
              for path in source_files}
    binary_hash = hashlib.sha256(BINARY.read_bytes()).hexdigest()
    report = {'stage3Allowed': False, 'historicalResources': 'unconfirmed and untouched',
              'scope': 'fixed native acceptance only; no models or user-session execution recovery',
              'sourceSha256': hashes, 'binarySha256': binary_hash, 'profiles': []}
    save(output / 'intent.json', report)
    for index, profile in enumerate(args.profiles):
        directory = output / f'target-{index + 1}-lifecycle'
        directory.mkdir(mode=0o700)
        code = launch(directory, profile, 'lifecycle')
        item = {'profile': profile, 'lifecycleExitCode': code, 'crashRecovery': 'not run'}
        report['profiles'].append(item)
        save(output / 'progress.json', report)
        if code != 0:
            continue
        crash = output / f'target-{index + 1}-crash'
        crash.mkdir(mode=0o700)
        with (crash.parent / f'{crash.name}-launcher.log').open('w') as log:
            child = subprocess.Popen([str(BINARY), '--native-host-check', str(crash), profile, 'crash'],
                                     cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 90
            checkpoint = crash / 'host-checkpoint.json'
            while not checkpoint.exists() and child.poll() is None and time.monotonic() < deadline:
                time.sleep(0.1)
            if checkpoint.exists():
                facts = json.loads(checkpoint.read_text())
                if facts['actualStarted'] and facts['ledger'] == {'debt': 1, 'custody': 1}:
                    # Only this still-owned Child is selected for interruption.
                    child.kill()
                    item['ownedChildWaitExitCode'] = child.wait()
                    item['crashRecoveryExitCode'] = launch(crash, profile, 'recover')
                    item['crashRecovery'] = 'completed' if item['crashRecoveryExitCode'] == 0 else 'unconfirmed'
                else:
                    item['crashRecovery'] = 'checkpoint incomplete; original owner retained'
            else:
                item['crashRecovery'] = 'started checkpoint unavailable'
                if child.poll() is None:
                    save(output / 'progress.json', report)
                    # Retain the actual owning Child instead of inventing a
                    # stored-PID cleanup or dropping ownership on timeout.
                    child.wait()
        save(output / 'progress.json', report)
    report['sourceUnchanged'] = all(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest
                                    for name, digest in hashes.items())
    report['binaryUnchanged'] = hashlib.sha256(BINARY.read_bytes()).hexdigest() == binary_hash
    report['passed'] = (report['sourceUnchanged'] and report['binaryUnchanged']
                        and all(item['lifecycleExitCode'] == 0 and item.get('crashRecoveryExitCode') == 0
                                for item in report['profiles']))
    save(output / 'report.json', report)
    print(json.dumps({'report': str(output / 'report.json'), 'passed': report['passed']}))


if __name__ == '__main__':
    main()
