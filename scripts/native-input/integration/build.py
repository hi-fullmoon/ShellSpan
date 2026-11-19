"""Build distributable NIP modules against pinned, independently built Bash ABIs.

GNU source fetching/verification is shared with the P0 dependency builder. The
production module source and Cargo target are independent of the experiment.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'scripts/native-input'))
from build_paths import BUILD_ROOT, build_directory, is_test_build

OUT = build_directory(BUILD_ROOT, 'integration')
READLINE_VERSIONS = {'4.1': '6.0', '4.4': '7.0', '5.3': '8.3.6'}
X86_GLIBC_MINIMUM = (2, 28)
X86_GLIBC_VERSION = '.'.join(map(str, X86_GLIBC_MINIMUM))
X86_TARGET = f'linux-x86_64-glibc-{X86_GLIBC_VERSION}'


def verify_glibc_needs(path):
    output = subprocess.check_output(['readelf', '--version-info', '--wide', path],
                                     text=True, env={**os.environ, 'LC_ALL': 'C'})
    required = set(re.findall(r'Name:\s+(GLIBC_\S+)', output))
    if not required:
        raise RuntimeError(f'{path}: expected versioned glibc imports')
    for name in sorted(required):
        match = re.fullmatch(r'GLIBC_(\d+)\.(\d+)(?:\.(\d+))?', name)
        if not match or tuple(map(int, match.groups(default='0'))) > (*X86_GLIBC_MINIMUM, 0):
            raise RuntimeError(f'{path}: {name} exceeds the glibc {X86_GLIBC_VERSION} baseline')


def macos_rust_environment(manifest):
    metadata = json.loads(subprocess.check_output(
        ['cargo', 'metadata', '--locked', '--format-version', '1',
         '--filter-platform', 'aarch64-apple-darwin', '--manifest-path', str(manifest)],
        cwd=ROOT,
    ))
    registry_roots = sorted({
        Path(package['manifest_path']).parent.parent
        for package in metadata['packages']
        if (package.get('source') or '').startswith('registry+')
    })
    sysroot = subprocess.check_output(
        [os.environ.get('RUSTC', 'rustc'), '--print', 'sysroot'], cwd=ROOT, text=True,
    ).strip()
    inherited = os.environ.get('CARGO_ENCODED_RUSTFLAGS')
    if inherited is None:
        inherited = '\x1f'.join(os.environ.get('RUSTFLAGS', '').split())
    # A versioned vendor tree can be inside ROOT. Its more specific mapping
    # must come last to match the crate path used with the Cargo registry.
    remaps = [
        f'--remap-path-prefix={ROOT}=/shellspan/source',
        f'--remap-path-prefix={sysroot}=/shellspan/rust',
        *(f'--remap-path-prefix={path}=/shellspan/crates' for path in registry_roots),
    ]
    return {**os.environ, 'CARGO_ENCODED_RUSTFLAGS': '\x1f'.join(filter(None, [inherited, *remaps]))}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--versions', default='5.3', help='comma-separated Bash versions (default: 5.3)')
    args = parser.parse_args()
    versions = args.versions.split(',')
    if len(set(versions)) != len(versions) or any(version not in READLINE_VERSIONS for version in versions):
        parser.error('--versions requires distinct supported Bash versions: 4.1, 4.4, 5.3')
    host = platform.system().lower()
    machine = platform.machine()
    if host == 'darwin' and machine in ('arm64', 'aarch64'):
        target = 'macos-arm64'
    elif host == 'linux':
        glibc = os.confstr('CS_GNU_LIBC_VERSION')
        if machine in ('arm64', 'aarch64') and glibc == 'glibc 2.36':
            target = 'linux-aarch64-glibc-2.36'
        elif machine == 'x86_64' and glibc == f'glibc {X86_GLIBC_VERSION}':
            if versions != ['5.3']:
                parser.error('Linux x86_64 supports only Bash 5.3 / Readline 8.3.6')
            target = X86_TARGET
        else:
            raise RuntimeError(f'Unaccepted Linux module build host: {machine}, {glibc}')
    else:
        raise RuntimeError('Unaccepted module OS/architecture/libc')
    # Keep both Linux dependency builds, including the P0 build cache, isolated
    # when the ARM64 and x86_64 producers mount the same checkout.
    x86_linux = target == X86_TARGET
    dependency_root = BUILD_ROOT
    if x86_linux:
        dependency_root = OUT / 'dependency-cache' / target if is_test_build(BUILD_ROOT) else BUILD_ROOT / target
    OUT.mkdir(parents=True, exist_ok=True)
    log = OUT / f'build-{target if x86_linux else host}.log'

    def run(command, env=None):
        with log.open('ab') as output:
            subprocess.run(list(map(str, command)), cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT, check=True)

    input_manifest = json.loads(Path(__file__).with_name('bash-build-inputs.json').read_text())
    inputs = [ROOT / p for p in [*input_manifest['adapter'], *input_manifest['common'],
                                *input_manifest['targets'].get(target, [])]]
    sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    before = {p.relative_to(ROOT).as_posix(): sha(p) for p in inputs}

    run(['python3', '-B', 'scripts/dependency-builds/bash-native/build.py', '--versions', args.versions],
        {**os.environ, 'SHELLSPAN_NATIVE_BUILD_ROOT': str(dependency_root)})
    source = ROOT / 'src-tauri/native-input-adapter'
    manifest = source / 'Cargo.toml'
    rust_environment = macos_rust_environment(manifest) if host == 'darwin' else os.environ
    builds = json.loads((build_directory(dependency_root, 'integration') / f'bash-{host}.json').read_text())
    catalogue = OUT / 'resources/native-input'
    catalogue.mkdir(parents=True, exist_ok=True)
    profiles = []
    for version in versions:
        readline = READLINE_VERSIONS[version]
        profile = f'gnu-bash-{version}-readline-{readline}-{target}-native'
        rust = OUT / 'build' / profile
        run(['cargo', 'build', '--release', '--locked', '--manifest-path', manifest, '--target-dir', rust],
            {**rust_environment, 'SHELLSPAN_NIP_VERIFIED_PROFILE': profile})
        shell = Path(builds[version]['shell'])
        if builds[version].get('readlineDisplayAbi') != 1:
            raise RuntimeError('Readline native display ABI missing')
        upstream=Path(builds[version]['source'])
        includes=list(map(Path,builds[version]['includes']))
        destination = catalogue / profile
        destination.mkdir(exist_ok=True)
        # Darwin's debug map otherwise embeds the absolute Rust archive path.
        linker = ['-bundle', '-undefined', 'dynamic_lookup', '-Wl,-S'] if host == 'darwin' else ['-shared', '-fPIC']
        if x86_linux:
            # The SSH worker uploads and reads back this module before opening
            # the terminal. Keep only the code and symbols needed at runtime.
            linker += ['-Wl,--strip-debug,--exclude-libs,ALL,--gc-sections']
        module = destination / 'adapter.so'
        candidate = destination / 'adapter.candidate.so'
        runtime_defines = [f'-DSHELLSPAN_MIN_GLIBC="{X86_GLIBC_VERSION}"'] if x86_linux else []
        run(['cc', *linker, *runtime_defines, '-O2', *[f'-I{p}' for p in includes], *[f'-I{p / "lib"}' for p in includes],
             source / 'bridge.c', rust / 'release/libshellspan_native_input_adapter.a', '-lpthread', '-ldl', '-lm', '-o', candidate])
        if x86_linux:
            for artifact in (shell, candidate, rust / 'release/native-input-relay'):
                verify_glibc_needs(artifact)
        # The real target must expose the versioned native display API. Loading
        # the actual module verifies it without opening a PTY or accepting input.
        run([shell, '--noprofile', '--norc', '-c', 'enable -f "$1" ss_native_input ss_native_input_display_abi && builtin ss_native_input_display_abi', 'native-display-abi-check', candidate],
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
                         **({'bashPatchLevel': builds[version]['bashPatchLevel']} if 'bashPatchLevel' in builds[version] else {}),
                         'shellSha256': sha(shell), 'moduleSha256': sha(module), 'module': f'{profile}/adapter.so',
                         'buildShell': str(shell), 'captureFence': 1,
                         'readlineDisplayAbi': 1,
                         'relay': f'{profile}/native-input-relay', 'relaySha256':sha(relay)})
    if before != {p.relative_to(ROOT).as_posix(): sha(p) for p in inputs}:
        raise RuntimeError('Producer sources changed during build')
    (catalogue / f'catalogue-{target}.json').write_text(json.dumps({'version': 1, 'profiles': profiles, 'sources': before}, indent=2))
    # Source archives, exact GNU patches and license notices accompany modules.
    notices = catalogue / 'sources'
    notices.mkdir(exist_ok=True)
    if x86_linux:
        shutil.copy2('/opt/shellspan/share/ncurses-COPYRIGHT', notices / 'ncurses-COPYRIGHT')
    archives = [f'bash-{version}.tar.gz' for version in versions]
    if '5.3' in versions:
        pin = json.loads((ROOT / 'scripts/native-input/prototype/readline-sources.json').read_text())
        archives.extend(['readline-8.3.tar.gz', *(f'readline83-{n:03d}' for n in range(1, len(pin['patches']) + 1))])
        archives.extend(builds['5.3'].get('gnuBashPatches', {}))
    for name in archives:
        shutil.copy2(build_directory(dependency_root, 'prototype') / 'upstream' / name, notices / name)
    for name in ['COPYING', 'AUTHORS']:
        shutil.copy2(upstream / name, notices / f'bash-{name}')
    for path in inputs:
        if path.parent == ROOT / 'scripts/dependency-builds/bash-native' and path.suffix in ['.patch', '.h']:
            shutil.copy2(path, notices / path.name)
    shutil.copy2(ROOT / 'scripts/native-input/prototype/readline-sources.json', notices / 'readline-sources.json')
    (catalogue / 'README.txt').write_text('GNU Bash/Readline: GPL-3.0-or-later. Exact source archives, official GNU patches, post-profile integration and native prompt-column patches are in sources/.\nReadline native display ABI: 1; explicit matching targets only. Linux x86_64 SSH uses the verified Bash in the private directory of a new session.\nShellSpan adapter source: src-tauri/native-input-adapter; rebuild: python3 scripts/native-input/integration/build.py\n')
    print(f'NIP production modules: {catalogue}')


if __name__ == '__main__':
    main()
