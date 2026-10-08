"""Interrupt only announced, identity-checked self-owned real-model Wry Apps."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--unknown", action="store_true")
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists() or not output.is_relative_to(ROOT / ".phase4-acceptance"):
        parser.error("output must be a fresh directory in the ignored acceptance tree")
    output.mkdir(parents=True, mode=0o700)
    fixture = output / ("shellspan-phase5-pipeline-model-unknown" if args.unknown else "shellspan-phase5-pipeline-model-waiting")
    fixture.mkdir(mode=0o700)
    binary = ROOT / "src-tauri/target/debug/ShellSpan"
    mode = "model-unknown" if args.unknown else "model-waiting"
    report = {"mode": mode, "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "status": "pending"}
    environment = os.environ.copy()
    environment["SHELLSPAN_NATIVE_SHUTDOWN_CHECK"] = mode + "-seed"
    print(f"Running actual {mode} seed", flush=True)
    with (output / "seed.log").open("w") as log:
        child = subprocess.Popen([str(binary), "--native-agent-check", str(fixture), "normal"], cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 180
        while not (fixture / "pipeline-ready.json").exists():
            if child.poll() is not None:
                report["seedExitCode"] = child.returncode
                report["reason"] = "seed exited before publishing a real model boundary"
                break
            if time.monotonic() >= deadline:
                # No identity-announced readiness means no forced interruption.
                report["reason"] = "readiness deadline elapsed; owned application left to its own bounded cleanup"
                break
            time.sleep(0.1)
        else:
            with (output / "interrupt.log").open("w") as interrupt:
                result = subprocess.run(["python3", "tests/agent-shell-sandbox-phase-5/interrupt_owned_pipeline.py", str(fixture)], cwd=ROOT, stdout=interrupt, stderr=subprocess.STDOUT, timeout=15)
            report["interruptExitCode"] = result.returncode
            if result.returncode == 0:
                report["seedExitCode"] = child.wait(timeout=10)
                # Existing reopen code also checks every recorded PID/starttime.
                time.sleep(8 if args.unknown else 2)
                print(f"Running actual {mode} reopen", flush=True)
                environment["SHELLSPAN_NATIVE_SHUTDOWN_CHECK"] = mode + "-reopen"
                with (output / "reopen.log").open("w") as reopened:
                    result = subprocess.run([str(binary), "--native-agent-check", str(fixture), "normal"], cwd=ROOT, env=environment, stdout=reopened, stderr=subprocess.STDOUT, timeout=180)
                report["reopenExitCode"] = result.returncode
                actual = json.loads((fixture / "model-recovery-result.json").read_text())
                report["status"] = "passed" if result.returncode == 0 and actual.get("passed") is True else "pending"
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))
    raise SystemExit(0 if report["status"] == "passed" else 2)


if __name__ == "__main__":
    main()
