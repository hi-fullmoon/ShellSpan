"""Ordinary compatibility runner; never an ingress or authorization adapter."""
import json
from pathlib import Path
import subprocess
import sys
import uuid


def command(*args, timeout=30):
    return subprocess.run(['docker', *args], check=True, capture_output=True,
                          text=True, timeout=timeout)


def verify(image_id, log_path):
    if not image_id.startswith('sha256:') or len(image_id) != 71 or any(char not in '0123456789abcdef' for char in image_id[7:]):
        raise ValueError('An immutable pre-provisioned image ID is required')
    nonce = uuid.uuid4().hex
    volumes = []
    container_id = None
    try:
        for suffix, initial_path in [('workspace', '/opt/app'), ('cache', '/home/node')]:
            volume = f'shellspan-compat-{nonce}-{suffix}'
            command('volume', 'create', volume)
            volumes.append(volume)
            command('run', '--rm', '--pull', 'never', '--network', 'none',
                    '--read-only', '--user', '1000:1000', '--mount',
                    f'type=volume,source={volume},target={initial_path}',
                    '--entrypoint', '/bin/sh', image_id, '-c', f'test -w {initial_path}', timeout=60)
        args = ['create', '--pull', 'never', '--network', 'none', '--read-only',
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--user', '1000:1000', '--pids-limit', '512']
        for volume, directory in zip(volumes, ['/workspace', '/cache']):
            args += ['--mount', f'type=volume,source={volume},target={directory}']
        args += ['--tmpfs', '/tmp:rw,exec,nosuid,nodev,uid=1000,gid=1000,mode=0700',
                 image_id, '/usr/bin/env', '-i', 'PATH=/opt/cargo/bin:/usr/local/bin:/usr/bin:/bin',
                 'HOME=/tmp/home', 'RUSTUP_HOME=/opt/rust', 'RUSTUP_TOOLCHAIN=1.95.0',
                 'CARGO_HOME=/cache/cargo', 'CARGO_BUILD_JOBS=1', 'CARGO_INCREMENTAL=0',
                 'CARGO_PROFILE_DEV_DEBUG=0', 'CARGO_PROFILE_TEST_DEBUG=0', 'CI=true',
                 'XDG_CACHE_HOME=/cache', 'TMPDIR=/tmp', 'PNPM_HOME=/cache/pnpm',
                 '/bin/sh', '/opt/run_build_compat.sh']
        container_id = command(*args).stdout.strip()
        with Path(log_path).open('w') as output:
            result = subprocess.run(['docker', 'start', '--attach', container_id],
                                    stdout=output, stderr=subprocess.STDOUT, timeout=1800)
        state = json.loads(command('inspect', container_id).stdout)[0]['State']
        print(json.dumps({'image': image_id, 'container': container_id,
                          'exitCode': state['ExitCode'], 'running': state['Running'],
                          'oomKilled': state['OOMKilled'], 'log': log_path}))
        if state['Running'] or result.returncode or state['ExitCode']:
            raise SystemExit(1)
    finally:
        # Only this request's exact receipt and freshly generated volumes.
        if container_id is not None:
            command('rm', '--force', container_id)
        for volume in volumes:
            command('volume', 'rm', volume)


if __name__ == '__main__':
    verify(*sys.argv[1:3])
