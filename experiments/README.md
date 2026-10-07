# Multi-item region comparison

Tested 2026-10-06 with the user's unannotated pantry photo and the egg photo
extracted from a screenshot. Photos are not committed. Desktop CPU, four threads,
Python 3.12, LiteRT-LM 0.18.0, MediaPipe 0.10.32. The model matches the app; the historical 307-label vocabulary is saved in
`food-labels-307.json` (the app preset has since expanded to 710); desktop SDK default precision differs from Android's explicit FP32.
These times are **not Pixel performance estimates**. Cold preparation of all
307 food labels plus three backgrounds took 8.04 s / 7.80 s for pantry / eggs;
all method timings below reuse those vectors. Runs were sequential in the order
shown and are single samples, not a statistical benchmark.

| Photo | Method | Regions | Warm desktop total |
|---|---|---:|---:|
| Pantry | Whole | 1 | 0.32 s |
| Pantry | Grid | 10 | 2.48 s |
| Pantry | Lite0 | 1 | 0.95 s |
| Pantry | Lite2 | 0 | 1.13 s |
| Eggs | Whole | 1 | 0.29 s |
| Eggs | Grid | 10 | 2.50 s |
| Eggs | Lite0 | 3 | 0.81 s |
| Eggs | Lite2 | 3 | 0.81 s |

The detectors did not segment the pantry packages: Lite0 labeled the whole scene
“bed”; Lite2 returned no boxes. Egg-scene boxes were labeled “book”, “teddy bear”,
and “bed”, illustrating the COCO-domain mismatch. Classifying these boxes yielded
eggs but also false infant-formula/instant-coffee or baking-soda suggestions.

Whole-photo matching returned eggs alone under the stronger-match rule. Grid
matching added the related alternative “egg whites”. Pantry grid crops recovered
rice/risotto suggestions absent from the whole-photo top five, but also false
cereal, tortilla and rice-flour suggestions. Unioning top crop matches is therefore
insufficient for dependable inventory. Repeated regions must not be counted as
packages. Raw scores, boxes and per-crop results are in
[pantry-desktop.json](pantry-desktop.json) and [eggs-desktop.json](eggs-desktop.json).

## Reproduce

Create a Python 3.12 environment and install `litert-lm==0.18.0`,
`mediapipe==0.10.32`, `pillow`, and `numpy`. Download the pinned EmbeddingGemma
model documented in the main README. Detector files and their SHA-256 values are
in `android/app/src/main/assets/detectors/manifest.json`.

```sh
python experiments/benchmark_regions.py --model /path/to/model.litertlm \
  --photo /path/to/pantry.jpg --output /tmp/pantry-results.json
python experiments/benchmark_regions.py --model /path/to/model.litertlm \
  --photo /path/to/egg-screenshot.png --crop 0.08,0.177,0.92,0.680 \
  --output /tmp/egg-results.json
```

Only crop a screenshot when necessary; do not feed annotations or app text to
classification. The script resizes the extracted photo to at most 1600 pixels per
side, embeds “A photo of <label>”, and classifies JPEG crops against all labels.
The historical 307-label JSON is the default; pass `--labels` with a different JSON array to compare another catalog. The top five are retained per region. Stronger matches must beat the background
and be within 0.04 of that region's best label. This is a heuristic, not a
calibrated probability or detection threshold.

## Phone checks still needed

Use **Scan a shelf → Compare multi-item scanning** with the same source photo and
saved labels on Pixel 8 and Pixel 10. Run whole/grid/Lite0/Lite2 twice each. Inspect
crop accuracy, missed categories, false suggestions, elapsed time, cached label
time and sampled app PSS. Verify cancellation during native inference and model
loading after releasing memory. No physical phone was attached for this test.

The next accuracy experiment should prioritize package-oriented region proposals
and visual reference examples or OCR for ambiguous labels. A generic COCO detector
is not supported as the default inventory path by these results.


## Phone result reported by the user

The phone comparison with 307 labels gave Lite2 **5.81 s / 2 regions / 848 MiB**
sampled app PSS, Lite0 **3.09 s / 1 region / 762 MiB**, and grid **16.82 s / 10
regions / 779 MiB**. Lite2 isolated the rice bag and a pasta packet despite calling
them “bottle” and “sandwich”. The user preferred Lite2's crops; the grid produced
many unrelated suggestions. These are reported app measurements, not reproduced
desktop timings. Lite2 is now the default experiment method; other methods remain
available for comparison. Two useful crops still do not demonstrate full package
recall or reliable inventory counts.

## MobileCLIP-S0 image encoder comparison

Official [Apple code](https://github.com/apple/ml-mobileclip) at revision
`48faa0fea4b08d74188b3841771aca6ff2c92852`; [S0 checkpoint](https://huggingface.co/apple/MobileCLIP-S0)
at revision `71aa3e13dda93115871afbd017336535ba29886c`. Python 3.12, Torch
2.14.1+cpu, torchvision 0.29.1+cpu, timm 1.0.30, open-clip-torch 3.3.0, four CPU
threads. The reparameterized image encoder has 11,356,992 parameters. Apple model
terms differ from its code license; this benchmark does not bundle any weights.

Both models received the same JPEG whole-photo/grid crops and 307 “A photo of”
labels plus three backgrounds, with their respective official image preprocessing.
MobileCLIP used 512-dimensional normalized vectors, Gemma 256. One MobileCLIP
warm-up is excluded; each MobileCLIP image time is the median of three runs, while
Gemma uses one run per crop. Label preparation is measured separately. Gemma
SDK-default desktop precision differs from Android's explicit FP32. These are
small exploratory samples, **not phone latency, memory or accuracy benchmarks**.

| Photo | MobileCLIP median image inference | Gemma median image inference |
|---|---:|---:|
| Pantry, 10 crops | 19.0 ms | 269.9 ms |
| Eggs, 10 crops | 18.3 ms | 233.0 ms |

Speed alone did not give better recognition. MobileCLIP's whole pantry top label
was “ready-made meals”, with several crops returning that, potato chips, cereal or
muesli. Gemma's whole-photo top label was pasta and it recovered rice in a crop,
although it also gave false suggestions. Both found eggs in the whole egg photo;
MobileCLIP called the bottom three crops “frozen chicken”, while Gemma retained eggs.
Raw rankings and timings: [pantry](mobileclip-pantry-desktop.json),
[eggs](mobileclip-eggs-desktop.json). Keep Gemma in the APK pending a larger
labeled evaluation and a real mobile encoder export/benchmark.

```sh
python experiments/benchmark_mobileclip.py --mobileclip-code /path/to/ml-mobileclip \
  --mobileclip-model /path/to/mobileclip_s0.pt --gemma-model /path/to/model.litertlm \
  --photo /path/to/pantry.jpg --output /tmp/mobileclip-pantry.json
```

## Package-oriented proposal checkpoint

Evaluated the author's ONNX [SKU110K-trained YOLO11n checkpoint](https://huggingface.co/chistopat/sku110k-yolo11-object-detector),
revision `ee1b8ac34eb3b68969ffa8165e50c43457fe4e35`, file
`weights/sku110k-yolo11-n640.onnx`. The script verifies its published SHA-256
`5810269bf9687ca93b0d4e1bc91cb83ac4311cd48d91c4f6091777721ba083c5` before loading.
ONNX Runtime 1.30.0 CPU, four threads, 640×640 letterbox input, score ≥0.25,
NMS IoU 0.45. One cold plus three warm calls; ~17 ms median warm desktop inference.
This measures proposals only, not OCR, recognition, model loading or mobile speed.

It proposed **2 pantry regions** (part of the capellini packet and a logo fragment)
and **5 egg-scene regions**. It missed most pantry packages and split the egg scene;
these proposals are not package quantities. Raw boxes and times:
[pantry](packages-pantry-desktop.json), [eggs](packages-eggs-desktop.json).
The [SKU110K dataset](https://github.com/eg4000/SKU110K_CVPR19) restricts commercial
use and upstream YOLO/model terms require review. This is research-only, not an APK
asset or a replacement for the phone's useful Lite2 baseline.

```sh
python experiments/benchmark_packages.py --model /path/to/sku110k-yolo11-n640.onnx \
  --photo /path/to/pantry.jpg --output /tmp/packages.json --overlay /tmp/packages.png
```

## OCR experiment validation

Automated food-evidence tests cover variants, brand-only text, ingredient headings,
fuzzy OCR, unknown, disagreement and multiple products. Browser tests mock native
OCR to check source-resolution crop arguments, review, correction identities and
failure handling. Android builds verify bundled ML Kit integration. They do not
measure actual ML Kit accuracy on these phone photos. Compare Lite2 with OCR off/on
and rotation off/on on the same Pixel photos, record total and OCR times, inspect
raw recognized text, then confirm/reject crops and repeat with memory off/on.


## Candidate package reference

The user also supplied Gemini's description of roughly twelve visible packages:
long pasta/Capellini, another long pasta bag, Lucchetti packaging, Maruchan ramen,
a folded white/red packet, a red small-pasta bag, green/white Mira packaging, the
large foreground pouch, a prepared-dish pouch, a clear spiral-pasta bag, a tucked
green bag and a partially visible checkered item. This is a tentative localization
reference, **not verified food-category ground truth**: brand-only, wrapper-only
and partially hidden items need user confirmation. The user's earlier annotations
identify rice noodles, baby pasta, risotto rice and ramen variants. Future recall
evaluation should use confirmed boxes/categories and retain occluded/unknown items
rather than treating Gemini's prose as training labels.


## Follow-up phone OCR result

The user reported Lite2 visual-only **2.43 s / 2 regions / 910 MiB** sampled PSS,
OCR **4.78 s / 2 regions / 910 MiB**, and an earlier OCR+memory run **7.49 s /
860 MiB**, still with 307 saved labels. These are sequential exploratory runs with
different warm states/options, not isolated OCR overhead measurements. Both crops
were shown as Unknown despite nearby rice/pasta variants; the old strict top-two
margin treated related varieties as competing categories. Family-aware review now
uses a bounded nearby-majority rule, retains background rejection and explicit
negative corrections, and never confirms presence or the exact variety. The
visible OCR crop was only 122×289 pixels; no usable OCR keywords are visible in
these screenshots. Raw OCR text is needed to distinguish unreadable text from
missing aliases. A bigger source image or closer package photo may help text
recognition; upscaling would not recover missing source detail.

## Visual matching with corrections, without OCR

Phone feedback preferred Lite2 visual matching with a larger food list and user
corrections. OCR has been removed from the app; crop memory remains on and can be toggled
independently. All experiment crops use the crop-scoped matching command, so
confirming or rejecting a crop works even when OCR and remembered examples are
off. Remembered examples are only applied when their checkbox is on. The OCR results above are historical research records. Browser verification mocks native calls to check this
routing, confirmation session identity, and absence of OCR calls when disabled.

Inventory review is now reachable from each crop with **Review for inventory**.
A browser integration check verified that two selections of the same label keep
one selected review row at quantity 1, no inventory write or feedback happens
until the corresponding explicit action, and saving sends the chosen Pantry
location and reviewed item to the existing `apply_scan_results` command. Native
calls were mocked for this UI check; it is not a phone recognition benchmark.

## Overlapping Lite2 detection and marked packages

On 2026-10-06, the user's newly supplied 594 × 739 pantry JPEG was tested
with the bundled Lite2 model (MediaPipe desktop CPU, threshold 0.25, max 12
results per pass). Full-photo detection reproduced the phone's two boxes:
“bottle” (0.410) and “sandwich” (0.309). Full photo plus nine overlapping
half-size sections returned 17 raw proposals before deduplication. Inspection
showed oversized multi-package boxes, repeated rice fragments, and food pictures
or logos labeled bowl/cup. More proposals did not produce reliable package
segmentation, so this tiled approach was not added as an inventory detector.

The app now offers **Mark packages**: the user draws up to 12 normalized boxes,
which go directly to the existing visual crop matcher, correction memory, and
inventory review. This is a manual fallback, not an improved automatic detector.
Browser checks with mocked native matching scanned four marked boxes, showed
four review controls, and verified inventory handoff, undo, cancellation, and
clear. Actual recognition quality still requires phone testing.

## Automatic package detector research

See [the 2026-10-07 investigation](package-detection-research.md) for primary
sources, new FastSAM/YOLOE proposal tests on the supplied pantry photo, and the
recommended training and Android evaluation path. YOLOE-26n with food-package
prompts returned eight raw boxes, including duplicates and partial boxes;
FastSAM returned many package fragments. These are exploratory localization
results, not confirmed inventory items or measured package recall.

## RF-DETR Nano phone experiment

The app now includes **RF-DETR Nano · CPU** alongside Lite0/Lite2 and manual
marking. It uses the official pretrained sparse-ID COCO checkpoint, exported
with RF-DETR 1.11.2 to float32 ONNX opset 17 at 384 × 384, and ONNX Runtime
Android 1.30.0 with four CPU threads. No GPU/NNAPI provider is registered.
The source/export checksums and class map are recorded in the detector assets;
Apache-2.0 licensing is bundled. The 99.8 MB gzip asset is extracted to a
hash-named cache file with integrity verification on first use. Each detector
session closes before crop classification, avoiding keeping both models loaded.

The UI offers thresholds 0.10, 0.25 (default) and 0.50. All above-threshold
queries are sorted and capped at 12; one COCO category per query is retained,
with no additional NMS, food-category filtering, or correction-memory filtering.
Normalized center/size boxes are clipped to the original photo before the usual
crop padding and review. Detector category names do not determine food identity.

On the supplied 594 × 739 pantry JPEG, desktop ONNX CPU returned **zero boxes
at 0.25**, with a highest score of about 0.234 for dining table. At 0.10 it has
weak and overlapping background/fragment proposals; lowering the threshold is
an inspection aid, not improved package accuracy. The official PyTorch predictor
produced matching top classes/scores (about 1e-6 differences). Warm desktop
inference was about 65 ms, excluding preprocessing and load. This is **not a
Pixel benchmark**. Data: [rfdetr-pantry-desktop.json](rfdetr-pantry-desktop.json).
The pretrained model still needs package-domain training for reliable scanning.

Checks cover RGB/ImageNet NCHW normalization, sparse class IDs including the
last foreground slot, sigmoid confidence, clipping, invalid outputs and the
12-query cap. Browser verification with mocked native calls checked RF-DETR
selection, threshold 0.10, four returned regions going through crop matching,
and inventory review. No physical Android device was available for this check.
Reproduce the export with [export_rfdetr_nano.py](export_rfdetr_nano.py).
