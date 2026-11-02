"""Build distributable NIP/1 modules against pinned, independently built Bash ABIs.

GNU source fetching/verification is shared with the P0 dependency builder. The
production module source and Cargo target are independent of the experiment.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.native-input-p2'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--versions', default='4.1,4.4,5.3')
    args = parser.parse_args()
    if platform.machine() not in ['arm64', 'aarch64']:
        raise RuntimeError('Unaccepted module architecture')
    host = platform.system().lower()
    if host == 'darwin':
        target = 'macos-arm64'
    elif host == 'linux' and platform.libc_ver() == ('glibc', '2.36'):
        target = 'linux-aarch64-glibc-2.36'
    else:
        raise RuntimeError('Unaccepted module OS/libc')
    OUT.mkdir(exist_ok=True)
    log = OUT / f'build-{host}.log'

    def run(command, env=None):
        with log.open('ab') as output:
            subprocess.run(list(map(str, command)), cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT, check=True)

    run(['python3', '-B', 'scripts/dependency-builds/bash-native/build.py', '--versions', args.versions])
    source = ROOT / 'src-tauri/native-input-adapter'
    inputs = [p for p in source.rglob('*') if p.is_file() and 'target' not in p.parts]
    inputs += [ROOT / 'src-tauri/src/terminal_command/protocol.rs', Path(__file__).resolve(),
        ROOT / 'scripts/native-input-p0/build.py', ROOT / 'scripts/native-input-p0/readline-sources.json',
        *[p for p in (ROOT/'scripts/dependency-builds/bash-native').iterdir() if p.is_file()]]
    sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    before = {str(p.relative_to(ROOT)): sha(p) for p in inputs}
    builds = json.loads((OUT / f'bash-{host}.json').read_text())
    catalogue = OUT / 'resources/native-input-v1'
    catalogue.mkdir(parents=True, exist_ok=True)
    profiles = []
    for version in args.versions.split(','):
        readline = {'4.1': '6.0', '4.4': '7.0', '5.3': '8.3.6'}[version]
        profile = f'gnu-bash-{version}-readline-{readline}-{target}-nip1-init1-capture1'
        rust = OUT / 'build' / profile
        run(['cargo', 'build', '--release', '--locked', '--manifest-path', source / 'Cargo.toml', '--target-dir', rust],
            {**os.environ, 'SHELLSPAN_NIP_VERIFIED_PROFILE': profile})
        shell = Path(builds[version]['shell'])
        if builds[version].get('readlineDisplayAbi') != 1:
            raise RuntimeError('Readline native display ABI missing')
        upstream=Path(builds[version]['source'])
        includes=list(map(Path,builds[version]['includes']))
        destination = catalogue / profile
        destination.mkdir(exist_ok=True)
        linker = ['-bundle', '-undefined', 'dynamic_lookup'] if host == 'darwin' else ['-shared', '-fPIC']
        module = destination / 'adapter.so'
        candidate = destination / 'adapter.candidate.so'
        run(['cc', *linker, '-O2', *[f'-I{p}' for p in includes], *[f'-I{p / "lib"}' for p in includes],
             source / 'bridge.c', rust / 'release/libshellspan_native_input_adapter.a', '-lpthread', '-ldl', '-lm', '-o', candidate])
        # The real target must expose the versioned native display API. Loading
        # the actual module verifies it without opening a PTY or accepting input.
        run([shell, '--noprofile', '--norc', '-c', 'enable -f "$1" ss_native_input_v1 ss_native_input_v1_display_abi && builtin ss_native_input_v1_display_abi', 'native-display-abi-check', candidate],
            {'PATH': os.defpath, 'HOME': str(OUT), 'LC_ALL': 'en_US.UTF-8'})
        os.replace(candidate, module)
        module.chmod(0o500)
        relay=destination/'native-input-relay'
        relay_candidate=destination/'relay.candidate'
        shutil.copy2(rust/'release/native-input-relay',relay_candidate)
        os.replace(relay_candidate,relay)
        relay.chmod(0o500)
        shell_candidate=destination/'bash.candidate'
        shutil.copy2(shell,shell_candidate)
        os.replace(shell_candidate,destination/'bash')
        (destination/'bash').chmod(0o500)
        proof = OUT / 'producers' / profile
        proof.mkdir(parents=True, exist_ok=True)
        (proof / 'manifest.json').write_text(json.dumps({'profile': profile, 'shell': str(shell), 'bridge': str(module),
            'artifacts': {str(p): sha(p) for p in [shell, module]}, 'sources': before}, indent=2))
        profiles.append({'id': profile, 'target': target, 'bashVersion': version, 'readlineVersion': readline,
                         'shellSha256': sha(shell), 'moduleSha256': sha(module), 'module': f'{profile}/adapter.so',
                         'buildShell': str(shell), 'captureFence': 1,
                         'readlineDisplayAbi': 1,
                         'relay': f'{profile}/native-input-relay', 'relaySha256':sha(relay)})
    if before != {str(p.relative_to(ROOT)): sha(p) for p in inputs}:
        raise RuntimeError('Producer sources changed during build')
    (catalogue / f'catalogue-{target}.json').write_text(json.dumps({'version': 1, 'profiles': profiles, 'sources': before}, indent=2))
    # Source archives, exact GNU patches and license notices accompany modules.
    notices = catalogue / 'sources'
    notices.mkdir(exist_ok=True)
    for path in (ROOT / '.native-input-p0/upstream').iterdir():
        if path.is_file() and (path.name.endswith('.tar.gz') or path.name.startswith('readline83-')):
            shutil.copy2(path, notices / path.name)
    for name in ['COPYING', 'AUTHORS']:
        shutil.copy2(upstream / name, notices / f'bash-{name}')
    for path in (ROOT / 'scripts/dependency-builds/bash-native').iterdir():
        if path.is_file() and path.suffix == '.patch':
            shutil.copy2(path, notices / path.name)
    shutil.copy2(ROOT / 'scripts/native-input-p0/readline-sources.json', notices / 'readline-sources.json')
    (catalogue / 'README.txt').write_text('GNU Bash/Readline: GPL-3.0-or-later. Exact source archives, official GNU patches, post-profile integration and native prompt-column patches are in sources/.\nReadline native display ABI: 1; explicit matching targets only; never replaces an already-bound Shell.\nShellSpan adapter source: src-tauri/native-input-adapter; rebuild: python3 scripts/native-input-p2/build.py\n')
    print(f'NIP/1 production modules: {catalogue}')


if __name__ == '__main__':
    main()
