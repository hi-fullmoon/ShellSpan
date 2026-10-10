"""Export an exact committed real-dispatch prefix for rendering only, without custody."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--journal', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source, output = args.journal.resolve(), args.output.resolve()
    allowed = ROOT / '.phase4-acceptance'
    if not source.is_relative_to(allowed) or not output.is_relative_to(allowed) or output.exists():
        parser.error('use an exact owned journal and a new ignored output directory')
    raw = source.read_bytes()
    lines = raw.splitlines(keepends=True)
    rows = [json.loads(line) for line in lines]
    if not any(row['type'] == 'request/start' for row in rows):
        parser.error('an actual model recording is required')
    boundary = next(index for index, row in enumerate(rows)
                    if row['type'] == 'tool/execution' and row['data']['status'] == 'dispatched')
    if not any(row['type'] == 'tool/approval' and row['data']['status'] == 'approved' for row in rows[:boundary]):
        parser.error('an actual approved native dispatch is required')
    output.mkdir(mode=0o700)
    prefix = b''.join(lines[:boundary + 1])
    path = output / source.name
    path.write_bytes(prefix)
    report = {'source': str(source), 'sourceSha256': hashlib.sha256(raw).hexdigest(),
              'prefix': str(path), 'prefixSha256': hashlib.sha256(prefix).hexdigest(),
              'lastSeq': rows[boundary]['seq'], 'events': boundary + 1,
              'scope': 'exact recorded history prefix for narrow UI only; no model replay, custody or live grants copied',
              'stage3Allowed': False}
    (output / 'provenance.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
