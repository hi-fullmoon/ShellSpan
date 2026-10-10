"""Exercise the actual host controller using owned local children and receipts."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / 'src-tauri/src/agent_runtime'
PROGRAM = ("import sys,types\nm=types.ModuleType('shellspan_controller')\n"
           "sys.modules[m.__name__]=m\n"
           f"exec({(SOURCES / 'remote_seatbelt.py').read_text()!r},m.__dict__)\n"
           f"exec({(SOURCES / 'remote_host.py').read_text()!r})\n")


def invoke(request):
    return subprocess.run([sys.executable, '-I', '-c', PROGRAM],
                          input=json.dumps(request).encode() + b'\n',
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)


class HostController(unittest.TestCase):
    def test_exit_and_timeout_have_authenticated_cleanup_receipts(self):
        with tempfile.TemporaryDirectory(prefix='shellspan-host-controller-test-') as directory:
            inspected = invoke({'mode': 'inspect', 'hostController': True, 'root': directory})
            self.assertEqual(inspected.returncode, 0, inspected.stderr.decode())
            facts = json.loads(inspected.stdout)
            self.assertEqual(facts['uid'], os.getuid())
            for command, timeout, state in [('printf own-output', 5000, 'exited'),
                                            ('printf own-output', 3600000, 'exited'),
                                            ('printf own-output; sleep 30', 1000, 'timedOut')]:
                request = facts | {'mode': 'run', 'hostController': True, 'policy': 'host',
                                   'jobId': str(uuid.uuid4()), 'token': secrets.token_hex(32),
                                   'command': command, 'timeoutMs': timeout,
                                   'digest': hashlib.sha256(command.encode()).hexdigest()}
                result = invoke(request)
                self.assertEqual(result.stdout, b'own-output', result.stderr.decode())
                self.assertIn(result.returncode, (0, 124))
                receipt = invoke(request | {'mode': 'status'})
                self.assertEqual(receipt.returncode, 0, receipt.stderr.decode())
                data = json.loads(receipt.stdout)['data']
                self.assertEqual(data['state'], state)
                self.assertTrue(data['controllerFinished'])
                self.assertTrue(data['terminationConfirmed'])
                wrong_key = invoke(request | {'mode': 'cleanup', 'token': secrets.token_hex(32)})
                self.assertNotEqual(wrong_key.returncode, 0)
                cleaned = invoke(request | {'mode': 'cleanup'})
                self.assertEqual(cleaned.returncode, 0, cleaned.stderr.decode())
                self.assertFalse((Path(facts['tempBase']) / f"shellspan-native-remote-{request['jobId']}").exists())


if __name__ == '__main__':
    unittest.main()
