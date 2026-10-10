"""Launch the current debug revision as a distinct normal workbench bundle."""
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def main():
    output = ROOT / '.phase4-acceptance/stage2-real-account-review-2026-10-10'
    output.mkdir(exist_ok=False)
    bundle = output / 'ShellSpan Account Review.app'
    contents = bundle / 'Contents'
    executable = contents / 'MacOS' / 'ShellSpanAccountReview'
    executable.parent.mkdir(parents=True)
    source = ROOT / 'src-tauri/target/debug/ShellSpan'
    shutil.copy2(source, executable)
    with (contents / 'Info.plist').open('wb') as handle:
        plistlib.dump({'CFBundleIdentifier': 'com.shellspan.account-review-20261010',
                      'CFBundleName': 'ShellSpan Account Review',
                      'CFBundleExecutable': executable.name,
                      'CFBundlePackageType': 'APPL', 'CFBundleVersion': '1',
                      'NSHighResolutionCapable': True}, handle)
    report = {'binarySha256': hashlib.sha256(source.read_bytes()).hexdigest(),
              'scope': 'current normal development workbench; existing development profiles and keychain references',
              'stage3Allowed': False}
    with (output / 'app.log').open('w') as log:
        process = subprocess.Popen([str(executable)], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        report['pid'] = process.pid
        (output / 'launch.json').write_text(json.dumps(report, indent=2) + '\n')
        report['exitCode'] = process.wait()
    (output / 'launch-final.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
