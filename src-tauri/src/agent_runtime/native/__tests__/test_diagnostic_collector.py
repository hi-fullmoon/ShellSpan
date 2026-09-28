"""Real local process, HTTP and TLS integration tests; no substituted collectors."""
import base64
import functools
import http.server
import json
import os
from pathlib import Path
import platform
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest

COLLECTOR = Path(__file__).resolve().parents[1] / "diagnostic_collector.py"
REPOSITORY = COLLECTOR.parents[4]
NETWORK_DENY_LIST = json.loads((REPOSITORY / "protocol/agent/runtime/blocked-network-destinations.json").read_text())


def collect(name, arguments, env=None):
    arguments = {"_targetId": "integration-local", "timeoutMs": 5000,
                 "_networkDenyList": NETWORK_DENY_LIST, **arguments}
    encoded = base64.b64encode(json.dumps(arguments).encode()).decode()
    result = subprocess.run([sys.executable, "-I", str(COLLECTOR), name, encoded],
                            capture_output=True, timeout=10, check=True, env=env)
    return json.loads(result.stdout)


class QuietFileHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, _format, *args):
        pass


class DiagnosticCollectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = http.server.ThreadingHTTPServer(("127.0.0.1", 0),
            functools.partial(QuietFileHandler, directory=str(REPOSITORY)))
        cls.worker = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.worker.join()

    def test_host_metrics_match_actual_machine_and_fields_are_selective(self):
        result = collect("inspect_host", {"fields": ["system", "cpu", "disk"]})
        self.assertEqual(result["status"], "ok")
        values = result["data"]["observations"]
        self.assertEqual(set(values), {"system", "cpu", "disk"})
        self.assertEqual(values["system"]["data"]["os"], platform.system())
        self.assertEqual(values["cpu"]["data"]["logicalCount"], os.cpu_count())
        self.assertEqual(values["disk"]["data"]["totalBytes"], shutil.disk_usage("/").total)

    def test_http_head_uses_real_server_and_does_not_follow_redirect(self):
        args = {"host": "127.0.0.1", "port": self.http.server_port, "protocol": "http"}
        result = collect("diagnose_endpoint", {**args, "path": "/protocol/agent/runtime/built-in-tools.json"})
        stages = result["data"]["stages"]
        self.assertEqual(stages["http"]["statusCode"], 200)
        self.assertEqual(stages["http"]["method"], "HEAD")
        self.assertEqual(stages["tls"]["status"], "notRun")
        redirect = collect("diagnose_endpoint", {**args, "path": "/protocol"})
        self.assertEqual(redirect["data"]["stages"]["http"]["statusCode"], 301)
        self.assertFalse(redirect["data"]["redirectsFollowed"])

    def test_prohibited_addresses_never_reach_tcp(self):
        for host in ("169.254.169.254", "0.0.0.0", "224.0.0.1", "[::ffff:169.254.169.254]",
                     "[fd00:ec2::254]", "[FD00:0EC2:0:0:0:0:0:0254]"):
            with self.subTest(host=host):
                result = collect("diagnose_endpoint", {"host": host, "port": 80, "protocol": "http"})
                self.assertEqual(result["data"]["stages"]["tcp"]["status"], "denied")
                self.assertEqual(result["data"]["stages"]["http"]["status"], "notRun")

    def test_metadata_hostname_is_denied_before_resolution(self):
        for host in ("metadata.google.internal", "METADATA.GOOGLE.INTERNAL."):
            result = collect("diagnose_endpoint", {"host": host, "port": 80, "protocol": "http"})
            self.assertEqual(result["data"]["stages"]["dns"]["status"], "denied")
            self.assertEqual(result["data"]["stages"]["tcp"]["status"], "notRun")

    def test_unresponsive_real_socket_obeys_total_deadline(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            start = time.monotonic()
            result = collect("diagnose_endpoint", {"host": "127.0.0.1", "port": listener.getsockname()[1],
                             "protocol": "http", "timeoutMs": 150})
            self.assertLess(time.monotonic() - start, 3)
            self.assertEqual(result["data"]["stages"]["tcp"]["status"], "ok")
            self.assertEqual(result["data"]["stages"]["http"]["status"], "failed")

    def test_service_reports_unsupported_environment_without_inventing_health(self):
        if Path("/run/systemd/system").is_dir():
            self.skipTest("this assertion targets non-systemd hosts")
        result = collect("inspect_service", {"service": "sshd.service"})
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["code"], "unsupported")
        self.assertNotIn("data", result)

    def test_tls_validates_real_certificate_and_rejects_untrusted_chain(self):
        if not shutil.which("openssl"):
            self.skipTest("openssl required to generate an ephemeral real certificate")
        with tempfile.TemporaryDirectory() as directory:
            cert, key = Path(directory) / "cert.pem", Path(directory) / "key.pem"
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                            "-keyout", str(key), "-out", str(cert), "-days", "1", "-subj", "/CN=localhost",
                            "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
                           check=True, capture_output=True)
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0),
                functools.partial(QuietFileHandler, directory=str(REPOSITORY)))
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert, key)
            server.socket = context.wrap_socket(server.socket, server_side=True)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                args = {"host": "localhost", "port": server.server_port, "protocol": "https"}
                denied = collect("diagnose_endpoint", args)
                self.assertFalse(denied["data"]["stages"]["tls"]["verified"])
                self.assertEqual(denied["data"]["stages"]["http"]["status"], "notRun")
                trusted = collect("diagnose_endpoint", args, env={**os.environ, "SSL_CERT_FILE": str(cert)})
                self.assertTrue(trusted["data"]["stages"]["tls"]["verified"])
                self.assertGreater(trusted["data"]["stages"]["tls"]["daysRemaining"], 0)
                self.assertEqual(trusted["data"]["stages"]["http"]["statusCode"], 200)
            finally:
                server.shutdown()
                server.server_close()
                worker.join()


if __name__ == "__main__":
    unittest.main()
