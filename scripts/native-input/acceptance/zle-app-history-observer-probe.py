import json
import os
from pathlib import Path
import pty
import select
import signal
import sys
import time

shell, home_text, evidence_text = sys.argv[1:]
home = Path(home_text)
evidence = Path(evidence_text)
child, fd = pty.fork()
if child == 0:
    os.chdir(home)
    os.environ.update(HOME=str(home), ZDOTDIR=str(home), TERM="xterm-256color", LC_ALL="en_US.UTF-8")
    os.execv(shell, [shell, "-i"])

raw = bytearray()
ending = None
(evidence / "process.json").write_text(json.dumps({"pid": child, "shell": shell, "home": str(home), "parent": os.getpid()}))
try:
    deadline = time.monotonic() + 5
    while not list((home / "history-observations").glob("*/ready")):
        if time.monotonic() >= deadline:
            raise RuntimeError("Real ordinary ZLE did not produce passive startup observation")
        readable, _, _ = select.select([fd], [], [], 0.05)
        if readable:
            raw.extend(os.read(fd, 65536))
    os.write(fd, b"builtin print -r -- PASSIVE_OBSERVER_REAL_SOURCE\r")
    deadline = time.monotonic() + 5
    while b"PASSIVE_OBSERVER_REAL_SOURCE\r\n" not in raw:
        if time.monotonic() >= deadline:
            raise RuntimeError("Real user command did not complete")
        readable, _, _ = select.select([fd], [], [], 0.05)
        if readable:
            raw.extend(os.read(fd, 65536))
    os.write(fd, b"(exit 7)\rbuiltin printf 'PASSIVE_STATUS=%s\\n' \"$?\"\r")
    deadline = time.monotonic() + 5
    while b"PASSIVE_STATUS=7\r\n" not in raw:
        if time.monotonic() >= deadline:
            raise RuntimeError("Passive observer changed real parent exit status")
        readable, _, _ = select.select([fd], [], [], 0.05)
        if readable:
            raw.extend(os.read(fd, 65536))
    os.write(fd, b"exit 0\r")
    deadline = time.monotonic() + 5
    while ending is None:
        pid, status = os.waitpid(child, os.WNOHANG)
        if pid:
            ending = status
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("Real ordinary ZLE did not exit")
        readable, _, _ = select.select([fd], [], [], 0.05)
        if readable:
            try:
                raw.extend(os.read(fd, 65536))
            except OSError:
                pass
    assert os.waitstatus_to_exitcode(ending) == 0
finally:
    (evidence / "raw.bin").write_bytes(raw)
    if ending is None:
        os.kill(child, signal.SIGKILL)
        _, ending = os.waitpid(child, 0)
    os.close(fd)
    (evidence / "pty-exit.json").write_text(json.dumps({"status": os.waitstatus_to_exitcode(ending), "scope": "Real ordinary public ZLE observer only; no NIP, App or model credit"}))


