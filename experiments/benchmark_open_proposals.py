#!/usr/bin/env python3
"""Compare raw FastSAM/YOLOE proposals. Counts are not package accuracy.

Dependencies used: ultralytics==8.4.174, torch==2.14.1+cpu, Pillow,
ultralytics/CLIP revision 7ffa84b3bfa40c42ecc1c77147a855e69cb2dd40.
Models and the text encoder are downloaded by Ultralytics if absent.
Photos, models, and overlays should remain outside the repository.
"""
import argparse
import hashlib
import json
import os
import platform
import statistics
import time
from pathlib import Path

PROFILES = {
    "containers": ["food package", "plastic bag", "cardboard box", "food pouch"],
    "food-packages": ["pasta bag", "rice bag", "instant noodle packet", "food box", "food pouch"],
}


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("photo", type=Path)
    parser.add_argument("--models-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--overlays-dir", type=Path)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    if args.threads < 1 or args.repeats < 1:
        parser.error("threads and repeats must be positive")
    photo_path = args.photo.resolve(strict=True)
    model_dir = args.models_dir.resolve()
    output = args.output.resolve()
    overlays = args.overlays_dir.resolve() if args.overlays_dir else None
    model_dir.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    if overlays:
        overlays.mkdir(parents=True, exist_ok=True)
    # Ultralytics downloads its text encoder into the working directory.
    os.chdir(model_dir)
    import torch
    import ultralytics
    from PIL import Image, ImageOps
    from ultralytics import FastSAM, YOLOE

    torch.set_num_threads(args.threads)
    with Image.open(photo_path) as source:
        photo = ImageOps.exif_transpose(source).convert("RGB")
    results = {
        "platform": f"desktop CPU, {args.threads} threads; not phone timings",
        "machine": platform.machine(),
        "ultralytics": ultralytics.__version__,
        "torch": torch.__version__,
        "photo_sha256": sha256(photo_path),
        "photo_size": list(photo.size),
        "warm_repeats": args.repeats,
        "timing_scope": "predict API including preprocessing, masks and postprocessing; excludes model loading, downloads and prompt preparation",
        "runs": [],
    }
    configs = []
    for name in ["FastSAM-s.pt", "yoloe-26n-seg-pf.pt"]:
        for size in [640, 1024]:
            configs.append((name, size, .25, .7, None))
    for name in ["yoloe-26n-seg.pt", "yoloe-26s-seg.pt"]:
        for profile in PROFILES:
            configs.append((name, 640, .15, .5, profile))
    for name, size, confidence, iou, profile in configs:
        # Fresh instances isolate prompt profiles from earlier predictions.
        model = FastSAM(str(model_dir / name)) if name.startswith("FastSAM") else YOLOE(str(model_dir / name))
        entry = {
            "model": name, "model_sha256": sha256(model_dir / name),
            "model_bytes": (model_dir / name).stat().st_size,
            "size": size, "confidence": confidence, "iou": iou,
        }
        if profile:
            start = time.perf_counter()
            model.set_classes(PROFILES[profile])
            entry.update(profile=profile, prompts=PROFILES[profile], prompt_prepare_s=time.perf_counter() - start)
        elapsed = []
        for _ in range(args.repeats + 1):
            start = time.perf_counter()
            prediction = model.predict(photo, device="cpu", imgsz=size, conf=confidence, iou=iou, retina_masks=True, verbose=False)[0]
            elapsed.append(time.perf_counter() - start)
        entry.update(cold_s=elapsed[0], warm_median_s=statistics.median(elapsed[1:]))
        entry["boxes"] = [
            {"box": box.xyxy[0].tolist(), "label": prediction.names[int(box.cls[0])], "score": float(box.conf[0])}
            for box in prediction.boxes
        ]
        if overlays:
            prediction.save(filename=str(overlays / f"{name}-{profile or size}.jpg"))
        results["runs"].append(entry)
        # Preserve completed runs even if a later model/export fails.
        output.write_text(json.dumps(results, indent=2) + "\n")
        print(f"{name} {profile or size}: {len(entry['boxes'])} raw proposals, {entry['warm_median_s']:.3f}s warm", flush=True)


if __name__ == "__main__":
    main()
