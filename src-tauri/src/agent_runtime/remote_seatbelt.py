"""Unprivileged SSH control layer; sandbox-exec supplies the OS boundary.

Sent to an existing interpreter through an SSH exec argument, never installed.
JSON, subprocess and UnixStreamServer supply framing and process control.
"""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import platform
import pwd
import select
import signal
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import uuid


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def profile(root, home, work, readonly, deny):
    value = '(version 1)(deny default)(import "system.sb")(allow process*)(allow signal (target same-sandbox))(deny network*)(allow file-read-metadata)(allow file-write* (literal "/dev/null"))'
    for path in ["/System", "/usr", "/bin", "/sbin", "/Library", "/Applications/Xcode.app", "/opt/homebrew", "/dev", "/private/etc", "/private/var/db/dyld", str(root), str(work)]:
        value += f"(allow file-read* (subpath {json.dumps(path)}))"
    for relative in [".cargo", ".rustup", ".nvm/versions/node", ".volta/tools/image", ".local/share/mise/installs", "Library/pnpm", ".local/share/pnpm"]:
        value += f"(allow file-read* (subpath {json.dumps(str(home / relative))}))"
    value += f"(allow file-write* (subpath {json.dumps(str(work))}))"
    if not readonly:
        value += f"(allow file-write* (subpath {json.dumps(str(root))}))"
    for path in deny:
        value += f"(deny file-read* file-write* (subpath {json.dumps(path)}))"
    project_env = json.dumps(str(root / ".env.local"))
    value += '(deny file-write* (regex #"(^|/)\\.env($|\\.)"))'
    value += f'(deny file-read* (require-all (regex #"(^|/)\\.env($|\\.)") (require-not (literal {project_env}))))'
    return value


def environment(home, work):
    paths = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", str(home / ".cargo/bin"), str(home / "Library/pnpm"), str(home / ".local/share/pnpm")]
    return {"PATH": ":".join(paths), "HOME": str(home), "LANG": "en_US.UTF-8", "TMPDIR": str(work), "TEMP": str(work), "TMP": str(work), "XDG_CACHE_HOME": str(work / "cache"), "CARGO_TARGET_DIR": str(work / "target"), "NPM_CONFIG_CACHE": str(work / "cache/npm")}


def signed(key, data):
    serialized = encoded(data)
    return {"data": data, "encoded": base64.b64encode(serialized).decode("ascii"), "proof": hmac.new(key, serialized, hashlib.sha256).hexdigest()}


def write_state(path, key, data):
    pending = path.with_suffix(".new")
    with pending.open("wb") as output:
        output.write(encoded(signed(key, data)))
        output.flush()
        os.fsync(output.fileno())
    os.replace(pending, path)


def alive(group):
    try:
        os.killpg(group, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # A reparented group can still exist without being signalable by this
        # account. Lack of permission is never proof of termination.
        return True


class RemoteTransportClosed(Exception):
    pass


def wait_command_finished(child, reader, timeout, disconnected):
    deadline = time.monotonic() + timeout
    while child.returncode is None:
        if disconnected.is_set():
            raise RemoteTransportClosed()
        if select.select([reader], [], [], 0.02)[0]:
            data = reader.readline(129)
            if not data:
                # A concurrent stop closes the pipe before wait() publishes
                # returncode. Do not race its signed final controller state.
                time.sleep(0.02)
            else:
                if len(data) > 128 or not data.endswith(b"\n"):
                    raise RuntimeError("remoteSeatbeltCompletionInvalid")
                code = json.loads(data)
                if not isinstance(code, int) or not -255 <= code <= 255:
                    raise RuntimeError("remoteSeatbeltCompletionInvalid")
                return code
        if time.monotonic() >= deadline:
            raise subprocess.TimeoutExpired("owned remote child", timeout)
    return child.returncode


def terminate(child, kind="terminate"):
    # The fixed leader stays alive after command completion. Never poll/reap
    # it before the last group signal, including on Python without waitid.
    if child.returncode is None:
        selected={"interrupt":signal.SIGINT,"terminate":signal.SIGTERM,"kill":signal.SIGKILL}[kind]
        try:
            os.killpg(child.pid, selected)
        except (ProcessLookupError, PermissionError):
            pass
        if kind != "kill":
            time.sleep(1)
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        child.wait(timeout=2)
    # Once reaped, only observe; a historical PID never authorizes a signal.
    deadline = time.monotonic() + 2
    while alive(child.pid) and time.monotonic() < deadline:
        time.sleep(0.02)
    return not alive(child.pid)


def main(request):
    if platform.system() != "Darwin":
        raise RuntimeError("remoteSeatbeltPlatformUnsupported")
    mode = request["mode"]
    control_mode = mode in ["stop", "status", "cleanup"]
    root = Path(request["root"]) if control_mode else Path(request["root"]).resolve(strict=True)
    account = pwd.getpwuid(os.getuid())
    home = Path(account.pw_dir).resolve(strict=not control_mode)
    if mode != "inspect" and (os.getuid() != request["uid"] or not control_mode and str(home) != request["home"]):
        raise RuntimeError("remoteSeatbeltAccountChanged")
    base = Path(request["tempBase"]) if control_mode else Path(tempfile.gettempdir()).resolve(strict=True)
    if not control_mode and (str(root) != request["root"] or not root.is_dir() or root == home or home.is_relative_to(root) or base.is_relative_to(root)):
        raise RuntimeError("remoteSeatbeltRootUnsupported")
    if any(ord(c) < 32 for c in str(root) + str(home) + str(base)):
        raise RuntimeError("remoteSeatbeltPathInvalid")
    if mode == "inspect":
        print(json.dumps({"root": str(root), "home": str(home), "tempBase": str(base), "platform": "macos", "uid":os.getuid()}))
        return
    job_id = str(uuid.UUID(request["jobId"]))
    key = bytes.fromhex(request["token"])
    if len(key) != 32:
        raise RuntimeError("remoteSeatbeltTokenInvalid")
    directory = base / f"shellspan-native-remote-{job_id}"
    if control_mode:
        if mode == "stop":
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(4)
                client.connect(str(directory / "control"))
                client.sendall(encoded({"token": request["token"], "action": "stop", "signal":request.get("signal","terminate")}) + b"\n")
                with client.makefile("rb") as response:
                    data = response.readline(32769)
                    if len(data) > 32768:
                        raise RuntimeError("remoteSeatbeltControlLimit")
                    result = json.loads(data)
        else:
            result = json.loads((directory / "state.json").read_bytes())
        if mode == "cleanup":
            expected = hmac.new(key, encoded(result["data"]), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(result["proof"], expected) or result["data"]["jobId"] != job_id or result["data"]["root"] != str(root) or result["data"]["digest"] != request["digest"] or not result["data"].get("controllerFinished") or not result["data"]["terminationConfirmed"]:
                raise RuntimeError("remoteSeatbeltCleanupUnconfirmed")
            shutil.rmtree(directory)
        print(json.dumps(result))
        return
    if mode not in ["run", "selftest"] or request["policy"] not in ["readOnly", "workspace"]:
        raise RuntimeError("remoteSeatbeltPolicyUnsupported")
    if mode == "selftest":
        with tempfile.TemporaryDirectory(prefix="shellspan-remote-preflight-") as fixture:
            fixture = Path(fixture).resolve()
            project = fixture / "project"
            project.mkdir()
            work = fixture / "work"
            work.mkdir()
            outside = fixture / "outside"
            outside.write_text("protected-remote-fixture")
            (project / "input").write_text("remote-ready")
            listener = socket.socket()
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            baseline = socket.create_connection(("127.0.0.1", port), timeout=1)
            accepted, _ = listener.accept()
            accepted.close()
            baseline.close()
            checks = ["import pathlib,socket; p=pathlib.Path('input'); assert p.read_text()=='remote-ready'; pathlib.Path('output').write_text('written')",
                      f"import pathlib; pathlib.Path({str(outside)!r}).read_text()",
                      f"import socket; socket.create_connection(('127.0.0.1',{port}),timeout=1)"]
            codes = []
            for code in checks:
                result = subprocess.run(["/usr/bin/sandbox-exec", "-p", profile(project, home, work, False, request["deny"]), sys.executable, "-c", code], cwd=project, env=environment(home, work), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)
                codes.append(result.returncode)
            readonly = subprocess.run(["/usr/bin/sandbox-exec", "-p", profile(project, home, work, True, request["deny"]), sys.executable, "-c", "import pathlib; pathlib.Path('output').write_text('changed')"], cwd=project, env=environment(home, work), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)
            listener.close()
            if codes[0] != 0 or codes[1] == 0 or codes[2] == 0 or readonly.returncode == 0 or (project / "output").read_text() != "written":
                raise RuntimeError("remoteSeatbeltSelftestFailed")
            print(json.dumps(signed(key, {"jobId": job_id, "root": str(root), "home": str(home), "tempBase": str(base), "verified": True, "uid":os.getuid()})))
        return
    timeout = request["timeoutMs"] / 1000
    if not 0 < timeout <= 300 or not isinstance(request["command"], str) or "\x00" in request["command"]:
        raise RuntimeError("remoteSeatbeltExecutionInvalid")
    if request["readAllow"] != [str(root)] or request["writeAllow"] != ([] if request["policy"] == "readOnly" else [str(root)]):
        raise RuntimeError("remoteSeatbeltPathGrantUnsupported")
    directory.mkdir(mode=0o700)
    work = directory / "work"
    work.mkdir(mode=0o700)
    (work / "cache").mkdir(mode=0o700)
    state = {"jobId": job_id, "root": str(root), "digest": request["digest"], "state": "starting", "started": False, "terminationConfirmed": False, "controllerFinished": False}
    child = None
    lock = threading.Lock()
    class Control(socketserver.StreamRequestHandler):
        def handle(self):
            self.request.settimeout(2)
            line = self.rfile.readline(32769)
            if len(line) > 32768:
                return
            message = json.loads(line)
            if not hmac.compare_digest(message.get("token", ""), request["token"]) or message.get("action") != "stop":
                return
            if message.get("signal","terminate") not in ["interrupt","terminate","kill"]:
                return
            with lock:
                confirmed = terminate(child,message.get("signal","terminate"))
                state["state"] = "cancelled"
                state["terminationConfirmed"] = confirmed
                write_state(directory / "state.json", key, state)
                self.wfile.write(encoded(signed(key, state)) + b"\n")
    # Bind the control socket before creating any user process. Setup errors
    # after spawn always pass through the termination guard below.
    server = socketserver.UnixStreamServer(str(directory / "control"), Control)
    os.chmod(directory / "control", 0o600)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    disconnected = threading.Event()
    # Losing the SSH client must not bypass the actual Popen/group owner and
    # its signed final receipt. The handler never acquires the controller lock.
    signal.signal(signal.SIGHUP, lambda signum, frame: disconnected.set())
    code = 125
    completion_read, completion_write = os.pipe()
    completion_reader = os.fdopen(completion_read, "rb", buffering=0)
    # The user Shell does not inherit this completion descriptor. Its own
    # completion does not release the leader identity used for group cleanup.
    leader = f'/bin/sh -c "$1" {completion_write}>&-; code=$?; printf "%s\\n" "$code" >&{completion_write}; read -r shellspan_hold'
    try:
        child = subprocess.Popen(["/usr/bin/sandbox-exec", "-p", profile(root, home, work, request["policy"] == "readOnly", request["deny"]), "/bin/sh", "-c", leader, "shellspan-owned-leader", request["command"]], cwd=root, env=environment(home, work), stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr, close_fds=True, pass_fds=(completion_write,), start_new_session=True)
        os.close(completion_write)
        completion_write = None
        state["started"] = True
        state["state"] = "running"
        worker.start()
        write_state(directory / "state.json", key, state)
        try:
            code = wait_command_finished(child, completion_reader, timeout, disconnected)
        except RemoteTransportClosed:
            with lock:
                state["state"] = "cancelled"
                state["terminationConfirmed"] = terminate(child, "kill")
            code = 125
        except subprocess.TimeoutExpired:
            with lock:
                state["state"] = "timedOut"
                state["terminationConfirmed"] = terminate(child)
            code = 124
        with lock:
            if state["state"] == "running":
                state["state"] = "exited"
                state["terminationConfirmed"] = terminate(child)
            elif state["state"] == "cancelled":
                code = child.returncode
            state["exitCode"] = code
            write_state(directory / "state.json", key, state)
    finally:
        completion_reader.close()
        if completion_write is not None:
            os.close(completion_write)
        if child is not None:
            with lock:
                state["terminationConfirmed"] = terminate(child)
        if worker.ident is not None:
            server.shutdown()
        server.server_close()
        if worker.ident is not None:
            worker.join(timeout=2)
    state["controllerFinished"] = not worker.is_alive()
    write_state(directory / "state.json", key, state)
    # The signed receipt remains briefly for the native waiter after SSH EOF;
    # the separate receipt is never a recovered resource grant.
    # Cleanup is done by the caller only after confirmation; unknown cleanup
    # leaves this directory visible rather than claiming success.
    sys.exit(code if 0 <= code <= 255 else 1)


if __name__ == "__main__":
    try:
        # Native waits for the signed ready receipt before sending user stdin,
        # so BufferedReader cannot prefetch and strand interactive input.
        signal.alarm(15)
        line = sys.stdin.buffer.readline(65537)
        signal.alarm(0)
        if len(line) > 65536 or not line.endswith(b"\n"):
            raise RuntimeError("remoteSeatbeltRequestLimit")
        main(json.loads(line))
    except Exception as error:
        # Exception class is useful controller evidence; messages/tracebacks
        # may include request values or secret material and are never emitted.
        trace = error.__traceback__
        while trace.tb_next is not None:
            trace = trace.tb_next
        sys.stderr.write(f"remoteSeatbeltControllerFailed:{type(error).__name__}:{trace.tb_frame.f_code.co_name}:{getattr(error, 'errno', None)}\n")
        sys.exit(125)
