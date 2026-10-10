"""Cross-check actual public-IPC activity observations against durable own journals."""
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
    destination = output / "activity-evidence.json"
    if destination.exists():
        parser.error("preserve previous reports")
    fixture = output / "fixture"
    ax = (output / "activity-final.ax.txt").read_text()
    prefix = '"activityChecks":'
    position = ax.find(prefix)
    if position < 0:
        parser.error("actual console check summary required")
    checks, _ = json.JSONDecoder().raw_decode(ax[position + len(prefix):])
    if not isinstance(checks, dict) or any(type(value) is not bool for value in checks.values()):
        parser.error("actual fixed boolean check summary required")
    pages = [list(map(json.loads, path.read_text().splitlines())) for path in (fixture / "agent-runtime/sessions-v5").glob("*.jsonl")]
    observed = []
    for kind in ["child", "fleet"]:
        candidates = []
        for page in pages:
            created = page[0]
            parent_id = created["data"].get("parentSessionId")
            if not parent_id:
                continue
            command = f"printf started > {kind}-{parent_id}-started; sleep 90; printf ended > {kind}-{parent_id}-ended"
            if any(event["type"] == "tool/call" and event["data"]["call"].get("arguments", {}).get("command") == command for event in page):
                candidates.append(page)
        page = max(candidates, key=lambda value: value[0]["timeUnixMs"])
        created = page[0]
        header = created["data"]
        parent_id = header["parentSessionId"]
        project = Path(header["target"]["cwd"])
        root = fixture / "owned-project"
        rebound = root / ("child-rebind" if kind == "child" else "fleet-rebind")
        later = [candidate for candidate in pages if candidate[0]["timeUnixMs"] > created["timeUnixMs"] and candidate[0]["data"].get("target", {}).get("cwd") == str(rebound) and not candidate[0]["data"].get("parentSessionId")]
        facts = {"kind": kind, "parentSessionId": parent_id, "childSessionId": created["sessionId"],
                 "oldRoot": str(project), "newRoot": str(rebound),
                 "newSessionId": max(later, key=lambda value: value[0]["timeUnixMs"])[0]["sessionId"],
                 "actualModelRequest": any(event["type"] == "request/start" for event in page),
                 "backgroundRunningResult": any(event["type"] == "tool/result" and (event["data"].get("data") or {}).get("lifecycle") == "running" for event in page),
                 "durableCancellation": any(event["type"] == "session/ended" and event["data"]["status"] == "cancelled" for event in page),
                 "startedMatches": (project / f"{kind}-{parent_id}-started").read_text() == "started",
                 "endedAbsent": not (project / f"{kind}-{parent_id}-ended").exists(),
                 "inheritedWorkspaceApproval": header.get("sandboxPolicy") == "workspace" and header.get("permissionMode") == "requestApproval" and header.get("executionSurface") == "direct"}
        if kind == "fleet":
            parent_page = next(candidate for candidate in pages if candidate[0]["sessionId"] == parent_id)
            facts["fleetAborted"] = any(event["type"] == "task/state" and (event["data"].get("fleet") or {}).get("status") == "aborted" for event in parent_page)
            facts["rolesObserved"] = sorted({candidate[0]["data"].get("subagent", {}).get("role") for candidate in pages if candidate[0]["data"].get("parentSessionId") == parent_id})
        observed.append(facts)
    with sqlite3.connect(f"file:{fixture / 'agent-direct-ownership.sqlite3'}?mode=ro", uri=True) as database:
        debt = database.execute("SELECT count(*) FROM dispatch_debt").fetchone()[0]
        custody = database.execute("SELECT count(*) FROM remote_cleanup_custody").fetchone()[0]
    passed = len(checks) == 15 and all(checks.values()) and debt == 0 and custody == 0 and all(all(value for value in facts.values() if isinstance(value, bool)) for facts in observed)
    source_names = ["src-tauri/src/agent_runtime/subagent.rs", "src-tauri/src/agent_runtime/runtime.rs", "src/lib/ai/agent-session-projection.ts", "src/components/ai/__tests__/sandbox-activity-native.ts"]
    report = {"passed": passed, "checks": checks, "facts": observed, "directDebt": debt, "remainingCustody": custody,
              "stageStatus": "pending", "stage3Allowed": False, "historicalTimeoutResources": "unconfirmed; untouched",
              "scope": "actual child and fleet Operator background resources, cancellation, immutable old roots and explicitly selected fresh conversations; fleet aborted while active, not completed four-role acceptance",
              "sourceSha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in source_names},
              "uiEvidenceSha256": hashlib.sha256((output / "activity-final.ax.txt").read_bytes()).hexdigest()}
    destination.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(destination), "passed": passed}))
    return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
