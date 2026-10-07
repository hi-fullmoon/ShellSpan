"""Interrupt only a live, identity-checked App announced by this recovery fixture."""
import argparse
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument("fixture_root", type=Path)
parser.add_argument("--ready-timeout", type=float, default=15)
args = parser.parse_args()
root = args.fixture_root
ready_deadline = time.monotonic() + args.ready_timeout
while not (root / "pipeline-ready.json").is_file():
    assert not any((root / name).is_file() for name in (
        "pipeline-result.json", "model-recovery-result.json")), "Owned stage ended before ready"
    assert time.monotonic() < ready_deadline, "Owned pipeline did not publish a ready record"
    time.sleep(0.01)
ready = json.loads((root / "pipeline-ready.json").read_text())
assert root.is_absolute() and root.name.startswith("shellspan-phase5-pipeline-")
assert ready["ready"] is True and ready["fixtureRoot"] == str(root)
assert ready["identifier"] == "com.shellspan.native-pipeline-recovery-check"
assert ready["recoveryKind"] == ("executionInFlight" if ready["unknown"] else "waitingApproval")
pid = ready["pid"]
assert isinstance(pid, int) and pid > 1 and pid != os.getpid()
environment = dict(os.environ, LC_ALL="C")

def ps(field):
    return subprocess.run(["ps", "-p", str(pid), "-o", f"{field}="],
                          env=environment, text=True, capture_output=True, check=True).stdout.strip()

actual_argv = shlex.split(ps("command"))
assert actual_argv == ready["argv"], "Actual argv no longer matches the owned fixture"
assert actual_argv[1:] == ["--native-agent-check", str(root), "normal"]
assert Path(actual_argv[0]).resolve() == Path(
    "/Users/zhengbiwen/Developer/my/ShellSpan/src-tauri/target/debug/ShellSpan").resolve()
actual_start = int(time.mktime(time.strptime(ps("lstart"), "%a %b %d %H:%M:%S %Y")))
assert abs(actual_start - ready["startTime"]) <= 1, "PID start time changed"
for child in ready["descendants"]:
    assert child["pid"] != pid
    assert Path(child["cwd"]).resolve() == (root / "project").resolve()
if ready["unknown"]:
    assert (root / "project" / "unknown-marker").read_text() == "started"

os.kill(pid, signal.SIGKILL)
deadline = time.monotonic() + 5
while subprocess.run(["ps", "-p", str(pid), "-o", "pid="],
                     capture_output=True).returncode == 0:
    assert time.monotonic() < deadline, "Owned App did not terminate after its fixture interrupt"
    time.sleep(0.02)
print(json.dumps({"interruptedPid": pid, "originalStartTime": actual_start,
                  "signal": "SIGKILL", "scope": "owned App only; no descendant PID was signalled"}))
