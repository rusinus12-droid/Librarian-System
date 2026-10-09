import hashlib
import importlib.util
import pathlib
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('installer', pathlib.Path(__file__).parents[1] / 'tools/termux_install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def fixture(self, home, extra=None):
        archive = home / '배포 파일.zip'
        files = {'PROGRAM/program-manifest.json': b'{}', 'PROGRAM/1_서버_실행.sh': b'echo ready', 'DATA/keep.txt': b'new'}
        sums = '\n'.join(hashlib.sha256(v).hexdigest() + '  ./' + k for k, v in files.items() if k.startswith('PROGRAM/'))
        files['SHA256SUMS.txt'] = sums.encode()
        files.update(extra or {})
        with zipfile.ZipFile(archive, 'w') as z:
            for key, value in files.items():
                z.writestr('release/' + key, value)
        return archive

    def test_verified_install_and_existing_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            archive = self.fixture(home)
            dest = installer.install(archive, home / 'installed', home)
            (dest / 'DATA/keep.txt').write_text('user data')
            with self.assertRaises(ValueError):
                installer.install(archive, dest, home)
            self.assertEqual((dest / 'DATA/keep.txt').read_text(), 'user data')

    def test_traversal_and_unverified_file(self):
        for extra in ({'../../escape': b'bad'}, {'PROGRAM/unlisted.sh': b'bad'}, {'PROGRAM/1_서버_실행.sh': b'changed'}):
            with tempfile.TemporaryDirectory() as tmp:
                home = pathlib.Path(tmp)
                archive = self.fixture(home, extra)
                with self.assertRaises(ValueError):
                    installer.install(archive, home / 'installed', home)
                self.assertFalse((home / 'installed').exists())


if __name__ == '__main__':
    unittest.main()
