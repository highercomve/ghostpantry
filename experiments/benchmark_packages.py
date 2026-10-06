"""Research-only SKU110K-trained YOLO11n region evaluation; no weights shipped.
Needs onnxruntime, pillow, numpy. Dataset terms restrict non-commercial use.
"""
import argparse,hashlib,json,time
from pathlib import Path
import numpy as np
import onnxruntime as ort
from PIL import Image,ImageDraw,ImageOps
EXPECTED="5810269bf9687ca93b0d4e1bc91cb83ac4311cd48d91c4f6091777721ba083c5"
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument("--model",required=True);p.add_argument("--photo",required=True)
 p.add_argument("--crop");p.add_argument("--output",required=True);p.add_argument("--overlay",required=True);a=p.parse_args()
 data=Path(a.model).read_bytes();assert hashlib.sha256(data).hexdigest()==EXPECTED,"Checkpoint hash mismatch"
 photo=ImageOps.exif_transpose(Image.open(a.photo)).convert("RGB")
 if a.crop:
  x,y,r,b=map(float,a.crop.split(","));photo=photo.crop((round(x*photo.width),round(y*photo.height),round(r*photo.width),round(b*photo.height)))
 photo.thumbnail((1600,1600));scale=min(640/photo.width,640/photo.height)
 size=(round(photo.width*scale),round(photo.height*scale));left=(640-size[0])//2;top=(640-size[1])//2
 canvas=Image.new("RGB",(640,640),(114,114,114));canvas.paste(photo.resize(size,Image.Resampling.BILINEAR),(left,top))
 tensor=np.asarray(canvas,dtype=np.float32).transpose(2,0,1)[None]/255
 options=ort.SessionOptions();options.intra_op_num_threads=4;options.inter_op_num_threads=1
 started=time.perf_counter();session=ort.InferenceSession(a.model,sess_options=options,providers=["CPUExecutionProvider"]);load=time.perf_counter()-started
 times=[]
 for repeat in range(4):
  started=time.perf_counter();raw=session.run(None,{session.get_inputs()[0].name:tensor})[0];times.append(time.perf_counter()-started)
 assert raw.shape[1]==5,raw.shape
 candidates=[]
 for row in raw[0].T:
  cx,cy,w,h,score=map(float,row)
  if score<.25:continue
  x1,y1=max(0,(cx-w/2-left)/scale),max(0,(cy-h/2-top)/scale)
  x2,y2=min(photo.width,(cx+w/2-left)/scale),min(photo.height,(cy+h/2-top)/scale)
  if x2>x1 and y2>y1:candidates.append([x1,y1,x2,y2,score])
 candidates=sorted(candidates,key=lambda b:b[4],reverse=True)[:512];boxes=[]
 for b in candidates:
  def iou(c):
   intersection=max(0,min(b[2],c[2])-max(b[0],c[0]))*max(0,min(b[3],c[3])-max(b[1],c[1]))
   union=(b[2]-b[0])*(b[3]-b[1])+(c[2]-c[0])*(c[3]-c[1])-intersection
   return intersection/union if union else 0
  if all(iou(c)<.45 for c in boxes):boxes.append(b)
  if len(boxes)==32:break
 draw=ImageDraw.Draw(photo)
 for index,b in enumerate(boxes):draw.rectangle(b[:4],outline="lime",width=3);draw.text((b[0],b[1]),f"{index+1}: {b[4]:.2f}",fill="lime")
 photo.save(a.overlay)
 report={"model":"chistopat/sku110k-yolo11-object-detector","revision":"ee1b8ac34eb3b68969ffa8165e50c43457fe4e35","sha256":EXPECTED,
  "usage":"research-only evaluation; not bundled in GhostPantry","model_bytes":len(data),"platform":"desktop CPU four threads; NOT phone timings",
  "input_shape":[1,3,640,640],"photo_size":photo.size,"threshold":.25,"nms_iou":.45,"load_s":load,"inference_s":times,
  "boxes":[{"x":b[0]/photo.width,"y":b[1]/photo.height,"width":(b[2]-b[0])/photo.width,"height":(b[3]-b[1])/photo.height,"score":b[4]} for b in boxes]}
 Path(a.output).write_text(json.dumps(report,indent=2)+"\n");print(len(boxes),"regions;",round(np.median(times[1:])*1000,1),"ms warm desktop inference")
if __name__=="__main__":main()
