"""Compare MobileCLIP-S0 with EmbeddingGemma on identical JPEG crops.
Desktop CPU timings only. Needs official Apple repository on --mobileclip-code,
MobileCLIP-S0 checkpoint, torch CPU, timm, open_clip_torch and litert-lm.
"""
import argparse,hashlib,io,json,sys,time
from pathlib import Path
import numpy as np
import torch
from PIL import Image,ImageOps
import litert_lm
from benchmark_regions import grid
ROOT=Path(__file__).resolve().parents[1]
EXPECTED="809b408eff74f8058843e86a1f92967097d42ba782450e85b8f4867b7f0ca0b7"
def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument("--mobileclip-code",required=True);p.add_argument("--mobileclip-model",required=True)
 p.add_argument("--gemma-model",required=True);p.add_argument("--photo",required=True)
 p.add_argument("--labels",help="JSON food labels; defaults to the historical 307-label comparison preset",default=str(ROOT/"experiments/food-labels-307.json"));p.add_argument("--crop");p.add_argument("--output",required=True);a=p.parse_args()
 checkpoint_hash=hashlib.sha256(Path(a.mobileclip_model).read_bytes()).hexdigest()
 if checkpoint_hash!=EXPECTED:raise ValueError("Use the pinned Apple MobileCLIP-S0 checkpoint")
 sys.path.insert(0,a.mobileclip_code)
 import mobileclip
 torch.set_num_threads(4)
 photo=ImageOps.exif_transpose(Image.open(a.photo)).convert("RGB")
 if a.crop:
  x,y,r,b=map(float,a.crop.split(","));photo=photo.crop((round(x*photo.width),round(y*photo.height),round(r*photo.width),round(b*photo.height)))
 photo.thumbnail((1600,1600))
 labels=json.loads(Path(a.labels).read_text())+["other food","non-food objects","empty shelf"]
 started=time.perf_counter();model,_,preprocess=mobileclip.create_model_and_transforms("mobileclip_s0",pretrained=a.mobileclip_model,device="cpu")
 load=time.perf_counter()-started;tokenizer=mobileclip.get_tokenizer("mobileclip_s0")
 with torch.inference_mode():
  started=time.perf_counter();texts=[]
  for i in range(0,len(labels),32):
   v=model.encode_text(tokenizer(["A photo of "+label for label in labels[i:i+32]]));texts.append(torch.nn.functional.normalize(v,dim=-1))
  text_vectors=torch.cat(texts);text_time=time.perf_counter()-started
  model.encode_image(preprocess(photo).unsqueeze(0)) # Excluded warm-up, reported below.
 report={"platform":"desktop CPU, four threads; NOT phone benchmarks","labels":len(labels)-3,
  "mobileclip":{"code_revision":"48faa0fea4b08d74188b3841771aca6ff2c92852","revision":"71aa3e13dda93115871afbd017336535ba29886c","sha256":checkpoint_hash,"load_s":load,"cold_labels_s":text_time,"image_parameters":sum(p.numel() for p in model.image_encoder.parameters()),"warmup_excluded":True},"runs":[]}
 backend=litert_lm.Backend.CPU(thread_count=4)
 engine=litert_lm.EmbeddingEngine(a.gemma_model,backend=backend,vision_backend=backend,cache_dir="/tmp/ghostpantry-embedding-cache",max_input_length=128,vision_tokens_per_image=70)
 options=litert_lm.EmbeddingOptions(normalize=True,output_size=256,vision_tokens_per_image=70)
 try:
  started=time.perf_counter();gemma_vectors=np.asarray([engine.compute_embedding("A photo of "+label,options).embedding for label in labels]);report["gemma_cold_labels_s"]=time.perf_counter()-started
  for index,(x,y,w,h,label) in enumerate(grid()):
   left,top=int(x*photo.width),int(y*photo.height)
   crop=photo.crop((left,top,min(photo.width,left+int(np.ceil(w*photo.width))),min(photo.height,top+int(np.ceil(h*photo.height)))))
   encoded=io.BytesIO();crop.save(encoded,format="JPEG",quality=90);jpeg=encoded.getvalue();decoded=Image.open(io.BytesIO(jpeg)).convert("RGB")
   tensor=preprocess(decoded).unsqueeze(0)
   timings=[]
   with torch.inference_mode():
    for repeat in range(3):
     started=time.perf_counter();feature=torch.nn.functional.normalize(model.encode_image(tensor),dim=-1);timings.append(time.perf_counter()-started)
    scores=(feature@text_vectors.T).squeeze().numpy()
   started=time.perf_counter();gemma=engine.compute_embedding(litert_lm.Content.ImageBytes(jpeg),options).embedding;gemma_time=time.perf_counter()-started;gscores=gemma_vectors@np.asarray(gemma)
   def ranking(scores):
    order=sorted(range(len(labels)-3),key=lambda i:float(scores[i]),reverse=True)[:5]
    return {"top5":[{"label":labels[i],"score":float(scores[i])} for i in order],"background":float(max(scores[-3:]))}
   report["runs"].append({"region":label,"mobileclip_image_s":timings,"mobileclip":ranking(scores),"gemma_image_s":gemma_time,"gemma":ranking(gscores)})
   print(label,"MobileCLIP",round(np.median(timings),3),"Gemma",round(gemma_time,3),"top",labels[int(np.argmax(scores[:-3]))],flush=True)
  Path(a.output).write_text(json.dumps(report,indent=2)+"\n")
 finally:engine.close()
if __name__=="__main__":main()
