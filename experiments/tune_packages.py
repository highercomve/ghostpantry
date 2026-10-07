#!/usr/bin/env python3
"""CPU proposal sweep on one photo; writes results for gtk_package_lab.py.

Uses the existing research venv (onnxruntime, Pillow, numpy, ultralytics).
Reference boxes are approximate visible extents; do not interpret this as
held-out accuracy. Models/photos/overlays remain outside the repository.
"""
import argparse
import hashlib
import json
import os
import platform
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageOps


def iou(a, b):
    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - intersection
    return intersection / union if union > 0 else 0


def suppress(boxes, threshold=.5, limit=12):
    selected = []
    for box in sorted(boxes, key=lambda b: b['score'], reverse=True):
        if all(iou(box['box'], other['box']) < threshold for other in selected):
            selected.append(box)
        if len(selected) == limit:
            break
    return selected


def evaluate(boxes, references):
    # Best available overlaps are independent; matches use one-to-one greedy
    # descending IoU, so duplicates cannot count as additional packages.
    pairs = sorted([(iou(b['box'], r['box']), bi, ri) for bi, b in enumerate(boxes)
                    for ri, r in enumerate(references)], reverse=True)
    used_b, used_r = set(), set()
    for overlap, bi, ri in pairs:
        if overlap >= .5 and bi not in used_b and ri not in used_r:
            used_b.add(bi)
            used_r.add(ri)
    return {'matched_at_iou_50': len(used_r), 'reference_count': len(references),
            'unmatched_proposals': len(boxes)-len(used_b),
            'best_iou_by_reference': {r['label']: round(max([iou(b['box'], r['box']) for b in boxes], default=0), 3)
                                      for r in references}}


def tiles(width, height, layout):
    if layout == 'whole':
        return [(0, 0, width, height)]
    count, fraction = (2, .65) if layout == '2x2' else (3, .5)
    tw, th = round(width*fraction), round(height*fraction)
    return [(round(x*(width-tw)/(count-1)), round(y*(height-th)/(count-1)),
             round(x*(width-tw)/(count-1))+tw, round(y*(height-th)/(count-1))+th)
            for y in range(count) for x in range(count)]


def rfdetr(session, photo, tile, rotation, classes):
    crop = photo.crop(tile)
    original_w, original_h = crop.size
    rotated = crop.transpose(Image.Transpose.ROTATE_90) if rotation else crop
    tensor = np.asarray(rotated.resize((384,384), Image.Resampling.BILINEAR), dtype=np.float32)/255
    tensor = ((tensor-np.array([.485,.456,.406], dtype=np.float32))/np.array([.229,.224,.225], dtype=np.float32)).transpose(2,0,1)[None]
    dets, logits = session.run(['dets','labels'], {'input': tensor})
    ids = list(classes)
    scores = 1/(1+np.exp(-np.clip(logits[0][:, ids], -80, 80)))
    best = scores.argmax(axis=1)
    boxes = []
    for d, index, score in zip(dets[0], best, scores.max(axis=1)):
        cx,cy,w,h = map(float,d)
        a,b,c,e = max(0,cx-w/2),max(0,cy-h/2),min(1,cx+w/2),min(1,cy+h/2)
        if rotation:
            a,b,c,e = 1-e,a,1-b,c
        box = [tile[0]+a*original_w,tile[1]+b*original_h,tile[0]+c*original_w,tile[1]+e*original_h]
        if all(np.isfinite(box)) and box[2]>box[0] and box[3]>box[1]:
            boxes.append({'box':box,'score':float(score),'label':classes[ids[index]]})
    return boxes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('photo', type=Path)
    parser.add_argument('--rfdetr', type=Path, required=True)
    parser.add_argument('--models-dir', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--references', type=Path, default=Path(__file__).with_name('pantry-reference-boxes.json'))
    parser.add_argument('--skip-yoloe', action='store_true')
    args = parser.parse_args()
    photo_path = args.photo.resolve(strict=True)
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    photo = ImageOps.exif_transpose(Image.open(photo_path)).convert('RGB')
    ref = json.loads(args.references.read_text())
    if list(photo.size) != ref['photo_size']:
        parser.error('Reference boxes must match photo dimensions')
    classes_path = Path(__file__).resolve().parents[1]/'android/app/src/main/assets/detectors/rfdetr_nano.json'
    contract = json.loads(classes_path.read_text())
    model = args.rfdetr.resolve(strict=True)
    if hashlib.file_digest(model.open('rb'), 'sha256').hexdigest() != contract['onnx_sha256']:
        parser.error('RF-DETR model hash mismatch')
    classes = {int(k):v for k,v in contract['classes'].items()}
    report = {'photo':str(photo_path),'photo_sha256':hashlib.file_digest(photo_path.open('rb'),'sha256').hexdigest(),
              'photo_size':list(photo.size),'reference_note':ref['description'],'references':ref['boxes'],
              'machine':platform.machine(),'rfdetr_onnx_sha256':contract['onnx_sha256'],
              'preprocessing_note':'RF-DETR uses Pillow bilinear square resize with its default downsampling filter. This differs slightly from Android Bitmap scaling and can move low-confidence scores across thresholds.',
              'timing_note':'Desktop CPU, four threads. Includes resize, inference and decoding; excludes model/prompt load. Not phone timings.',
              'runs':[]}

    def save(name, boxes, elapsed, **config):
        entry = {'name':name,'boxes':boxes,'seconds':round(elapsed,4),**config,**evaluate(boxes,ref['boxes'])}
        overlay = photo.copy()
        draw = ImageDraw.Draw(overlay)
        for index, b in enumerate(boxes):
            draw.rectangle(b['box'], outline='#ffb700', width=3)
            draw.text((b['box'][0]+3,b['box'][1]+3), f"{index+1} {b['label']} {b['score']:.2f}", fill='white', stroke_width=1, stroke_fill='black')
        entry['overlay'] = str(output_dir/f'{len(report["runs"]):02d}.png')
        overlay.save(entry['overlay'])
        report['runs'].append(entry)
        # Atomic replacement allows the GTK viewer to reload while the sweep runs.
        temporary = output_dir/'results.tmp'
        temporary.write_text(json.dumps(report,indent=2)+'\n')
        temporary.replace(output_dir/'results.json')
        print(f"{name}: {len(boxes)} boxes, {entry['matched_at_iou_50']}/{len(ref['boxes'])} reference overlaps, {elapsed:.3f}s", flush=True)

    import onnxruntime as ort
    report['onnxruntime'] = ort.__version__
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(model),sess_options=options,providers=['CPUExecutionProvider'])
    # Warm the session before the timed sweep.
    rfdetr(session, photo, (0,0,*photo.size), False, classes)
    for layout in ['whole','2x2','3x3']:
        for rotate in [False, True]:
            started = time.perf_counter()
            raw = []
            for tile in tiles(*photo.size,layout):
                raw.extend(rfdetr(session,photo,tile,False,classes))
                if rotate:
                    raw.extend(rfdetr(session,photo,tile,True,classes))
            elapsed = time.perf_counter()-started
            for threshold in [.1,.15,.25]:
                filtered = [b for b in raw if b['score']>=threshold]
                # Keep whole-photo/no-rotation baseline identical to Android:
                # one best class/query, score ordering, 12 cap, no extra NMS.
                boxes = sorted(filtered,key=lambda b:b['score'],reverse=True)[:12] if layout=='whole' and not rotate else suppress(filtered)
                save(f'RF-DETR {layout} {"+90°" if rotate else ""} @{threshold:.2f}',boxes,elapsed,
                     model='RF-DETR Nano ONNX',layout=layout,rotated=rotate,threshold=threshold)
    del session
    if args.skip_yoloe:
        return
    import torch
    import ultralytics
    from ultralytics import YOLOE
    report.update(torch=torch.__version__,ultralytics=ultralytics.__version__)
    torch.set_num_threads(4)
    models_dir = args.models_dir.resolve(strict=True)
    os.chdir(models_dir)
    profiles = {
        'single-package':['food package'],
        'materials':['plastic food bag','cardboard food box','food pouch'],
        'specific':['bag of pasta','bag of rice','packet of instant noodles','box of pasta'],
    }
    for model_name in ['yoloe-26n-seg.pt','yoloe-26s-seg.pt']:
        model_hash = hashlib.file_digest((models_dir/model_name).open('rb'),'sha256').hexdigest()
        for profile,prompts in profiles.items():
            detector = YOLOE(str(models_dir/model_name))
            detector.set_classes(prompts)
            for size,layout in [(640,'whole'),(1024,'whole'),(640,'2x2')]:
                detector.predict(photo,imgsz=size,device='cpu',conf=.1,iou=.5,verbose=False)
                started = time.perf_counter()
                raw = []
                for tile in tiles(*photo.size,layout):
                    result = detector.predict(photo.crop(tile),imgsz=size,device='cpu',conf=.1,iou=.5,verbose=False)[0]
                    for b in result.boxes:
                        coords = b.xyxy[0].tolist()
                        coords = [coords[0]+tile[0],coords[1]+tile[1],coords[2]+tile[0],coords[3]+tile[1]]
                        raw.append({'box':coords,'score':float(b.conf[0]),'label':result.names[int(b.cls[0])]})
                elapsed = time.perf_counter()-started
                for threshold in [.1,.25]:
                    save(f'{model_name} {profile} {size} {layout} @{threshold:.2f}',
                         suppress([b for b in raw if b['score']>=threshold]),elapsed,
                         model=model_name,model_sha256=model_hash,prompts=prompts,size=size,layout=layout,threshold=threshold)
    # A fixed, reproducible union: whole-photo specific prompts retain full
    # packages, while material prompts on tiles recover smaller/occluded bags.
    # Compare several suppression values rather than silently tuning one.
    whole = next(r for r in report['runs'] if r['name']=='yoloe-26n-seg.pt specific 640 whole @0.10')
    cropped = next(r for r in report['runs'] if r['name']=='yoloe-26n-seg.pt materials 640 2x2 @0.10')
    for nms in [.3,.4,.5]:
        save(f'YOLOE Nano whole-specific + tiled-materials @0.10 NMS {nms:.2f}',
             suppress(whole['boxes']+cropped['boxes'],nms),whole['seconds']+cropped['seconds'],
             model='yoloe-26n-seg.pt',components=[whole['name'],cropped['name']],
             threshold=.1,nms_iou=nms,
             timing_scope='Sum of component prediction times; excludes switching prompt embeddings and union postprocessing')
    small_whole = next(r for r in report['runs'] if r['name']=='yoloe-26s-seg.pt specific 640 whole @0.10')
    for nms in [.3,.4,.5]:
        save(f'YOLOE Small whole-specific + Nano tiled-materials @0.10 NMS {nms:.2f}',
             suppress(small_whole['boxes']+cropped['boxes'],nms),small_whole['seconds']+cropped['seconds'],
             model='YOLOE Small + Nano',components=[small_whole['name'],cropped['name']],
             threshold=.1,nms_iou=nms,
             timing_scope='Sum of component prediction times; excludes model/prompt loading and union postprocessing')


if __name__ == '__main__':
    main()
