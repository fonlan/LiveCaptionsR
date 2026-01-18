# LiveCaptionsR

LiveCaptionsR is a real-time subtitle translation tool built with Tauri, React, and Rust. It captures system audio captions via Windows LiveCaptions and translates them instantly using various translation providers.

## ✨ Features

- **Real-time Capture**: Seamlessly integrates with Windows LiveCaptions (Win+Ctrl+L) using UI Automation.
- **Instant Translation**: Supports multiple translation providers:
  - **Google Translate** (Free)
  - **Microsoft Azure Translator**
  - **OpenAI Compatible** (GPT-4o, Local LLMs, etc.)
- **Smart Segmentation**:
  - Automatically detects sentence boundaries based on punctuation.
  - Handles incomplete sentences and continuous streams.
- **Intelligent Deduplication**:
  - Uses Levenshtein distance similarity (>66%) to merge similar segments.
  - Detects prefix overlaps to update existing captions instead of creating duplicates.
- **Modern UI**:
  - Dark mode Cyber-noir aesthetic.
  - "Always on Top" mode for overlay usage.
  - Auto-scrolling history.
- **System Integration**:
  - Auto-launches Windows LiveCaptions on start.
  - Can hide the native LiveCaptions window while capturing.
  - Auto-closes LiveCaptions on exit.
- **Proxy Support**:
  - Independent HTTP/SOCKS5 proxy configuration for each provider.

## 🚀 Getting Started

### Prerequisites

- Windows 10/11 (22H2 or later)
- [Node.js](https://nodejs.org/) (v16+)
- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- **Windows LiveCaptions** must be installed (usually pre-installed on Win11 22H2+).

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/LiveCaptionsR.git
   cd LiveCaptionsR
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Run in development mode**
   ```bash
   npm run tauri dev
   ```

4. **Build for production**
   ```bash
   npm run tauri build
   ```
   The installer will be available in `src-tauri/target/release/bundle/msi/`.

## ⚙️ Configuration

Click the **Settings** icon in the bottom-right corner to configure:

### Translation Providers

1. **Google Translate**: Free, no API key required.
   - *Note*: Rate limits may apply for heavy usage.

2. **Microsoft Azure**:
   - Requires `API Key` and `Region` from Azure Portal.

3. **OpenAI Compatible**:
   - Supports official OpenAI API or any compatible endpoint (e.g., LocalAI, Ollama).
   - Configure multiple endpoints (e.g., "GPT-4o" and "Local Llama 3").
   - Set custom `Base URL` and `Model`.

### Proxy Settings

Each provider has independent proxy settings:
- Toggle **Use Proxy**.
- Format: `http://127.0.0.1:7890` or `socks5://127.0.0.1:1080`.

### Behavior

- **Hide System LiveCaptions Window**: Keeps the native caption bar hidden while capturing.
- **Always on Top**: Keeps the LiveCaptionsR window above other applications.

## 🛠️ Architecture

- **Frontend**: React + TypeScript + Vite
  - Handles UI, settings, caption segmentation, and display logic.
  - Calculates text similarity for deduplication.
- **Backend**: Rust (Tauri)
  - `livecaptions.rs`: Manages Windows UI Automation and process control.
  - `translation.rs`: Handles HTTP requests to translation APIs.
  - `lib.rs`: Bridges frontend and backend events.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

MIT License
