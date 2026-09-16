import http.server
import os


STATUS = int(os.environ.get("HEALTH_STATUS", "200"))


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/healthz":
            self.send_response(404)
        else:
            self.send_response(STATUS)
        self.end_headers()

    def log_message(self, _format, *_args):
        return


http.server.ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
