"""Real filesystem counterexamples for proposed ordinary-copy writeback."""

import os
from pathlib import Path
import shutil
import tempfile
import unittest


class WritebackEvidence(unittest.TestCase):
    def test_copy_over_existing_hardlink_changes_project_external_object(self):
        with tempfile.TemporaryDirectory(prefix='shellspan-phase2-export-') as temp:
            root = Path(temp)
            project = root / 'project'
            project.mkdir()
            outside = root / 'outside-marker'
            outside.write_text('outside-original')
            os.link(outside, project / 'output')
            output = root / 'container-output'
            output.write_text('new-project-content')
            shutil.copyfile(output, project / 'output')
            self.assertEqual(outside.read_text(), 'new-project-content')

    def test_open_directory_identity_does_not_pin_current_host_path(self):
        with tempfile.TemporaryDirectory(prefix='shellspan-phase2-export-race-') as temp:
            root = Path(temp)
            project = root / 'project'
            project.mkdir()
            descriptor = os.open(project, os.O_RDONLY | os.O_DIRECTORY)
            try:
                # A concurrent host process moves the validated directory away
                # and recreates the visible project path before the next write.
                outside = root / 'moved-outside'
                project.rename(outside)
                project.mkdir()
                output = os.open('output', os.O_WRONLY | os.O_CREAT, 0o600,
                                 dir_fd=descriptor)
                with os.fdopen(output, 'w') as writer:
                    writer.write('exported-content')
                self.assertFalse((project / 'output').exists())
                self.assertEqual((outside / 'output').read_text(), 'exported-content')
            finally:
                os.close(descriptor)


if __name__ == '__main__':
    unittest.main()
