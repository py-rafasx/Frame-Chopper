# Frame Chopper

<div align="center">

A graphical interface to extract frames from videos using FFmpeg.

**Rust + Tauri 2 edition**

[![Download Release](https://img.shields.io/badge/Download-Release-blue)](https://github.com/py-rafasx/Frame-Chopper/releases/latest)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)
[![Rust](https://img.shields.io/badge/Rust-Tauri%202-orange)](src-tauri)

<img src="./src/renderer/assets/framchopper-screenshot.png" alt="Frame Chopper Screenshot" width="400">

</div>

## Overview

Frame Chopper is a desktop app that extracts frames from videos with FFmpeg. This version replaces the original Electron runtime with a Rust backend built on **Tauri 2**, while reusing the same HTML/CSS/JS renderer.

Instead of bundling Chromium and Node.js, Tauri uses the webview already provided by the operating system. That is what makes the binary so small.

> [!NOTE]
> **AI-assisted port.** The Rust/Tauri backend, the FFmpeg setup screen and the release workflow were converted from the original Electron app with the help of AI coding assistants. The renderer and original UI are kept from the author's Electron version.

## Tiny binary

Measured on the Windows x64 build (v1.6.5):

| Artifact | Size |
| --- | --- |
| `frame-chopper.exe` | **3.4 MB** |
| NSIS installer | **1.23 MB** |
| MSI installer | **1.75 MB** |

For comparison, Electron installers carry the whole Chromium/Node runtime and are typically tens of megabytes larger. Tauri only ships the app code and relies on the system webview.

## Features

- **Easy to Use**: Simple drag-and-drop interface
- **Frame Extraction**: Extract frames at any FPS rate
- **Quality Control**: Adjustable quality for JPEG output
- **Multiple Formats**: Support for JPEG and PNG formats
- **Custom Naming**: Configure frame naming patterns with zero-padding
- **FFmpeg Powered**: Leverages the power of FFmpeg for video processing
- **Small Footprint**: Rust/Tauri build with a ~3.4 MB executable
- **FFmpeg Check**: Built-in setup screen with per-OS install commands and download links

## Project layout

| Path | Description |
| --- | --- |
| `src/renderer/` | Shared HTML/CSS/JS user interface |
| `src-tauri/` | Rust/Tauri backend (current version) |
| `electron/` | Original Electron backend (kept as an alternative build) |

## Requirements

### To run

- **FFmpeg** and **ffprobe** installed and available on `PATH` (or in a common install location). If they are missing, the app shows a setup screen with the recommended command for your operating system.
- **Windows 10/11**, **macOS 10.14+**, or a modern Linux distribution with WebKitGTK.
- On Windows, the WebView2 runtime (preinstalled on Windows 10/11).

FFmpeg is **not** bundled with the release. Install it separately using the in-app instructions.

### To build from source

- **Node.js** 18 or higher
- **Rust stable** (install via [rustup](https://rustup.rs)) with `cargo` on `PATH`
- Platform tooling:
  - **Windows**: Visual Studio Build Tools with the C++ workload (MSVC)
  - **macOS**: Xcode Command Line Tools
  - **Linux**: `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf`, `build-essential`

## Installation

### From release

1. Download the latest release from the [releases page](https://github.com/py-rafasx/Frame-Chopper/releases/latest)
2. Choose the installer for your platform:
   - **Windows**: NSIS `.exe` or `.msi`
   - **macOS**: `.dmg`
   - **Linux**: `.AppImage` or `.deb`
3. Launch Frame Chopper and install FFmpeg when prompted

### From source (Tauri)

```bash
git clone https://github.com/py-rafasx/Frame-Chopper.git
cd Frame-Chopper

npm install
npm run dev:tauri    # development
npm run build:tauri  # installers in src-tauri/target/release/bundle
```

### Electron build (alternative)

The original Electron backend is still available:

```bash
npm install
npm start        # development
npm run build    # installers in dist/
```

The Electron build ships its own Chromium runtime and is significantly larger than the Tauri build.

## Usage

1. **Select Video**: Choose a video file or drag and drop it into the application
2. **Configure Settings**:
   - **Frames Per Second**: Set how many frames to extract per second (1 = one frame per second)
   - **Quality**: Set JPEG quality (1 = best, 31 = worst). Note: PNG has no quality option
   - **Subtitles**: Choose to include subtitles in the output (if available in MKV files)
   - **Output Folder**: Specify where frames will be saved
   - **Frame Prefix**: Add a prefix to frame filenames
   - **Zero Padding**: Add leading zeros to frame numbers for easier sorting
   - **Format**: Choose between JPEG or PNG output format
3. **Extract**: Click to start the frame extraction process

## License

This project is licensed under the [MIT LICENSE](LICENSE).
