"""Interrupt only our live Wry Child; its independent controllers must clean up."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists() or not output.is_relative_to(ROOT / ".phase4-acceptance"):
        parser.error("output must be a fresh ignored directory")
    output.mkdir(mode=0o700)
    fixture = output / "fixture"
    fixture.mkdir(mode=0o700)
    binary = ROOT / "src-tauri/target/debug/ShellSpan"
    environment = os.environ.copy()
    environment["SHELLSPAN_NATIVE_SHUTDOWN_CHECK"] = "local-crash-seed"
    report = {"status": "pending", "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest()}
    with (output / "seed.log").open("w") as log:
        child = subprocess.Popen([str(binary), "--native-agent-check", str(fixture), "normal"], env=environment, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 90
        while not (fixture / "local-ready.json").exists():
            assert child.poll() is None, "owned Wry exited before readiness"
            assert time.monotonic() < deadline, "owned Wry did not reach running resources"
            time.sleep(0.05)
        ready = json.loads((fixture / "local-ready.json").read_text())
        assert ready["ready"] is True and ready["pid"] == child.pid and ready["fixtureRoot"] == str(fixture)
        assert ready["identifier"] == "com.shellspan.native-shutdown-check" and ready["sourcePtyWrites"] == 0
        child.kill()
        report["seedExitCode"] = child.wait(timeout=10)
        assert report["seedExitCode"] == -signal.SIGKILL
    time.sleep(5)
    environment["SHELLSPAN_NATIVE_SHUTDOWN_CHECK"] = "local-crash-reopen"
    with (output / "reopen.log").open("w") as log:
        reopened = subprocess.run([str(binary), "--native-agent-check", str(fixture), "normal"], env=environment, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, timeout=90)
    report["reopenExitCode"] = reopened.returncode
    actual = json.loads((fixture / "shutdown-check.json").read_text())
    report["status"] = "passed" if reopened.returncode == 0 and actual.get("passed") is True else "pending"
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))
    raise SystemExit(0 if report["status"] == "passed" else 2)


if __name__ == "__main__":
    main()
