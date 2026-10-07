"""Real macOS SRT 0.0.78 object-boundary counterexample, not production support."""

import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest


class NativeEvidence(unittest.TestCase):
    def test_mature_seatbelt_runner_still_exposes_existing_hardlink(self):
        runner = Path(os.environ['SANDBOX_SRT_BIN'])
        version = subprocess.run([str(runner), '--version'], capture_output=True,
                                 text=True, timeout=15)
        self.assertEqual(version.returncode, 0, version.stderr)
        self.assertEqual(version.stdout.strip(), '0.0.78')
        with tempfile.TemporaryDirectory(prefix='shellspan-phase2-native-', dir='/tmp') as temp:
            root = Path(temp).resolve()
            project = root / 'project'
            project.mkdir()
            home = root / 'home'
            home.mkdir()
            secret = root / 'denied-marker'
            secret.write_text('outside-marker')
            os.link(secret, project / 'ordinary-name')
            settings = root / 'settings.json'
            settings.write_text(json.dumps({
                'filesystem': {'denyRead': [str(secret)],
                               'allowWrite': [str(project)],
                               'denyWrite': [str(secret)]},
                'network': {'allowedDomains': [], 'deniedDomains': []}
            }))
            env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'TMPDIR': str(root)}
            # Explicit deny remains effective for the original pathname.
            result = subprocess.run([str(runner), '--settings', str(settings), '-c',
                                     'cat ' + shlex.quote(str(secret))], cwd=project,
                                    env=env, capture_output=True, text=True, timeout=15)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertNotIn('outside-marker', result.stdout)
            # The same object is reachable by its ordinary project alias.
            result = subprocess.run([str(runner), '--settings', str(settings), '-c',
                                     "cat ordinary-name && printf outside-modified > ordinary-name"],
                                    cwd=project, env=env, capture_output=True,
                                    text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('outside-marker', result.stdout)
            self.assertEqual(secret.read_text(), 'outside-modified')


if __name__ == '__main__':
    unittest.main()
