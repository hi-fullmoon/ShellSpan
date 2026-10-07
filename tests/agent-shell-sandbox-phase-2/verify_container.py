"""Real Docker evidence, not a production runner or a workspace sync adapter.

No project/HOME/socket bind mounts are used by the isolated candidate. The one
explicit bind-mount counterexample only exposes this test's temporary markers.
Every container is removed in finally, including failed assertions/timeouts.
"""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import uuid


HERE = Path(__file__).resolve().parent
IMAGE = "shellspan-sandbox-phase2:local"
DOCKER = "/usr/local/bin/docker"
PROFILE = os.environ.get("SANDBOX_SECCOMP_PROFILE")


def docker(*args, **kwargs):
    return subprocess.run([DOCKER, *args], capture_output=True, text=True,
                          timeout=30, **kwargs)


class ContainerEvidence(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = docker("info", "--format", "{{.OSType}}")
        if result.returncode or result.stdout.strip() != "linux":
            raise RuntimeError(f"Real Linux Docker daemon required: {result.stderr}")
        if not PROFILE or not Path(PROFILE).is_file():
            raise RuntimeError("SANDBOX_SECCOMP_PROFILE must name the generated Moby profile")
        result = docker("image", "inspect", IMAGE)
        if result.returncode:
            raise RuntimeError(f"Build {IMAGE} first: {result.stderr}")

    def setUp(self):
        self.names = []

    def tearDown(self):
        for name in reversed(self.names):
            result = docker("rm", "--force", name)
            self.assertEqual(result.returncode, 0, result.stderr)

    def create(self, command, *, restricted=True, mounts=(), read_only=True):
        name = f"shellspan-phase2-{uuid.uuid4().hex}"
        args = ["create", "--interactive", "--name", name, "--pull", "never", "--network", "none",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                "--user", "1000:1000", "--pids-limit", "128",
                "--tmpfs", "/workspace:rw,exec,nosuid,nodev,uid=1000,gid=1000,mode=0700",
                "--tmpfs", "/tmp:rw,exec,nosuid,nodev,uid=1000,gid=1000,mode=0700",
                "--tmpfs", "/cache:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700"]
        if read_only:
            args.append("--read-only")
        if restricted:
            args += ["--security-opt", f"seccomp={PROFILE}"]
        for mount in mounts:
            args += ["--mount", mount]
        # env -i clears image ENV as well as preventing host credential inheritance.
        args += [IMAGE, "/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin",
                 "HOME=/tmp/home", "TMPDIR=/tmp", "XDG_CACHE_HOME=/cache",
                 "CARGO_HOME=/cache/cargo", "PNPM_HOME=/cache/pnpm",
                 "/bin/sh", "-c", command]
        result = docker(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.names.append(name)
        return name

    def run_command(self, command, **kwargs):
        name = self.create(command, **kwargs)
        result = docker("start", "--attach", name)
        return name, result

    def inspect(self, name):
        result = docker("inspect", name)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)[0]

    def test_real_builds_and_clean_environment(self):
        _, result = self.run_command(
            "mkdir -p /tmp/home /cache/cargo /cache/pnpm; "
            "cp -r /opt/projects/node /opt/projects/rust /workspace/; "
            "cd /workspace/node && pnpm build && pnpm test && "
            "cd /workspace/rust && cargo build --offline && cargo test --offline && "
            "python3 -c 'import os; assert set(os.environ) <= "
            "{\"PATH\",\"HOME\",\"TMPDIR\",\"XDG_CACHE_HOME\",\"CARGO_HOME\",\"PNPM_HOME\",\"PWD\",\"OLDPWD\",\"LC_CTYPE\"}'")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("1 passed", result.stdout)

    def test_paths_hardlinks_and_host_credentials_are_absent(self):
        script = """
import errno, os
from pathlib import Path
for path in ['/Users', '/host', '/var/run/docker.sock', '/run/host-services', '/root/.ssh']:
    try:
        assert not Path(path).exists(), path
    except PermissionError:
        pass
Path('/workspace/value').write_text('inside')
os.link('/workspace/value', '/workspace/alias')
Path('/workspace/alias').write_text('changed')
assert Path('/workspace/value').read_text() == 'changed'
os.symlink('/etc/passwd', '/workspace/escape')
for path in ['/etc/passwd', '/workspace/escape', '/workspace/../etc/passwd']:
    try:
        Path(path).write_text('attack')
    except OSError as error:
        assert error.errno in [errno.EROFS, errno.EACCES, errno.ENOENT], error
    else:
        raise AssertionError(path)
try:
    os.link('/etc/passwd', '/workspace/system-alias')
except OSError as error:
    assert error.errno in [errno.EXDEV, errno.EPERM, errno.EROFS], error
else:
    raise AssertionError('cross-filesystem hardlink accepted')
"""
        _, result = self.run_command("python3 -c " + shell_quote(script))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_network_syscalls_denied_with_positive_control(self):
        script = """
import errno, socket
for family, kind in [(socket.AF_INET, socket.SOCK_STREAM),
                     (socket.AF_INET6, socket.SOCK_STREAM),
                     (socket.AF_INET, socket.SOCK_DGRAM),
                     (socket.AF_INET6, socket.SOCK_DGRAM),
                     (socket.AF_UNIX, socket.SOCK_STREAM),
                     (socket.AF_NETLINK, socket.SOCK_RAW),
                     (socket.AF_VSOCK, socket.SOCK_STREAM)]:
    try:
        sock = socket.socket(family, kind)
    except OSError as error:
        assert error.errno == errno.EPERM, error
    else:
        sock.close()
        raise AssertionError((family, kind))
left, right = socket.socketpair()
left.send(b'private IPC')
assert right.recv(20) == b'private IPC'
"""
        _, result = self.run_command("python3 -c " + shell_quote(script))
        self.assertEqual(result.returncode, 0, result.stderr)
        # network=none by itself permits private loopback listening/connecting.
        control = """
import socket
server = socket.socket()
server.bind(('127.0.0.1', 0))
server.listen()
client = socket.socket()
client.connect(server.getsockname())
peer, _ = server.accept()
client.send(b'ok')
assert peer.recv(2) == b'ok'
"""
        _, result = self.run_command("python3 -c " + shell_quote(control), restricted=False)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_sensitive_alias_bind_mount_counterexample(self):
        # An intentionally rejected design, not a supported execution mode.
        with tempfile.TemporaryDirectory(prefix="shellspan-phase2-links-") as temp:
            root = Path(temp)
            project = root / "project"
            project.mkdir(mode=0o777)
            project.chmod(0o777)
            secret = root / "denied-marker"
            secret.write_text("outside-marker")
            secret.chmod(0o666)
            os.link(secret, project / "ordinary-name")
            script = """
from pathlib import Path
assert not Path('/denied-marker').exists()
assert Path('/shared/ordinary-name').read_text() == 'outside-marker'
Path('/shared/ordinary-name').write_text('outside-modified')
"""
            _, result = self.run_command("python3 -c " + shell_quote(script),
                                         mounts=[f"type=bind,source={project},target=/shared"])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(secret.read_text(), "outside-modified")

    def test_concurrent_alias_injection_defeats_preflight(self):
        with tempfile.TemporaryDirectory(prefix="shellspan-phase2-race-") as temp:
            root = Path(temp)
            project = root / "project"
            project.mkdir(mode=0o777)
            project.chmod(0o777)
            secret = root / "denied-marker"
            secret.write_text("outside-marker")
            secret.chmod(0o666)
            self.assertEqual(list(project.iterdir()), [])
            script = """
import time
from pathlib import Path
Path('/shared/ready').write_text('ready')
deadline = time.monotonic() + 10
while not Path('/shared/ordinary-name').exists():
    assert time.monotonic() < deadline, 'host injection did not happen'
    time.sleep(.02)
assert Path('/shared/ordinary-name').read_text() == 'outside-marker'
Path('/shared/ordinary-name').write_text('race-modified')
"""
            name = self.create("python3 -c " + shell_quote(script),
                               mounts=[f"type=bind,source={project},target=/shared"])
            result = docker("start", name)
            self.assertEqual(result.returncode, 0, result.stderr)
            deadline = time.monotonic() + 10
            while not (project / "ready").exists():
                self.assertLess(time.monotonic(), deadline, "container not ready")
                time.sleep(.02)
            os.link(secret, project / "ordinary-name")
            result = docker("wait", name)
            self.assertEqual(result.stdout.strip(), "0", result.stderr)
            self.assertEqual(secret.read_text(), "race-modified")

    def test_background_stdin_wait_and_complete_kill(self):
        script = """
import os, sys, time
child = os.fork()
if child == 0:
    os.setsid()
    if os.fork() != 0:
        os._exit(0)
    while True:
        time.sleep(.1)
print('READY', flush=True)
line = sys.stdin.readline()
assert line == 'payload\\n', repr(line)
print('STDIN_OK', flush=True)
while True:
    time.sleep(.1)
"""
        name = self.create("python3 -c " + shell_quote(script))
        # Docker attach is the maintained stream transport; no frame parser.
        attached = subprocess.Popen([DOCKER, "start", "--attach", "--interactive", name],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 10
            while True:
                result = docker("logs", name)
                if "READY" in result.stdout:
                    break
                self.assertLess(time.monotonic(), deadline, result.stderr)
                time.sleep(.02)
            attached.stdin.write("payload\n")
            attached.stdin.flush()
            while True:
                result = docker("logs", name)
                if "STDIN_OK" in result.stdout:
                    break
                self.assertLess(time.monotonic(), deadline, result.stdout + result.stderr)
                time.sleep(.02)
            result = docker("top", name, "-eo", "pid,ppid,sid,comm")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertGreaterEqual(result.stdout.count("python3"), 2, result.stdout)
            result = docker("kill", "--signal", "KILL", name)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = docker("wait", name)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(self.inspect(name)["State"]["Running"])
            result = docker("top", name)
            self.assertNotEqual(result.returncode, 0)
        finally:
            docker("kill", name)
            attached.communicate(timeout=10)

    def test_command_failure_is_not_infrastructure_success(self):
        name, result = self.run_command("exit 23")
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertEqual(self.inspect(name)["State"]["ExitCode"], 23)
        result = docker("create", "--pull", "never", "--network", "none",
                        "shellspan-phase2-intentionally-absent:local", "true")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_copy_to_independent_filesystem_still_leaks_denied_alias(self):
        with tempfile.TemporaryDirectory(prefix="shellspan-phase2-import-") as temp:
            root = Path(temp)
            project = root / "project"
            project.mkdir()
            secret = root / "denied-marker"
            secret.write_text("outside-marker")
            os.link(secret, project / "ordinary-name")
            script = """
import time
from pathlib import Path
deadline = time.monotonic() + 10
while not Path('/tmp/import-complete').exists():
    assert time.monotonic() < deadline, 'import did not happen'
    time.sleep(.02)
assert Path('/imported/ordinary-name').read_text() == 'outside-marker'
"""
            # docker cp refuses read-only rootfs, even for this writable tmpfs.
            # A writable intake container demonstrates why copying is not policy.
            name = self.create("python3 -c " + shell_quote(script), read_only=False)
            result = docker("start", name)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = docker("cp", str(project), f"{name}:/imported")
            self.assertEqual(result.returncode, 0, result.stderr)
            result = docker("exec", name, "touch", "/tmp/import-complete")
            self.assertEqual(result.returncode, 0, result.stderr)
            result = docker("wait", name)
            logs = docker("logs", name)
            self.assertEqual(result.stdout.strip(), "0", result.stderr + logs.stderr)
            self.assertEqual(secret.read_text(), "outside-marker")

    def test_client_exit_does_not_clean_daemon_background_process(self):
        name = self.create("sleep 60")
        result = docker("start", name)
        self.assertEqual(result.returncode, 0, result.stderr)
        # start has returned: the client is gone but its workload remains.
        self.assertTrue(self.inspect(name)["State"]["Running"])
        result = docker("kill", name)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.inspect(name)["State"]["Running"])

    def test_timeout_must_stop_container_not_just_attached_client(self):
        name = self.create("sleep 60")
        with self.assertRaises(subprocess.TimeoutExpired):
            subprocess.run([DOCKER, "start", "--attach", name],
                           capture_output=True, timeout=2)
        self.assertTrue(self.inspect(name)["State"]["Running"])
        result = docker("kill", name)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = docker("wait", name)
        self.assertEqual(result.stdout.strip(), "137", result.stderr)
        self.assertFalse(self.inspect(name)["State"]["Running"])


def shell_quote(value):
    import shlex
    return shlex.quote(value)


if __name__ == "__main__":
    unittest.main()
