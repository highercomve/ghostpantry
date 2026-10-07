# Automatic pantry package detection

Research and exploratory inference, 2026-10-07.

## Recommendation

Test **YOLOE-26n with a fixed package prompt set** as the next automatic proposal
experiment. For dependable detection, train a compact detector on **one class:
physical pantry package**, using actual home pantry photos. Keep localization
separate from food recognition: package boxes → existing Gemma crop matching →
correction memory → explicit inventory review. OCR is unnecessary for this path.

This recommendation is based on the tests below, not a claim that a pretrained
model already solves pantry scanning. Manual boxes remain useful for correcting
misses. Detector scores and raw box counts must never become inventory quantities.

## What was tested

Same supplied 594 × 739 JPEG, SHA-256
`0a87473a388019b011a9588ddbf40586044b5d3d1244604a817a4e5ab9bc7649`.
Desktop AMD Ryzen 7 7800X3D, four PyTorch CPU threads,
Ultralytics 8.4.174, Torch 2.14.1+cpu. Warm times are the median of three
predict calls after one first prediction, excluding model load/download and text
prompt preparation. They include preprocessing, segmentation and postprocessing.
**These are not Pixel timings or accuracy measurements.**

| Model / configuration | Raw boxes | Warm desktop time | Inspection |
| --- | ---: | ---: | --- |
| Current Lite2, full photo | 2 | Separate earlier test | Rice bag and noodle packet only |
| FastSAM-s, 640, confidence .25 | 93 | 72 ms | Many logos, printed pictures, panels and bag fragments |
| FastSAM-s, 1024, confidence .25 | 101 | 118 ms | More proposals; count is not accuracy |
| YOLOE-26n prompt-free, 640, confidence .25 | 11 | 117 ms | Some useful boxes, whole-scene box and wrong semantic labels |
| YOLOE-26n prompt-free, 1024, confidence .25 | 13 | 303 ms | More proposals; no verified recall improvement |
| YOLOE-26n container prompts, 640, confidence .15 | 2 | 20 ms | Generic wording misses most bags |
| YOLOE-26n food-package prompts, 640, confidence .15 | 8 | 18 ms | Best inspected candidate; duplicates and misses remain |
| YOLOE-26s container prompts, same settings | 2 | 37 ms | No improvement on this scene |
| YOLOE-26s food-package prompts, same settings | 3 | 39 ms | Larger checkpoint does not win this scene |

Container prompts: `food package`, `plastic bag`, `cardboard box`, `food pouch`.
Food-package prompts: `pasta bag`, `rice bag`, `instant noodle packet`, `food box`,
`food pouch`. NMS IoU .5 for prompted models, .7 for FastSAM/prompt-free models.
All tests requested retina masks; comparisons are exploratory and have different
thresholds, vocabularies and resolutions. The saved JSON includes checkpoint
hashes, settings, pixel boxes and scores.

The eight nano food-prompt boxes include the foreground rice bag, bottom noodle
packet, white/red packet, Capellini bag, clear noodle bag and central red pasta
bag. Two overlapping proposals cover the upper-left long-pasta package; one is
oversized. Upper-right packages and partially hidden bags are still missed.
**All eight were labeled “pasta bag,” including the rice bag.** Use these labels
only to request localization; do not use them as food identity. This is one
unannotated scene, not eight confirmed packages, a recall score, or evidence of
generalization. Prompts must be selected on a development set and frozen before
testing other pantries.

## Algorithm choices

**Compact detector trained for packages — preferred production direction.**
Learn whole-wrapper boxes across upright, sideways, transparent, crumpled and
occluded packages. A small convolutional detector is the first mobile candidate;
compare RF-DETR-Nano on identical annotations and phone hardware. RF-DETR's core
Nano–Large models are Apache-2.0 and support custom fine-tuning. Its direct LiteRT
export currently requires float32 and CPU XNNPACK because query selection contains
unsupported GPU-delegate operations. Mobile export support does not establish
acceptable phone latency. [RF-DETR repository](https://github.com/roboflow/rf-detr),
[LiteRT export limitations](https://rfdetr.roboflow.com/latest/exports/litert/).

**YOLOE — most promising pretrained candidate tested here.** It supports text,
visual examples and a built-in vocabulary. Fixed text embeddings can be baked
into exported weights: Android need not run the large text encoder. Start with
the nano model and five fixed prompts above, verify export output parity and
benchmark a boxes-only configuration before adding it to the app. Prompt wording
is a material source of instability. YOLOE's official implementation is AGPL-3.0;
resolve distribution terms before bundling it with this MIT project.
[YOLOE documentation](https://docs.ultralytics.com/models/yoloe/),
[official authors' repository](https://github.com/THU-MIG/yoloe).

**FastSAM / automatic segmentation — auxiliary tool.** FastSAM uses a CNN to
generate instance proposals followed by prompt selection. Our raw proposals
include package parts as well as packages. A mask boundary alone cannot determine
which region is a physical item; selection still needs learned evidence. Use
segmentation to refine a good box or assist annotations, rather than feeding
every mask into Gemma. [FastSAM documentation](https://docs.ultralytics.com/models/fast-sam/).

**SAM 3 — potential annotation teacher.** Concept prompts can find multiple
instances. The official setup requires a CUDA GPU and authenticated access to
checkpoints; Android deployment has not been established here. Evaluate it on a
desktop/server for draft annotations, then have a human correct the boxes before
training the compact model. No SAM 3 inference was run in this investigation.
[SAM 3 official repository](https://github.com/facebookresearch/sam3).

**Overlapping tiles / SAHI — secondary improvement.** Tiling rescales small objects
and merges detections across sections. It cannot teach a generic detector what a
pantry wrapper looks like. Our earlier Lite2 full-photo-plus-tiles test yielded 17
raw proposals including printed food and multi-package boxes. Revisit slicing
only after package precision is acceptable, measuring added latency and duplicate
boxes. [SAHI algorithm](https://obss.github.io/sahi/guides/sliced-inference/).

## Data and evaluation needed

1. Collect a pilot of roughly 200–500 varied home pantry photos. This is a planning
   estimate, not a proven sufficient training size. Include drawers, shelves,
   different households/brands, low light, transparent bags, severe occlusion,
   rotated packages, empty shelves and printed food pictures as hard negatives.
2. Annotate every identifiable physical package consistently. Use a tight box
   enclosing its visible extent; mark uncertain fragments as ignore regions and
   exclude images with incomplete annotations until corrected. Don't label each
   logo or printed food picture as a package. Review duplicate/adjacent items.
3. Split by pantry/scene and capture session, with held-out households/brands.
   Nearby frames of the same drawer must stay in one split. Existing app crop
   corrections save embedding examples, **not original photos plus box training
   annotations**. Add an explicit opt-in dataset export before using corrections
   for detector training.
4. Compare frozen-prompt YOLOE, a package-trained compact CNN and RF-DETR-Nano.
   Report package precision/recall at IoU .5, AP50–95, misses under occlusion,
   duplicate boxes and false proposals per photo. Use one-to-one ground-truth
   matching; high proposal counts alone are not success.
5. Export the best accuracy candidates and verify preprocessing/box parity on the
   same inputs. Then measure Pixel cold/warm p50/p95, sampled app memory, model
   size and total scan time including Gemma for every crop. Test float32 first,
   then remeasure accuracy after FP16/INT8. Desktop speed does not predict phone
   speed, and detecting more packages increases classification work.
6. Keep automatic boxes editable and inventory addition explicit. Add/delete/
   resize corrections should become useful annotations when the user opts in.
   Do not impose a two-item cap or select only regions with remembered labels.

## Reproduce the proposal experiment

Use a separate Python environment. Install `ultralytics==8.4.174`, Torch/Pillow
and `ultralytics/CLIP` at revision
`7ffa84b3bfa40c42ecc1c77147a855e69cb2dd40`. Ultralytics downloads model checkpoints
and a text encoder on first use; these are research dependencies, not app assets.

```bash
rtk proxy /path/to/venv/bin/python experiments/benchmark_open_proposals.py \
  /path/to/pantry.jpg --models-dir /tmp/pantry-models \
  --output /tmp/pantry-proposals.json --overlays-dir /tmp/pantry-overlays
```

The original results are in `open-proposals-pantry-desktop.json`. The reproduction
script loads a fresh model for each configuration to isolate prompting state;
the exploratory run reused each model between profiles. A fresh-instance rerun
reproduced all eight proposal counts, including nano's eight food-prompt boxes.
Its warm times varied (nano food prompts: 29 ms versus 18 ms initially); the JSON
records this verification separately. Count agreement does not establish accuracy.
User photos, overlays and checkpoint binaries are intentionally outside Git.
