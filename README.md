# 👻🥫 GhostPantry

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
- **Node.js 18+** & **npm**
- **Oriel CLI**: `oriel` (at `~/.local/bin/oriel`)
- *(Optional for local vision)*: [Ollama](https://ollama.ai) with `llama3.2-vision` or `qwen2.5-vl`

### 2. Development Mode

Start the Vite development server with hot-reloading:

```bash
cd /home/projects/ghostpantry
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

### Option A: OpenAI (Pay-per-token API)
- **Base URL**: `https://api.openai.com/v1`
- **Model**: `gpt-4o-mini` or `gpt-4o`
- **API Key**: `sk-...`

### Option B: ChatGPT Plan Token Allowance (New OpenAI Feature)
If you subscribe to ChatGPT Plus or Pro, you can use your plan's token allowance in third-party apps:
- See OpenAI's guide: [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)
- **Base URL**: `https://api.openai.com/v1`
- **Model**: `gpt-4o-mini`
- **API Key / Personal Token**: Paste your generated ChatGPT app token.

### Option C: Small Local Vision Model (Free & Offline)
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

## 📄 License

MIT
