"""Rebuild the NIP producer from pinned GNU inputs and reviewed source patches."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'artifacts/tests/native-input-p0/p1-protocol-build'

def main():
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise RuntimeError('This native producer acceptance is frozen to macOS arm64')
    OUT.mkdir(parents=True, exist_ok=True)
    sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    sources = [ROOT / name for name in ['scripts/native-input-p0/src/lib.rs', 'scripts/native-input-p0/src/native_protocol.rs',
        'scripts/native-input-p0/bridge.c', 'scripts/native-input-p0/inband-display.patch', 'scripts/native-input-p1/display.patch',
        'scripts/native-input-p0/Cargo.toml', 'scripts/native-input-p0/Cargo.lock', 'scripts/native-input-p1/build.py',
        'src-tauri/src/terminal_command/protocol.rs']]
    before = {str(p.relative_to(ROOT)): sha(p) for p in sources}
    log = OUT / 'build.log'
    def run(arguments, cwd=ROOT, env=None):
        with log.open('ab') as output:
            subprocess.run(list(map(str, arguments)), cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT, check=True)
    # The P0 builder owns pinned GNU archive/Readline patch verification. It is
    # invoked from source; no timestamped capture/build directory is required.
    run(['python3', 'scripts/native-input-p0/build.py', '--upstream', '--versions', '5.3'],
        env={**os.environ, 'SHELLSPAN_NATIVE_BUILD_ROOT': 'artifacts/tests'})
    profile='gnu-bash-5.3-readline-8.3.6-macos-arm64-prototype'
    run(['cargo', 'build', '--locked', '--manifest-path', 'scripts/native-input-p0/Cargo.toml', '--target-dir', OUT / 'rust'],env={**os.environ,'SHELLSPAN_NIP_VERIFIED_PROFILE':profile})
    source = OUT / 'bridge.c'
    shutil.copy2(ROOT / 'scripts/native-input-p0/bridge.c', source)
    for patch in ['scripts/native-input-p0/inband-display.patch', 'scripts/native-input-p1/display.patch']:
        run(['patch', '--batch', '-p1', '-i', ROOT / patch], OUT)
    build = ROOT / 'artifacts/tests/native-input-p0/build-darwin'
    upstream = ROOT / 'artifacts/tests/native-input-p0/upstream/bash-5.3'
    includes = [build / 'readline-8.3.6/install/include', build / 'bash-5.3-readline-8.3.6', upstream, upstream / 'include']
    library = OUT / 'rust/debug/libshellspan_native_input_p0.a'
    run(['cc', '-bundle', '-undefined', 'dynamic_lookup', *[f'-I{p}' for p in includes], *[f'-I{p / "lib"}' for p in includes],
         '-I/opt/homebrew/opt/readline/include', source, library, '-lpthread', '-ldl', '-lm', '-o', OUT / 'bridge.so'])
    shell = build / 'bash-5.3-readline-8.3.6/bash'
    after = {str(p.relative_to(ROOT)): sha(p) for p in sources}
    if before != after:
        raise RuntimeError('Native producer inputs changed during the build')
    (OUT / 'manifest.json').write_text(json.dumps({'profile':profile,'shell': str(shell), 'bridge': str(OUT / 'bridge.so'),
        'artifacts': {str(p): sha(p) for p in [shell, source, library, OUT / 'bridge.so']},
        'sources': before}, indent=2))
    print(f'NIP native producer built: {OUT}')

if __name__ == '__main__':
    main()
