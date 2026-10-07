#!/usr/bin/env python3
"""Export CPU ONNX models with the package-tuning prompts baked in.

Requires the tuning environment: ultralytics 8.4.174, torch 2.14.1+cpu,
onnx 1.23.2. Text encoder lives in --models-dir; it is not shipped to phones.
Outputs gzip .bin assets (Android expands/renames .gz assets automatically).
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path

PROFILES = {
    'yoloe_packages_whole':['bag of pasta','bag of rice','packet of instant noodles','box of pasta','glass jar','plastic bottle','milk carton'],
    'yoloe_packages_tiles':['plastic food bag','cardboard food box','food pouch','glass jar','plastic bottle','milk carton'],
    'yoloe_produce':['fruit','vegetable','avocado','mushroom'],
}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream,'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models-dir',type=Path,required=True)
    parser.add_argument('--output-dir',type=Path,required=True)
    args = parser.parse_args()
    models = args.models_dir.resolve(strict=True)
    output = args.output_dir.resolve()
    output.mkdir(parents=True,exist_ok=True)
    os.chdir(models)
    import torch
    import onnx
    import ultralytics
    from ultralytics import YOLOE
    torch.set_num_threads(4)
    assert ultralytics.__version__=='8.4.174'
    source = models/'yoloe-26n-seg.pt'
    assert digest(source)=='1741c1f8da3cea47e2c01829c334a50dc0b9bbd05e685b90a3ce84fae32c8c1b'
    result = {'input_size':640,'stride':32,'dynamic_shape':True,'tile_fraction':.65,'nms_iou':.3,'default_threshold':.1,
              'source_sha256':digest(source),'ultralytics':ultralytics.__version__,
              'torch':torch.__version__,'opset':17,'license':'AGPL-3.0','profiles':[]}
    for name,prompts in PROFILES.items():
        detector = YOLOE(str(source))
        detector.set_classes(prompts)
        detector.model.pt_path = str(output/f'{name}.pt')
        # nms=None preserves the checkpoint's one-to-many head. nms=False
        # switches YOLO26 exports to one-to-one and changes this tuning result.
        exported = Path(detector.export(format='onnx',imgsz=640,batch=1,device='cpu',
                                        half=False,dynamic=True,simplify=False,opset=17,nms=None))
        graph = onnx.load(exported)
        shape = lambda v:[d.dim_param or d.dim_value for d in v.type.tensor_type.shape.dim]
        outputs = {v.name:shape(v) for v in graph.graph.output}
        assert shape(graph.graph.input[0])==['batch',3,'height','width']
        import onnxruntime as ort
        import numpy as np
        session = ort.InferenceSession(str(exported),providers=['CPUExecutionProvider'])
        assert session.run(['output0'],{'images':np.zeros((1,3,544,640),dtype=np.float32)})[0].shape==(1,4+len(prompts)+32,7140)
        packed = output/f'{name}.onnx.bin'
        packed.write_bytes(gzip.compress(exported.read_bytes(),compresslevel=6,mtime=0))
        result['profiles'].append({'name':name,'prompts':prompts,'input':'images','output':'output0',
                                   'output_format':'cxcywh_class_probabilities_masks','head':'one-to-many',
                                   'outputs':outputs,'onnx_sha256':digest(exported),
                                   'onnx_bytes':exported.stat().st_size,'file':packed.name,
                                   'bytes':packed.stat().st_size,'sha256':digest(packed)})
        print(f'{name}: {exported.stat().st_size} bytes, {outputs}',flush=True)
    (output/'yoloe_packages.json').write_text(json.dumps(result,indent=2)+'\n')


if __name__=='__main__':
    main()
