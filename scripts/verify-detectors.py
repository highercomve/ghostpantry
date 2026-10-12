"""Verify bundled YOLOE detector assets against their pinned export contract.

    python3 scripts/verify-detectors.py [yoloe-coreml.tar.gz | yoloe-coreml/]

Always checks Android's gzipped ONNX detectors. With an argument, also the
Apple CoreML detectors (the release asset build.zig.zon pins, or its
unpacked folder) against ios/native/detectors/yoloe_coreml.json.
"""
import gzip
import hashlib
import json
import sys
import tarfile
import tempfile
from pathlib import Path

repo = Path(__file__).resolve().parents[1]
root = repo / "android/native/detectors"
for model in json.loads((root / "yoloe_packages.json").read_text())["profiles"]:
    packed = (root / model["file"]).read_bytes()
    data = gzip.decompress(packed)
    if (len(packed) != model["bytes"] or hashlib.sha256(packed).hexdigest() != model["sha256"]
        or len(data) != model["onnx_bytes"] or hashlib.sha256(data).hexdigest() != model["onnx_sha256"]):
        raise SystemExit(f"Detector asset mismatch: {model['name']}")
    print(f"Verified {model['name']} ({len(packed):,} bytes)")

if len(sys.argv) > 1:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from export_yoloe_coreml import tree_digest

    pinned = json.loads((repo / "ios/native/detectors/yoloe_coreml.json").read_text())
    source = Path(sys.argv[1])
    with tempfile.TemporaryDirectory() as scratch:
        if source.is_file():
            with tarfile.open(source) as tar:
                tar.extractall(scratch, filter="data")
            source = Path(scratch) / "yoloe-coreml"
        if json.loads((source / "yoloe_coreml.json").read_text()) != pinned:
            raise SystemExit("CoreML detector manifest differs from ios/native/detectors/yoloe_coreml.json")
        for model in pinned["profiles"]:
            if tree_digest(source / model["file"]) != model["sha256"]:
                raise SystemExit(f"CoreML detector mismatch: {model['name']}")
            print(f"Verified {model['name']} (CoreML)")
