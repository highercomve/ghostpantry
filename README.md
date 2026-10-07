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

### Fast local scan (YOLOE + EmbeddingGemma 2)

**Fast local** is the default provider. YOLOE scans packages, jars and cartons,
then loose fruit and vegetables. It merges overlapping boxes before
EmbeddingGemma 2 matches each crop against your saved food labels. The three
fixed-prompt YOLOE profiles are bundled; the 388 MB matching model downloads once
and works offline. Gemma 4 is a separate optional local LLM, not the fast matcher.

Choose each crop's product and **Add to final review**. Matching products are
grouped: three distinct avocado crops become one row with quantity three.
Repeatedly selecting the same crop does not increase the count. Continue reviewing
crops without navigation, then choose **Review quantities and fill** to edit counts,
fill levels and names. Only the final save writes to inventory. Detector boxes
and visual suggestions can be wrong; all products need confirmation.

**Mark missed foods** lets you draw boxes around visible items the detector missed.
Saved crop corrections and food-label vectors stay on the device. CPU is the
starting matching backend; GPU is available where the device supports it.
The full editable preset contains 710 labels, with a limit of 1,024 custom labels.

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

Use **Confirm and remember crop** or **Wrong category for this crop** to teach
explicit corrections. Up to 128 positive/negative vectors per processor and scope
are persisted, without storing photos or changing model weights. Similar future
crops receive bounded ranking adjustments, including custom food names. Adding to
final review does not teach the model. **Clear learned corrections** resets memory
without deleting inventory or the matching model.

### Android package size and retained providers

Android produces separate **arm64-v8a** (phones and ARM Chromebooks) and **x86_64**
(Intel Chromebooks) APKs, with compressed native libraries. Each APK contains only
its own processor's libraries. System AI, downloaded local vision LLMs, fast local
YOLOE/EmbeddingGemma scanning, and configured server/API scanning remain supported.
Selecting Local LLM uses that model; unavailable system AI uses fast local scanning.
Gemma/Qwen LLM weights and EmbeddingGemma weights are downloaded separately,
so catalog entries do not add their model sizes to the APK.

RF-DETR, EfficientDet Lite0/Lite2, MediaPipe vision, whole-photo/grid comparison
screens and old experiment reports have been removed. The YOLOE profiles retain
their bundled AGPL-3.0 license and pinned hashes in `yoloe_packages.json`.

Rebuild the fixed-prompt models with [export_yoloe_packages.py](scripts/export_yoloe_packages.py).
Use [benchmark_yoloe_export.py](scripts/benchmark_yoloe_export.py) to validate exports
against photos on desktop, and `python3 scripts/verify-detectors.py` to check bundled
compressed and decompressed hashes. Desktop results do not establish phone accuracy.
