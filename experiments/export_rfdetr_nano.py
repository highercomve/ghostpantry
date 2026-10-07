"""Reproduce the bundled float32 RF-DETR Nano ONNX/gzip asset.

Use the recorded environment: rfdetr[onnx]==1.11.2, torch==2.14.1+cpu,
onnx==1.23.2, onnxruntime==1.30.0. Official weights are downloaded by RF-DETR.
Writes to an external directory; does not replace the app asset automatically.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    contract = json.loads((Path(__file__).resolve().parents[1] / "android/app/src/main/assets/detectors/rfdetr_nano.json").read_text())
    import torch
    import rfdetr
    import onnxruntime as ort
    from importlib.metadata import version
    from rfdetr.assets.model_weights import get_model_cache_dir

    if version("rfdetr") != "1.11.2" or str(torch.__version__) != contract["torch"]:
        raise SystemExit("Use the pinned RF-DETR/Torch export environment")
    torch.set_num_threads(4)
    model = rfdetr.RFDETRNano(device="cpu")
    checkpoint = Path(get_model_cache_dir()) / "rf-detr-nano.pth"
    if digest(checkpoint) != contract["checkpoint_sha256"]:
        raise SystemExit("Published checkpoint differs from the pinned source")
    path = model.export(output_dir=str(output), format="onnx", opset_version=17, verbose=False)
    path = Path(path)
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    assert [(node.name, node.shape) for node in session.get_inputs()] == [("input", [1, 3, 384, 384])]
    assert {node.name: node.shape for node in session.get_outputs()} == {"dets": [1, 300, 4], "labels": [1, 300, 91]}
    if digest(path) != contract["onnx_sha256"]:
        raise SystemExit("Export hash differs; inspect exporter versions and output parity before replacing the app model")
    packed = output / "rfdetr_nano.onnx.bin"
    packed.write_bytes(gzip.compress(path.read_bytes(), compresslevel=6, mtime=0))
    print(f"Verified exported model: {path}\nCompressed asset: {packed} ({packed.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
