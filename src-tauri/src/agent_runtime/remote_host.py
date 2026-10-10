"""Host-account controller: authenticated ownership receipts, no isolation."""
from shellspan_controller import (
    Path, encoded, signed, write_state, terminate, wait_command_finished,
    RemoteTransportClosed, hashlib, hmac, json, os, platform, pwd, signal,
    shutil, socket, socketserver, subprocess, sys, tempfile, threading, uuid,
)


def main(request):
    system = platform.system()
    if system not in ("Linux", "Darwin") or request.get("hostController") is not True:
        raise RuntimeError("remoteHostPlatformUnsupported")
    mode = request["mode"]
    control = mode in ("status", "stop", "cleanup")
    root = Path(request["root"]) if control else Path(request["root"]).resolve(strict=True)
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    # macOS account TMPDIR paths can exceed sockaddr_un's socket path limit
    # once the UUID/control suffix is added. Use the POSIX temporary root;
    # ownership still comes from exclusive mkdir, the live Child and token.
    base = Path(request["tempBase"]) if control else Path("/tmp").resolve(strict=True)
    if not control and not root.is_dir():
        raise RuntimeError("remoteHostCwdInvalid")
    if mode == "inspect":
        print(json.dumps({"root": str(root), "home": str(home), "tempBase": str(base),
                          "platform": "linux" if system == "Linux" else "macos", "uid": os.getuid()}))
        return
    if os.getuid() != request["uid"] or str(home) != request["home"]:
        raise RuntimeError("remoteHostAccountChanged")
    job_id = str(uuid.UUID(request["jobId"]))
    key = bytes.fromhex(request["token"])
    if len(key) != 32:
        raise RuntimeError("remoteHostTokenInvalid")
    directory = base / f"shellspan-native-remote-{job_id}"
    if control:
        if mode == "stop":
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(4)
                client.connect(str(directory / "control"))
                client.sendall(encoded({"token": request["token"], "action": "stop",
                                       "signal": request.get("signal", "terminate")}) + b"\n")
                with client.makefile("rb") as response:
                    data = response.readline(32769)
                    if len(data) > 32768:
                        raise RuntimeError("remoteHostControlLimit")
                    result = json.loads(data)
        else:
            result = json.loads((directory / "state.json").read_bytes())
        proof = hmac.new(key, encoded(result["data"]), hashlib.sha256).hexdigest()
        facts = result["data"]
        if (not hmac.compare_digest(proof, result["proof"]) or facts["jobId"] != job_id
                or facts["root"] != str(root) or facts["digest"] != request["digest"]):
            raise RuntimeError("remoteHostReceiptInvalid")
        if mode == "cleanup":
            if not facts.get("controllerFinished") or not facts.get("terminationConfirmed"):
                raise RuntimeError("remoteHostCleanupUnconfirmed")
            shutil.rmtree(directory)
        print(json.dumps(result))
        return
    if mode != "run" or request["policy"] != "host":
        raise RuntimeError("remoteHostPolicyUnsupported")
    timeout = request["timeoutMs"] / 1000
    if not 0 < timeout <= 3600:
        raise RuntimeError("remoteHostDeadlineInvalid")
    directory.mkdir(mode=0o700)
    state = {"jobId": job_id, "root": str(root), "digest": request["digest"],
             "state": "starting", "started": False, "terminationConfirmed": False,
             "controllerFinished": False}
    child = None
    lock = threading.Lock()

    class Control(socketserver.StreamRequestHandler):
        def handle(self):
            self.request.settimeout(2)
            line = self.rfile.readline(32769)
            if len(line) > 32768:
                return
            message = json.loads(line)
            if (not hmac.compare_digest(message.get("token", ""), request["token"])
                    or message.get("action") != "stop"
                    or message.get("signal", "terminate") not in ("interrupt", "terminate", "kill")):
                return
            with lock:
                state["terminationConfirmed"] = terminate(child, message.get("signal", "terminate"))
                state["state"] = "cancelled"
                write_state(directory / "state.json", key, state)
                self.wfile.write(encoded(signed(key, state)) + b"\n")

    # No user child exists until the authenticated control socket is bound.
    server = socketserver.UnixStreamServer(str(directory / "control"), Control)
    os.chmod(directory / "control", 0o600)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    disconnected = threading.Event()
    signal.signal(signal.SIGHUP, lambda signum, frame: disconnected.set())
    reader_fd, writer_fd = os.pipe()
    reader = os.fdopen(reader_fd, "rb", buffering=0)
    leader = f'/bin/sh -c "$1" {writer_fd}>&-; code=$?; printf "%s\\n" "$code" >&{writer_fd}; read -r shellspan_hold'
    code = 125
    try:
        child = subprocess.Popen(["/bin/sh", "-c", leader, "shellspan-owned-leader", request["command"]],
                                 cwd=root, stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr,
                                 close_fds=True, pass_fds=(writer_fd,), start_new_session=True)
        os.close(writer_fd)
        writer_fd = None
        state.update(started=True, state="running")
        worker.start()
        write_state(directory / "state.json", key, state)
        try:
            code = wait_command_finished(child, reader, timeout, disconnected)
        except RemoteTransportClosed:
            with lock:
                state["state"] = "cancelled"
                state["terminationConfirmed"] = terminate(child, "kill")
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
    finally:
        reader.close()
        if writer_fd is not None:
            os.close(writer_fd)
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
    sys.exit(code if code is not None and 0 <= code <= 255 else 1)


try:
    signal.alarm(15)
    line = sys.stdin.buffer.readline(65537)
    signal.alarm(0)
    if len(line) > 65536 or not line.endswith(b"\n"):
        raise RuntimeError("remoteHostRequestLimit")
    main(json.loads(line))
except Exception as error:
    sys.stderr.write(f"remoteHostControllerFailed:{type(error).__name__}\n")
    sys.exit(125)
