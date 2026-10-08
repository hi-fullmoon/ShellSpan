"""Verify current stage-1 evidence and regressions without opening stage 2."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time


ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to(ROOT / ".phase4-acceptance") or output.exists():
        parser.error("output must be a new directory in .phase4-acceptance")
    evidence = json.loads(args.evidence.read_text())
    hashes = {
        name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
        for name in evidence["sourceSha256"]
    }
    output.mkdir(parents=True, mode=0o700)
    report = {
        "baseRevision": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "evidence": str(args.evidence.resolve()),
        "evidenceSha256": hashlib.sha256(args.evidence.read_bytes()).hexdigest(),
        "sourceSha256": hashes,
        "priorSourceHashesMatch": hashes == evidence["sourceSha256"],
        "priorStageStatus": evidence["stageStatus"],
        "priorGaps": evidence["gaps"],
        "checks": [],
        "stage2Status": "pending",
        "stage2GatePassed": False,
        "scope": "Existing evidence identity and current resource-layer regressions only; no workbench or model acceptance",
    }
    cargo = ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml"]
    for name, selection in [
        ("ownership", "direct_ownership"),
        ("process", "agent_runtime::native::process::tests"),
    ]:
        command = cargo + [selection, "--", "--test-threads=1"]
        started = time.monotonic()
        with (output / f"{name}.log").open("w") as log:
            result = subprocess.run(command, cwd=ROOT, stdout=log,
                                    stderr=subprocess.STDOUT, timeout=600)
        report["checks"].append({"name": name, "command": command,
                                 "exitCode": result.returncode,
                                 "durationSeconds": round(time.monotonic() - started, 3)})
    report["sourceUnchanged"] = all(
        hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest
        for name, digest in hashes.items())
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(output / "report.json"),
                      "stage2GatePassed": False,
                      "regressionsPassed": all(item["exitCode"] == 0 for item in report["checks"])}))
    # This verifier cannot certify the missing model/SSH/multi-session facts.
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
