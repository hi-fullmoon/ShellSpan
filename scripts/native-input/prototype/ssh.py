"""Disposable loopback-only SSH acceptance. Never changes host SSH config."""
import json
import argparse
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'artifacts/tests/native-input-p0'


def run(command, log):
    with log.open('ab') as output:
        output.write(('\n$ '+' '.join(command)+'\n').encode())
        output.flush()
        result = subprocess.run(command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError(f'{command[0]} exit {result.returncode}; {log}')


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--versions',default='4.1,4.4,5.3')
    parser.add_argument('--display-profile',default='legacy',choices=['legacy','append'])
    parser.add_argument('--causal-output',type=Path)
    parser.add_argument('--schedule',type=Path)
    parser.add_argument('--modes',default='pure,append-display')
    args=parser.parse_args()
    directory = OUT/'ssh'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    run_output=directory/'runs'/time.strftime('%Y%m%d-%H%M%S',time.gmtime())
    run_output.mkdir(parents=True)
    (OUT/'cargo-registry').mkdir(exist_ok=True)
    log = directory/'driver.log'
    container = 'shellspan-p0-'+uuid.uuid4().hex[:8]
    with socket.socket() as available:
        available.bind(('127.0.0.1',0))
        port = available.getsockname()[1]
    for key in ['host_key', 'identity']:
        if not (directory/key).exists():
            run(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(directory/key)],log)
    public = (directory/'host_key.pub').read_text().split()
    (run_output/'known_hosts').write_text(f'[127.0.0.1]:{port} {public[0]} {public[1]}\n')
    (directory/'sshd_config').write_text('''Port 22229
ListenAddress 0.0.0.0
HostKey /work/artifacts/tests/native-input-p0/ssh/host_key
PidFile /tmp/p0-sshd.pid
AuthorizedKeysFile /work/artifacts/tests/native-input-p0/ssh/identity.pub
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
PermitRootLogin no
AllowUsers p0
AllowTcpForwarding remote
AllowStreamLocalForwarding remote
StreamLocalBindUnlink yes
LogLevel VERBOSE
''')
    run(['docker','build','--build-arg',f'FIXTURE_UID={os.getuid()}',
         '-t','shellspan-native-input-p0:local','-f','scripts/native-input/prototype/Dockerfile',
         'scripts/native-input/prototype'],log)
    workers=[]
    try:
        run(['docker','run','-d','--name',container,'-p',f'127.0.0.1:{port}:22229',
             '-v',f'{ROOT}:/work','-v',f'{OUT / "cargo-registry"}:/usr/local/cargo/registry',
             '-w','/work','shellspan-native-input-p0:local',
             'sleep','infinity'],log)
        run(['docker','exec','-e','SHELLSPAN_NATIVE_BUILD_ROOT=artifacts/tests',container,
             'python3','scripts/native-input/prototype/build.py','--upstream','--versions',args.versions],log)
        run(['docker','exec','-d',container,'/usr/sbin/sshd','-D','-e','-f','/work/artifacts/tests/native-input-p0/ssh/sshd_config'],log)
        for _ in range(100):
            try:
                with socket.create_connection(('127.0.0.1',port),timeout=0.1):
                    break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError('isolated sshd did not become ready')
        builds=json.loads((OUT/'build-linux.json').read_text())
        codes=[]
        for version, build in builds.items():
            if args.causal_output:
                for mode in args.modes.split(','):
                    directory=args.causal_output/f'ssh-{version}-{mode}'
                    directory.mkdir(parents=True)
                    command=['python3','scripts/native-input/prototype/background-causality.py','--ssh',
                        '--port',str(port),'--key',str(OUT/'ssh/identity'),
                        '--known-hosts',str(run_output/'known_hosts'),'--schedule',str(args.schedule),
                        '--shell',build['shell'],'--bridge',build['bridge'],'--mode',mode,'--output',str(directory)]
                    output=(directory/'driver-native.log').open('wb')
                    workers.append((f'{version}-{mode}',subprocess.Popen(command,cwd=ROOT,stdout=output,stderr=subprocess.STDOUT),output))
                continue
            command=['python3','scripts/native-input/prototype/acceptance.py','--ssh',
                     '--port',str(port),'--key',str(directory/'identity'),
                     '--known-hosts',str(run_output/'known_hosts'),
                     '--shell',build['shell'],'--bridge',build['bridge'],
                     '--expected-version',version,
                     '--display-profile',args.display_profile,
                     '--output',str(run_output/version)]
            output=(run_output/f'acceptance-{version}.log').open('wb')
            workers.append((version,subprocess.Popen(command,cwd=ROOT,stdout=output,stderr=subprocess.STDOUT),output))
        for version,worker,output in workers:
            code=worker.wait()
            output.close()
            codes.append({'version':version,'exit':code})
        info=subprocess.check_output(['docker','inspect',container]).decode()
        (run_output/'container.json').write_text(info)
        (run_output/'results.json').write_text(json.dumps(codes,indent=2))
        print(f'P0 loopback SSH: {codes}; {run_output}')
        return any(item['exit'] for item in codes)
    finally:
        for _,worker,output in workers:
            if worker.poll() is None:
                worker.terminate()
                try:
                    worker.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    worker.kill()
                    worker.wait()
            output.close()
        subprocess.run(['docker','rm','-f',container],stdout=subprocess.DEVNULL,check=True)


if __name__=='__main__':
    raise SystemExit(main())
