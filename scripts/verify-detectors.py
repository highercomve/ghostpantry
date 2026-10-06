"""Verify bundled detector assets against their pinned download manifest."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1] / "android/app/src/main/assets/detectors"
for model in json.loads((root / "manifest.json").read_text()):
    data = (root / (model["name"] + ".tflite")).read_bytes()
    if len(data) != model["bytes"] or hashlib.sha256(data).hexdigest() != model["sha256"]:
        raise SystemExit(f"Detector asset mismatch: {model['name']}")
    print(f"Verified {model['name']} ({len(data):,} bytes)")
