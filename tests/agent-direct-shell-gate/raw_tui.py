"""Tiny raw-terminal fixture standing in for a TUI input loop."""

import os
import sys
import termios
import tty

fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
try:
    tty.setraw(fd)
    os.write(sys.stdout.fileno(), b"GATE_TUI_READY\r\n")
    line = bytearray()
    while True:
        ch = os.read(fd, 1)
        if ch in (b"\r", b"\n"):
            break
        line.extend(ch)
    os.write(sys.stdout.fileno(), b"GATE_TUI_CONSUMED:" + bytes(line) + b"\r\n")
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
