"""Real Wry public IPC/model-only child and fleet; never whole-stage acceptance."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
SOURCES = [
    "src-tauri/src/agent_runtime/sandbox_settings_check.rs",
    "src-tauri/src/agent_runtime/subagent.rs",
    "src-tauri/src/agent_runtime/commands.rs",
    "src-tauri/src/keychain.rs",
    "src/components/ai/__tests__/sandbox-orchestration-native.tsx",
    "src/components/ai/__tests__/sandbox-orchestration-native.html",
    "src/lib/ipc/tauri.ts",
    "tests/agent-shell-sandbox-macos-ssh/verify_stage2_public_ipc.py",
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
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
              "stageStatus": "pending", "scope": "Actual public IPC and real scoped model-only child/fleet; no child shell or model-tool exposure claim"}
    started = time.monotonic()
    with (output / "wry.log").open("w") as log:
        try:
            result = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, timeout=250,
                                    env=os.environ | {"SHELLSPAN_SANDBOX_SETTINGS_DEV_URL": "http://127.0.0.1:1420",
                                                      "SHELLSPAN_SANDBOX_WORKBENCH_MODEL": "1",
                                                      "SHELLSPAN_SANDBOX_WORKBENCH_ORCHESTRATION": "1"})
            report["exitCode"] = result.returncode
        except subprocess.TimeoutExpired:
            report["exitCode"] = None
            report["resourceState"] = "unconfirmed after timeout; no historical PID cleanup"
    report["durationSeconds"] = round(time.monotonic() - started, 3)
    for name in ["orchestration-review", "settings-review"]:
        path = fixture / f"{name}.json"
        report[name] = json.loads(path.read_text()) if path.is_file() else None
    report["sourceUnchanged"] = hashes == {name: digest(ROOT / name) for name in SOURCES}
    report["binaryUnchanged"] = report["binarySha256"] == digest(binary)
    report["userKnownHostsUnchanged"] = before == [digest(path) for path in known]
    report["passed"] = (report["exitCode"] == 0 and report["orchestration-review"] is not None
                        and report["orchestration-review"]["passed"] is True
                        and report["sourceUnchanged"] and report["binaryUnchanged"] and report["userKnownHostsUnchanged"])
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report":str(output / "report.json"),"passed":report["passed"],"stageStatus":"pending"}))
    return 0 if report["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
