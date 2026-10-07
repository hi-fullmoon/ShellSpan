"""Bounded ordinary-account OpenSSH feasibility check; no system changes."""
import getpass
import base64
import hashlib
import hmac
import http.server
import json
import os
from pathlib import Path
import signal
import shlex
import socket
import subprocess
import tempfile
import time
import threading
import secrets
import uuid


def run():
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C"}
    with tempfile.TemporaryDirectory(prefix="shellspan-phase4-sshd-") as directory:
        root = Path(directory).resolve()
        for name in ["host", "client"]:
            subprocess.run(["/usr/bin/ssh-keygen", "-q", "-t", "rsa", "-b", "3072", "-m", "PEM", "-N", "", "-f", str(root / name)], env=env, check=True, timeout=15)
        authorized = root / "authorized_keys"
        authorized.write_bytes((root / "client.pub").read_bytes())
        authorized.chmod(0o600)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        config = root / "sshd_config"
        config.write_text(f"Port {port}\nListenAddress 127.0.0.1\nHostKey {root / 'host'}\nPidFile {root / 'pid'}\nAuthorizedKeysFile {authorized}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nUsePAM no\nStrictModes yes\nAllowUsers {getpass.getuser()}\nLogLevel ERROR\n", encoding="utf8")
        known_hosts = root / "known_hosts"
        known_hosts.write_text(f"[127.0.0.1]:{port} {(root / 'host.pub').read_text().strip()}\n", encoding="utf8")
        with (root / "server.log").open("wb") as log:
            server = subprocess.Popen(["/usr/sbin/sshd", "-D", "-e", "-f", str(config)], env=env, stdout=subprocess.DEVNULL, stderr=log, start_new_session=True)
            try:
                deadline = time.monotonic() + 3
                while server.poll() is None and time.monotonic() < deadline:
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                            break
                    except OSError:
                        time.sleep(0.05)
                result = subprocess.run(["/usr/bin/ssh", "-F", "/dev/null", "-i", str(root / "client"), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={known_hosts}", "-o", "ConnectTimeout=3", "-p", str(port), "127.0.0.1", "/usr/bin/true"], env=env, capture_output=True, timeout=8)
                assert result.returncode == 0, "ordinary-account SSH authentication failed"
                project = root / "project"
                project.mkdir()
                (project / "input").write_text("phase4-real-ssh-input", encoding="utf8")
                outside = root / "outside"
                outside.write_text("phase4-protected-fixture", encoding="utf8")
                profile = '(version 1)(deny default)(import "system.sb")(allow process*)(allow signal (target same-sandbox))(deny network*)(allow file-read-metadata)'
                for system in ["/System", "/usr", "/bin", "/sbin", "/Library", "/dev", "/private/etc", "/private/var/db/dyld"]:
                    profile += f"(allow file-read* (subpath {json.dumps(system)}))"
                profile += f"(allow file-read* file-write* (subpath {json.dumps(str(project))}))(allow file-write* (literal \"/dev/null\"))"
                ssh = ["/usr/bin/ssh", "-F", "/dev/null", "-i", str(root / "client"), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={known_hosts}", "-o", "ConnectTimeout=3", "-p", str(port), "127.0.0.1"]
                def restricted(command):
                    return subprocess.run(ssh + [shlex.join(["/usr/bin/env", "-i", "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "/usr/bin/sandbox-exec", "-p", profile, "/bin/sh", "-c", command])], env=env, capture_output=True, timeout=5)
                read = restricted(shlex.join(["/bin/cat", str(project / "input")]))
                assert read.returncode == 0 and read.stdout == b"phase4-real-ssh-input"
                write = restricted(f"printf phase4-written > {shlex.quote(str(project / 'output'))}")
                assert write.returncode == 0 and (project / "output").read_text() == "phase4-written"
                denied = restricted(shlex.join(["/bin/cat", str(outside)]))
                assert denied.returncode != 0 and denied.stdout == b""
                denied_write = restricted(f"printf replacement > {shlex.quote(str(outside))}")
                assert denied_write.returncode != 0 and outside.read_text() == "phase4-protected-fixture"
                class Quiet(http.server.SimpleHTTPRequestHandler):
                    def __init__(self, *args, **kwargs):
                        super().__init__(*args, directory=str(project), **kwargs)
                    def log_message(self, *args):
                        pass
                http_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
                worker = threading.Thread(target=http_server.serve_forever)
                worker.start()
                try:
                    url = f"http://127.0.0.1:{http_server.server_port}/input"
                    baseline = subprocess.run(ssh + [shlex.join(["/usr/bin/curl", "--noproxy", "*", "-f", "-s", "--max-time", "2", url])], env=env, capture_output=True, timeout=5)
                    assert baseline.returncode == 0 and baseline.stdout == b"phase4-real-ssh-input"
                    network = restricted(shlex.join(["/usr/bin/curl", "--noproxy", "*", "-f", "-s", "--max-time", "2", url]))
                    assert network.returncode != 0 and network.stdout == b""
                finally:
                    http_server.shutdown()
                    http_server.server_close()
                    worker.join(timeout=3)
                controller = (Path(__file__).resolve().parents[2] / "src-tauri/src/agent_runtime/remote_seatbelt.py").read_text()
                interpreter = next(str(path) for path in [Path("/Library/Developer/CommandLineTools/usr/bin/python3"), Path("/opt/homebrew/bin/python3")] if path.is_file())
                token = secrets.token_hex(32)
                job = str(uuid.uuid4())
                request = {"mode":"inspect", "root":str(project), "home":str(Path.home().resolve()), "jobId":job, "token":token, "policy":"workspace"}
                def invocation(data):
                    return ssh + [shlex.join(["/usr/bin/env", "-i", "PATH=/usr/bin:/bin:/usr/sbin:/sbin", interpreter, "-c", controller])]
                def control(data):
                    completed = subprocess.run(invocation(data), input=json.dumps(data).encode()+b"\n", env=env, capture_output=True, timeout=8)
                    assert completed.returncode == 0, "real SSH controller operation failed"
                    return json.loads(completed.stdout)
                facts = control(request)
                request.update({"root":facts["root"], "home":facts["home"], "tempBase":facts["tempBase"], "uid":facts["uid"], "deny":[str(Path(facts["home"]) / "Library/Keychains"),str(Path(facts["home"]) / "Library/Application Support"),str(outside)],"readAllow":[facts["root"]],"writeAllow":[facts["root"]]})
                def verified(receipt):
                    raw = base64.b64decode(receipt["encoded"], validate=True)
                    assert hmac.compare_digest(receipt["proof"], hmac.new(bytes.fromhex(token), raw, hashlib.sha256).hexdigest())
                    assert json.loads(raw) == receipt["data"] and receipt["data"]["jobId"] == job
                    return receipt["data"]
                request["mode"] = "selftest"
                assert verified(control(request))["verified"]
                request.update({"mode":"run", "command":"printf controller-ready; exec sleep 15", "timeoutMs":20000, "digest":hashlib.sha256(b"phase4-controller-fixture").hexdigest()})
                running = subprocess.Popen(invocation(request), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                running.stdin.write(json.dumps(request).encode()+b"\n")
                running.stdin.flush()
                try:
                    deadline = time.monotonic() + 5
                    while True:
                        try:
                            active = control({**request,"mode":"status"})
                            if verified(active)["state"] == "running":
                                break
                        except (AssertionError, json.JSONDecodeError):
                            pass
                        assert time.monotonic() < deadline, "real SSH controller did not publish its running receipt"
                        time.sleep(0.05)
                    stopped = verified(control({**request,"mode":"stop"}))
                    assert stopped["terminationConfirmed"]
                    output, errors = running.communicate(timeout=5)
                    assert output == b"controller-ready"
                    final = verified(control({**request,"mode":"status"}))
                    assert final["controllerFinished"] and final["terminationConfirmed"]
                    verified(control({**request,"mode":"cleanup"}))
                finally:
                    if running.poll() is None:
                        running.kill()
                        running.communicate(timeout=3)
                print(json.dumps({"authenticated": True, "realSshSeatbelt": True, "projectReadWrite": True, "outsideReadWriteDenied": True, "liveLoopbackNetworkDenied": True, "controllerSelftest":True, "controllerCancel":True, "controllerReceiptVerified":True, "controllerCleanup":True, "serverDiagnostic": (root / "server.log").read_text()}, ensure_ascii=False))
            finally:
                if server.poll() is None:
                    os.killpg(server.pid, signal.SIGTERM)
                    try:
                        server.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        os.killpg(server.pid, signal.SIGKILL)
                        server.wait(timeout=3)


if __name__ == "__main__":
    run()
