"""Read exact owned acceptance journal; export facts without grants or credentials."""
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
        parser.error("only exact ignored acceptance roots are supported")
    fixture = output / "fixture"
    rows = [json.loads(line) for path in (fixture / "agent-runtime/sessions-v5").glob("*.jsonl")
            for line in path.read_text().splitlines()]
    results = []
    for row in rows:
        if row["type"] != "tool/result":
            continue
        payload = row["data"]
        data = payload.get("data") or {}
        contract = data.get("sandboxContract") or {}
        results.append({"status": payload["status"],
                        **{key: data.get(key) for key in ["channel", "sandboxBackend", "exitCode", "terminationConfirmed", "durationMs", "state"]},
                        "capability": (data.get("sandboxCapability") or {}).get("status"),
                        "policy": contract.get("policy"), "root": contract.get("root"),
                        "resourceGrantCount": len(contract.get("resourceGrants", []))})
    intent = json.loads((fixture / "root-review-intent.json").read_text())
    project = Path(intent["projectRoot"]).resolve()
    marker = project / "remote-stage2-marker"
    with sqlite3.connect(f"file:{fixture / 'agent-direct-ownership.sqlite3'}?mode=ro", uri=True) as db:
        debt = db.execute("SELECT count(*) FROM dispatch_debt").fetchone()[0]
    source_names = ["src/lib/ai/agent-session-adapter.ts", "tests/agent-shell-sandbox-macos-ssh/inspect_remote_workbench.py"]
    report = {"scope": "actual journal/controller and exact loopback-host project observation; model claims are not evidence",
              "stageStatus": "pending", "modelRequests": sum(row["type"] == "request/start" for row in rows),
              "results": results, "markerMatches": marker.is_file() and marker.read_text() == "remote-stage2",
              "markerObservation": "local OS observation on same-host SSH fixture; not SFTP verification",
              "directDebt": debt,
              "sourceSha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in source_names}}
    approval = output / "approval.ax.txt"
    expired = output / "expired.ax.txt"
    if approval.is_file() and expired.is_file():
        approval_text = approval.read_text()
        checks = {
            "summaryVerified": "工作区执行 · 部分限制有效" in approval_text,
            "approvalRestricted": "此命令执行项目路径与默认网络限制" in approval_text
                and "此命令尚无沙箱隔离" not in approval_text,
            "expiryDisplayed": "批准请求已过期" in expired.read_text(),
            "expiredResult": any(row["type"] == "tool/result"
                and row["data"].get("summary") == "Native approval expired" for row in rows),
            "verifiedExecution": any(result["sandboxBackend"] == "remote-macos-seatbelt"
                and result["policy"] == "workspace" and result["capability"] == "partial"
                and result["exitCode"] == 0 and result["terminationConfirmed"] is True for result in results),
            "markerMatches": report["markerMatches"],
            "noDirectDebt": debt == 0,
        }
        report["checks"] = checks
        report["failedChecks"] = [name for name, passed in checks.items() if not passed]
        report["scopePassed"] = all(checks.values())
    revocation = output / "revoked.ax.txt"
    if revocation.is_file():
        text = revocation.read_text()
        audits = [row["data"]["audit"] for row in rows if row["type"] == "sandbox/resource_audit"]
        checks = {
            "backgroundStarted": any(result["state"] == "running" and result["sandboxBackend"] == "remote-macos-seatbelt" for result in results),
            "startEffect": (project / "revoke-start-marker").is_file() and (project / "revoke-start-marker").read_text() == "started",
            "endEffectAbsent": not (project / "revoke-end-marker").exists(),
            "cleanupAudit": any(audit["action"] == "revoked" and audit["cleanupConfirmed"] is True and not audit["resources"] for audit in audits),
            "zeroActiveDisplayed": "运行中或尚未确认结束的后台进程：0" in text,
            "noErrorDisplayed": "操作失败" not in text,
            "noDirectDebt": debt == 0,
        }
        report["revocationChecks"] = checks
        report["revocationScopePassed"] = all(checks.values())
    (output / "live-model-facts.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(output / "live-model-facts.json"), "stageStatus": "pending"}))


if __name__ == "__main__":
    main()
