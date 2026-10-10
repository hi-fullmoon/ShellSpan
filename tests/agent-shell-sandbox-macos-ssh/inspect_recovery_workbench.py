"""Export only observed journal, UI and own-resource facts; no secret custody data."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ["src-tauri/src/agent_runtime/runtime.rs", "src-tauri/src/agent_runtime/session.rs",
           "src-tauri/src/agent_runtime/sandbox_settings_check.rs",
           "src/components/ai/workspace/ai-native-recovery-notice.tsx",
           "src/components/ai/workspace/ai-workspace-root.tsx",
           "src/components/ai/workspace/use-ai-session-controller.ts",
           "src/components/ai/__tests__/sandbox-activity-native.ts",
           "src/components/ai/__tests__/recovery-diagnostics.ts"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--report-name", required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to(ROOT / ".phase4-acceptance") or Path(args.report_name).name != args.report_name:
        parser.error("exact owned evidence root and simple new report name required")
    destination = output / args.report_name
    if destination.exists():
        parser.error("preserve previous reports")
    fixture = output / "fixture"
    journals = [json.loads(line) for path in (fixture / "agent-runtime/sessions-v5").glob("*.jsonl") for line in path.read_text().splitlines() if line]
    old_id = next(event["sessionId"] for event in journals if event["type"] == "session/created" and 'sleep 120' in event["data"]["goal"])
    old = [event for event in journals if event["sessionId"] == old_id]
    old_dispatch = [event for event in old if event["type"] == "tool/execution"]
    fresh = [event for event in journals if event["type"] == "tool/result" and isinstance(event["data"].get("data"), dict) and event["data"]["data"].get("exitCode") == 0 and event["sessionId"] != old_id]
    fresh_result = next(event for event in fresh if any(call["sessionId"] == event["sessionId"] and call["type"] == "tool/call" and call["data"]["call"].get("arguments", {}).get("command") == "printf fresh > recovery-fresh" for call in journals))
    project = fixture / "owned-project"
    unresolved = (output / "resources-unconfirmed.ax.txt").read_text()
    confirmed = (output / "resources-confirmed.ax.txt").read_text()
    approval = (output / "fresh-awaiting-approval.ax.txt").read_text()
    old_approval = (output / "old-approval-rejected.ax.txt").read_text()
    launch = json.loads((output / ("launch-final.json" if (output / "launch-final.json").is_file() else "reopen-launch.json")).read_text())
    reopen = json.loads((output / ("current-launch.json" if (output / "current-launch.json").is_file() else "reopen-launch.json")).read_text())
    with sqlite3.connect(f"file:{fixture / 'agent-direct-ownership.sqlite3'}?mode=ro", uri=True) as connection:
        debt = connection.execute("SELECT count(*) FROM dispatch_debt").fetchone()[0]
        custody = connection.execute("SELECT count(*) FROM remote_cleanup_custody").fetchone()[0]
    checks = {"actualModelDispatch": len(old_dispatch) == 1 and any(event["type"] == "request/start" for event in old),
              "ownedAppCrash": launch.get("seedExitCode") == -9 and launch.get("actualDispatchAndStartedBeforeCrash") is True,
              "sameStateDirectory": fresh_result["data"]["data"].get("sandboxContract", {}).get("root") == str(project),
              "recoveryGateVisible": "执行中断，需要确认资源恢复" in unresolved,
              "unconfirmedBlocks": "仍有 1 项资源无法确认" in unresolved and "button (disabled) 结束中断回合并新建会话" in unresolved,
              "trustedCleanupConfirmed": "本次解除 1 项" in confirmed and debt == 0 and custody == 0,
              "oldApprovalRejected": '"oldApprovalRejected":true' in old_approval,
              "oldAuthorizationAbsent": '"state":"none"' in old_approval and '"activeProcesses":0' in old_approval,
              "notReplayed": (project / "recovery-started").read_text() == "started" and not (project / "recovery-ended").exists(),
              "freshExplicitApproval": "printf fresh > recovery-fresh" in approval and fresh_result["sessionId"] != old_id,
              "freshNativeTerminal": fresh_result["data"]["data"].get("terminationConfirmed") is True and (project / "recovery-fresh").read_text() == "fresh"}
    report = {"passed": all(checks.values()), "checks": checks, "stageStatus": "pending",
              "scope": "actual own Wry/controller model crash and same-directory restart, trusted cleanup and fresh separately approved conversation",
              "resourceState": "confirmed", "directDebt": debt, "remainingCustody": custody,
              "oldSessionId": old_id, "freshSessionId": fresh_result["sessionId"],
              "freshNativeResult": {key: fresh_result["data"]["data"].get(key) for key in ["channel", "lifecycle", "exitCode", "terminationConfirmed", "durationMs", "sandboxBackend"]},
              "seedBinarySha256": launch["binarySha256"],
              "reopenBinarySha256": reopen["binarySha256"],
              "sourceSha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in SOURCES},
              "artifacts": {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in output.iterdir() if path.is_file() and path.suffix in [".png", ".txt", ".log"]},
              "historicalTimeoutResources": "unconfirmed; untouched", "stage3Allowed": False}
    destination.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(destination), "passed": report["passed"]}))
    return 0 if report["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
