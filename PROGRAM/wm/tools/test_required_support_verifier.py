#!/usr/bin/env python3
"""Offline negative controls for the support-only integrity verifier."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

class SupportVerifierTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wm support verifier ')
        self.root = Path(self.temp.name) / 'candidate'
        shutil.copytree(ROOT, self.root, ignore=shutil.ignore_patterns('test-output', 'verification', '__pycache__'))

    def tearDown(self):
        self.temp.cleanup()

    def verify(self):
        proc = subprocess.run([sys.executable, str(ROOT / 'tools/verify_required_support.py'), str(self.root)], text=True, capture_output=True)
        return proc

    def test_complete_support_is_accepted(self):
        proc = self.verify()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertTrue(json.loads(proc.stdout)['ok'])

    def test_gui_runs_from_path_with_spaces(self):
        proc = subprocess.run([sys.executable, str(ROOT / 'tools/verify_required_support.py'), str(self.root), '--run-gui'], text=True, capture_output=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(json.loads(proc.stdout)['gui']['exitCode'], 0)

    def test_changed_fixture_is_rejected(self):
        with (self.root / 'ux-prototype/libra-gui-ux-prototype.html').open('a') as out:
            out.write('\nchanged fixture\n')
        proc = self.verify()
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('hash_mismatch:ux-prototype/libra-gui-ux-prototype.html', proc.stdout)

    def test_missing_type_support_is_rejected(self):
        (self.root / 'vendor/risu-cbs-standalone/src/types.ts').unlink()
        proc = self.verify()
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('missing:vendor/risu-cbs-standalone/src/types.ts', proc.stdout)

    def test_changed_generated_source_is_rejected(self):
        with (self.root / 'src/parts/11-risu-cbs-parity-generated.js').open('a') as out:
            out.write('\n// changed\n')
        proc = self.verify()
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('hash_mismatch:src/parts/11-risu-cbs-parity-generated.js', proc.stdout)

    def test_legacy_companion_is_not_activated(self):
        path = self.root / 'module/libra-cbs-bridge.lua'
        path.parent.mkdir()
        path.write_text('return true\n')
        proc = self.verify()
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('forbidden_active_legacy:module/libra-cbs-bridge.lua', proc.stdout)

if __name__ == '__main__':
    unittest.main()
