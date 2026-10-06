# Multi-item region comparison

Tested 2026-10-06 with the user's unannotated pantry photo and the egg photo
extracted from a screenshot. Photos are not committed. Desktop CPU, four threads,
Python 3.12, LiteRT-LM 0.18.0, MediaPipe 0.10.32. Model and label vocabulary match
the app; desktop SDK default precision differs from Android's explicit FP32.
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
The top five are retained per region. Stronger matches must beat the background
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
