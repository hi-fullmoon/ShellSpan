"""Actual Wry/SSH verification-hook regression, never whole-stage acceptance."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import shutil
import plistlib
import uuid
import time

ROOT = Path(__file__).resolve().parents[2]
SOURCES = [
    "src/components/ai/workspace/use-remote-sandbox-verification.ts",
    "src/components/ai/workspace/use-ai-session-controller.ts",
    "src/components/ai/workspace/project-directory-input.tsx",
    "src/components/ai/__tests__/project-directory.browser.mjs",
    "src/components/ai/__tests__/sandbox-settings-native.tsx",
    "src/components/ai/__tests__/remote-verification-native.tsx",
    "src/components/ai/__tests__/remote-verification-native.html",
    "src-tauri/src/agent_runtime/sandbox_settings_check.rs",
    "src-tauri/src/agent_runtime/remote_backend_commands.rs",
    "src-tauri/src/agent_runtime/remote_seatbelt.rs",
    "src-tauri/src/known_hosts.rs",
    "src-tauri/src/keychain.rs",
    "src-tauri/src/tests/keychain_native_acceptance.rs",
    "src/lib/ai/error-message.ts",
    "src/lib/ai/__tests__/error-message.test.ts",
    "src/locales/zh-CN.ts",
    "src/locales/en-US.ts",
    "tests/agent-shell-sandbox-macos-ssh/verify_stage2.py",
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--bundle", action="store_true")
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to(ROOT / ".phase4-acceptance") or output.exists():
        parser.error("output must be a new directory in .phase4-acceptance")
    output.mkdir(parents=True, mode=0o700)
    fixture = output / "wry-regression"
    fixture.mkdir(mode=0o700)
    binary = ROOT / "src-tauri/target/debug/ShellSpan"
    bundle = None
    if args.bundle:
        bundle = output / "ShellSpan Verification Acceptance.app"
        executable = bundle / "Contents/MacOS/ShellSpan"
        executable.parent.mkdir(parents=True)
        shutil.copy2(binary, executable)
        with (bundle / "Contents/Info.plist").open("wb") as handle:
            plistlib.dump({"CFBundleIdentifier":f"com.shellspan.stage2-verification.{uuid.uuid4().hex}",
                          "CFBundleName":"ShellSpan Verification Acceptance", "CFBundleExecutable":"ShellSpan",
                          "CFBundlePackageType":"APPL", "CFBundleVersion":"1", "NSHighResolutionCapable":True},handle)
        binary = executable
    known_hosts = [Path.home() / name / "known_hosts" for name in [".shellspan", ".shellspan-dev"]]
    before = [digest(path) for path in known_hosts]
    hashes = {name: digest(ROOT / name) for name in SOURCES}
    command = [str(binary), "--native-sandbox-settings-check", str(fixture)]
    report = {
        "baseRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "sourceSha256": hashes,
        "binarySha256": digest(binary),
        "command": command,
        "stageStatus": "pending",
        "scope": "Real StrictMode verification hook and Wry SSH IPC; no main workbench/model/fleet acceptance",
    }
    started = time.monotonic()
    with (output / "wry.log").open("w") as log:
        process = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                                   env=os.environ | {"SHELLSPAN_SANDBOX_VERIFICATION_REGRESSION": "1",
                                                     "SHELLSPAN_SANDBOX_SETTINGS_DEV_URL": "http://127.0.0.1:1420"})
        (output / "launch.json").write_text(json.dumps({"pid":process.pid,"bundle":str(bundle) if bundle else None},indent=2))
        try:
            report["exitCode"] = process.wait(timeout=120)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            report["exitCode"] = None
            report["resourceState"] = "unconfirmed after owned wrapper timeout; no historical resource cleanup"
    report["durationSeconds"] = round(time.monotonic() - started, 3)
    report["userKnownHostsUnchanged"] = before == [digest(path) for path in known_hosts]
    report["sourceUnchanged"] = hashes == {name: digest(ROOT / name) for name in SOURCES}
    report["binaryUnchanged"] = report["binarySha256"] == digest(binary)
    facts = fixture / "verification-regression.json"
    report["regression"] = json.loads(facts.read_text()) if facts.is_file() else None
    report["passed"] = (report["exitCode"] == 0 and report["regression"] is not None
                        and report["regression"]["passed"] is True
                        and report["userKnownHostsUnchanged"] and report["sourceUnchanged"] and report["binaryUnchanged"])
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(output / "report.json"), "passed": report["passed"], "stageStatus": "pending"}))
    return 0 if report["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
