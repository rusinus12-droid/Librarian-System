#!/usr/bin/env python3
"""Verification-tool tests; no production fixture, network or user-data access."""
from pathlib import Path
import json, shutil, subprocess, sys, tempfile, unittest

TOOLS = Path(__file__).resolve().parent
NODE = shutil.which('node')

class RunnerPortability(unittest.TestCase):
    def test_path_with_spaces_receipt_and_no_overwrite(self):
        self.assertIsNotNone(NODE)
        with tempfile.TemporaryDirectory(prefix='wm runner path with spaces ') as tmp:
            root=Path(tmp); (root/'tools').mkdir()
            for name in ['run-integration-verification.py','strict-offline-guard.cjs','portable-test-paths.cjs']:
                shutil.copy2(TOOLS/name,root/'tools'/name)
            command=[sys.executable,str(root/'tools/run-integration-verification.py'),'SPACE-CONTROL','--node',NODE,'--','-e','console.log("offline runner space-path control")']
            first=subprocess.run(command,text=True,capture_output=True,timeout=20)
            self.assertEqual(first.returncode,0,first.stdout+first.stderr)
            receipt=root/'evidence/SPACE-CONTROL/RESULT.json'
            row=json.loads(receipt.read_text())
            self.assertEqual(row['status'],'PASS'); self.assertEqual(row['networkAttempts'],0)
            before=receipt.read_bytes()
            second=subprocess.run(command,text=True,capture_output=True,timeout=20)
            self.assertNotEqual(second.returncode,0)
            self.assertEqual(before,receipt.read_bytes(),'existing evidence must not be overwritten')

if __name__=='__main__': unittest.main()
