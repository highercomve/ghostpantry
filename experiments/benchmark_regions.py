"""Desktop CPU comparison. Timings are NOT Pixel performance estimates.
Install Python 3.12: pip install litert-lm==0.18.0 mediapipe==0.10.32 pillow
Run --help. Uses the same crop geometry, text prompts and stronger-match rule as the app.
"""
import argparse, io, json, re, time
from pathlib import Path
import numpy as np
import litert_lm
import mediapipe as mp
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]

def grid():
    return [(0, 0, 1, 1, "Whole photo")] + [(x*.25, y*.25, .5, .5, f"Grid {y*3+x+1}") for y in range(3) for x in range(3)]

def detect(photo, name):
    started = time.perf_counter()
    options = mp.tasks.vision.ObjectDetectorOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(ROOT / f"android/app/src/main/assets/detectors/{name}.tflite")),
        running_mode=mp.tasks.vision.RunningMode.IMAGE, max_results=12, score_threshold=.25)
    with mp.tasks.vision.ObjectDetector.create_from_options(options) as detector:
        loaded = time.perf_counter()
        result = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(photo)))
        detected = time.perf_counter()
    regions = []
    for item in result.detections:
        b = item.bounding_box
        x, y, w, h = b.origin_x/photo.width, b.origin_y/photo.height, b.width/photo.width, b.height/photo.height
        left, top = max(0, x-w*.05), max(0, y-h*.05)
        right, bottom = min(1, x+w*1.05), min(1, y+h*1.05)
        category = max(item.categories, key=lambda c: c.score)
        if right > left and bottom > top:
            regions.append((left, top, right-left, bottom-top, category.category_name))
    return regions, {"load_s": loaded-started, "inference_s": detected-loaded}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--labels", default=str(ROOT / "experiments/food-labels-307.json"), help="JSON vocabulary; historical 307-label baseline by default")
    parser.add_argument("--photo", required=True)
    parser.add_argument("--crop", help="optional normalized left,top,right,bottom to extract photo from screenshot")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    photo = ImageOps.exif_transpose(Image.open(args.photo)).convert("RGB")
    if args.crop:
        x,y,r,b = map(float,args.crop.split(","))
        photo = photo.crop((round(x*photo.width),round(y*photo.height),round(r*photo.width),round(b*photo.height)))
    photo.thumbnail((1600,1600))
    labels = json.loads(Path(args.labels).read_text())
    backgrounds = ["other food", "non-food objects", "empty shelf"]
    backend = litert_lm.Backend.CPU(thread_count=4)
    started = time.perf_counter()
    engine = litert_lm.EmbeddingEngine(args.model, backend=backend, vision_backend=backend,
        cache_dir="/tmp/ghostpantry-embedding-cache", max_input_length=128, vision_tokens_per_image=70)
    load_s = time.perf_counter()-started
    options = litert_lm.EmbeddingOptions(normalize=True, output_size=256, vision_tokens_per_image=70)
    try:
        started = time.perf_counter()
        vectors = []
        for index,label in enumerate(labels+backgrounds):
            vectors.append(engine.compute_embedding("A photo of "+label, options).embedding)
            if index%50 == 0: print(f"Preparing label {index+1}/{len(labels)+3}", flush=True)
        text_s = time.perf_counter()-started
        vectors = np.asarray(vectors)
        report = {"platform": "desktop CPU, 4 threads; not phone timings", "photo_size": photo.size,
            "labels": len(labels), "embedding_load_s": load_s, "cold_text_s": text_s,
            "precision": "SDK default desktop precision; Android uses FP32", "runs": []}
        for mode in ["whole", "grid", "efficientdet_lite0", "efficientdet_lite2"]:
            print("Running "+mode, flush=True)
            started = time.perf_counter()
            detection = None
            if mode == "whole": regions = grid()[:1]
            elif mode == "grid": regions = grid()
            else: regions,detection = detect(photo,mode)
            results,merged = [],{}
            for index,(x,y,w,h,name) in enumerate(regions):
                left,top = int(x*photo.width),int(y*photo.height)
                crop = photo.crop((left,top,min(photo.width,left+int(np.ceil(w*photo.width))),min(photo.height,top+int(np.ceil(h*photo.height)))))
                encoded = io.BytesIO();crop.save(encoded,format="JPEG",quality=90)
                image_started = time.perf_counter()
                vector = engine.compute_embedding(litert_lm.Content.ImageBytes(encoded.getvalue()),options).embedding
                image_s = time.perf_counter()-image_started
                scores = vectors @ np.asarray(vector)
                ranked = sorted(range(len(labels)), key=lambda i: float(scores[i]), reverse=True)[:5]
                background = float(max(scores[len(labels):]))
                stronger = [labels[i] for i in ranked if scores[i]>background and scores[i]>=scores[ranked[0]]-.04]
                for i in ranked:
                    if labels[i] in stronger:
                        previous = merged.get(labels[i], {"score": -1, "regions": []})
                        merged[labels[i]] = {"score": max(previous["score"],float(scores[i])), "regions": previous["regions"]+[index+1]}
                results.append({"region": [x,y,w,h],"detector_label": name,"image_s": image_s,"background_score":background,
                    "matches": [{"label":labels[i],"score":float(scores[i])} for i in ranked],"stronger":stronger})
                print(f"  {index+1}/{len(regions)}: {', '.join(stronger) or 'no stronger match'}",flush=True)
            report["runs"].append({"mode":mode,"warm_total_s":time.perf_counter()-started,"detection":detection,
                "regions":results,"merged":dict(sorted(merged.items(),key=lambda x:x[1]["score"],reverse=True))})
        Path(args.output).write_text(json.dumps(report,indent=2)+"\n")
    finally: engine.close()

if __name__ == "__main__": main()
