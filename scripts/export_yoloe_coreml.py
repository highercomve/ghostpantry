#!/usr/bin/env python3
"""Export the YOLOE package and produce detectors for Apple (CoreML).

The same checkpoint and prompts as export_yoloe_packages.py (Android's ONNX
models), exported with a fixed 640x640 input (CoreML has no free dynamic
shape here; the Swift side letterboxes each tile into it) and compiled with
`xcrun coremlcompiler`, so the app ships .mlmodelc bundles and never
compiles on the phone. Runs on a Mac with Xcode.

Requires: ultralytics 8.4.174, torch 2.7.0 (coremltools' newest tested;
2.14 fails to convert), coremltools 9.0 and numpy 2.2 (numpy 2.3+ breaks
coremltools' int casts; pip warns that ultralytics wants newer). The text
encoder Ultralytics downloads for set_classes lives in --models-dir; it is
not shipped. Writes <output>/yoloe-coreml/ (the .mlmodelc bundles and
yoloe_coreml.json) and <output>/yoloe-coreml.tar.gz, the release asset that
build.zig.zon pins by hash.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
from pathlib import Path

from export_yoloe_packages import PROFILES

SOURCE_SHA256 = '1741c1f8da3cea47e2c01829c334a50dc0b9bbd05e685b90a3ce84fae32c8c1b'
SIDE = 640


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def tree_digest(root):
    """One SHA-256 over a bundle's files: relative path, size and contents, in order."""
    h = hashlib.sha256()
    for path in sorted(p for p in root.rglob('*') if p.is_file()):
        rel = path.relative_to(root).as_posix().encode()
        h.update(len(rel).to_bytes(4, 'big') + rel + path.stat().st_size.to_bytes(8, 'big'))
        h.update(path.read_bytes())
    return h.hexdigest()


def reset(info):
    """Reproducible tarball: no owners, times or modes from this machine."""
    info.uid = info.gid = 0
    info.uname = info.gname = ''
    info.mtime = 0
    info.mode = 0o755 if info.isdir() else 0o644
    return info


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models-dir', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    models = args.models_dir.resolve(strict=True)
    output = args.output_dir.resolve()
    bundle = output / 'yoloe-coreml'
    if bundle.exists():
        shutil.rmtree(bundle)
    bundle.mkdir(parents=True)
    os.chdir(models)
    import coremltools as ct
    import torch
    from PIL import Image
    import ultralytics
    from ultralytics import YOLOE
    torch.set_num_threads(4)
    assert ultralytics.__version__ == '8.4.174'
    source = models / 'yoloe-26n-seg.pt'
    assert digest(source) == SOURCE_SHA256
    result = {'input_size': SIDE, 'stride': 32, 'dynamic_shape': False, 'tile_fraction': .65, 'nms_iou': .3,
              'default_threshold': .1, 'source_sha256': SOURCE_SHA256, 'ultralytics': ultralytics.__version__,
              'torch': torch.__version__, 'coremltools': ct.__version__, 'license': 'AGPL-3.0', 'profiles': []}
    for name, prompts in PROFILES.items():
        detector = YOLOE(str(source))
        detector.set_classes(prompts)
        detector.model.pt_path = str(output / f'{name}.pt')
        # nms=None keeps the checkpoint's one-to-many head, as the ONNX export.
        exported = Path(detector.export(format='coreml', imgsz=SIDE, batch=1, device='cpu',
                                        half=False, nms=None))
        model = ct.models.MLModel(str(exported))
        spec = model.get_spec()
        inputs = [i.name for i in spec.description.input]
        outputs = [o.name for o in spec.description.output]
        assert len(inputs) == 1, inputs
        # Ultralytics exports an RGB image input scaled by 1/255, as the ONNX
        # models' normalization: the app passes a 640x640 pixel buffer.
        image = spec.description.input[0].type.imageType
        assert (image.width, image.height) == (SIDE, SIDE), image
        # The raw head: (1, 4 + classes + 32 mask coefficients, 8400 anchors).
        probe = model.predict({inputs[0]: Image.new('RGB', (SIDE, SIDE), (114, 114, 114))})
        head = [n for n in outputs if probe[n].shape == (1, 4 + len(prompts) + 32, 8400)]
        assert len(head) == 1, {n: probe[n].shape for n in outputs}
        compiled_parent = output / 'compiled'
        if compiled_parent.exists():
            shutil.rmtree(compiled_parent)
        subprocess.run(['xcrun', 'coremlcompiler', 'compile', str(exported), str(compiled_parent)], check=True)
        compiled = next(compiled_parent.glob('*.mlmodelc'))
        target = bundle / f'{name}.mlmodelc'
        shutil.move(str(compiled), target)
        result['profiles'].append({'name': name, 'prompts': prompts, 'input': inputs[0], 'output': head[0],
                                   'output_format': 'cxcywh_class_probabilities_masks', 'head': 'one-to-many',
                                   'file': target.name, 'sha256': tree_digest(target)})
        print(f'{name}: input {inputs[0]}, output {head[0]}', flush=True)
    (bundle / 'yoloe_coreml.json').write_text(json.dumps(result, indent=2) + '\n')
    shutil.copy(Path(__file__).resolve().parents[1] / 'android/native/detectors/YOLOE-LICENSE', bundle / 'YOLOE-LICENSE')
    archive = output / 'yoloe-coreml.tar.gz'
    with tarfile.open(archive, 'w:gz', compresslevel=9) as tar:
        tar.add(bundle, arcname='yoloe-coreml', filter=reset)
    print(f'{archive}: {archive.stat().st_size} bytes, sha256 {digest(archive)}')


if __name__ == '__main__':
    main()
