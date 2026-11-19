"""Resolve native build directories for the test and release layouts."""

import argparse
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BUILD_ROOT = ROOT / os.environ.get('SHELLSPAN_NATIVE_BUILD_ROOT', 'src-tauri/target/native-input')
SECTIONS = ('prototype', 'integration', 'acceptance')


def is_test_build(build_root):
    return Path(os.path.abspath(build_root)).is_relative_to(ROOT / 'artifacts/tests')


def build_directory(build_root, section):
    if is_test_build(build_root):
        return build_root / 'native-input' / section
    return build_root / section


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('section', choices=SECTIONS)
    print(build_directory(BUILD_ROOT, parser.parse_args().section))
