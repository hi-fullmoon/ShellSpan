"""Cross-check real owned SSH generations, model journals, UI and resource facts."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[2]
PRODUCTION = ["src-tauri/src/agent_runtime/native_adapter.rs",
              "src-tauri/src/agent_runtime/tool_pipeline.rs"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to(ROOT / ".phase4-acceptance"):
        parser.error("an exact owned acceptance directory is required")
    report_path = output / "binding-evidence.json"
    if report_path.exists():
        parser.error("preserve the original evidence; use a new acceptance run")
    fixture = output / "fixture"
    journals = [[json.loads(line) for line in path.read_text().splitlines()]
                for path in (fixture / "agent-runtime/sessions-v5").glob("*.jsonl")]
    cancelled = [rows for rows in journals if any(row["type"] == "tool/approval"
                 and row["data"]["status"] == "cancelled"
                 and "Remote execution binding changed" in row["data"].get("reason", "") for row in rows)]
    completed = [rows for rows in journals if any(row["type"] == "tool/result"
                 and row["data"].get("data", {}).get("terminationConfirmed") is True for row in rows)]
    if len(cancelled) != 1 or len(completed) != 1:
        parser.error("one actual rejected original and one confirmed fresh execution are required")
    old, fresh = cancelled[0], completed[0]
    requested = next(row for row in old if row["type"] == "tool/approval" and row["data"]["status"] == "requested")
    refused = next(row for row in old if row["type"] == "tool/approval" and row["data"]["status"] == "cancelled")
    approved = next(row for row in fresh if row["type"] == "tool/approval" and row["data"]["status"] == "approved")
    result = next(row["data"]["data"] for row in fresh if row["type"] == "tool/result")
    disconnected = json.loads((fixture / "binding-disconnected.json").read_text())
    connected = json.loads((fixture / "binding-reconnected.json").read_text())
    resources = json.loads((output / "resource-terminal.json").read_text())["bindingResources"]
    root = Path(json.loads((fixture / "root-review-intent.json").read_text())["projectRoot"])
    with sqlite3.connect(f"file:{fixture / 'agent-direct-ownership.sqlite3'}?mode=ro", uri=True) as db:
        debt = db.execute("SELECT count(*) FROM dispatch_debt").fetchone()[0]
        custody = db.execute("SELECT count(*) FROM remote_cleanup_custody").fetchone()[0]
    ui = (output / "old-cancelled.ax.txt").read_text()
    pending_ui = (output / "fresh-pending.ax.txt").read_text()
    terminal_ui = (output / "fresh-terminal.ax.txt").read_text()
    checks = {
        "actualModel": all(any(row["type"] == "request/start" for row in rows) for rows in [old, fresh]),
        "realSourceGenerationChanged": bool(disconnected["beforeGeneration"]) and disconnected["afterGeneration"] is None
            and bool(connected["afterGeneration"]) and connected["afterGeneration"] != disconnected["beforeGeneration"],
        "oldRejectedBeforeExpiry": refused["timeUnixMs"] < requested["data"]["expiresAtUnixMs"],
        "originalApprovalCancelled": requested["data"]["approvalId"] == refused["data"]["approvalId"],
        "oldNeverApprovedOrDispatched": not any(row["type"] == "tool/execution"
            or row["type"] == "tool/approval" and row["data"]["status"] == "approved" for row in old),
        "oldEffectAbsent": not (root / "binding-approved").exists(),
        "freshIndependentApproval": old[0]["sessionId"] != fresh[0]["sessionId"]
            and requested["data"]["approvalId"] != approved["data"]["approvalId"]
            and approved["timeUnixMs"] > refused["timeUnixMs"],
        "freshConfirmedRestrictedTerminal": result["exitCode"] == 0 and result["terminationConfirmed"] is True
            and result["sandboxBackend"] == "remote-macos-seatbelt" and result["sandboxContract"]["policy"] == "workspace",
        "freshExactEffect": (root / "binding-fresh").read_text() == "fresh",
        "actualCancelledUi": "批准请求已取消" in ui and "允许执行一次" not in ui,
        "actualFreshApprovalUi": "printf fresh > binding-fresh" in pending_ui and "允许执行一次" in pending_ui,
        "actualFreshTerminalUi": "已批准" in terminal_ui and "已完成" in terminal_ui,
        "resourceTerminal": {row["sessionId"] for row in resources} == {old[0]["sessionId"], fresh[0]["sessionId"]}
            and all(row["state"] == "none" and row["activeProcesses"] == 0
                    and not any(row[key] for key in ["readPaths", "writePaths", "networkTargets", "localServices"]) for row in resources),
        "noDebtOrCustody": debt == 0 and custody == 0,
        "sourcePtyUntouched": disconnected["sourcePtyWrites"] == connected["sourcePtyWrites"] == 0,
    }
    report = {"passed": all(checks.values()), "checks": checks, "stage3Allowed": False,
              "scope": "real same-account SSH reconnect, original approval invalidation and fresh explicit UI approval",
              "oldSession": old[0]["sessionId"], "freshSession": fresh[0]["sessionId"],
              "sourceSha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in PRODUCTION},
              "binarySha256": json.loads((output / "launch.json").read_text())["binarySha256"],
              "historicalResources": "unconfirmed and untouched", "differentActualAccounts": "deferred"}
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(report_path), "passed": report["passed"], "checks": len(checks)}))
    return 0 if report["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
