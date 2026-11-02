"""Build the isolated prototype and optional upstream Bash versions.

Sources are pinned GNU release archives. Artifacts stay outside test discovery.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.native-input-p0'
PINNED = {
    '4.1': '3f627124a83c6d34db503a923e20710d370573a29dd5d11d6f116d1aee7be1da',
    '4.4': 'd86b3392c1202e8ff5a423b302e6284db7f8f435ea9f39b5b1b20fd3ac36dfcb',
    '5.3': '0d5cd86965f869a26cf64f4b71be7b96f90a3ba8b3d74e27e8e9d9d5550f31ba',
}


def run(command, log, cwd=ROOT):
    with log.open('ab') as output:
        output.write(('\n$ '+' '.join(map(str, command))+'\n').encode())
        output.flush()
        result = subprocess.run(command, cwd=cwd, stdout=output, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError(f'{command[0]} exit {result.returncode}; see {log}')


def build_readline(build, source_root, upstream, log):
    pinned=json.loads((ROOT/'scripts/native-input-p0/readline-sources.json').read_text())
    archive=upstream/'readline-8.3.tar.gz'
    if not archive.exists():
        urllib.request.urlretrieve('https://ftp.gnu.org/gnu/readline/readline-8.3.tar.gz',archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest()!=pinned['archive']:
        raise RuntimeError('Readline archive checksum mismatch')
    source=source_root/'readline-8.3'
    if not source.exists():
        run(['tar','-xzf',str(archive),'-C',str(source_root)],log)
    for number,expected in enumerate(pinned['patches'],1):
        name=f'readline83-{number:03d}'
        patch=upstream/name
        if not patch.exists():
            urllib.request.urlretrieve(f'https://ftp.gnu.org/gnu/readline/readline-8.3-patches/{name}',patch)
        if hashlib.sha256(patch.read_bytes()).hexdigest()!=expected:
            raise RuntimeError(f'{name}: checksum mismatch')
        stamp=source/f'.{name}.applied'
        if not stamp.exists():
            run(['patch','--batch','-p0','-i',str(patch)],log,source)
            stamp.write_text(expected)
    target=build/'readline-8.3.6'
    target.mkdir(exist_ok=True)
    prefix=target/'install'
    if not (prefix/'lib/libreadline.a').exists():
        run([str(source/'configure'),f'--prefix={prefix}','--disable-shared','--enable-static','CFLAGS=-O2 -fPIC'],log,target)
        run(['make','-j4'],log,target)
        run(['make','install'],log,target)
    return prefix


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--upstream', action='store_true')
    parser.add_argument('--headers', default='/opt/homebrew/include/bash')
    parser.add_argument('--versions', default='4.1,4.4,5.3')
    args = parser.parse_args()
    OUT.mkdir(exist_ok=True)
    host = platform.system().lower()
    build = OUT / f'build-{host}'
    log = OUT / f'build-{host}.log'
    run(['cargo', 'build', '--locked', '--manifest-path', 'scripts/native-input-p0/Cargo.toml',
         '--target-dir', str(build)], log)
    versions = {}
    if args.upstream:
        upstream = OUT / 'upstream'
        upstream.mkdir(exist_ok=True)
        for version, expected in PINNED.items():
            if version not in args.versions.split(','):
                continue
            archive = upstream / f'bash-{version}.tar.gz'
            if not archive.exists():
                urllib.request.urlretrieve(f'https://ftp.gnu.org/gnu/bash/bash-{version}.tar.gz', archive)
            actual = hashlib.sha256(archive.read_bytes()).hexdigest()
            if actual != expected:
                raise RuntimeError(f'{archive}: checksum mismatch')
            source_root = upstream if host=='darwin' else OUT/'upstream-linux'
            source_root.mkdir(exist_ok=True)
            source = source_root / f'bash-{version}'
            if not source.exists():
                # Only these pinned GNU archives are accepted, never caller data.
                run(['tar','-xzf',str(archive),'-C',str(source_root)],log)
            if host=='linux':
                # GNU 4.1 predates AArch64. Consume Debian's packaged GNU
                # config helpers; do not change Bash/Readline runtime sources.
                for name in ['config.guess','config.sub']:
                    helper=Path('/usr/share/misc')/name
                    shutil.copyfile(helper,source/'support'/name)
                    (source/'support'/name).chmod(0o755)
                (OUT/'gnu-config-helpers.json').write_text(json.dumps({name:hashlib.sha256((Path('/usr/share/misc')/name).read_bytes()).hexdigest() for name in ['config.guess','config.sub']},indent=2))
            readline=build_readline(build,source_root,upstream,log) if version=='5.3' else None
            target = build / (f'bash-{version}-readline-8.3.6' if readline else f'bash-{version}')
            target.mkdir(parents=True, exist_ok=True)
            if not (target / 'bash').exists():
                run([str(source / 'configure'), '--without-bash-malloc', '--disable-nls',
                     'CFLAGS=-O2 -std=gnu89 -Wno-implicit-function-declaration -Wno-int-conversion',
                     *([f'--with-installed-readline={readline}'] if readline else [])], log, target)
            if not (target / 'bash').exists():
                run(['make', '-j4', 'CFLAGS=-O2 -std=gnu89 -Wno-implicit-function-declaration -Wno-int-conversion'], log, target)
            bridge = OUT / f'bridge-{host}-{version}.so'
            compile_bridge(build, [*([readline/'include'] if readline else []),target, source, source / 'include'], bridge, log)
            versions[version] = {'shell': str(target / 'bash'), 'bridge': str(bridge),
                                 'archive_sha256':actual,'readline':'8.3.6 static (GNU patches 001-006)' if readline else 'bundled'}
    else:
        bridge = OUT / f'bridge-{host}.so'
        compile_bridge(build, [Path(args.headers), Path(args.headers)/'include'], bridge, log)
        versions['installed'] = {'shell': '/opt/homebrew/bin/bash', 'bridge': str(bridge)}
    (OUT / f'build-{host}.json').write_text(json.dumps(versions, indent=2))
    sources={str(path.relative_to(ROOT)):hashlib.sha256(path.read_bytes()).hexdigest()
             for path in (ROOT/'scripts/native-input-p0').rglob('*')
             if path.is_file() and '__pycache__' not in path.parts}
    metadata=json.loads(subprocess.check_output(['cargo','metadata','--locked','--format-version','1',
        '--manifest-path','scripts/native-input-p0/Cargo.toml'],cwd=ROOT))
    manifest={'sources':sources,'artifacts':{},'dependencies':[
        {field:package.get(field) for field in ['name','version','license','source']}
        for package in metadata['packages']]}
    for version,build_info in versions.items():
        manifest['artifacts'][version]={kind:{'path':build_info[kind],
            'sha256':hashlib.sha256(Path(build_info[kind]).read_bytes()).hexdigest()}
            for kind in ['shell','bridge']}
    (OUT/f'artifact-manifest-{host}.json').write_text(json.dumps(manifest,indent=2))
    print(f'P0 {host} build complete: {OUT / f"build-{host}.json"}')


def compile_bridge(build, includes, output, log):
    linker = ['-bundle', '-undefined', 'dynamic_lookup'] if platform.system()=='Darwin' else ['-shared', '-fPIC']
    run(['cc', *linker, *[f'-I{path}' for path in includes],
         *[f'-I{path / "lib"}' for path in includes],
         *(['-I/opt/homebrew/opt/readline/include'] if platform.system()=='Darwin' else []),
         str(ROOT/'scripts/native-input-p0/bridge.c'),
         str(build/'debug/libshellspan_native_input_p0.a'),
         '-lpthread', '-ldl', '-lm', '-o', str(output)], log)


if __name__ == '__main__':
    main()
