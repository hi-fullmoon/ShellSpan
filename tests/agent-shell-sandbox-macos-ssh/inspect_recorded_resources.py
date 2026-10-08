"""Read-only observations of exact stage-1 receipts and debt databases.

Never scans temp directories, signals a PID, deletes a file or reads custody.
Historical paths identify observations, not cleanup authority.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3


ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    evidence = ROOT / ".phase4-acceptance"
    if output.exists() or not output.is_relative_to(evidence):
        parser.error("output must be a fresh ignored directory")
    output.mkdir(mode=0o700)
    report = {"mode": "read-only", "sourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "recordedRemoteDirectories": [], "recordedLocalDirectories": [], "debtJournals": [],
              "unrecordedLocalResources": "uncertain: old local intents contain no authenticated cleanup receipt or exact owned temp path"}
    for run in sorted(evidence.glob("stage1-*")):
        if not run.is_dir() or run.is_symlink() or run == output:
            continue
        for receipt in sorted(run.rglob("local-ready.json")):
            if receipt.is_symlink():
                continue
            value = json.loads(receipt.read_text())
            if value.get("identifier") != "com.shellspan.native-shutdown-check":
                continue
            for raw in value.get("directories", []):
                path = Path(raw)
                if not path.is_absolute() or not path.name.startswith("shellspan-native-"):
                    raise ValueError("unexpected recorded local fixture path")
                report["recordedLocalDirectories"].append({"receipt": str(receipt.relative_to(ROOT)),
                    "path": str(path), "observation": "present" if path.exists() or path.is_symlink() else "absent",
                    "cleanupAuthority": False})
        for receipt in sorted(run.rglob("remote-ready.json")):
            if receipt.is_symlink():
                continue
            value = json.loads(receipt.read_text())
            if value.get("identifier") != "com.shellspan.native-remote-recovery-check":
                continue
            for raw in value.get("directories", []):
                path = Path(raw)
                if path.parent != Path("/private/tmp") or not path.name.startswith("shellspan-native-remote-"):
                    raise ValueError("unexpected recorded remote fixture path")
                report["recordedRemoteDirectories"].append({"receipt": str(receipt.relative_to(ROOT)),
                    "path": str(path), "observation": "present" if path.exists() or path.is_symlink() else "absent",
                    "cleanupAuthority": False})
        for database in sorted(run.rglob("agent-direct-ownership.sqlite3")):
            if database.is_symlink():
                continue
            try:
                with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
                    count = connection.execute("SELECT count(*) FROM dispatch_debt").fetchone()[0]
                report["debtJournals"].append({"path": str(database.relative_to(ROOT)), "debtCount": count})
            except sqlite3.Error:
                report["debtJournals"].append({"path": str(database.relative_to(ROOT)), "observation": "unavailable"})
    report["presentRecordedRemoteDirectories"] = sum(item["observation"] == "present" for item in report["recordedRemoteDirectories"])
    report["presentRecordedLocalDirectories"] = sum(item["observation"] == "present" for item in report["recordedLocalDirectories"])
    report["stageStatus"] = "pending"
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(output / "report.json"),
                      "recordedRemoteDirectories": len(report["recordedRemoteDirectories"]),
                      "presentRecordedRemoteDirectories": report["presentRecordedRemoteDirectories"],
                      "recordedLocalDirectories": len(report["recordedLocalDirectories"]),
                      "presentRecordedLocalDirectories": report["presentRecordedLocalDirectories"],
                      "debtJournals": len(report["debtJournals"]), "stageStatus": "pending"}))


if __name__ == "__main__":
    main()
