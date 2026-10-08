"""Keep the exact parent-owned SSH server alive across real client App crashes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import signal
import socket
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--crash", action="store_true")
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists() or not output.is_relative_to(ROOT / ".phase4-acceptance"):
        parser.error("output must be a fresh ignored directory")
    output.mkdir(parents=True, mode=0o700)
    fixture = output / "shellspan-stage1-ssh-fixture"
    fixture.mkdir(mode=0o700)
    ssh = fixture / "ssh"
    ssh.mkdir(mode=0o700)
    for name in ["host", "client-alpha", "client-beta"]:
        subprocess.run(["/usr/bin/ssh-keygen", "-q", "-t", "rsa", "-b", "3072", "-m", "PEM", "-N", "", "-f", str(ssh / name)], check=True)
    (ssh / "authorized_keys").write_text("".join((ssh / f"client-{name}.pub").read_text() for name in ["alpha", "beta"]))
    os.chmod(ssh / "authorized_keys", 0o600)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    username = pwd.getpwuid(os.getuid()).pw_name
    (ssh / "sshd_config").write_text(f"Port {port}\nListenAddress 127.0.0.1\nHostKey {ssh / 'host'}\nPidFile {ssh / 'pid'}\nAuthorizedKeysFile {ssh / 'authorized_keys'}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nUsePAM no\nStrictModes yes\nAllowUsers {username}\nSubsystem sftp internal-sftp\n")
    for name in ["alpha", "beta"]:
        (fixture / "projects" / name).mkdir(parents=True, mode=0o700)
    (fixture / "fixture.json").write_text(json.dumps({"fixtureRoot": str(fixture), "port": port, "username": username, "parentPid": os.getpid(), "parentNonce": str(uuid.uuid4())}))
    binary = ROOT / "src-tauri/target/debug/ShellSpan"
    environment = os.environ.copy()
    user_known_hosts = Path.home() / ".shellspan-dev/known_hosts"
    user_known_hosts_before = hashlib.sha256(user_known_hosts.read_bytes()).hexdigest() if user_known_hosts.exists() else None
    report = {"status": "pending", "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "crash": args.crash}
    with (output / "server.log").open("w") as server_log:
        server = subprocess.Popen(["/usr/sbin/sshd", "-D", "-e", "-f", str(ssh / "sshd_config")], stdout=server_log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 5
            while True:
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                        break
                except OSError:
                    assert server.poll() is None and time.monotonic() < deadline, "owned server did not start"
                    time.sleep(0.05)
            environment["SHELLSPAN_NATIVE_REMOTE_LIFECYCLE_CHECK"] = "crash-seed" if args.crash else "multi"
            print("Running actual remote client seed" if args.crash else "Running two actual remote sessions", flush=True)
            with (output / "client.log").open("w") as client_log:
                client = subprocess.Popen([str(binary), "--native-remote-check", str(fixture)], cwd=ROOT, env=environment, stdout=client_log, stderr=subprocess.STDOUT)
                if args.crash:
                    deadline = time.monotonic() + 90
                    while not (fixture / "remote-ready.json").exists():
                        assert client.poll() is None, "client exited before both real remote effects"
                        assert time.monotonic() < deadline, "client did not publish readiness"
                        time.sleep(0.05)
                    ready = json.loads((fixture / "remote-ready.json").read_text())
                    assert ready["ready"] is True and ready["pid"] == client.pid and ready["fixtureRoot"] == str(fixture)
                    assert ready["identifier"] == "com.shellspan.native-remote-recovery-check"
                    assert ready["effects"] == ["started", "started"] and ready["sourcePtyWrites"] == 0
                    # The live Popen handle is our authority to interrupt this
                    # client. No descendant or historical PID is signalled.
                    client.kill()
                    report["clientInterruptedExitCode"] = client.wait(timeout=10)
                    assert report["clientInterruptedExitCode"] == -signal.SIGKILL
                    assert server.poll() is None, "parent-owned SSH server must survive"
                    time.sleep(3)
                    environment["SHELLSPAN_NATIVE_REMOTE_LIFECYCLE_CHECK"] = "crash-reopen"
                    print("Reopening actual remote client on the identical state", flush=True)
                    with (output / "reopen.log").open("w") as reopened:
                        result = subprocess.run([str(binary), "--native-remote-check", str(fixture)], cwd=ROOT, env=environment, stdout=reopened, stderr=subprocess.STDOUT, timeout=120)
                    report["reopenExitCode"] = result.returncode
                else:
                    report["clientExitCode"] = client.wait(timeout=120)
            actual = json.loads((fixture / "remote-lifecycle.json").read_text())
            code = report.get("reopenExitCode") if args.crash else report.get("clientExitCode")
            report["status"] = "passed" if actual.get("passed") is True and code == 0 else "pending"
        except Exception as error:
            report["reason"] = str(error)
        finally:
            # Only the exact server Child created here is stopped and reaped.
            server.terminate()
            server.wait(timeout=10)
    report["userKnownHostsUnchanged"] = (hashlib.sha256(user_known_hosts.read_bytes()).hexdigest() if user_known_hosts.exists() else None) == user_known_hosts_before
    if not report["userKnownHostsUnchanged"]:
        report["status"] = "pending"
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))
    raise SystemExit(0 if report["status"] == "passed" else 2)


if __name__ == "__main__":
    main()
