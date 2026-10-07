#!/usr/bin/env python3
"""Exercise the Android ONNX contract on the reference photo before APK builds."""
import argparse
import json
import time
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw, ImageOps
from tune_packages import suppress, evaluate, tiles


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('photo',type=Path)
    p.add_argument('--models-dir',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--overlay',type=Path,required=True)
    p.add_argument('--no-reference',action='store_true',help='Skip reference metrics for a different photo')
    a = p.parse_args()
    photo = ImageOps.exif_transpose(Image.open(a.photo)).convert('RGB')
    contract = json.loads((a.models_dir/'yoloe_packages.json').read_text())
    references = [] if a.no_reference else json.loads(Path(__file__).with_name('pantry-reference-boxes.json').read_text())['boxes']
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    all_boxes = []
    times = []
    for index,profile in enumerate(contract['profiles']):
        session = ort.InferenceSession(str(a.models_dir/(profile['name']+'.onnx')),sess_options=options,providers=['CPUExecutionProvider'])
        assert session.get_inputs()[0].shape == ['batch',3,'height','width']
        started = time.perf_counter()
        candidates = []
        for tile in tiles(*photo.size,'whole' if index==0 else '2x2'):
            image = np.asarray(photo.crop(tile))
            h,w = image.shape[:2]
            scale = min(640/w,640/h)
            nw,nh = round(w*scale),round(h*scale)
            input_w,input_h = ((nw+31)//32)*32,((nh+31)//32)*32
            left,top = (input_w-nw)//2,(input_h-nh)//2
            canvas = np.full((input_h,input_w,3),114,dtype=np.uint8)
            canvas[top:top+nh,left:left+nw] = cv2.resize(image,(nw,nh),interpolation=cv2.INTER_LINEAR)
            tensor = canvas.transpose(2,0,1)[None].astype(np.float32)/255
            rows = session.run(['output0'],{'images':tensor})[0]
            assert rows.shape[0:2] == (1,4+len(profile['prompts'])+32)
            for row in rows[0].T:
                cx,cy,wbox,hbox = map(float,row[:4])
                category = int(np.argmax(row[4:4+len(profile['prompts'])]))
                score = float(row[4+category])
                x,y,r,b = cx-wbox/2,cy-hbox/2,cx+wbox/2,cy+hbox/2
                if score < .1:
                    continue
                assert 0 <= category < len(profile['prompts']) and category == int(category)
                box = [tile[0]+max(0,(x-left)/scale),tile[1]+max(0,(y-top)/scale),
                       tile[0]+min(w,(r-left)/scale),tile[1]+min(h,(b-top)/scale)]
                if box[2]>box[0] and box[3]>box[1]:
                    candidates.append({'box':box,'score':score,'label':profile['prompts'][int(category)]})
        all_boxes.extend(suppress(candidates,.5))
        times.append(time.perf_counter()-started)
        del session
    boxes = suppress(all_boxes,.3)
    result = {'model':'YOLOE Nano fixed-prompt ONNX','threshold':.1,'boxes':boxes,
              **(evaluate(boxes,references) if references else {}),'prediction_s':times,
              'timing_note':'Desktop CPU four threads including preprocessing; excludes session load; not phone timings'}
    a.output.write_text(json.dumps(result,indent=2)+'\n')
    draw = ImageDraw.Draw(photo)
    for index,b in enumerate(boxes):
        draw.rectangle(b['box'],outline='orange',width=3)
        draw.text((b['box'][0],b['box'][1]),str(index+1),fill='white',stroke_width=1,stroke_fill='black')
    photo.save(a.overlay)
    metrics = f", {result['matched_at_iou_50']}/9 draft references" if references else ', reference metrics skipped'
    print(f"Exported ONNX: {len(boxes)} boxes{metrics}",flush=True)


if __name__=='__main__':
    main()
