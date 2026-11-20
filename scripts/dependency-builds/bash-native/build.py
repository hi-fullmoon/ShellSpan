"""Pinned GNU targets with an explicit, post-profile integration entry."""
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
sys.path.insert(0, str(ROOT / 'scripts/native-input'))
from build_paths import BUILD_ROOT, build_directory

OUT = build_directory(BUILD_ROOT, 'integration')
UPSTREAM = build_directory(BUILD_ROOT, 'prototype') / 'upstream'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--versions', default='5.3', help='comma-separated Bash versions (default: 5.3)')
    args = parser.parse_args()
    host = platform.system().lower()
    OUT.mkdir(parents=True, exist_ok=True)
    log = OUT / f'bash-build-{host}.log'

    def run(command, cwd=ROOT):
        with log.open('ab') as output:
            subprocess.run(list(map(str, command)), cwd=cwd, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}, stdout=output, stderr=subprocess.STDOUT, check=True)

    # Reuse the already reviewed GNU archive/Readline verification. This is a
    # source dependency build, never a timestamped previous capture or module.
    run(['python3', '-B', 'scripts/native-input/prototype/build.py', '--upstream', '--versions', args.versions])
    helper_path = ROOT / 'scripts/native-input/prototype/build.py'
    spec = importlib.util.spec_from_file_location('gnu_dependency_inputs', helper_path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    patches = {version: Path(__file__).with_name(f'startup-init-{version}.patch') for version in ['4.1', '4.4', '5.3']}
    readline_versions = {'4.1': '6.0', '4.4': '7.0', '5.3': '8.3.6'}
    display_patches = {version: Path(__file__).with_name(f'readline-columns-{readline_versions[version]}.patch') for version in patches}
    paste_patch = Path(__file__).with_name('readline-paste-6.0.patch')
    darwin_patch = Path(__file__).with_name('darwin-headers-4.1.patch')
    bind_x_patch = Path(__file__).with_name('bash-bind-x-return-4.1.patch')
    unload_patch = Path(__file__).with_name('bash-unload-hook-4.1.patch')
    combining_patch = Path(__file__).with_name('readline-combining-wrap.patch')
    native_history_patch = Path(__file__).with_name('native-history-5.3.patch')
    setpgid_patches = {version: Path(__file__).with_name('darwin-setpgid.patch' if version == '4.1' else f'darwin-setpgid-{version}.patch') for version in patches}
    setpgid_header = Path(__file__).with_name('darwin-setpgid.h')
    resize_patches = {version: Path(__file__).with_name(f'readline-resize-{readline_versions[version]}.patch') for version in ['4.1', '4.4']}
    sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    static_tinfo = None
    if host == 'linux' and platform.machine() == 'x86_64':
        archive = Path(subprocess.check_output(['cc', '-print-file-name=libtinfo.a'], text=True).strip())
        if not archive.is_absolute() or not archive.is_file():
            raise RuntimeError('The Linux x86_64 Bash build requires the libtinfo static archive (libncurses-dev)')
        static_tinfo = archive.resolve()
    build_inputs = [
        *patches.values(), *display_patches.values(), paste_patch, darwin_patch, bind_x_patch,
        unload_patch, combining_patch, native_history_patch, *setpgid_patches.values(),
        setpgid_header, *resize_patches.values(), Path(__file__), helper_path,
        ROOT / 'scripts/native-input/prototype/readline-sources.json',
    ]
    inputs_digest = ''.join(sha(path) for path in build_inputs)
    # Generated GNU Makefiles contain absolute source and install paths.
    stamp = hashlib.sha256(f'{inputs_digest}\0{OUT.resolve()}'.encode()).hexdigest()[:20]
    if static_tinfo:
        stamp += '-' + sha(static_tinfo)[:12]
    bash_patch_lock = Path(__file__).with_name('bash-5.3-patches.json')
    macos_bash_patches = {}
    if host == 'darwin' and '5.3' in args.versions.split(','):
        pin = json.loads(bash_patch_lock.read_text())
        if len(pin) != 20:
            raise RuntimeError('Expected GNU Bash 5.3 patches 001–020')
        stamp += '-' + sha(bash_patch_lock)[:12]
        for number, expected in enumerate(pin, 1):
            name = f'bash53-{number:03d}'
            official_patch = UPSTREAM / name
            helper.ensure_gnu_source(f'bash/bash-5.3-patches/{name}', official_patch, expected)
            macos_bash_patches[official_patch] = expected
    base = OUT / f'bash-{host}' / stamp
    sources = base / 'source'
    sources.mkdir(parents=True, exist_ok=True)
    builds = {}

    def apply_display_patch(source, patch, marker_name='.shellspan-native-display'):
        marker = source / marker_name
        if not marker.exists():
            run(['patch', '--batch', '-F', '0', '-p1', '-i', patch], source)
            marker.write_text(sha(patch))
        if marker.read_text() != sha(patch):
            raise RuntimeError('Stale Readline native display patch')

    def build_readline83():
        pin = json.loads((ROOT / 'scripts/native-input/prototype/readline-sources.json').read_text())
        upstream = UPSTREAM
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
        if host == 'darwin':
            apply_display_patch(source, combining_patch, '.shellspan-combining-wrap')
        target = base / 'readline-build'
        prefix = base / 'readline-install'
        target.mkdir(exist_ok=True)
        if not (target / 'Makefile').exists():
            run([source / 'configure', f'--prefix={prefix}', '--disable-shared', '--enable-static', 'CFLAGS=-O2 -fPIC'], target)
        run(['make', '-j4', 'CFLAGS=-O2 -fPIC -Werror=implicit-function-declaration'], target)
        run(['make', 'install'], target)
        return prefix, source

    for version in args.versions.split(','):
        if version not in patches:
            raise RuntimeError('Unaccepted GNU Bash version')
        patch=patches[version]
        archive = UPSTREAM / f'bash-{version}.tar.gz'
        if sha(archive) != helper.PINNED[version]:
            raise RuntimeError('GNU Bash archive checksum mismatch')
        source = sources / f'bash-{version}'
        if not source.exists():
            run(['tar', '-xzf', archive, '-C', sources])
            if version == '5.3':
                for official_patch in macos_bash_patches:
                    run(['patch', '--batch', '-F', '0', '-p0', '-i', official_patch], source)
            run(['patch', '--batch', '-p1', '-i', patch], source)
            (source / '.shellspan-startup-init').write_text(sha(patch))
            if host == 'linux':
                for name in ['config.guess', 'config.sub']:
                    shutil.copy2(Path('/usr/share/misc') / name, source / 'support' / name)
        if (source / '.shellspan-startup-init').read_text() != sha(patch):
            raise RuntimeError('Stale GNU source patch')
        if version == '5.3':
            apply_display_patch(source, native_history_patch, '.shellspan-native-history')
        if host == 'darwin':
            setpgid_patch = setpgid_patches[version]
            apply_display_patch(source, setpgid_patch, '.shellspan-darwin-setpgid')
            copied_header = source / 'shellspan-darwin-setpgid.h'
            if not copied_header.exists():
                shutil.copy2(setpgid_header, copied_header)
            if sha(copied_header) != sha(setpgid_header):
                raise RuntimeError('Stale Darwin process-group completion header')
        if host == 'darwin' and version == '4.1':
            apply_display_patch(source, darwin_patch, '.shellspan-darwin-headers')
            apply_display_patch(source, bind_x_patch, '.shellspan-bind-x-return')
            apply_display_patch(source, unload_patch, '.shellspan-unload-hook')
        if version == '5.3':
            readline, readline_source = build_readline83()
        else:
            readline = None
            readline_source = source / 'lib/readline'
            apply_display_patch(readline_source, display_patches[version])
            apply_display_patch(readline_source, resize_patches[version], '.shellspan-owned-line-resize')
            if host == 'darwin':
                apply_display_patch(readline_source, combining_patch, '.shellspan-combining-wrap')
            if version == '4.1':
                apply_display_patch(readline_source, paste_patch, '.shellspan-bracketed-paste')
        target = base / f'build-{version}'
        target.mkdir(exist_ok=True)
        if not (target / 'Makefile').exists():
            run([source / 'configure', '--without-bash-malloc', '--disable-nls',
                 'CFLAGS=-O2 -std=gnu89 -Wno-error=implicit-function-declaration -Wno-error=int-conversion',
                 *([f'--with-installed-readline={readline}'] if readline else [])], target)
        if host == 'darwin' and version == '4.1':
            # Compile the actual production bind-x callback with its return contract checked.
            run(['make', 'bashline.o', 'CFLAGS=-O2 -std=gnu89 -Werror=implicit-function-declaration -Werror=return-type'], target)
        terminal_library = [f'TERMCAP_LIB={static_tinfo}'] if static_tinfo and version == '5.3' else []
        run(['make', '-j4', 'CFLAGS=-O2 -std=gnu89 -Werror=implicit-function-declaration', *terminal_library], target)
        shell = target / 'bash'
        if terminal_library:
            dynamic = subprocess.check_output(['readelf', '-dW', shell], text=True)
            if 'libtinfo.so' in dynamic or 'libncurses' in dynamic:
                raise RuntimeError('Linux x86_64 Bash still depends on a shared terminal library')
        if version == '5.3' and macos_bash_patches:
            patch_level = subprocess.check_output([shell, '--noprofile', '--norc', '-c',
                                                   'printf "%s" "${BASH_VERSINFO[2]}"'], text=True)
            if patch_level != str(len(macos_bash_patches)):
                raise RuntimeError(f'Unexpected GNU Bash patch level: {patch_level}')
        builds[version] = {'shell': str(shell), 'source': str(source), 'includes':
                          [*([str(readline / 'include')] if readline else []), str(target), str(source), str(source / 'include')],
                          'shellSha256': sha(shell), 'startupPatchSha256': sha(patch), 'archiveSha256': sha(archive),
                          'sourcePatch': str(patch.relative_to(ROOT)), 'readlineDisplayAbi': 1,
                          'readlineSource': str(readline_source),
                          'readlineDisplayPatch': str(display_patches[version].relative_to(ROOT)),
                          'readlineDisplayPatchSha256': sha(display_patches[version]),
                          'readlinePasteBackport': {'from': 'Bash 4.4 / Readline 7.0', 'patch': str(paste_patch.relative_to(ROOT)), 'sha256': sha(paste_patch)} if version == '4.1' else None,
                          'readlineNativeSources': {name: sha(readline_source / name) for name in ['display.c', 'terminal.c', 'readline.h', 'readline.c', 'rlprivate.h', 'rltty.c', 'bind.c', 'funmap.c', 'kill.c']},
                          'readlineResizeBackport': {'from': 'Readline 8.3.6', 'patch': str(resize_patches[version].relative_to(ROOT)), 'sha256': sha(resize_patches[version])} if version in resize_patches else None,
                          'readlineCombiningWrapPatch': {'patch': str(combining_patch.relative_to(ROOT)), 'sha256': sha(combining_patch)} if host == 'darwin' else None,
                          'darwinSetpgidSynchronization': {'patch': str(setpgid_patch.relative_to(ROOT)), 'sha256': sha(setpgid_patch), 'header': str(setpgid_header.relative_to(ROOT)), 'headerSha256': sha(setpgid_header), 'jobsSourceSha256': sha(source / 'jobs.c')} if host == 'darwin' else None,
                          'darwinHeaderPatch': {'patch': str(darwin_patch.relative_to(ROOT)), 'sha256': sha(darwin_patch)} if host == 'darwin' and version == '4.1' else None,
                          'unloadHookBackport': {'from': 'Bash 4.4', 'patch': str(unload_patch.relative_to(ROOT)), 'sha256': sha(unload_patch), 'enableSourceSha256': sha(source / 'builtins/enable.def'), 'generalHeaderSha256': sha(source / 'general.h')} if host == 'darwin' and version == '4.1' else None,
                          'bindXReturnBackport': {'from': 'Bash 4.4', 'patch': str(bind_x_patch.relative_to(ROOT)), 'sha256': sha(bind_x_patch), 'sourceSha256': sha(source / 'bashline.c'), 'compileGuard': '-Werror=return-type'} if host == 'darwin' and version == '4.1' else None}
        if version == '5.3' and macos_bash_patches:
            builds[version]['bashPatchLevel'] = int(patch_level)
            builds[version]['gnuBashPatches'] = {path.name: digest for path, digest in macos_bash_patches.items()}
    (OUT / f'bash-{host}.json').write_text(json.dumps(builds, indent=2))
    print(f'GNU Bash post-profile targets: {OUT / f"bash-{host}.json"}')


if __name__ == '__main__':
    main()
