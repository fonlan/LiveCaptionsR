# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LiveCaptionsR** is a real-time subtitle translation tool for Windows that captures system audio captions (via Windows LiveCaptions or Microsoft Teams) and translates them using multiple providers (Google, Azure, OpenAI, GitHub Copilot).

**Tech Stack**: Tauri v2 + React 19 + TypeScript + Rust

## Development Commands

### Primary Commands
```bash
npm install              # Install dependencies
npm run tauri dev        # Start dev server (Frontend + Backend)
npm run tauri build      # Build production MSI installer
```

### Testing & Type Checking
```bash
# Backend (run from src-tauri/)
cargo test               # Run all tests
cargo test -- test_name  # Run specific test
cargo check              # Fast compilation check
cargo clippy             # Rust linter

# Frontend
npx tsc --noEmit         # TypeScript type checking
```

## Critical Architecture Patterns

### Frontend-Backend Communication (Tauri IPC)

**Commands** (frontend → backend):
```typescript
await invoke<ReturnType>("command_name", { params });
```
- `start_caption_watcher` / `stop_caption_watcher` - Control caption capture
- `translate_text` - Translate individual captions
- `summarize_text` - Generate AI summaries
- `save_config` / `get_config` - Configuration management
- `create_session` / `save_session_data` / `load_session_data` - Session CRUD
- `get_teams_windows` - Scan Teams meeting windows
- `start_copilot_auth` / `poll_copilot_token` - GitHub OAuth flow

**Events** (backend → frontend):
```typescript
listen<EventType>("event-name", (event) => { ... });
```
- `caption-raw` - Raw caption with `{ text, user, timestamp }`
- `caption-status` - Status updates
- `caption-error` - Error messages
- `caption-visibility` - LiveCaptions window visibility state

### Caption Processing Pipeline

**Data Flow**: Windows LiveCaptions/Teams → UI Automation → `caption-raw` event → Frontend processing → Translation API → Display → SQLite storage

**Key Files**:
- `src/utils/captionProcessing.ts` - Sentence splitting, delta detection, deduplication
- `src/utils/textUtils.ts` - Levenshtein distance, similarity calculation (66% threshold for overwrite)
- `src-tauri/src/livecaptions.rs` - Windows LiveCaptions integration
- `src-tauri/src/teams.rs` - Microsoft Teams integration
- `src-tauri/src/translation.rs` - Translation API clients with semaphore-based concurrency

**Important**: Caption polling runs at ~20Hz. Keep zero heavy logic in the poll loop.

### State Management

**Frontend** (`App.tsx`):
- `useState` for UI state
- `useRef` for high-frequency data (caption buffers, config refs) to prevent re-render thrashing
- Auto-save with 2-second debounce for sessions

**Backend** (Rust):
- Global singletons with `Lazy<Mutex<T>>` for config, db connection, running state
- Avoid complex mutex locking in high-frequency loops

### Translation Service Architecture

**Strategy Pattern** with multiple providers:
- Google Translate (free, no API key)
- Microsoft Azure Translator (requires API key + region)
- OpenAI-compatible APIs (supports custom base URLs)
- GitHub Copilot (OAuth device flow with token caching)

**Configuration Hierarchy**:
```
AppConfig
├── provider: string           # "google", "microsoft", or model ID
├── ai_channels: AIChannel[]   # OpenAI/Copilot credentials
├── ai_models: AIModel[]       # Models linked to channels
└── ... proxy configs (per-provider HTTP/SOCKS5)
```

**Context-aware Translation**: OpenAI providers can include previous captions as context (configurable via `openai_context_count`).

### Windows Integration Constraints

**CRITICAL**:
- Never use `ShowWindow(SW_HIDE)` on LiveCaptions window; it stops audio capture. Use off-screen positioning (-10000, -10000) instead.
- All Windows-specific API calls must be guarded with `#[cfg(windows)]`.
- LiveCaptions.exe is auto-launched/closed by the app.

### Type Sharing

**Central Types** (`src/types.ts`): Shared between frontend and backend via Tauri type serialization. Update this file first when data structures change.

### Logging System

**Architecture**: Structured logging with `tracing` crate for backend operations.

**Configuration**:
- Log levels: `error`, `warn`, `info` (default), `debug`
- Configurable via Settings UI → General → Log Level
- Runtime updates supported via `update_log_level_command` Tauri command
- Stored in `AppConfig.log_level`

**File Location**: `%APPDATA%\LiveCaptionsR\logs\livecaptions-r.log`

**Rotation Policy**:
- Size-based rotation at 10MB per file
- Keeps last 5 rotated files (`.1`, `.2`, `.3`, `.4`, `.5` suffixes)
- Implemented with `tracing-rolling-file` crate
- Non-blocking async writes for performance

**Output Targets**:
- **File**: All logs at configured level (with timestamps, targets)
- **Stderr**: ERROR and WARN only (for console debugging)

**Usage Patterns**:
```rust
use tracing::{info, warn, error, debug};

// Configuration changes
info!(theme = %config.theme, provider = %config.provider, "Saving configuration");

// API requests (with structured fields)
debug!(
    provider = "google",
    text_len = text.len(),
    from_lang = from,
    to_lang = to,
    "Starting translation request"
);

// Errors (with context)
error!(error = %e, "Failed to parse JSON response");
```

**Performance Considerations**:
- Uses non-blocking file writer to avoid blocking high-frequency caption polling
- Structured fields (e.g., `text_len = text.len()`) instead of formatted strings where possible
- File rotation happens asynchronously

**API Request Logging**:
- Translation requests log: provider, text length, language pair, timing
- Response logs include: status codes, response sizes, parsed data
- Errors capture full context: provider, error message, request details

**Key File**: `src-tauri/src/logger.rs`

## Code Conventions

### Rust (Backend)
- `snake_case` for functions/variables, `PascalCase` for structs/enums
- Use `anyhow::Result` for fallible operations
- **NEVER** use `unwrap()` in production; use `?` or `expect("context")`
- Use `tokio::spawn` for heavy tasks; never block main thread

### TypeScript (Frontend)
- `PascalCase` for components, `camelCase` for variables/functions
- Functional components with Hooks
- **Strict typing**: No `any`; define interfaces in `src/types.ts`
- Avoid "God Components"; refactor `App.tsx` logic into custom hooks when appropriate

## Localization

**i18n**: `react-i18next` with English (`en.json`) and Chinese (`zh-CN.json`).
- Add new translation keys to both files
- Use via `t("namespace.key")` hook in components

## Database

**SQLite** at `%APPDATA%\LiveCaptionsR\data.db`:
- `sessions` table: id, name, created_at
- `session_cards` table: id, session_id, original, translated, status, user, timestamp
- Cascade delete on session deletion

**Key File**: `src-tauri/src/storage.rs` and `src-tauri/src/db.rs`
