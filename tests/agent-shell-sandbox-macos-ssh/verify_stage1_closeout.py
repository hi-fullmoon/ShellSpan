"""Real first-preflight interruption and repeated redaction/AppExit checks."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
SOURCES = [
    "src-tauri/src/agent_runtime/native/local_guardian.rs",
    "src-tauri/src/agent_runtime/native/terminal_interactive.rs",
    "src-tauri/src/agent_runtime/native_shutdown_check.rs",
    "src-tauri/src/agent_runtime/native_agent_check.rs",
    "tests/agent-shell-sandbox-macos-ssh/verify_stage1_closeout.py",
    "src-tauri/src/redaction.rs",
    "src-tauri/src/terminal_screen.rs",
    "src-tauri/src/agent_runtime/native/process.rs",
    "src-tauri/src/agent_runtime/native/macos_sandbox.rs",
    "src-tauri/src/agent_runtime/native/direct_ownership.rs",
    "src-tauri/src/agent_runtime/native/runtime.rs",
    "src-tauri/src/agent_runtime/native_adapter.rs",
    "src-tauri/src/agent_runtime/runtime.rs",
    "src-tauri/src/agent_runtime/commands.rs",
    "src-tauri/src/keychain.rs",
    "src-tauri/src/app_exit.rs",
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repetitions", type=int, default=20)
    parser.add_argument("--running-preflight", action="store_true")
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists() or not output.is_relative_to(ROOT / ".phase4-acceptance") or args.repetitions < 1:
        parser.error("use a fresh ignored directory and positive repetitions")
    output.mkdir(mode=0o700)
    binary = ROOT / "src-tauri/target/debug/ShellSpan"
    hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in SOURCES}
    report = {"sourceSha256": hashes, "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
              "baseRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "checks": [], "stageStatus": "pending"}

    def save():
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")

    def run(name, command, env=None, timeout=180):
        with (output / f"{name}.log").open("w") as log:
            try:
                code = subprocess.run(command, cwd=ROOT, env=env, stdout=log,
                                      stderr=subprocess.STDOUT, timeout=timeout).returncode
            except subprocess.TimeoutExpired:
                code = None
        report["checks"].append({"name": name, "exitCode": code})
        save()
        return code

    fixture = output / "preflight"
    fixture.mkdir(mode=0o700)
    env = os.environ | {"SHELLSPAN_NATIVE_SHUTDOWN_CHECK": "preflight-crash-seed",
                       "SHELLSPAN_PREFLIGHT_CHECK_ROOT": str(fixture)}
    env["SHELLSPAN_PREFLIGHT_RUNNING_CHECK"] = "1" if args.running_preflight else "0"
    child = None
    try:
        with (output / "preflight-seed.log").open("w") as log:
            child = subprocess.Popen([str(binary), "--native-agent-check", str(fixture), "normal"],
                                     cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 60
            while not (fixture / "preflight-ready.json").exists():
                assert child.poll() is None, "owned App exited before preflight checkpoint"
                assert time.monotonic() < deadline, "preflight checkpoint missing"
                time.sleep(0.005)
            ready = json.loads((fixture / "preflight-ready.json").read_text())
            assert ready["appPid"] == child.pid and ready["fixtureRoot"] == str(fixture)
            controller = ready["controllerPid"]
            process = subprocess.check_output(["ps", "-p", str(controller), "-o", "ppid=,stat="], text=True).split()
            assert int(process[0]) == child.pid and not process[1].startswith("Z")
            if args.running_preflight:
                shell = ready["shellPid"]
                deadline = time.monotonic() + 1
                while True:
                    actual = subprocess.check_output(["ps", "-p", str(shell), "-o", "ppid=,stat="], text=True).split()
                    assert int(actual[0]) == controller, "fixed Shell ownership changed"
                    if actual[1].startswith("T"):
                        break
                    assert time.monotonic() < deadline, "fixed Shell did not reach injected stop"
                    time.sleep(0.005)
                report["actualShellStoppedBeforeAppKill"] = True
            assert ready["receiptPending"] and all(Path(path).is_dir() for path in ready["directories"])
            journals = list((fixture / "state").rglob("agent-direct-ownership.sqlite3"))
            assert len(journals) == 1
            with sqlite3.connect(journals[0].as_uri() + "?mode=ro", uri=True) as db:
                assert db.execute("SELECT count(*) FROM dispatch_debt").fetchone()[0] == 1
            child.kill()
            assert child.wait(timeout=10) == -signal.SIGKILL
            report["preflightWindow"] = ready["window"]
            report["seedExitCode"] = -signal.SIGKILL
        (fixture / "preflight-release").touch(mode=0o600)
        deadline = time.monotonic() + 15
        while subprocess.run(["ps", "-p", str(controller)], stdout=subprocess.DEVNULL).returncode == 0:
            assert time.monotonic() < deadline, "owned controller did not exit"
            time.sleep(0.05)
        report["controllerGone"] = True
        if args.running_preflight:
            report["actualShellGone"] = subprocess.run(["ps", "-p", str(shell)], stdout=subprocess.DEVNULL).returncode != 0
            assert report["actualShellGone"], "fixed Shell survived controller termination"
        receipt_paths = list((fixture / "state").rglob("receipt.json"))
        report["receiptPresentBeforeRecovery"] = len(receipt_paths) == 1
        assert report["receiptPresentBeforeRecovery"], "signed receipt missing"
        env["SHELLSPAN_NATIVE_SHUTDOWN_CHECK"] = "preflight-crash-reopen"
        run("preflight-reopen", [str(binary), "--native-agent-check", str(fixture), "normal"], env)
        report["preflightRecovery"] = json.loads((fixture / "shutdown-check.json").read_text())
    except (AssertionError, OSError, ValueError, subprocess.SubprocessError) as error:
        report["preflightError"] = str(error)
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            child.wait(timeout=10)
        (fixture / "preflight-release").touch(mode=0o600)
        save()

    cargo = ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml"]
    run("unclosed-key-prompt", cargo + ["terminal_screen_blocks_prompt_after_unclosed_real_private_key", "--", "--test-threads=1"])
    for index in range(args.repetitions):
        run(f"redaction-{index + 1}", cargo + ["terminal_screen_redacts_real_private_keys_across_rows_and_wrapped_delimiters", "--", "--test-threads=1"])
        exit_fixture = output / f"exit-{index + 1}"
        exit_fixture.mkdir(mode=0o700)
        run(f"exit-{index + 1}", [str(binary), "--native-agent-check", str(exit_fixture), "normal"],
            os.environ | {"SHELLSPAN_NATIVE_SHUTDOWN_CHECK": "exit-active"})
    report["sourceUnchanged"] = all(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest for name, digest in hashes.items())
    report["binaryUnchanged"] = hashlib.sha256(binary.read_bytes()).hexdigest() == report["binarySha256"]
    report["failedChecks"] = [item["name"] for item in report["checks"] if item["exitCode"] != 0]
    report["passed"] = not report["failedChecks"] and report.get("preflightRecovery", {}).get("passed") is True and report["sourceUnchanged"] and report["binaryUnchanged"]
    save()
    print(json.dumps({"report": str(output / "report.json"), "passed": report["passed"], "failedChecks": report["failedChecks"], "stageStatus": "pending"}))
    raise SystemExit(0 if report["passed"] else 2)


if __name__ == "__main__":
    main()
