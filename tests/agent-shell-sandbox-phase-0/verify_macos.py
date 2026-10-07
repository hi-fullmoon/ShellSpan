"""Real Seatbelt experiments; no production integration or actual secrets."""
import json
import os
from pathlib import Path
import platform
import shutil
import shlex
import socket
import subprocess
import sys
import tempfile
import unittest


class SeatbeltBoundary(unittest.TestCase):
    def setUp(self):
        if sys.platform != "darwin":
            self.fail("Native macOS required; unsupported hosts are not passing evidence")
        self.directory = tempfile.TemporaryDirectory(prefix="shellspan-phase0-")
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name).resolve()
        self.workspace = self.base / "workspace"
        self.temp = self.base / "temp"
        self.cache = self.base / "cache"
        self.outside = self.base / "outside"
        for path in (self.workspace, self.temp, self.cache, self.outside):
            path.mkdir()
        self.secret = self.outside / "sensitive"
        self.secret.write_text("noncredential-test-marker")
        self.project_secret = self.workspace / ".env"
        self.project_secret.write_text("noncredential-project-marker")

    def run_shell(self, command, *, deny_reads=False, readonly=False, invalid=False):
        quote = lambda path: json.dumps(str(path))
        writable = [self.temp, self.cache] + ([] if readonly else [self.workspace])
        profile = '(version 1)(deny default)(import "system.sb")(deny network*)'
        profile += '(deny file-write* (subpath "/cores"))(allow process*)(allow file-read*)'
        profile += '(allow file-write* ' + ' '.join(f'(subpath {quote(p)})' for p in writable) + ')'
        if deny_reads:
            profile += f'(deny file-read* (subpath {quote(self.outside)}) (literal {quote(self.project_secret)}))'
        if invalid:
            profile = "(invalid-profile"
        environment = {"PATH": os.environ["PATH"], "HOME": str(self.temp),
                       "TMPDIR": str(self.temp), "TMP": str(self.temp), "TEMP": str(self.temp),
                       "XDG_CACHE_HOME": str(self.cache), "CARGO_HOME": str(self.cache / "cargo")}
        return subprocess.run(["/usr/bin/sandbox-exec", "-p", profile, "/bin/sh", "-c", command],
                              cwd=self.workspace, env=environment, capture_output=True, text=True, timeout=30)

    def test_project_temp_cache_and_system_read(self):
        result = self.run_shell('cat /usr/share/zoneinfo/UTC >/dev/null && printf ok > project && printf ok > "$TMPDIR/tmp" && printf ok > "$XDG_CACHE_HOME/cache"')
        self.assertEqual(result.returncode, 0, result.stderr)
        for path in (self.workspace / "project", self.temp / "tmp", self.cache / "cache"):
            self.assertEqual(path.read_text(), "ok")

    def test_parent_and_symlink_write_denied(self):
        (self.workspace / "escape").symlink_to(self.outside, target_is_directory=True)
        for command in ('printf bad > ../outside/sensitive', 'printf bad > escape/sensitive'):
            result = self.run_shell(command)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Operation not permitted", result.stderr)
            self.assertEqual(self.secret.read_text(), "noncredential-test-marker")

    def test_existing_profile_reads_sensitive_fixture(self):
        result = self.run_shell('cat ../outside/sensitive .env')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("noncredential-test-marker", result.stdout)

    def test_explicit_denies_block_direct_and_symlink_read(self):
        (self.workspace / "escape").symlink_to(self.secret)
        for target in ('../outside/sensitive', '.env', 'escape'):
            result = self.run_shell(f'cat {target}', deny_reads=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Operation not permitted", result.stderr)
            self.assertEqual(result.stdout, "")

    def test_preexisting_hardlink_exposes_path_policy_gap(self):
        os.link(self.secret, self.workspace / "alias")
        result = self.run_shell('cat alias; printf changed > alias', deny_reads=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("noncredential-test-marker", result.stdout)
        self.assertEqual(self.secret.read_text(), "changed")

    def test_readonly_project_and_temp(self):
        result = self.run_shell('printf bad > project', readonly=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.workspace / "project").exists())
        result = self.run_shell('printf ok > "$TMPDIR/tmp"', readonly=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_real_socket_denials(self):
        for family, address in ((socket.AF_INET, ('127.0.0.1', 0)), (socket.AF_INET6, ('::1', 0)),
                                (socket.AF_UNIX, str(self.temp / 'listener.sock'))):
            with socket.socket(family) as listener:
                listener.bind(address)
                listener.listen()
                target = listener.getsockname()
                with socket.socket(family) as control:
                    control.connect(target)
                accepted, _ = listener.accept()
                accepted.close()
                code = f'import socket; s=socket.socket({family}); s.connect({target!r})'
                command = shlex.quote(shutil.which("python3")) + ' -c ' + shlex.quote(code)
                result = self.run_shell(command)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Operation not permitted", result.stderr)

    def test_child_inherits_and_environment_is_clean(self):
        result = self.run_shell('/bin/sh -c "printf bad > ../outside/new"')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.outside / "new").exists())
        result = self.run_shell('env')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(set(line.split('=', 1)[0] for line in result.stdout.splitlines()),
                         {'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'CARGO_HOME', 'PWD', 'SHLVL', '_'})

    def test_actual_node_and_rust_compilation(self):
        node = shutil.which('node')
        rustc = subprocess.run(['rustup', 'which', 'rustc'], check=True,
                               capture_output=True, text=True).stdout.strip()
        self.assertIsNotNone(node)
        self.assertIsNotNone(rustc)
        (self.workspace / "main.rs").write_text('fn main() { assert_eq!(2 + 2, 4); }')
        command = f'{shlex.quote(node)} -e "require(\'fs\').writeFileSync(\'node-result\', \'ok\')" && {shlex.quote(rustc)} main.rs -o compiled && ./compiled'
        result = self.run_shell(command)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.workspace / 'node-result').read_text(), 'ok')

    def test_invalid_profile_does_not_execute(self):
        result = self.run_shell('printf bad > started', invalid=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.workspace / 'started').exists())


if __name__ == '__main__':
    print(f'Native host: {platform.platform()}', flush=True)
    unittest.main(verbosity=1)
