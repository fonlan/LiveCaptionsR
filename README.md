# LiveCaptionsR

LiveCaptionsR is a real-time subtitle translation tool built with Tauri, React, and Rust. It captures system audio captions via Windows LiveCaptions and translates them instantly using various translation providers.

## ✨ Features

- **Multiple Caption Sources**:
  - **Windows LiveCaptions**: Seamlessly integrates with Windows LiveCaptions (Win+Ctrl+L) using UI Automation.
  - **Microsoft Teams**: Captures live captions from Teams meetings via UI Automation.

- **Instant Translation**: Supports multiple translation providers:
  - **Google Translate** (Free)
  - **Microsoft Azure Translator**
  - **OpenAI Compatible** (GPT-4o, Local LLMs, etc.)
  - **GitHub Copilot** (Uses your GitHub Copilot subscription)

- **Smart Segmentation**:
  - Automatically detects sentence boundaries based on punctuation.
  - Handles incomplete sentences and continuous streams.

- **Intelligent Deduplication**:
  - Uses Levenshtein distance similarity (>66%) to merge similar segments.
  - Detects prefix overlaps to update existing captions instead of creating duplicates.

- **Session Management**:
  - Save and load caption sessions.
  - Session summaries using AI (OpenAI or Copilot).

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

### Caption Sources

1. **Windows LiveCaptions** (Default):
   - Requires Windows 11 22H2+ or Windows 10 22H2+ with LiveCaptions installed.
   - Press `Win+Ctrl+L` to toggle LiveCaptions.

2. **Microsoft Teams**:
   - Requires Teams desktop app running.
   - Click "Scan Teams Windows" to detect active Teams meetings.
   - Select the meeting window to capture captions from.
   - Teams must have live captions enabled in the meeting settings.

### Translation Providers

1. **Google Translate**: Free, no API key required.
   - *Note*: Rate limits may apply for heavy usage.

2. **Microsoft Azure**:
   - Requires `API Key` and `Region` from Azure Portal.

3. **OpenAI Compatible**:
   - Supports official OpenAI API or any compatible endpoint (e.g., LocalAI, Ollama).
   - Configure multiple endpoints (e.g., "GPT-4o" and "Local Llama 3").
   - Set custom `Base URL` and `Model`.

4. **GitHub Copilot**:
   - Requires a GitHub Copilot subscription.
   - Click "Login with GitHub" to authenticate (OAuth Device Flow).
   - Supports all available Copilot models (e.g., `gpt-4`, `gpt-4o`).
   - Can also be used for session summarization.

### Proxy Settings

Each provider has independent proxy settings:
- Toggle **Use Proxy**.
- Format: `http://127.0.0.1:7890` or `socks5://127.0.0.1:1080`.

### Behavior

- **Hide System LiveCaptions Window**: Keeps the native caption bar hidden while capturing.
- **Always on Top**: Keeps the LiveCaptionsR window above other applications.
- **Session Summaries**: Generate AI-powered summaries using OpenAI or Copilot.

## 🛠️ Architecture

- **Frontend**: React + TypeScript + Vite
  - Handles UI, settings, caption segmentation, and display logic.
  - Calculates text similarity for deduplication.

- **Backend**: Rust (Tauri)
  - `livecaptions.rs`: Manages Windows UI Automation and LiveCaptions process control.
  - `teams.rs`: Captures captions from Microsoft Teams meetings via process hierarchy detection and UI Automation.
  - `translation.rs`: Handles HTTP requests to translation APIs (Google, Azure, OpenAI, Copilot).
  - `lib.rs`: Bridges frontend and backend events.

## 🔍 Troubleshooting

### Viewing Logs

LiveCaptionsR maintains detailed logs to help diagnose issues:

**Log Location**: `%APPDATA%\LiveCaptionsR\logs\livecaptions-r.log`

To quickly access the logs directory:
1. Press `Win+R` to open Run dialog
2. Type: `%APPDATA%\LiveCaptionsR\logs`
3. Press Enter

**Log Files**:
- `livecaptions-r.log` - Current log file
- `livecaptions-r.log.1` through `.5` - Rotated log files (older logs)

**Changing Log Level**:

For detailed debugging information:

1. Open LiveCaptionsR Settings (gear icon)
2. Navigate to **General** section
3. Change **Log Level** to `debug`
4. The change takes effect immediately (no restart required)

**Available Log Levels**:
- `error` - Only critical errors
- `warn` - Warnings and errors
- `info` - General information (default)
- `debug` - Detailed diagnostic information

**Common Issues to Check Logs For**:
- Translation API failures (check for HTTP errors, authentication issues)
- Caption capture problems (check Windows UI Automation errors)
- Configuration loading errors
- Network/proxy connection issues

**Example Log Entries**:
```
2024-01-26T12:00:00.123Z INFO  Configuration saved successfully theme=dark provider=google
2024-01-26T12:00:01.456Z DEBUG Starting translation request provider=google text_len=42
2024-01-26T12:00:01.789Z ERROR Failed to connect to API endpoint error="connection timeout"
```

**Note**: Log files automatically rotate when they reach 10MB. The system keeps the last 5 rotated files, so you won't run out of disk space.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

MIT License
