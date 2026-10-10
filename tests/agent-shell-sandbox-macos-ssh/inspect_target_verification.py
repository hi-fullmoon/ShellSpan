"""Keep actual hook/UI evidence separate from the still-pending live model case."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    destination = output / 'target-verification-evidence.json'
    if not output.is_relative_to(ROOT / '.phase4-acceptance') or destination.exists():
        parser.error('preserve previous owned evidence')
    ax = (output / 'verification-matrix.ax.txt').read_text()
    marker = '{"verificationMatrix":'
    value, _ = json.JSONDecoder().raw_decode(ax[ax.index(marker):])
    checks = value['verificationMatrix']
    if len(checks) != 11 or any(type(item) is not bool for item in checks.values()):
        parser.error('complete actual fixed verification matrix required')
    journals = [[json.loads(line) for line in path.read_text().splitlines()]
                for path in (output / 'fixture/agent-runtime/sessions-v5').glob('*.jsonl')]
    report = {'verificationPassed': all(checks.values()), 'checks': checks,
              'scope': 'real production hook in Wry with two owned same-account authenticated SSH PTYs and distinct projects; no mock IPC or altered timer',
              'mainWorkbenchEvidence': ['b-after-inflight.ax.txt', 'b-after-inflight.png', 'a-after-roundtrip.ax.txt'],
              'actualModelRequests': sum(row['type'] == 'request/start' for page in journals for row in page),
              'modelApprovalCombination': 'pending: original start sampled inside SecItemCopyMatching; Mac locked',
              'ownedFixtureShutdown': 'pending while original handles remain resident',
              'overallPassed': False, 'stage3Allowed': False,
              'differentActualAccounts': 'deferred', 'historicalResources': 'unconfirmed and untouched'}
    destination.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'report': str(destination), 'verificationPassed': report['verificationPassed'], 'overallPassed': False}))


if __name__ == '__main__':
    main()
