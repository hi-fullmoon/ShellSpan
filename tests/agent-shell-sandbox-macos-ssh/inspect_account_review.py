"""Snapshot only this run's exact journals and verify bounded account evidence."""
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / '.phase4-acceptance/stage2-real-account-review-2026-10-10'
JOURNALS = Path.home() / 'Library/Application Support/com.shellspan-dev/agent-runtime/sessions-v5'
IDS = {
    'a': 'agent-0db2a256-2a37-42fe-b3c3-a2bb0327fd63-mv1ze5lo-52nmojp',
    'b': 'agent-3b6f4759-a2ca-4687-8c9d-68cfbb92f168-mv1zf134-085dq3a',
    'activity': 'agent-0db2a256-2a37-42fe-b3c3-a2bb0327fd63-mv1zgale-t4hprl5',
}


def main():
    destination = OUTPUT / 'account-evidence.json'
    assert not destination.exists(), 'preserve existing evidence'
    snapshots = OUTPUT / 'journals'
    snapshots.mkdir(exist_ok=False)
    pages = {}
    digests = {}
    for label, session in IDS.items():
        source = JOURNALS / f'{session}.jsonl'
        saved = snapshots / source.name
        shutil.copyfile(source, saved)
        digests[saved.name] = hashlib.sha256(saved.read_bytes()).hexdigest()
        pages[label] = [json.loads(line) for line in saved.read_text().splitlines()]
    approvals = lambda label, status: [row for row in pages[label]
        if row['type'] == 'tool/approval' and row['data']['status'] == status]
    results = lambda label: [row for row in pages[label] if row['type'] == 'tool/result']
    a_request = approvals('a', 'requested')[0]
    b_request = approvals('b', 'requested')[0]
    observed = json.loads((OUTPUT / 'b-isolated-time.json').read_text())['observedAtUnixMs']
    b_result = results('b')[0]['data']['data']
    activity = results('activity')[0]['data']['data']
    checks = {
        'aActualPendingUi': '将在 175.178.66.45' in (OUTPUT / 'a-pending.ax.txt').read_text(),
        'bIsolatedBeforeAExpiry': a_request['timeUnixMs'] < observed < a_request['data']['expiresAtUnixMs'],
        'bNoAApproval': '允许执行一次' not in (OUTPUT / 'b-isolated.ax.txt').read_text(),
        'bHistoryIdentityFiltered': '当前登录身份：root@8.216.9.10:22' in (OUTPUT / 'b-history.ax.txt').read_text()
            and 'SSH登录审批隔离验收' not in (OUTPUT / 'b-history.ax.txt').read_text(),
        'aNeverApprovedOrDispatched': not approvals('a', 'approved')
            and not any(row['type'] == 'tool/execution' for row in pages['a']),
        'bIndependentApproval': a_request['data']['approvalId'] != b_request['data']['approvalId']
            and len(approvals('b', 'approved')) == 1,
        'bHandshakeFailureBeforeStart': b_result['failure']['admission'] == 'notStarted'
            and b_result['terminationConfirmed'] is True and b_result['stdout'] == '',
        'aActivityReallyStarted': activity['failure']['admission'] == 'started'
            and activity['stdout'] == 'shellspan-account-active-a',
        'aTimeoutUnconfirmedRetained': activity['terminationConfirmed'] is False
            and activity['lifecycle'] == 'timedOut',
        'resourcesNotTransferred': '"afterSwitchA":{"state":"none"' in (OUTPUT / 'activity-after-switch.ax.txt').read_text()
            and '"activeProcesses":1},"afterSwitchB"' in (OUTPUT / 'activity-after-switch.ax.txt').read_text()
            and '"activeProcesses":0}}' in (OUTPUT / 'activity-after-switch.ax.txt').read_text(),
        'bRetryBlockedByDebt': 'Shell 资源清理尚未确认' in (OUTPUT / 'cancel-and-gate.ax.txt').read_text()
            and len(approvals('b', 'requested')) == 1,
        'exactCancellationUnconfirmed': 'Native process cancellation remains unconfirmed' in (OUTPUT / 'cancel-and-gate.ax.txt').read_text(),
    }
    report = {'checks': checks, 'recordingChecksPassed': all(checks.values()),
              'scope': 'two real Linux root login identities on different hosts; host-account policy',
              'journalSha256': digests, 'sessions': IDS,
              'approvalIsolation': 'observed', 'resourceOwnershipIsolation': 'observed',
              'liveGrantTransfer': 'not covered: state none, host-account backend unavailable',
              'bExecution': 'not started: SSH handshake timeout',
              'ownedActivityCleanup': 'unconfirmed; exact original runtime cancellation failed',
              'historicalResources': 'unconfirmed and untouched', 'stage3Allowed': False,
              'overallPassed': False}
    destination.write_text(json.dumps(report, indent=2) + '\n')
    assert report['recordingChecksPassed'], checks
    print(json.dumps({'checks': len(checks), 'recordingChecksPassed': True, 'overallPassed': False}))


if __name__ == '__main__':
    main()
