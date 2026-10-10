"""Validate the owned live-model target-switch recording without changing it."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    output = parser.parse_args().output.resolve()
    destination = output / 'target-switch-final-evidence.json'
    root = Path(__file__).resolve().parents[2]
    if not output.is_relative_to(root / '.phase4-acceptance') or destination.exists():
        parser.error('preserve previous owned evidence')
    pages = list((output / 'fixture/agent-runtime/sessions-v5').glob('target-a-*.jsonl'))
    assert len(pages) == 1, 'exactly one actual model session required'
    rows = [json.loads(line) for line in pages[0].read_text().splitlines()]
    requested = [row for row in rows if row['type'] == 'tool/approval'
                 and row['data']['status'] == 'requested']
    assert len(requested) == 1, 'one original pending approval required'
    request = requested[0]
    calls = [row for row in rows if row['type'] == 'tool/call']
    a = (output / 'a-pending.ax.txt').read_text()
    b = (output / 'b-pending-isolated.ax.txt').read_text()
    returned = (output / 'a-return-expired.ax.txt').read_text()
    history = (output / 'b-history-expired.ax.txt').read_text()
    finish = json.loads((output / 'fixture/fixture-shutdown.json').read_text())
    launch = json.loads((output / 'launch-final.json').read_text())
    prior = json.loads((output / 'target-verification-evidence.json').read_text())
    checks = {
        'actualModelRequests': sum(row['type'] == 'request/start' for row in rows) == 2,
        'exactOwnCommand': len(calls) == 1 and calls[0]['data']['call']['arguments']['command'] == 'printf target-a > switch-target-a',
        'actualAPendingUi': '允许执行一次' in a and 'Own ordinary-account Mac SSH fixture, Value: on' in a,
        'bApprovalIsolated': 'Own secondary Mac SSH target, Value: on' in b and '新建会话' in b and '允许执行一次' not in b,
        'originalTtlUnchanged': request['data']['expiresAtUnixMs'] - calls[0]['timeUnixMs'] == 60000,
        'expiredUiNotRevived': '批准请求已过期' in returned and '允许执行一次' not in returned,
        'otherTargetHistoryCannotApprove': '批准请求已过期' in history and '允许执行一次' not in history and '旧命令不会自动重试' in history,
        'noApprovalOrDispatch': not any(row['type'] == 'tool/execution' and row['data'].get('status') == 'dispatched'
                                      or row['type'] == 'tool/approval' and row['data']['status'] == 'approved' for row in rows),
        'runtimeShutdown': finish['runtimeShutdownConfirmed'],
        'bothOriginalSourcesJoined': finish['fixture']['sourceWorkerJoined'] and finish['fixture']['sourceWorkerCount'] == 2,
        'originalServerWaited': finish['fixture']['serverWaitConfirmed'] and finish['fixture']['serverExitCode'] == 0,
        'exactCredentialReleased': finish['fixture']['ownedCredentialReleased'],
        'sourcePtyNeverWritten': finish['sourcePtyWrites'] == 0,
        'normalUnchangedExit': launch['exitCode'] == 0 and launch['sourceUnchanged'] and launch['binaryUnchanged'],
        'realVerificationMatrix': prior['verificationPassed'] and all(prior['checks'].values()),
    }
    report = {'checks': checks, 'passed': all(checks.values()), 'sessionId': request['sessionId'],
              'approvalId': request['data']['approvalId'], 'expiresAtUnixMs': request['data']['expiresAtUnixMs'],
              'scope': 'same-account two real SSH sources; pending approval isolated on B and naturally expired before return to A; historical view observed after expiry',
              'historicalResources': 'unconfirmed and untouched', 'differentActualAccounts': 'deferred',
              'stage3Allowed': False}
    destination.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'report': str(destination), 'passed': report['passed'], 'checks': len(checks)}))
    assert report['passed'], checks


if __name__ == '__main__':
    main()
