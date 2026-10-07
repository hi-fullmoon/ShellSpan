"""Real versioned loopback HTTP application deployed only to the own fixture."""
import hashlib
import http.server
import json
from pathlib import Path
import sys
import threading

artifact = Path("release.json").read_bytes()
release = json.loads(artifact)


class Application(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        payload = json.dumps({"version": release["version"], "artifactSha256": hashlib.sha256(artifact).hexdigest()}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        if self.path != "/shutdown":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()
        threading.Thread(target=self.server.shutdown).start()

    def log_message(self, *args):
        pass


server = http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), Application)
print("deployment-ready", flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
