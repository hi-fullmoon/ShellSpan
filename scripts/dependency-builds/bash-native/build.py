"""Pinned GNU targets with an explicit, post-profile integration entry.

The application never substitutes these binaries for the bound user shell.
Only independently installed matching targets can negotiate the native ABI.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / '.native-input-p2'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--versions', default='4.1,4.4,5.3')
    args = parser.parse_args()
    host = platform.system().lower()
    OUT.mkdir(exist_ok=True)
    log = OUT / f'bash-build-{host}.log'

    def run(command, cwd=ROOT):
        with log.open('ab') as output:
            subprocess.run(list(map(str, command)), cwd=cwd, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}, stdout=output, stderr=subprocess.STDOUT, check=True)

    # Reuse the already reviewed GNU archive/Readline verification. This is a
    # source dependency build, never a timestamped previous capture or module.
    run(['python3', '-B', 'scripts/native-input-p0/build.py', '--upstream', '--versions', args.versions])
    helper_path = ROOT / 'scripts/native-input-p0/build.py'
    spec = importlib.util.spec_from_file_location('gnu_dependency_inputs', helper_path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    patches = {version: Path(__file__).with_name(f'startup-init-{version}.patch') for version in ['4.1', '4.4', '5.3']}
    readline_versions = {'4.1': '6.0', '4.4': '7.0', '5.3': '8.3.6'}
    display_patches = {version: Path(__file__).with_name(f'readline-columns-{readline_versions[version]}.patch') for version in patches}
    sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    stamp = hashlib.sha256((''.join(sha(patch) for patch in [*patches.values(), *display_patches.values()]) + sha(Path(__file__)) + sha(helper_path) + sha(ROOT / 'scripts/native-input-p0/readline-sources.json')).encode()).hexdigest()[:20]
    base = OUT / f'bash-{host}' / stamp
    sources = base / 'source'
    sources.mkdir(parents=True, exist_ok=True)
    builds = {}

    def apply_display_patch(source, patch):
        marker = source / '.shellspan-native-display-v1'
        if not marker.exists():
            run(['patch', '--batch', '-F', '0', '-p1', '-i', patch], source)
            marker.write_text(sha(patch))
        if marker.read_text() != sha(patch):
            raise RuntimeError('Stale Readline native display patch')

    def build_readline83():
        pin = json.loads((ROOT / 'scripts/native-input-p0/readline-sources.json').read_text())
        upstream = ROOT / '.native-input-p0/upstream'
        archive = upstream / 'readline-8.3.tar.gz'
        if sha(archive) != pin['archive']:
            raise RuntimeError('GNU Readline archive checksum mismatch')
        source = sources / 'readline-8.3'
        if not source.exists():
            run(['tar', '-xzf', archive, '-C', sources])
        for number, expected in enumerate(pin['patches'], 1):
            patch = upstream / f'readline83-{number:03d}'
            if sha(patch) != expected:
                raise RuntimeError('GNU Readline patch checksum mismatch')
            marker = source / f'.readline83-{number:03d}.applied'
            if not marker.exists():
                run(['patch', '--batch', '-F', '0', '-p0', '-i', patch], source)
                marker.write_text(expected)
            if marker.read_text() != expected:
                raise RuntimeError('Stale GNU Readline source patch')
        apply_display_patch(source, display_patches['5.3'])
        target = base / 'readline-build'
        prefix = base / 'readline-install'
        target.mkdir(exist_ok=True)
        if not (target / 'Makefile').exists():
            run([source / 'configure', f'--prefix={prefix}', '--disable-shared', '--enable-static', 'CFLAGS=-O2 -fPIC'], target)
        run(['make', '-j4'], target)
        run(['make', 'install'], target)
        return prefix, source

    for version in args.versions.split(','):
        if version not in patches:
            raise RuntimeError('Unaccepted GNU Bash version')
        patch=patches[version]
        archive = ROOT / f'.native-input-p0/upstream/bash-{version}.tar.gz'
        if sha(archive) != helper.PINNED[version]:
            raise RuntimeError('GNU Bash archive checksum mismatch')
        source = sources / f'bash-{version}'
        if not source.exists():
            run(['tar', '-xzf', archive, '-C', sources])
            run(['patch', '--batch', '-p1', '-i', patch], source)
            (source / '.shellspan-startup-init').write_text(sha(patch))
            if host == 'linux':
                for name in ['config.guess', 'config.sub']:
                    shutil.copy2(Path('/usr/share/misc') / name, source / 'support' / name)
        if (source / '.shellspan-startup-init').read_text() != sha(patch):
            raise RuntimeError('Stale GNU source patch')
        if version == '5.3':
            readline, readline_source = build_readline83()
        else:
            readline = None
            readline_source = source / 'lib/readline'
            apply_display_patch(readline_source, display_patches[version])
        target = base / f'build-{version}'
        target.mkdir(exist_ok=True)
        if not (target / 'Makefile').exists():
            run([source / 'configure', '--without-bash-malloc', '--disable-nls',
                 'CFLAGS=-O2 -std=gnu89 -Wno-implicit-function-declaration -Wno-int-conversion',
                 *([f'--with-installed-readline={readline}'] if readline else [])], target)
        run(['make', '-j4'], target)
        shell = target / 'bash'
        builds[version] = {'shell': str(shell), 'source': str(source), 'includes':
                          [*([str(readline / 'include')] if readline else []), str(target), str(source), str(source / 'include')],
                          'shellSha256': sha(shell), 'startupPatchSha256': sha(patch), 'archiveSha256': sha(archive),
                          'sourcePatch': str(patch.relative_to(ROOT)), 'readlineDisplayAbi': 1,
                          'readlineSource': str(readline_source),
                          'readlineDisplayPatch': str(display_patches[version].relative_to(ROOT)),
                          'readlineDisplayPatchSha256': sha(display_patches[version]),
                          'readlineNativeSources': {name: sha(readline_source / name) for name in ['display.c', 'readline.h']}}
    (OUT / f'bash-{host}.json').write_text(json.dumps(builds, indent=2))
    print(f'GNU Bash post-profile targets: {OUT / f"bash-{host}.json"}')


if __name__ == '__main__':
    main()
