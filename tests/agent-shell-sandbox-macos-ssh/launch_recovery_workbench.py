"""Keep custody of a new workbench App across an explicit crash and reopen."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--reopen-existing", action="store_true")
    parser.add_argument("--app-name")
    args = parser.parse_args()
    output = args.output.resolve()
    if (output.exists() and not args.reopen_existing) or not output.is_relative_to(ROOT / ".phase4-acceptance"):
        parser.error("requires a fresh ignored acceptance directory")
    fixture = output / "fixture"
    if args.reopen_existing:
        if not (fixture / "root-review-intent.json").is_file():
            parser.error("original owned fixture required")
    else:
        fixture.mkdir(parents=True, mode=0o700)
    app_name = args.app_name or ("ShellSpan Recovery Current" if args.reopen_existing else "ShellSpan Recovery Acceptance")
    if not app_name.replace(" ", "").isalnum() or len(app_name) > 64:
        parser.error("short alphanumeric application name required")
    bundle = output / f"{app_name}.app"
    if bundle.exists():
        parser.error("each bundle must be newly created")
    executable = bundle / "Contents/MacOS/ShellSpan"
    executable.parent.mkdir(parents=True)
    shutil.copy2(ROOT / "src-tauri/target/debug/ShellSpan", executable)
    with (bundle / "Contents/Info.plist").open("wb") as handle:
        plistlib.dump({"CFBundleIdentifier": f"com.shellspan.stage2-recovery-{uuid.uuid4().hex}",
                      "CFBundleName": app_name, "CFBundleExecutable": "ShellSpan",
                      "CFBundlePackageType": "APPL", "CFBundleVersion": "1", "NSHighResolutionCapable": True}, handle)
    environment = os.environ | {"SHELLSPAN_SANDBOX_SETTINGS_DEV_URL": "http://127.0.0.1:1420",
                               "SHELLSPAN_SANDBOX_WORKBENCH_MODEL": "1"}
    command = [str(executable), "--native-sandbox-settings-check", str(fixture), "root-entry"]
    report = {"stageStatus": "pending", "resourceState": "unconfirmed", "bundle": str(bundle),
              "binarySha256": hashlib.sha256(executable.read_bytes()).hexdigest()}
    if args.reopen_existing:
        with (output / "current-reopen.log").open("w") as log:
            child = subprocess.Popen(command, cwd=ROOT, env=environment | {"SHELLSPAN_SANDBOX_WORKBENCH_REOPEN": "1"}, stdout=log, stderr=subprocess.STDOUT)
            report["pid"] = child.pid
            (output / "current-launch.json").write_text(json.dumps(report, indent=2) + "\n")
            report["exitCode"] = child.wait()
        (output / "current-final.json").write_text(json.dumps(report, indent=2) + "\n")
        return
    with (output / "seed.log").open("w") as log:
        child = subprocess.Popen(command, cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT)
        report["seedPid"] = child.pid
        (output / "launch.json").write_text(json.dumps(report, indent=2) + "\n")
        # The human/UI driver requests interruption only after actual journal and
        # owned command effects prove dispatch. Never adopt a historical PID.
        while child.poll() is None and not (output / "interrupt-owned-app").exists():
            time.sleep(0.2)
        if child.poll() is not None:
            report["seedExitCode"] = child.returncode
            report["reason"] = "App exited before the requested crash boundary"
        else:
            project = fixture / "owned-project"
            journals = list((fixture / "agent-runtime/sessions-v5").glob("*.jsonl"))
            records = [json.loads(line) for path in journals for line in path.read_text().splitlines() if line]
            dispatched = any("tool/execution" in json.dumps(record) for record in records)
            started = (project / "recovery-started").read_text() == "started" if (project / "recovery-started").is_file() else False
            if not dispatched or not started or (project / "recovery-ended").exists():
                report["reason"] = "Actual owned running dispatch boundary unavailable; no interruption performed"
            else:
                child.kill()
                report["seedExitCode"] = child.wait(timeout=10)
                report["actualDispatchAndStartedBeforeCrash"] = True
                with (output / "reopen.log").open("w") as reopened:
                    process = subprocess.Popen(command, cwd=ROOT,
                                               env=environment | {"SHELLSPAN_SANDBOX_WORKBENCH_REOPEN": "1"},
                                               stdout=reopened, stderr=subprocess.STDOUT)
                    report["reopenPid"] = process.pid
                    (output / "reopen-launch.json").write_text(json.dumps(report, indent=2) + "\n")
                    report["reopenExitCode"] = process.wait()
    (output / "launch-final.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
