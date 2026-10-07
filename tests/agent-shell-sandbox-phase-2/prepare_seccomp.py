"""Derive socket denial from pinned Moby policy; never loosen other syscalls."""

import hashlib
import json
from pathlib import Path
import sys
import urllib.request


def main():
    output = Path(sys.argv[1])
    commit = sys.argv[2]
    if len(commit) != 40 or any(char not in '0123456789abcdef' for char in commit):
        raise ValueError('An exact Moby profiles commit SHA is required')
    url = f'https://raw.githubusercontent.com/moby/profiles/{commit}/seccomp/default.json'
    with urllib.request.urlopen(url, timeout=30) as response:
        source = response.read()
    policy = json.loads(source)
    if policy['defaultAction'] != 'SCMP_ACT_ERRNO':
        raise ValueError('Upstream no longer uses the expected deny-by-default policy')
    denied = {'socket', 'socketcall', 'connect', 'bind', 'listen', 'accept', 'accept4',
              'io_uring_setup', 'io_uring_enter', 'io_uring_register'}
    rules = []
    for rule in policy['syscalls']:
        if rule['action'] == 'SCMP_ACT_ALLOW':
            rule['names'] = [name for name in rule['names'] if name not in denied]
        if rule['names']:
            rules.append(rule)
    policy['syscalls'] = rules
    output.write_text(json.dumps(policy, indent=2) + '\n')
    print(json.dumps({'source': url, 'sha256': hashlib.sha256(source).hexdigest(),
                      'derivedSha256': hashlib.sha256(output.read_bytes()).hexdigest()}))


if __name__ == '__main__':
    main()
