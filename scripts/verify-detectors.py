"""Verify bundled YOLOE detector assets against their pinned export contract."""
import gzip
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1] / "android/app/src/main/assets/detectors"
for model in json.loads((root / "yoloe_packages.json").read_text())["profiles"]:
    packed = (root / model["file"]).read_bytes()
    data = gzip.decompress(packed)
    if (len(packed) != model["bytes"] or hashlib.sha256(packed).hexdigest() != model["sha256"]
        or len(data) != model["onnx_bytes"] or hashlib.sha256(data).hexdigest() != model["onnx_sha256"]):
        raise SystemExit(f"Detector asset mismatch: {model['name']}")
    print(f"Verified {model['name']} ({len(packed):,} bytes)")
