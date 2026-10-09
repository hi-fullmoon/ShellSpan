"""Export actual owned read approvals/results without bearer credentials."""
import argparse
import json
from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to(ROOT / ".phase4-acceptance"):
        parser.error("exact ignored fixture output required")
    launch = json.loads((output / "launch.json").read_text())
    owned_file = launch["ownedReadFile"]
    fixture = output / "fixture"
    rows = [json.loads(line) for path in (fixture / "agent-runtime/sessions-v5").glob("*.jsonl")
            for line in path.read_text().splitlines()]
    audits = []
    results = []
    for row in rows:
        if row["type"] == "sandbox/resource_audit":
            audit = row["data"]["audit"]
            audits.append({**{key: audit.get(key) for key in ["action", "scope", "bindingRevision", "callExpiresAtUnixMs", "sessionExpiresAtUnixMs", "cleanupConfirmed"]},
                           "resourceCount": len(audit["resources"]),
                           "onlyOwnedFile": bool(audit["resources"]) and all(resource.get("kind") == "readPath" and resource.get("path") == owned_file for resource in audit["resources"])})
        if row["type"] == "tool/result":
            data = row["data"].get("data") or {}
            results.append({"status": row["data"]["status"],
                            **{key: data.get(key) for key in ["exitCode", "terminationConfirmed", "sandboxBackend", "durationMs"]},
                            "stdoutMatchesOwnedFile": data.get("stdout") == "stage2-owned-read-input"})
    with sqlite3.connect(f"file:{fixture / 'agent-direct-ownership.sqlite3'}?mode=ro", uri=True) as db:
        debt = db.execute("SELECT count(*) FROM dispatch_debt").fetchone()[0]
    report = {"stageStatus": "pending", "scope": "actual model/approval/native journal and exact owned file; no restored authority inference",
              "modelRequests": sum(row["type"] == "request/start" for row in rows),
              "audits": audits, "results": results, "directDebt": debt,
              "ownedReadFileExists": Path(owned_file).is_file()}
    (output / "resource-facts.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(output / "resource-facts.json"), "stageStatus": "pending"}))


if __name__ == "__main__":
    main()
