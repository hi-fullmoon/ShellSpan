"""Verify refusal on the observed default Docker configuration, not Linux support."""
import subprocess
import unittest


class LinuxUnavailable(unittest.TestCase):
    def test_namespace_failure_does_not_dispatch_command(self):
        version = subprocess.run(['docker', 'run', '--rm', '--network', 'none',
                                  'shellspan-sandbox-phase0:local', '--version'],
                                 capture_output=True, text=True, timeout=30)
        self.assertEqual(version.returncode, 0, version.stderr)
        self.assertIn('bubblewrap', version.stdout)
        result = subprocess.run(['docker', 'run', '--rm', '--network', 'none',
                                 'shellspan-sandbox-phase0:local', '--unshare-user',
                                 '--unshare-pid', '--unshare-net', '--new-session',
                                 '--die-with-parent', '--ro-bind', '/', '/',
                                 '/bin/sh', '-c', 'printf EXECUTION_STARTED'],
                                capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('No permissions to create new namespace', result.stderr)
        self.assertNotIn('EXECUTION_STARTED', result.stdout)


if __name__ == '__main__':
    unittest.main()
