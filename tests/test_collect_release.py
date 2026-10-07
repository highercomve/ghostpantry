import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/collect-release.py"


class ReleaseCollectionTests(unittest.TestCase):
    def test_android_keeps_installable_debug_and_release_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files = {
                "android/app/build/outputs/apk/debug/app-debug.apk": b"debug package",
                "android/app/build/outputs/apk/release/app-release-unsigned.apk": b"release package",
                "android/app/build/outputs/bundle/release/app-release.aab": b"bundle",
                "android/app/build/outputs/apk/release/app-old.apk": b"stale package",
            }
            for name, content in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
            for variant, filename in [("debug", "app-debug.apk"), ("release", "app-release-unsigned.apk")]:
                (root / f"android/app/build/outputs/apk/{variant}/output-metadata.json").write_text(
                    json.dumps({"elements": [{"outputFile": filename}]})
                )
            subprocess.run([sys.executable, str(SCRIPT), "android"], cwd=root, check=True, capture_output=True)
            checksums = (root / "dist/SHA256SUMS-android").read_text().splitlines()
            self.assertEqual(len(checksums), 3)
            for line in checksums:
                digest, name = line.split("  ", 1)
                content = (root / "dist" / name).read_bytes()
                self.assertEqual(digest, hashlib.sha256(content).hexdigest())
            self.assertTrue((root / "dist/ghostpantry-android-app-debug.apk").is_file())
            self.assertFalse((root / "dist/ghostpantry-android-app-old.apk").exists())

    def test_missing_packages_fail_instead_of_uploading_an_empty_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, str(SCRIPT), "linux-x86_64"], cwd=directory, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("No linux-x86_64 packages found", result.stderr)


if __name__ == "__main__":
    unittest.main()
