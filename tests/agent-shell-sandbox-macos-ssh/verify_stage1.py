"""Run stage 1 on self-owned fixtures; save facts without claiming full acceptance."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import time


ROOT = Path(__file__).resolve().parents[2]
SOURCES = [
    "src-tauri/src/known_hosts.rs",
    "src-tauri/src/lib.rs",
    "src-tauri/src/agent_runtime/remote_native_check.rs",
    "src-tauri/src/agent_runtime/native_remote_recovery_check.rs",
    "src-tauri/src/agent_runtime/remote_cleanup.rs",
    "src/types/agent-execution.ts",
    "src/lib/ipc/tauri.ts",
    "src/lib/ai/error-message.ts",
    "src/locales/zh-CN.ts",
    "src/locales/en-US.ts",
    "tests/agent-shell-sandbox-phase-5/interrupt_owned_pipeline.py",
    "tests/agent-shell-sandbox-macos-ssh/verify_model_interruptions.py",
    "tests/agent-shell-sandbox-macos-ssh/verify_remote_lifecycle.py",
    "src-tauri/src/agent_runtime/commands.rs",
    "src-tauri/src/agent_runtime/native/macos_sandbox.rs",
    "src-tauri/src/agent_runtime/native_adapter.rs",
    "src-tauri/src/agent_runtime/native_shutdown_check.rs",
    "src-tauri/src/agent_runtime/native_restore_check.rs",
    "src-tauri/src/agent_runtime/native_pipeline_recovery_check.rs",
    "src-tauri/src/agent_runtime/native_model_recovery_check.rs",
    "src-tauri/src/agent_runtime/native/direct_ownership.rs",
    "src-tauri/src/agent_runtime/native/mod.rs",
    "src-tauri/src/agent_runtime/native/process.rs",
    "src-tauri/src/agent_runtime/native/runtime.rs",
    "src-tauri/src/agent_runtime/remote_seatbelt.py",
    "src-tauri/src/agent_runtime/remote_seatbelt.rs",
    "src-tauri/src/agent_runtime/runtime.rs",
    "src-tauri/src/agent_runtime/tests/remote_seatbelt.rs",
    "src-tauri/src/agent_runtime/tests/remote_seatbelt_engine.rs",
    "src-tauri/src/agent_runtime/tests/remote_seatbelt_recovery.rs",
    "tests/agent-shell-sandbox-macos-ssh/verify_stage1.py",
    "src-tauri/src/agent_runtime/mod.rs",
    "src-tauri/src/agent_runtime/native/capability.rs",
    "src-tauri/src/agent_runtime/native/mcp.rs",
    "src-tauri/src/agent_runtime/registry.rs",
    "src-tauri/src/agent_runtime/sandbox.rs",
    "src-tauri/src/agent_runtime/sandbox_authorization.rs",
    "src-tauri/src/agent_runtime/session.rs",
    "src-tauri/src/agent_runtime/tool_boundary.rs",
    "src-tauri/src/app_exit.rs",
    "src-tauri/src/connection.rs",
    "src-tauri/src/db.rs",
    "src-tauri/src/execution/mod.rs",
    "src-tauri/src/execution/ssh.rs",
    "src-tauri/src/main.rs",
    "src-tauri/src/port_forward.rs",
    "src-tauri/src/keychain.rs",
    "src-tauri/src/agent_runtime/native/local_guardian.rs",
    "src-tauri/src/agent_runtime/native/network_proxy.rs",
    "src-tauri/src/agent_runtime/native_contract/types.rs",
    "src-tauri/src/agent_runtime/native_agent_check.rs",
    "tests/agent-shell-sandbox-macos-ssh/verify_local_crash.py",
    "src-tauri/src/agent_runtime/tests/sandbox_audit.rs",
    "src-tauri/src/agent_runtime/tests/macos_direct.rs",
    "src/lib/ai/__tests__/error-message.test.ts",
    "src-tauri/src/agent_runtime/native/terminal_interactive.rs",
    "tests/agent-shell-sandbox-macos-ssh/verify_stage1_closeout.py",
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--complete-recovery", action="store_true", help="explicit real selected-model and self-owned SSH App crash acceptance")
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to(ROOT / ".phase4-acceptance") or output.exists():
        parser.error("output must be a new directory inside the ignored .phase4-acceptance tree")
    output.mkdir(parents=True, mode=0o700)
    facts = output / "facts"
    facts.mkdir(mode=0o700)
    env = os.environ.copy()
    env["SHELLSPAN_STAGE1_EVIDENCE_DIR"] = str(facts)
    report = {
        "baseRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "sourceSha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in SOURCES},
        "environment": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
        "checks": [],
        "stageStatus": "pending",
        "gaps": ["No indefinite-offline or hostile-descendant claim", "Actual different SSH accounts need a second authorized ordinary account", "Historical resources without protected ownership custody remain uncertain"],
    }

    def save():
        pending = output / "report.pending.json"
        pending.write_text(json.dumps(report, indent=2) + "\n")
        pending.replace(output / "report.json")

    def run(name, command, overrides=None, timeout=600):
        print(f"Running {name}", flush=True)
        started = time.monotonic()
        selected_env = env | (overrides or {})
        with (output / f"{name}.log").open("w") as log:
            try:
                result = subprocess.run(command, cwd=ROOT, env=selected_env, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
                code = result.returncode
            except subprocess.TimeoutExpired:
                code = None
        item = {"name": name, "command": command, "exitCode": code, "durationSeconds": round(time.monotonic() - started, 3)}
        report["checks"].append(item)
        save()
        return code == 0

    cargo = ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml"]
    native_built = run("native-build", ["cargo", "build", "--manifest-path", "src-tauri/Cargo.toml"])
    run("rust-process-regression", cargo + ["agent_runtime::native::process::tests", "--", "--test-threads=1"])
    run("rust-ownership-regression", cargo + ["direct_ownership", "--", "--test-threads=1"])
    run("rust-local-receipts", cargo + ["local_guardian", "--", "--test-threads=1"])
    for name, test in [
        ("ssh-native-lifecycle", "agent_runtime::remote_seatbelt::tests::remote_native_lower_layer_freezes_sftp_root_transports_stdin_denies_and_cleans"),
        ("ssh-offline-reconnect", "agent_runtime::remote_seatbelt::tests::recovery_tests::offline_reconnect_keeps_cleanup_debt_and_never_reuses_execution_authority"),
        ("ssh-old-grants", "agent_runtime::remote_seatbelt::tests::engine_tests::remote_native_engine_signed_approval_and_reverification_never_revive_old_grants"),
    ]:
        run(name, cargo + [test, "--", "--ignored", "--exact"])
    run("rust-full", cargo)
    run("frontend-tests", ["pnpm", "test"])
    run("frontend-build", ["pnpm", "build"])
    for name, command in [
        ("rust-fmt", ["cargo", "fmt", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"]),
        ("rust-includes", ["pnpm", "check:rust:includes"]),
        ("ai-styles", ["pnpm", "check:ai-styles"]),
        ("llm-catalog", ["pnpm", "check:llm:catalog"]),
    ]:
        run(name, command)
    if native_built:
        binary = ROOT / "src-tauri/target/debug/ShellSpan"
        report["nativeBinarySha256"] = hashlib.sha256(binary.read_bytes()).hexdigest()
        if args.complete_recovery:
            for name, command in [
                ("stage1-closeout", ["python3", "tests/agent-shell-sandbox-macos-ssh/verify_stage1_closeout.py", "--output", str(output / "closeout")]),
                ("stage1-running-preflight", ["python3", "tests/agent-shell-sandbox-macos-ssh/verify_stage1_closeout.py", "--running-preflight", "--output", str(output / "closeout-running")]),
                ("local-app-crash", ["python3", "tests/agent-shell-sandbox-macos-ssh/verify_local_crash.py", "--output", str(output / "local-crash")]),
                ("model-waiting-interrupt", ["python3", "tests/agent-shell-sandbox-macos-ssh/verify_model_interruptions.py", "--output", str(output / "model-waiting")]),
                ("model-unknown-interrupt", ["python3", "tests/agent-shell-sandbox-macos-ssh/verify_model_interruptions.py", "--output", str(output / "model-unknown"), "--unknown"]),
                ("multi-remote-sessions", ["python3", "tests/agent-shell-sandbox-macos-ssh/verify_remote_lifecycle.py", "--output", str(output / "multi-remote")]),
                ("ssh-app-crash", ["python3", "tests/agent-shell-sandbox-macos-ssh/verify_remote_lifecycle.py", "--output", str(output / "ssh-crash"), "--crash"]),
            ]:
                run(name, command)
        for name, mode in [("wry-exit", "exit-active"), ("wry-restore", "restore-seed")]:
            fixture = output / name
            fixture.mkdir(mode=0o700)
            run(mode, [str(binary), "--native-agent-check", str(fixture), "normal"], {"SHELLSPAN_NATIVE_SHUTDOWN_CHECK": mode}, timeout=120)
            if mode == "restore-seed":
                run("restore-reopen", [str(binary), "--native-agent-check", str(fixture), "normal"], {"SHELLSPAN_NATIVE_SHUTDOWN_CHECK": "restore-reopen"}, timeout=120)
    report["sourceUnchanged"] = all(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest for name, digest in report["sourceSha256"].items())
    save()
    print(json.dumps({"report": str(output / "report.json"), "failedChecks": [check["name"] for check in report["checks"] if check["exitCode"] != 0], "stageStatus": "pending"}))


if __name__ == "__main__":
    main()
