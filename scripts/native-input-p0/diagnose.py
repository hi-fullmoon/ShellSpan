"""Capture locale/editor configuration on the same real probe shell."""
import argparse
import sys
from pathlib import Path
sys.dont_write_bytecode = True
from acceptance import Session, ARTIFACTS

args=argparse.Namespace(shell='/opt/homebrew/bin/bash',bridge=str(ARTIFACTS/'bridge-darwin-5.3.so'),
    output=ARTIFACTS,ssh=False,locale='en_US.UTF-8')
session=Session(args,'diagnostic')
try:
    session.run("locale; bind -v; printf 'LENGTH:%s\\n' \"${#LC_ALL}\"")
    session.drain()
    print(session.directory)
finally:
    session.close()
