"""Real loopback byte transports for the project-owned SSH fixture only."""
import socketserver
import threading
import time


class Echo(socketserver.BaseRequestHandler):
    def handle(self):
        while True:
            data = self.request.recv(16384)
            if not data:
                return
            self.request.sendall(data)


class Stalled(socketserver.BaseRequestHandler):
    def handle(self):
        time.sleep(3)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


servers = [Server(("127.0.0.1", 18082), Echo), Server(("127.0.0.1", 18083), Stalled)]
for server in servers:
    threading.Thread(target=server.serve_forever, daemon=True).start()
threading.Event().wait()
