"""Require original live expiry plus a separately approved real read after it."""
import argparse
import hashlib
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
        parser.error("exact owned evidence directory required")
    destination = output / "hour-evidence.json"
    if destination.exists():
        parser.error("preserve prior evidence")
    fixture = output / "fixture"
    initial = json.loads((fixture / "hour-initial.json").read_text())
    expired = json.loads((fixture / "hour-expired.json").read_text())
    finished = json.loads((fixture / "hour-acceptance.json").read_text())
    launch = json.loads((output / "launch.json").read_text())
    events = list(map(json.loads, (fixture / "agent-runtime/sessions-v5/hour-acceptance.jsonl").read_text().splitlines()))
    before, after = initial["authorization"], expired["authorization"]
    deadline = before["expiresAtUnixMs"]
    file = launch["ownedReadFile"]
    calls = [event for event in events if event["type"] == "tool/call"]
    audits = [event for event in events if event["type"] == "sandbox/resource_audit"]
    results = [event for event in events if event["type"] == "tool/result"]
    approvals = [event for event in events if event["type"] == "tool/approval" and event["data"]["status"] == "approved"]
    fresh = [event for event in events if event["type"] == "tool/approval" and event["data"]["status"] == "requested" and event["timeUnixMs"] >= deadline]
    checks = {
        "sameOriginalProcess": initial["pid"] == expired["pid"] == launch["pid"],
        "productionHourLifetime": 3_599_000 <= deadline - initial["auditAtUnixMs"] <= 3_601_000,
        "actualHourElapsed": expired["monotonicElapsedMs"] + expired["grantAgeAtObserverStartMs"] >= 3_599_000,
        "activeBefore": before["state"] == "active" and before["readPaths"] == [file],
        "expiredAfterDeadline": after["checkedAtUnixMs"] >= deadline and after["state"] == "expired" and after["readPaths"] == [],
        "exactTwoOwnedCalls": len(calls) == 2 and all(event["data"]["call"]["name"] == "run_terminal_command" and event["data"]["call"]["arguments"].get("command") == f"cat {file}" and event["data"]["call"]["arguments"].get("readPaths") == [file] for event in calls),
        "sessionThenFreshOnceAudit": len(audits) == 2 and audits[0]["data"]["audit"]["scope"] == "session" and audits[1]["timeUnixMs"] >= deadline and audits[1]["data"]["audit"]["scope"] == "once" and audits[1]["data"]["audit"]["action"] == "approved",
        "newExplicitApproval": len(approvals) == 2 and len(fresh) == 1 and approvals[1]["timeUnixMs"] >= deadline and approvals[1]["data"]["approvalId"] == fresh[0]["data"]["approvalId"] and approvals[0]["data"]["approvalId"] != approvals[1]["data"]["approvalId"],
        "actualNativeTerminals": len(results) == 2 and all(event["data"].get("data", {}).get("exitCode") == 0 and event["data"]["data"].get("terminationConfirmed") is True and event["data"]["data"].get("stdout") == "stage2-owned-read-input" for event in results),
        "backendVerdict": expired["passed"] is True and finished["passed"] is True,
    }
    with sqlite3.connect(f"file:{fixture / 'agent-direct-ownership.sqlite3'}?mode=ro", uri=True) as database:
        debt = database.execute("SELECT count(*) FROM dispatch_debt").fetchone()[0]
    checks["noDirectDebt"] = debt == 0
    report = {"passed": all(checks.values()), "checks": checks, "initial": initial, "expired": expired,
              "directDebt": debt, "stageStatus": "pending", "stage3Allowed": False,
              "scope": "original Runtime production one-hour expiry, actual MiniMax-M3 reads and distinct scoped approval after expiry",
              "artifacts": {name: hashlib.sha256((fixture / name).read_bytes()).hexdigest() for name in ["hour-initial.json", "hour-expired.json", "hour-acceptance.json"]},
              "binarySha256": launch["binarySha256"], "historicalTimeoutResources": "unconfirmed; untouched"}
    destination.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(destination), "passed": report["passed"]}))
    return 0 if report["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
