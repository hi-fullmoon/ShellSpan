"""Launch an independent own bundle so UI control cannot select the user's App."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--local", action="store_true")
    parser.add_argument("--replay-journal", type=Path)
    parser.add_argument("--app-name")
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists() or not output.is_relative_to(ROOT / ".phase4-acceptance"):
        parser.error("output must be a new ignored acceptance directory")
    fixture = output / "fixture"
    fixture.mkdir(parents=True, mode=0o700)
    replay = args.replay_journal.resolve() if args.replay_journal else None
    if replay:
        if not args.local or not replay.is_relative_to(ROOT / ".phase4-acceptance") or not replay.is_file() or replay.suffix != ".jsonl":
            parser.error("replay requires an exact owned ignored journal and local mode")
    app_name = args.app_name or ("ShellSpan Local Acceptance" if args.local else "ShellSpan Remote Acceptance")
    if not app_name.replace(" ", "").isalnum() or len(app_name) > 64:
        parser.error("short alphanumeric application name required")
    bundle = output / f"{app_name}.app"
    contents = bundle / "Contents"
    executable = contents / "MacOS" / "ShellSpan"
    executable.parent.mkdir(parents=True)
    source = ROOT / "src-tauri/target/debug/ShellSpan"
    shutil.copy2(source, executable)
    with (contents / "Info.plist").open("wb") as handle:
        plistlib.dump({"CFBundleIdentifier":f"com.shellspan.stage2-acceptance-{uuid.uuid4().hex}",
                      "CFBundleName":app_name, "CFBundleDisplayName":app_name,
                      "CFBundleExecutable":"ShellSpan", "CFBundlePackageType":"APPL",
                      "CFBundleVersion":"1", "NSHighResolutionCapable":True}, handle)
    names = ["src-tauri/src/keychain.rs","src-tauri/src/agent_runtime/sandbox_settings_check.rs",
             "src-tauri/src/agent_runtime/tests/remote_seatbelt.rs", "src/components/ai/__tests__/sandbox-settings-native.tsx",
             "src/components/ai/workspace/use-ai-session-controller.ts", "src/components/ai/workspace/use-remote-sandbox-verification.ts",
             "src/lib/ai/agent-session-adapter.ts", "src-tauri/src/agent_runtime/session.rs",
             "src-tauri/src/agent_runtime/sandbox_audit.rs", "src-tauri/src/agent_runtime/tests/sandbox_audit.rs",
             "src-tauri/src/agent_runtime/native/runtime.rs", "src-tauri/src/agent_runtime/native_adapter.rs",
             "src-tauri/src/agent_runtime/tests/external_read.rs", "src/components/ai/workspace/ai-approval-panel.tsx",
             "src/lib/ai/conversation-projection.ts",
             "src-tauri/src/agent_runtime/tool_pipeline.rs", "src/components/ai/__tests__/sandbox-binding-native.ts"]
    report = {"binarySha256":hashlib.sha256(executable.read_bytes()).hexdigest(),
              "sourceSha256":{name:hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in names},
              "scope":"independent bundle, actual controller/remote fixture/model; no automatic approval or stage pass",
              "stageStatus":"pending", "bundle":str(bundle)}
    if replay:
        report["replayJournalSha256"] = hashlib.sha256(replay.read_bytes()).hexdigest()
        report["replayScope"] = "verbatim owned committed history only; no database, credential, live grant or resource ownership copied"
    if args.local:
        resource_root = Path(tempfile.mkdtemp(prefix="shellspan-stage2-owned-read-")).resolve()
        resource_file = resource_root / "read-input.txt"
        resource_file.write_text("stage2-owned-read-input")
        report["ownedReadFile"] = str(resource_file)
        report["ownedReadFileCleanup"] = "retained; only this newly created exact resource is owned, no historical cleanup inferred"
    command = [str(executable),"--native-sandbox-settings-check",str(fixture),"root-entry"]
    with (output / "wry.log").open("w") as log:
        process = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                                   env=os.environ | {"SHELLSPAN_SANDBOX_SETTINGS_DEV_URL":"http://127.0.0.1:1420",
                                                     "SHELLSPAN_SANDBOX_WORKBENCH_REMOTE":"0" if args.local else "1",
                                                     "SHELLSPAN_SANDBOX_WORKBENCH_MODEL":"1",
                                                     **({"SHELLSPAN_SANDBOX_REVIEW_REPLAY_JOURNAL":str(replay)} if replay else {})})
        report["pid"] = process.pid
        (output / "launch.json").write_text(json.dumps(report, indent=2) + "\n")
        code = process.wait()
    report["exitCode"] = code
    report["sourceUnchanged"] = all(hashlib.sha256((ROOT / name).read_bytes()).hexdigest()==sha for name,sha in report["sourceSha256"].items())
    report["binaryUnchanged"] = hashlib.sha256(executable.read_bytes()).hexdigest()==report["binarySha256"]
    if replay:
        report["originalJournalUnchanged"] = hashlib.sha256(replay.read_bytes()).hexdigest()==report["replayJournalSha256"]
    (output / "launch-final.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report":str(output / "launch-final.json"),"exitCode":code,"stageStatus":"pending"}))


if __name__ == "__main__":
    main()
