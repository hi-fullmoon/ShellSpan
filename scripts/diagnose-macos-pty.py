"""Compare real macOS PTY and process session queries without a Rust build."""
import ctypes
import json
import os
import pty
import signal
import time

pid, master = pty.fork()
if pid == 0:
    os.execl('/bin/sleep', 'sleep', '30')

try:
    deadline = time.monotonic() + 5
    while os.tcgetpgrp(master) <= 0:
        if time.monotonic() >= deadline:
            raise TimeoutError('PTY foreground process did not become ready')
        time.sleep(0.01)
    group = os.tcgetpgrp(master)
    system = ctypes.CDLL(None, use_errno=True)
    system.tcgetsid.argtypes = [ctypes.c_int]
    system.tcgetsid.restype = ctypes.c_int
    ctypes.set_errno(0)
    tty_session = system.tcgetsid(master)
    tty_error = ctypes.get_errno()
    proc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    proc.proc_listpgrppids.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
    proc.proc_listpgrppids.restype = ctypes.c_int
    peers = (ctypes.c_int * 32)()
    count = proc.proc_listpgrppids(group, peers, ctypes.sizeof(peers))
    print(json.dumps({
        'child': pid, 'foreground': group, 'tty_session': tty_session,
        'tty_errno': tty_error, 'process_session': os.getsid(group),
        'process_count': count, 'peers': list(peers)[:max(0, count)],
    }), flush=True)
finally:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
    os.close(master)
