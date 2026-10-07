"""A separate APFS volume prevents cross-device aliases but not denied aliases.

Only a new disposable image is mounted. Existing projects/volumes are untouched.
"""

import errno
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class VolumeEvidence(unittest.TestCase):
    def test_separate_apfs_volume_is_not_complete_sensitive_object_boundary(self):
        runner = Path(os.environ['SANDBOX_SRT_BIN'])
        with tempfile.TemporaryDirectory(prefix='ss-phase2-volume-', dir='/tmp') as temp:
            root = Path(temp).resolve()
            image = root / 'workspace.sparseimage'
            mount = root / 'mount'
            mount.mkdir()
            result = subprocess.run(['/usr/bin/hdiutil', 'create', '-size', '128m',
                                     '-fs', 'APFS', '-type', 'SPARSE', '-volname',
                                     'ShellSpanPhase2', str(image)], capture_output=True,
                                    text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run(['/usr/bin/hdiutil', 'attach', str(image),
                                     '-mountpoint', str(mount), '-nobrowse', '-noautoopen'],
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            try:
                project = mount / 'project'
                project.mkdir()
                outside = root / 'outside-marker'
                outside.write_text('outside-marker')
                self.assertNotEqual(project.stat().st_dev, outside.stat().st_dev)
                with self.assertRaises(OSError) as rejected:
                    os.link(outside, project / 'external-alias')
                self.assertEqual(rejected.exception.errno, errno.EXDEV)
                # Sensitive files can still have another name on the new volume.
                secret = project / '.env'
                secret.write_text('inside-sensitive-marker')
                os.link(secret, project / 'ordinary-name')
                settings = root / 'settings.json'
                settings.write_text(json.dumps({
                    'filesystem': {'denyRead': [str(secret)],
                                   'allowWrite': [str(project)],
                                   'denyWrite': [str(secret)]},
                    'network': {'allowedDomains': [], 'deniedDomains': []}
                }))
                home = root / 'home'
                home.mkdir()
                env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'TMPDIR': str(root)}
                result = subprocess.run([str(runner), '--settings', str(settings), '-c',
                                         'cat .env'], cwd=project, env=env,
                                        capture_output=True, text=True, timeout=15)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertNotIn('inside-sensitive-marker', result.stdout)
                result = subprocess.run([str(runner), '--settings', str(settings), '-c',
                                         'cat ordinary-name'], cwd=project, env=env,
                                        capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('inside-sensitive-marker', result.stdout)
                self.assertEqual(outside.read_text(), 'outside-marker')
            finally:
                result = subprocess.run(['/usr/bin/hdiutil', 'detach', str(mount)],
                                        capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
