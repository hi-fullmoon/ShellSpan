"""Publish only locally built Linux binaries with their actual producer inputs."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess

root = Path(__file__).resolve().parents[2]
assert platform.system() == 'Linux' and platform.machine() == 'aarch64'
assert os.confstr('CS_GNU_LIBC_VERSION') == 'glibc 2.36'
assert subprocess.check_output(['/bin/zsh', '-f', '-c', 'print -rn -- $ZSH_VERSION']) == b'5.9'
identifier = 'zsh-5.9-zle-5.9-linux-aarch64-glibc-2.36-native'
resources = root / '.native-input-p2/resources/native-input'
destination = resources / identifier
destination.mkdir(parents=True, exist_ok=True)
sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
record = json.loads((root / '.native-input-p3/linux-core-build.json').read_text())
producer = json.loads((Path(record['directory']) / 'producer.json').read_text())
pin_path = root / 'scripts/dependency-builds/zsh/pin.json'
pin = json.loads(pin_path.read_text())
assert producer['target'] == 'linux-aarch64-glibc-2.36'
assert producer['pinSha256'] == sha(pin_path)
assert producer['nativeSourceHashes'] == pin['sourceHashes']
assert producer['patchSha256'] == sha(root / pin['patch']) == pin['patchSha256']
assert producer['mainSha256'] == sha('/bin/zsh') == pin['targets'][producer['target']]['mainSha256']
assert producer['unicode9Default'] is False and producer['nativeAcceptance'] is False
for name, digest in pin['sourceHashes'].items():
    assert sha(Path(producer['source']) / 'Src/Zle' / name) == digest
for source, name in [(root / '.native-input-p3/ss_nip-linux.so', 'ss_nip.so'),
                     (root / '.native-input-p3/linux-target/release/native-input-relay', 'native-input-relay'),
                     (Path(producer['editor']), 'zle.so'),
                     (Path(producer['directory']) / 'LICENCE.zsh', 'LICENCE.zsh')]:
    artifact = destination / name
    if artifact.exists():
        artifact.chmod(0o600)
    shutil.copy2(source, artifact)
    artifact.chmod(0o500 if name != 'LICENCE.zsh' else 0o400)
assert sha(destination / 'zle.so') == producer['editorSha256']
paths = [f'src-tauri/native-input-editors/{path}' for path in [
    'Cargo.toml', 'Cargo.lock', 'src/lib.rs', 'src/ffi.rs', 'zle.c', 'zle.zsh', 'psreadline.cs', 'psreadline.ps1']]
paths += ['src-tauri/src/terminal_command/protocol.rs', 'src-tauri/src/terminal_jobs.rs',
          'src-tauri/src/terminal_jobs.ps1', 'src-tauri/src/terminal_job_host.cs', 'src-tauri/src/terminal_console_signals.cs',
          'src-tauri/native-input-adapter/Cargo.toml', 'src-tauri/native-input-adapter/Cargo.lock',
          'src-tauri/native-input-adapter/src/bin/native-input-relay.rs',
          'scripts/native-input-p3/linux-build.sh', 'scripts/native-input-p3/publish-linux.py', 'scripts/native-input-p3/zsh-build-check.c']
paths += ['scripts/dependency-builds/zsh/pin.json', 'scripts/dependency-builds/zsh/native-display.patch',
          'scripts/native-input-p3/build-scoped-core.mjs']
profile = {'shell': 'zsh', 'shellVersion': '5.9', 'editor': 'zle', 'editorVersion': '5.9',
           'editorNumericVersion': 509, 'adapterVersion': '1', 'verifiedProfileId': identifier}
document = {'version': 1, 'profiles': [{'profile': profile, 'shellSha256': sha('/bin/zsh'),
    'core': identifier + '/zle.so', 'editorSha256': sha(destination / 'zle.so'),
    'coreLicense': identifier + '/LICENCE.zsh', 'coreLicenseSha256': sha(destination / 'LICENCE.zsh'),
    'moduleSha256': sha(destination / 'ss_nip.so'), 'module': identifier + '/ss_nip.so',
    'relay': identifier + '/native-input-relay', 'relaySha256': sha(destination / 'native-input-relay')}],
    'sources': {path: sha(root / path) for path in paths}}
(resources / 'editors-linux-aarch64-glibc-2.36.json').write_text(json.dumps(document, indent=2) + '\n')
(root / '.native-input-p3/scoped-linux-producer.json').write_text(json.dumps({'canonicalProducer': producer,
    'coreSha256': producer['editorSha256'], 'mainSha256': producer['mainSha256'], 'unicode9Default': False,
    'nativeAcceptance': False, 'mainProcessReplaced': False}, indent=2))
print(json.dumps({'target': 'linux-aarch64-glibc-2.36', 'profile': document['profiles'][0]}))
