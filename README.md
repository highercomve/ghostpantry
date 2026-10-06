<p align="center">
  <img src="frontend/public/brand/ghostpantry-logo.svg" alt="GhostPantry — A little less waste" width="420">
</p>

# GhostPantry

AI-powered home food inventory manager built with **[Oriel](https://github.com/highercomve/Oriel)** (Zig + SQLite + Webview) and **React + TypeScript**.

GhostPantry lets you snap pictures of your refrigerator and food pantry to automatically detect items, estimate usage/fill levels (e.g. *Harina Pan at half usage*, *Milk carton at 20%*), maintain your stock in local SQLite, and compare against your desired target amounts to automatically generate restock shopping lists.

---

## ✨ Features

- 📸 **Camera & AI Vision Recognition**:
  - Live camera stream and snapshot capture (HTML5 webcam & native Android camera).
  - Drag-and-drop or file upload for existing photos.
  - Multi-shelf scanning: Detects multiple items in a single photo.
- 🎚️ **Usage & Fill Level Tracking**:
  - Measures percentage remaining ($0\%$ to $100\%$).
  - Visual status color indicators:
    - 🔴 **0–25%**: Critically Low / Out of stock
    - 🟠 **26–55%**: Half usage / Running down
    - 🔵 **56–80%**: Moderate
    - 🟢 **81–100%**: Well stocked
- 🎯 **Desired vs. Current Restock Analysis**:
  - Set target stock per item (e.g. want 2 bags of Harina Pan, 12 eggs, 2 milk cartons).
  - Effective stock accounts for usage ($1 \text{ box} \times 50\% = 0.5 \text{ effective units}$).
  - One-click **Smart Shopping List** export to clipboard (formatted with markdown checkboxes for WhatsApp, SMS, or Notes).
  - One-click **"Mark as Bought"** restock action.
- 🗄️ **Local SQLite Database**:
  - Fast, self-contained persistence using embedded SQLite via `oriel.sql`.
  - Zero external database services needed; all data resides locally on your device.
- 🤖 **Universal AI Vision Support**:
  - **OpenAI Vision**: `gpt-4o`, `gpt-4o-mini` with API key.
  - **New ChatGPT Plan Token Allowance**: Use your personal ChatGPT Plus/Pro subscription token allowance without per-token API credits ([learn more](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)).
  - **Local Vision Models (Offline / LAN)**: Seamless compatibility with local Ollama (`llama3.2-vision`, `qwen2.5-vl`, `minicpm-v`) or LM Studio servers.
  - Built-in **"Test AI Connection"** button in Settings.
- 📱 **Cross-Platform**:
  - Desktop: Linux (GTK4/WebKitGTK), macOS, Windows.
  - Mobile: Android APK / AAB with native camera permissions (`android/` project included).

---

## 🚀 Quick Start

### 1. Requirements

- **Zig 0.16.0**
- **Node.js 24** & **npm**
- **Oriel CLI**: `oriel` (optional for the convenience commands below; CI uses `zig build` directly)
- *(Optional for local vision)*: [Ollama](https://ollama.ai) with `llama3.2-vision` or `qwen2.5-vl`

### 2. Development Mode

Start the Vite development server with hot-reloading:

```bash
cd ghostpantry
oriel dev
```

Any changes in `frontend/src` hot-reload instantly. If you modify Zig backend code in `src/`, Oriel automatically recompiles and restarts the native window.

### 3. Production Build

Build the standalone desktop binary with the React frontend embedded:

```bash
oriel build
# Executable is produced at:
./zig-out/bin/ghostpantry
```

### 4. Android Build

The Android Gradle scaffolding and camera permissions are already configured in `android/`:

```bash
# Debug run on connected Android phone/emulator:
oriel android dev

# Release APK build:
oriel android build --apk
```

---

## ⚙️ AI Vision Configuration

Open the **Settings** tab in GhostPantry to select your AI Vision provider:

### Option A: Android system AI (Gemini Nano)
Select **System AI** in Settings. GhostPantry asks Android’s ML Kit Prompt API whether the shared system model is **ready**, **downloadable**, **downloading**, or **unavailable**. The result comes from the phone, without a hardcoded device list. Use **Download system model** when offered, or **Choose a local model** if unavailable. Scans use image and text input, run on-device, and still require reviewing the detected items before saving. This integration uses Google’s beta API and needs validation on a supported physical phone.

A failed support check is shown separately from an unavailable model and can be retried. The app never silently sends a system-AI photo to a cloud provider. See [Google’s setup and capability API](https://developers.google.com/ml-kit/genai/prompt/android/get-started).

### Fast local scan (EmbeddingGemma 2)

Choose **Fast local** in Settings, download or reuse the EmbeddingGemma 2 model,
and save your settings. CPU is the starting backend; GPU is a separate device
support test. The provider selector uses two columns on phones so all four scan
options remain visible.

**Food labels for fast scans** persists an editable vocabulary of 2–1,024 food
names. The initial catalog contains 307 common food labels; **Use pasta and rice
labels** replaces it with pasta, rice noodles (rice-based pasta), baby pasta, ramen noodles, and
risotto rice. Save the labels before scanning. A scan ranks up to ten food
labels against the selected photo and opens the usual pantry review screen.
Suggestions start unchecked. Confirm only visible foods, rename them, set
package counts and fill levels, or use **Add a missing food**. Saving writes
only the foods you selected. Quantity defaults to one package and fill to
100% as editable starting values, not model measurements.

Text embeddings are cached in memory and in a small, checksummed file for each
backend. Restarting or releasing the model can reuse the disk cache. Cache keys
include the exact model, SDK/configuration, backend, caption format, dimensions,
and label order. Changing labels invalidates the previous vocabulary cache;
corrupt or incomplete files are recomputed. Deleting the model deletes these
caches. The scan reports photo time and whether labels came from disk, memory,
or fresh computation. Neither photos nor scan results leave the phone.

A user-reported Pixel 8 CPU run of the initial experiment took **3.24 seconds
total**, including **1.10 seconds for the photo**, **1.57 seconds for food
labels**, and **0.23 seconds for loading**, with **890 MiB app PSS**. These are
one run, not a general benchmark. The new persistent cache has unit tests;
its latency on the phone remains to be measured.

Whole-photo matching does not locate individual packages or establish counts.
Tests with the original unmarked pantry photo favored pasta; manually cropped
rice regions favored rice, but small-pasta and ramen regions still confused
some labels. The annotated image is a reference for evaluating the unmarked
photo, not an inference input. Package localization, OCR, and calibrated
presence checks would need further evaluation before automatic counting.

### Experiment: EmbeddingGemma 2 image matching

Try the same experiment on **Pixel 8 and Pixel 10**:

1. In **Settings → EmbeddingGemma 2**, download the 388 MB text-and-image model. Keep the app open; **Pause download** retains progress for resuming. The app checks the exact size and SHA-256 before installing it.
2. Start with **CPU** and **Test CPU support**. This initializes the model and verifies both text and image embeddings on the actual device. Select **GPU** and test separately; an unsupported backend reports its error and lets you choose CPU.
3. In **Scan a shelf**, select a clear photo of one item or package, then open **Try image matching**. Edit the candidate food labels and tap **Match photo on CPU** (or GPU).
4. Repeat with the same photo and labels for a warm run. Compare total time, model loading, label embedding, photo embedding, and app PSS memory across both phones. **Release model memory** clears the engine and label cache for another cold run. PSS includes the app and does not capture all GPU allocations.

The benchmark panel is a whole-photo similarity experiment. Its top labels and cosine scores are **not probabilities, quantities, object detections, or complete inventory scans**. It compares only the supplied 2–1,024 labels and does not save matches to the pantry. A crowded shelf needs a different detection/extraction step. Ordinary scans release this experiment's model memory before loading another provider.

Inference runs offline after the model download. This app-owned LiteRT model is independent of Android's shared AICore model, so it does not require System AI support. The app checks Android/ABI eligibility first and verifies backend execution when tested; Pixel models are not hardcoded. CPU and GPU are explicit choices, with no automatic cloud fallback or NPU acceleration claim. A Pixel 8 CPU result is reported above; Pixel 10 timings and broader accuracy evaluation remain pending. A desktop CPU smoke test with this exact model and 70-token/256-dimension configuration produced finite unit vectors for text and a photo, ranking pasta first for a pasta-heavy pantry image. This validates the basic matching path, not phone performance or shelf-detection accuracy.

The experiment uses [LiteRT-LM's embedding API](https://developers.google.com/edge/litert-lm/embedding_models), Android SDK `com.google.ai.edge.litertlm:litertlm-android:0.18.0`, 70 image tokens, and 256-dimensional normalized embeddings. Food-label embeddings are cached in memory and on disk. The [Apache-2.0 text/vision model](https://huggingface.co/litert-community/embeddinggemma-2-text-vision-440m-litert-lm) is pinned to revision `e301f74d5551b0c2641bd5cb4652a76239d5c5f8`, file `embeddinggemma-2-text-vision-440m.litertlm` (387,710,976 bytes), SHA-256 `92dcbea108899e5d6e30d919b0744f90d9967e80c67a4ab5503ac16d54f62eb0`. See Google's [EmbeddingGemma 2 model card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2) for intended uses and limitations.

### Option B: On this device (downloaded models, offline)
Download a vision model once from the model catalog (Qwen3.5 0.8B/2B, Qwen2.5-VL 3B, Gemma 3/4 — smallest first; phones are offered the small ones), and scans then run entirely on the device with llama.cpp: no server, no API key, works offline. The model stays loaded between scans and is freed again when Android reports memory pressure.

The smallest fallback, **Qwen3.5 0.8B Q4_K_M**, uses about **703 MiB** of downloads including its vision projector; runtime memory is higher. Its source revision and SHA-256 hashes are pinned. Treat it as a candidate for simple shelves; phone speed and pantry accuracy have not yet been measured.

**Fast** scan detail limits dynamic-resolution image processing to 512 tokens where the model supports it and limits output to 1024 tokens. **Detailed** keeps the model’s default image detail and a 2048-token output budget. Fast can miss small labels or crowded items. Scan review shows total, model load, photo processing, and answer generation times; compare both modes on the same shelf photo after the model is warm. CPU and vision encoding use up to four threads on phones. Switching processor or scan detail rebuilds the loaded model context so the setting takes effect.

Projectors have unique local filenames per model. Existing models that shared `mmproj-F16.gguf` may need their vision component downloaded again; the language-model weights are retained.

### Option C: OpenAI (Pay-per-token API)
- **Base URL**: `https://api.openai.com/v1`
- **Model**: `gpt-4o-mini` or `gpt-4o`
- **API Key**: `sk-...`

### Option D: ChatGPT Plan Token Allowance (New OpenAI Feature)
If you subscribe to ChatGPT Plus or Pro, you can use your plan's token allowance in third-party apps:
- See OpenAI's guide: [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)
- **Base URL**: `https://api.openai.com/v1`
- **Model**: `gpt-4o-mini`
- **API Key / Personal Token**: Paste your generated ChatGPT app token.

### Option E: Local server vision Model (Free & Offline)
Run an open multimodal vision model locally via Ollama:
```bash
ollama run llama3.2-vision
# or
ollama run qwen2.5-vl
```
In GhostPantry Settings:
- Choose preset: **Local Ollama Vision**
- **Base URL**: `http://localhost:11434/v1` (or your LAN IP `http://192.168.1.xxx:11434/v1`)
- **Model**: `llama3.2-vision`
- **API Key**: *(leave blank)*

Click **"Test AI Connection"** to verify the model responds.

---

## 🏗️ Architecture

```
ghostpantry/
├── src/
│   ├── main.zig        # Oriel entrypoint, command handlers (IPC), event emission
│   ├── db.zig          # SQLite storage (inventory_items, scan_logs, settings)
│   └── ai.zig          # Multimodal OpenAI / Ollama vision client & JSON parser
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── InventoryView.tsx    # Shelf items, fill gauges, quick stock adjustments
│   │   │   ├── ScanView.tsx         # Camera / upload, AI analysis & review modal
│   │   │   ├── CameraCapture.tsx    # HTML5 webcam stream, canvas capture & file picker
│   │   │   ├── ShoppingListView.tsx # Missing stock analysis & clipboard generator
│   │   │   └── SettingsView.tsx     # Provider presets, token setup, connection tester
│   │   ├── oriel.ts                 # Auto-generated typed IPC interfaces
│   │   ├── App.tsx                  # Main layout and tab router
│   │   └── style.css                # Polished responsive styling
│   └── package.json
├── android/            # Native Android Gradle project with CAMERA permissions
├── build.zig           # Oriel build config (.sql = true, .store = true, .tray, camera)
└── build.zig.zon       # Zig package manifest
```

---

## Brand assets

The logo is used in the app header, browser favicon, home-screen icon, and native app icons. Editable vector sources live in [`frontend/public/brand/`](frontend/public/brand/):

- [Horizontal logo](frontend/public/brand/ghostpantry-logo.svg)
- [Transparent mark](frontend/public/brand/ghostpantry-mark.svg)
- [App icon](frontend/public/brand/ghostpantry-app-icon.svg)

`icon.png` supplies the native app icon through Oriel’s build configuration. Android launcher assets are also included in `android/app/src/main/res/`.

## CI and releases

[Build and release](https://github.com/highercomve/ghostpantry/actions/workflows/release.yml) follows HollerShare’s platform layout: frontend and framework regression checks, then Linux x86_64, macOS arm64, Windows x86_64, and Android arm64/x86_64 builds. Pushes to `main` and pull requests upload packages and SHA-256 checksums as workflow artifacts. A `v*` tag builds all platforms and creates a draft GitHub release. Manual runs can select one platform.

A fresh clone includes the Oriel snapshot and generated TypeScript bindings; no sibling repository or private dependency is required. Regenerate bindings with `zig build types` when changing command signatures. Build locally without the Oriel CLI:

```bash
npm ci --prefix frontend
zig build -Doptimize=ReleaseSafe
# Linux packages need nfpm, squashfs-tools and the desktop development libraries:
zig build package -Doptimize=ReleaseSafe
# Android needs JDK 21 and the Android SDK:
zig build -Dtarget=aarch64-linux-android -Doptimize=ReleaseSafe
cd android
./gradlew :app:assembleDebug
```

Android artifacts include an installable debug APK, release APK, and AAB. Release packages are unsigned unless a manual run enables `sign_android` and this repository has `ORIEL_ANDROID_KEYSTORE_BASE64`, `ORIEL_ANDROID_KEYSTORE_PASSWORD`, `ORIEL_ANDROID_KEY_ALIAS`, and `ORIEL_ANDROID_KEY_PASSWORD` secrets. Secrets in HollerShare do not transfer to a new repository. macOS builds use ad-hoc signing; Windows packages are unsigned. Production desktop signing and Android upload credentials must be configured before distributing a production release. GhostPantry currently has no automatic updater.

## 📄 License

MIT

## Android photo extension development

This checkout includes a reproducible Oriel source snapshot in `vendor/oriel`
while the generic Android extension API is being developed. GhostPantry registers
`dev.ghostpantry.PantryAndroidExtension` through `.android.extensions` in
`build.zig`; its sources live in `android/native/`. Oriel copies those sources
and regenerates the registration on each Android build. Photo capture and
content-URI access are app behavior, with no edits or patches to Oriel's
generated runtime. The app's private photo provider is declared outside the
manifest's generated regions.

See [the framework extension contract](vendor/oriel/docs/android-extensions.md)
and [snapshot notes](vendor/README.md).
After that framework change is published, replace the local dependency path
with the released Oriel URL and hash using `zig fetch --save=oriel`.

### Learning from corrections

Fast local scan review offers **Remember this label** and **Wrong suggestion**.
Rename a suggestion before remembering it, or add a missing food and remember that
name. These explicit choices save the photo's embedding and label locally; the
photo itself is not saved in correction memory. Pantry selection and quantity
edits do not teach the matcher. An unchecked suggestion is not a rejection.

For future photos with image-embedding cosine similarity above 0.94, the closest
example for each label adds or subtracts up to 0.12 from its ranking. The displayed
similarity remains the original image/text cosine, with an indication when your
corrections adjusted the order. Up to 16 remembered positive labels outside your
current vocabulary can be considered for a similar photo. This is conservative
personalization of similar scenes, not retraining, reliable object detection, or
a guarantee of accuracy; the threshold and adjustment still need field testing.
For package-specific learning, use a close photo of one package.

Correction memory holds the latest 128 examples per processor and survives app
restarts. CPU and GPU memories are separate and tied to the model/runtime settings.
**Clear learned corrections** resets both memories without deleting pantry items
or the model. A newer correction replaces the same label for effectively the same
photo. Damaged memory is reported and ignored during scans; clear it to recover.

The full food preset contains 307 labels, including eggs, pasta variants, produce,
dairy, meat, seafood, frozen foods, snacks, drinks, condiments, and baking supplies.
Existing saved vocabularies are preserved: choose **Use full food list (307)** and
save Settings to replace a narrow preset. Custom lists support up to 1,024 labels.
Three background candidates (other food, non-food objects, empty shelf) can trigger
a review hint when they outrank all food suggestions. This comparison is also
heuristic; it does not guarantee rejection of a wrong category. Review displays
how many labels were compared, and never selects suggestions automatically.

Fast local review and the image-matching experiment separate stronger suggestions
from a collapsed **Weaker alternatives** list. A label must beat the background
candidates and be within 0.04 of the best adjusted rank to appear in the stronger
group. If none qualify, the UI says there is no clear food match. Alternatives
remain available for manual confirmation; selecting one keeps it visible when
collapsed. This score-gap rule reduces clutter (the egg-only example shows eggs
instead of five equally presented foods), but is a presentation heuristic, not a
calibrated food-presence detector. Crowded photos may have real foods in the weaker
list. All items still require explicit selection before saving.


### Experiment: multi-item regions

After choosing a photo, tap **Compare multi-item scanning**. Run **Whole photo**,
**Overlapping grid**, **Lite0 detector**, and **Lite2 detector** on the same photo
with the same saved food list and embedding backend. Repeat each method after its
first run to compare warm timings. Set the full 307-label list in Settings if an
older installation still has the small list.

The grid checks the whole photo plus nine overlapping half-size crops. The
CPU-only EfficientDet detectors propose up to 12 boxes at a 0.25 detector-score
threshold; each box gets 5% padding and EmbeddingGemma classification. Their
original COCO labels remain visible for diagnosis. Zero boxes remains a zero-box
result; it does not silently fall back to the grid. Both models are bundled in
the APK, while the existing EmbeddingGemma download is reused.

Stage text, elapsed time, region progress, and **Stop after current region** keep
the operation reviewable. Cancellation waits for the current native inference;
completed regions are retained. The comparison table keeps the last four runs
and the highest sampled app PSS, rather than claiming continuous peak memory.
First-use label-cache preparation can exceed 20 seconds. No fixed runtime limit
is enforced; warm timing on actual phones remains to be measured.

Combined labels use the best crop score and record supporting regions. Scores
are similarities, not presence probabilities. Overlapping regions do not imply
multiple packages or quantities. These experimental runs do not change inventory
or learn corrections. Review each crop, including its weaker matches, before
deciding whether the approach improves your photos.

The first desktop test found generic COCO detectors unsuitable for these pantry
photos: Lite0 proposed a whole-pantry “bed” and Lite2 found no pantry regions.
Grid crops recovered rice-related matches but introduced false labels. See
[the experiment report](experiments/README.md) for reproducible results and the
remaining phone checks. This is a comparison baseline, not a validated inventory
detector.
