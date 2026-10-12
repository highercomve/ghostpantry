# Licences of the Apple models

- **YOLOE detectors** (`yoloe-coreml.tar.gz`, a release asset; manifest:
  `yoloe_coreml.json`): exported from Ultralytics' `yoloe-26n-seg.pt` by
  `scripts/export_yoloe_coreml.py`, AGPL-3.0, the same terms as the Android
  ONNX detectors: see `android/native/detectors/YOLOE-LICENSE` (also inside the
  archive).
- **MobileCLIP-S2** (`apple/coreml-mobileclip` on Hugging Face, revision
  `3e0a7bfb9fe83da8a3efaa3fd8f7df24214bb947`): Apple's model under the Apple
  Sample Code License (`apple-ascl`), see
  https://huggingface.co/apple/coreml-mobileclip. GhostPantry doesn't ship
  it: the app downloads it once from that revision and checks every file's
  SHA-256 (`ios/native/MobileClip.swift`).
- **CLIP BPE merges** (`resources/clip/clip_merges.txt`): OpenAI CLIP, MIT,
  see `resources/clip/LICENSE`.
