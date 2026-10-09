"""Real Wry public IPC/model-only child and fleet; never whole-stage acceptance."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sqlite3
import time

ROOT = Path(__file__).resolve().parents[2]
SOURCES = [
    "src-tauri/src/agent_runtime/sandbox_settings_check.rs",
    "src-tauri/src/agent_runtime/subagent.rs",
    "src-tauri/src/agent_runtime/commands.rs",
    "src-tauri/src/keychain.rs",
    "src-tauri/src/agent_runtime/native/runtime.rs",
    "src-tauri/src/agent_runtime/native_adapter.rs",
    "src/components/ai/__tests__/sandbox-orchestration-native.tsx",
    "src/components/ai/__tests__/sandbox-orchestration-native.html",
    "src/components/ai/__tests__/sandbox-child-native.tsx",
    "src/components/ai/__tests__/sandbox-child-native.html",
    "src/components/ai/__tests__/sandbox-fleet-native.tsx",
    "src/components/ai/__tests__/sandbox-fleet-native.html",
    "src/lib/ipc/tauri.ts",
    "tests/agent-shell-sandbox-macos-ssh/verify_stage2_public_ipc.py",
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--child-native", action="store_true")
    modes.add_argument("--fleet-native", action="store_true")
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists() or not output.is_relative_to(ROOT / ".phase4-acceptance"):
        parser.error("output must be a new ignored acceptance directory")
    output.mkdir(parents=True, mode=0o700)
    fixture = output / "fixture"
    fixture.mkdir(mode=0o700)
    binary = ROOT / "src-tauri/target/debug/ShellSpan"
    known = [Path.home() / name / "known_hosts" for name in [".shellspan", ".shellspan-dev"]]
    before = [digest(path) for path in known]
    hashes = {name: digest(ROOT / name) for name in SOURCES}
    command = [str(binary), "--native-sandbox-settings-check", str(fixture), "root-entry"]
    report = {"sourceSha256": hashes, "binarySha256": digest(binary), "command": command,
              "baseRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "stageStatus": "pending", "scope": "Actual public IPC fleet Operator command; no active fleet cancellation claim" if args.fleet_native else "Actual public IPC child command with exact owned approval; no fleet native claim" if args.child_native else "Actual public IPC and real scoped model-only child/fleet; no child shell or model-tool exposure claim"}
    started = time.monotonic()
    with (output / "wry.log").open("w") as log:
        try:
            result = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, timeout=400 if args.fleet_native else 250,
                                    env=os.environ | {"SHELLSPAN_SANDBOX_SETTINGS_DEV_URL": "http://127.0.0.1:1420",
                                                      "SHELLSPAN_SANDBOX_WORKBENCH_MODEL": "1",
                                                      "SHELLSPAN_SANDBOX_WORKBENCH_ORCHESTRATION": "1",
                                                      "SHELLSPAN_SANDBOX_CHILD_NATIVE": "1" if args.child_native else "0",
                                                      "SHELLSPAN_SANDBOX_FLEET_NATIVE": "1" if args.fleet_native else "0"})
            report["exitCode"] = result.returncode
        except subprocess.TimeoutExpired:
            report["exitCode"] = None
            report["resourceState"] = "unconfirmed after timeout; no historical PID cleanup"
    report["durationSeconds"] = round(time.monotonic() - started, 3)
    review_name = "fleet-native-review" if args.fleet_native else "child-native-review" if args.child_native else "orchestration-review"
    for name in [review_name, "settings-review"]:
        path = fixture / f"{name}.json"
        report[name] = json.loads(path.read_text()) if path.is_file() else None
    report["sourceUnchanged"] = hashes == {name: digest(ROOT / name) for name in SOURCES}
    report["binaryUnchanged"] = report["binarySha256"] == digest(binary)
    report["userKnownHostsUnchanged"] = before == [digest(path) for path in known]
    debt = fixture / "agent-direct-ownership.sqlite3"
    report["directDebt"] = None
    if debt.is_file():
        with sqlite3.connect(f"file:{debt}?mode=ro", uri=True) as database:
            report["directDebt"] = database.execute("SELECT count(*) FROM dispatch_debt").fetchone()[0]
    report["passed"] = (report["exitCode"] == 0 and report[review_name] is not None
                        and report[review_name]["passed"] is True
                        and report["sourceUnchanged"] and report["binaryUnchanged"] and report["userKnownHostsUnchanged"]
                        and report["directDebt"] == 0)
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report":str(output / "report.json"),"passed":report["passed"],"stageStatus":"pending"}))
    return 0 if report["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
