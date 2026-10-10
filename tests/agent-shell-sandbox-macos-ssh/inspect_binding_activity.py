"""Inspect the exact live owned SSH activity fixture; never infer historical cleanup."""
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
    destination = output / "binding-activity-evidence.json"
    if not output.is_relative_to(ROOT / ".phase4-acceptance") or destination.exists():
        parser.error("use the exact owned fixture and preserve previous reports")
    fixture = output / "fixture"
    read = lambda name: json.loads((fixture / name).read_text())
    pages = [[json.loads(line) for line in path.read_text().splitlines()]
             for path in (fixture / "agent-runtime/sessions-v5").glob("*.jsonl")]
    old = next(page for page in pages if page[0]["sessionId"] == "binding-activity")
    fresh = next(page for page in pages if page[0]["sessionId"] != "binding-activity"
                 and any(row["type"] == "tool/result" and row["data"].get("data", {}).get("terminationConfirmed") is True for row in page))
    old_root = Path(read("root-review-intent.json")["projectRoot"])
    new_root = Path(read("binding-new-project.json")["rootPath"])
    started, process = read("binding-started-observed.json"), read("binding-process-observed.json")
    disconnected, connected = read("binding-disconnected.json"), read("binding-reconnected.json")
    facts_ax = (output / "activity-facts.ax.txt").read_text()
    # Web Inspector truncates long log previews. Decode the complete scalar
    # fields with the standard JSON decoder; never reconstruct omitted facts.
    def scalar(name):
        marker = f'"{name}":'
        index = facts_ax.index(marker) + len(marker)
        return json.JSONDecoder().raw_decode(facts_ax[index:])[0]
    binding_error, policy_error = scalar("bindingError"), scalar("policyError")
    running = next(row["data"]["data"] for row in old if row["type"] == "tool/result")
    audits = [row for row in old if row["type"] == "sandbox/resource_audit"]
    result = next(row["data"]["data"] for row in fresh if row["type"] == "tool/result")
    old_approval = next(row for row in old if row["type"] == "tool/approval" and row["data"]["status"] == "approved")
    new_approval = next(row for row in fresh if row["type"] == "tool/approval" and row["data"]["status"] == "approved")
    resources = json.loads((output / "resource-terminal.json").read_text())
    with sqlite3.connect(f"file:{fixture / 'agent-direct-ownership.sqlite3'}?mode=ro", uri=True) as db:
        debt = db.execute("SELECT count(*) FROM dispatch_debt").fetchone()[0]
        custody = db.execute("SELECT count(*) FROM remote_cleanup_custody").fetchone()[0]
    checks = {
        "actualModelAndBackground": any(row["type"] == "request/start" for row in old)
            and running["lifecycle"] == "running" and running["sandboxBackend"] == "remote-macos-seatbelt",
        "startedObservedOverSftpBeforeDisconnect": started["value"] == "started"
            and started["observedAtUnixMs"] < disconnected["observedAtUnixMs"],
        "actualStartEffect": (old_root / "binding-background-started").read_text() == "started",
        "activityRootMutationRejected": binding_error.startswith("Busy:") or "already bound" in binding_error,
        "activityPolicyMutationRejected": policy_error.startswith("SANDBOX_POLICY_BUSY:"),
        "connectionGenerationChanged": bool(disconnected["beforeGeneration"]) and disconnected["afterGeneration"] is None
            and bool(connected["afterGeneration"]) and connected["afterGeneration"] != disconnected["beforeGeneration"],
        "exactOwnedProcessTerminal": process["processHandle"] == running["processHandle"]
            and process["taskId"] == "binding-activity" and process["terminationConfirmed"] is True
            and process["state"] == "failed" and "remote connection binding changed" in process["error"],
        "confirmedCleanupAudit": any(row["data"]["audit"]["action"] == "revoked"
            and row["data"]["audit"]["cleanupConfirmed"] is True
            and row["timeUnixMs"] >= process["completedAtUnixMs"] for row in audits),
        "oldEndEffectAbsent": not (old_root / "binding-background-ended").exists(),
        "originalRootAndPolicyPreserved": old[0]["data"]["target"]["rootPath"] == str(old_root)
            and old[0]["data"]["sandboxPolicy"] == "workspace"
            and not any(row["type"] in ["session/project_root_bound", "session/sandbox_policy_changed"] for row in old),
        "freshNewRootSameAccount": fresh[0]["data"]["target"]["rootPath"] == str(new_root)
            and new_root.resolve() != old_root.resolve()
            and all(old[0]["data"]["target"][key] == fresh[0]["data"]["target"][key]
                    for key in ["sessionId", "profileId", "host", "port", "username"]),
        "freshIndependentApprovalAfterCleanup": old_approval["data"]["approvalId"] != new_approval["data"]["approvalId"]
            and new_approval["timeUnixMs"] > max(row["timeUnixMs"] for row in audits),
        "freshRestrictedConfirmedResult": result["exitCode"] == 0 and result["terminationConfirmed"] is True
            and result["sandboxBackend"] == "remote-macos-seatbelt" and not result["sandboxContract"]["resourceGrants"],
        "freshExactNewRootEffect": (new_root / "binding-fresh").read_text() == "fresh"
            and not (old_root / "binding-fresh").exists(),
        "realStoppedUi": "已停止" in (output / "activity-stopped.ax.txt").read_text(),
        "realFreshApprovedUi": "已批准" in (output / "rebound-terminal.ax.txt").read_text()
            and "已完成" in (output / "rebound-terminal.ax.txt").read_text()
            and (output / "rebound-pending.png").stat().st_size > 0,
        "actualResourcesNone": all(row["state"] == "none" and row["activeProcesses"] == 0
            and not any(row[key] for key in ["readPaths", "writePaths", "networkTargets", "localServices"])
            for row in resources.values()),
        "noDebtOrCustody": debt == 0 and custody == 0,
        "sourcePtyUntouched": disconnected["sourcePtyWrites"] == connected["sourcePtyWrites"] == 0,
    }
    report = {"passed": all(checks.values()), "checks": checks, "stage3Allowed": False,
              "scope": "actual started SSH background work, reconnect cleanup and fresh explicit UI approval in a new owned project",
              "differentActualAccounts": "deferred", "historicalResources": "unconfirmed and untouched",
              "oldSession": "binding-activity", "freshSession": fresh[0]["sessionId"],
              "sourceSha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in
                               ["src-tauri/src/agent_runtime/native_adapter.rs", "src-tauri/src/agent_runtime/tool_pipeline.rs"]}}
    destination.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(destination), "passed": report["passed"], "checks": len(checks)}))
    return 0 if report["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
