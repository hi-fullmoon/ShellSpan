"""Verify actual narrow Wry rendering against an unchanged real journal prefix."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    destination = output / 'narrow-evidence.json'
    if not output.is_relative_to(ROOT / '.phase4-acceptance') or destination.exists():
        parser.error('preserve existing exact owned evidence')
    launch = json.loads((output / 'launch-final.json').read_text())
    layouts = [json.loads((output / f'layout-{locale}-360.json').read_text())['recoveryLayout'] for locale in ['zh', 'en']]
    zh, en = [(output / f'{locale}-360.ax.txt').read_text() for locale in ['zh', 'en']]
    receipt = json.loads((output / 'fixture/fixture-shutdown.json').read_text())
    # The launcher records the exact replay digest; find only that owned prefix.
    original = ROOT / '.phase4-acceptance/stage2-narrow-recovery-prefix-2026-10-10/provenance.json'
    provenance = json.loads(original.read_text())
    prefix = Path(provenance['prefix']).read_bytes()
    journal = (output / 'fixture/agent-runtime/sessions-v5' / Path(provenance['prefix']).name).read_bytes()
    rows = [json.loads(line) for line in journal.splitlines()]
    checks = {
        'actual360BothLocales': all(layout['width'] == 360 and layout['documentWidth'] == 360 and layout['gate'] for layout in layouts),
        'buttonsInsideContainer': all(0 <= button['left'] < button['right'] <= layout['width']
            for layout in layouts for button in layout['buttons']),
        'finishBlockedBeforeReceipt': all(len(layout['buttons']) == 2 and not layout['buttons'][0]['disabled']
            and layout['buttons'][1]['disabled'] for layout in layouts),
        'actualBilingualRecoveryNotice': '旧授权不会恢复，命令不会自动重放' in zh
            and 'Previous grants are not restored and commands are not replayed' in en,
        'oldApprovalAndStopBlocked': 'button (disabled) 停止本轮' in zh and 'button (disabled) Stop this turn' in en
            and '允许执行一次' not in zh and 'Allow once' not in en,
        'keyboardReachesReceipt': 'focused UI element is 14 button Verify cleanup receipts' in (output / 'keyboard-focus.ax.txt').read_text(),
        'exactOriginalPrefix': journal.startswith(prefix) and hashlib.sha256(prefix).hexdigest() == launch['replayJournalSha256'],
        'noNewModelOrCommandReplay': not any(row['type'] == 'request/start' or row['type'] == 'tool/execution'
            and row['data']['status'] == 'dispatched' for row in rows[provenance['events']:]),
        'ownedPtyTerminalOnly': receipt['runtimeShutdownConfirmed'] is True
            and receipt['fixture']['sourceWaitConfirmed'] is True and receipt['fixture']['sourceWorkerJoined'] is True
            and receipt['sourcePtyWrites'] == 0,
        'normalExitUnchanged': launch['exitCode'] == 0 and launch['binaryUnchanged'] and launch['originalJournalUnchanged'],
    }
    report = {'passed': all(checks.values()), 'checks': checks, 'stage3Allowed': False,
              'scope': 'actual bilingual 360-wide Wry recovery rendering and own PTY shutdown only; no historical custody or cleanup authority imported',
              'provenance': provenance, 'historicalResources': 'unconfirmed and untouched'}
    destination.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'report': str(destination), 'passed': report['passed'], 'checks': len(checks)}))
    return 0 if report['passed'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
