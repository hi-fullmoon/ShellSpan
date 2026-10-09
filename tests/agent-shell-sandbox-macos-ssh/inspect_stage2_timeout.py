"""Read-only facts for the exact recorded timeout; never owns or cleans resources."""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists() or not output.is_relative_to(ROOT / ".phase4-acceptance"):
        parser.error("output must be a new ignored acceptance directory")
    prior = ROOT / ".phase4-acceptance/stage2-public-ipc-r2-2026-10-09"
    fixture = prior / "fixture"
    original = json.loads((prior / "report.json").read_text())
    project = Path(json.loads((fixture / "root-review-intent.json").read_text())["projectRoot"])
    events = [json.loads(line) for path in (fixture / "agent-runtime/sessions-v5").glob("*.jsonl")
              for line in path.read_text().splitlines() if line]
    db = sqlite3.connect(f"file:{fixture / 'agent-direct-ownership.sqlite3'}?mode=ro", uri=True)
    debt = db.execute("SELECT count(*) FROM dispatch_debt").fetchone()[0]
    db.close()
    observed = subprocess.run(["lsof", "-a", "-d", "cwd", str(project)], capture_output=True, text=True)
    output.mkdir(parents=True, mode=0o700)
    (output / "cwd-observation.log").write_text(observed.stdout + observed.stderr)
    counts = dict(collections.Counter(event["type"] for event in events))
    report = {
        "priorReportSha256":hashlib.sha256((prior / "report.json").read_bytes()).hexdigest(),
        "sourceSha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "originalExitCode":original["exitCode"], "originalDurationSeconds":original["durationSeconds"],
        "eventTypes":counts, "directDebt":debt, "projectExists":project.exists(),
        "cwdObservationExitCode":observed.returncode, "cwdObservationEmpty":not observed.stdout.strip(),
        "toolDispatchObserved":counts.get("tool/execution",0)>0,
        "scope":"exact recorded project and journal only; no process scan, signals, keychain read or directory deletion",
        "terminationConfirmed":False,
        "remainingEvidence":"Original source PTY handle and complete app shutdown receipt were lost; no authority is reconstructed from cwd, PID or journal",
        "stageStatus":"pending",
    }
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report":str(output / "report.json"),"toolDispatchObserved":report["toolDispatchObserved"],"directDebt":debt,"terminationConfirmed":False}))


if __name__ == "__main__":
    main()
