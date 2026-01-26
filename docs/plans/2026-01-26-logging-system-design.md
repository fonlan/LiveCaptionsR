# Logging System Design

**Date:** 2026-01-26
**Author:** LiveCaptionsR Development Team
**Status:** Approved

## Overview

This document describes the implementation of a comprehensive logging system for LiveCaptionsR. The system provides configurable log levels, automatic file rotation, and detailed API request logging for debugging.

## Requirements

1. **Configurable Log Levels**: Support ERROR, WARN, INFO, DEBUG levels via Settings UI
2. **File Persistence**: All backend logs written to files in `%APPDATA%\LiveCaptionsR\logs\`
3. **DEBUG Detail**: At DEBUG level, log complete API request/response details (method, URL, headers, body)
4. **Automatic Rotation**: Size-based rotation (10MB per file, keep last 5 files)
5. **Runtime Configuration**: Log level changes take effect immediately without restart
6. **Performance**: Minimal overhead in high-frequency paths (20Hz caption polling)

## Architecture

### Technology Stack

**Logging Library: `tracing` ecosystem**
- `tracing` (v0.1) - Core logging framework with structured events
- `tracing-subscriber` (v0.3) - Formatting and filtering
- `tracing-appender` (v0.2) - File rotation and management

**Rationale:**
- Modern Rust standard with better performance than `log` crate
- Built-in structured logging for complex data
- Native file rotation support
- Dynamic filtering with reload capability
- Minimal overhead with compile-time level checks

### Component Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Frontend (React)                     │
│  Settings UI: Log Level Dropdown (ERROR/WARN/INFO/DEBUG)│
└────────────────────┬────────────────────────────────────┘
                     │ invoke("update_log_level_command")
                     ▼
┌─────────────────────────────────────────────────────────┐
│               Backend (Rust/Tauri)                      │
│  ┌────────────────────────────────────────────────────┐ │
│  │  logger.rs (New Module)                            │ │
│  │  - init_logger(level) -> Result<()>                │ │
│  │  - update_log_level_command(level) -> Result<()>   │ │
│  │  - Global RELOAD_HANDLE for runtime changes        │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │  All Modules (lib.rs, translation.rs, etc.)        │ │
│  │  - Use tracing macros: error!, warn!, info!, debug!│ │
│  │  - Existing eprintln! works alongside (gradual)    │ │
│  └────────────────────────────────────────────────────┘ │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│            Log Files (File System)                      │
│  %APPDATA%\LiveCaptionsR\logs\                          │
│  ├── livecaptions-r.log       (current)                 │
│  ├── livecaptions-r.1.log     (rotated)                 │
│  ├── livecaptions-r.2.log                               │
│  └── livecaptions-r.3.log                               │
└─────────────────────────────────────────────────────────┘
```

## File Structure

### New Files

```
src-tauri/src/
└── logger.rs (NEW) - Logger initialization and runtime configuration
```

### Modified Files

**Configuration:**
- `src-tauri/src/lib.rs` - Add `log_level` field to `AppConfig` struct
- `src/types.ts` - Add `log_level: string` to `AppConfig` interface

**Integration:**
- `src-tauri/src/lib.rs` - Call `logger::init_logger()` at startup, add `update_log_level_command`
- `src-tauri/src/translation.rs` - Add DEBUG logging for API requests
- `src/App.tsx` - Add log level dropdown in Settings UI

### Log Directory Structure

```
%APPDATA%\LiveCaptionsR\
├── config.json (modified - add log_level field)
├── data.db (existing)
└── logs\ (NEW)
    ├── livecaptions-r.log       (active log file)
    ├── livecaptions-r.1.log     (most recent rotated)
    ├── livecaptions-r.2.log
    ├── livecaptions-r.3.log
    ├── livecaptions-r.4.log
    └── livecaptions-r.5.log     (oldest, auto-deleted on next rotation)
```

## Configuration Schema

### Backend: `AppConfig` (`src-tauri/src/lib.rs`)

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppConfig {
    // ... existing fields ...

    /// Log level: "error", "warn", "info", "debug"
    #[serde(default = "default_log_level")]
    pub log_level: String,
}

fn default_log_level() -> String {
    "info".to_string()
}
```

### Frontend: `AppConfig` (`src/types.ts`)

```typescript
export interface AppConfig {
  // ... existing fields ...
  log_level: string; // "error" | "warn" | "info" | "debug"
}

export const DEFAULT_CONFIG: AppConfig = {
  // ... existing defaults ...
  log_level: "info",
};
```

## Logger Module Implementation

### `src-tauri/src/logger.rs`

**Core Components:**

1. **Global Reload Handle**
   ```rust
   static RELOAD_HANDLE: Lazy<Mutex<Option<reload::Handle<EnvFilter, ...>>>> =
       Lazy::new(|| Mutex::new(None));
   ```
   - Stores handle for runtime log level changes
   - Thread-safe via Mutex
   - Initialized once at startup

2. **Initialization Function**
   ```rust
   pub fn init_logger(log_level: &str) -> anyhow::Result<()>
   ```
   - Parse log level string → `tracing::Level`
   - Create logs directory: `%APPDATA%\LiveCaptionsR\logs`
   - Set up file appender with rotation (10MB, 5 files)
   - Configure subscriber:
     * File output: All logs at configured level
     * Stderr output: ERROR/WARN only (for console visibility)
     * Format: `[timestamp] [level] [target] message {fields}`
   - Store reload handle in global static

3. **Runtime Update Command**
   ```rust
   #[tauri::command]
   pub fn update_log_level_command(level: String) -> Result<(), String>
   ```
   - Validate level: "error", "warn", "info", "debug"
   - Update filter using reload handle
   - Persist to config.json via `save_config`
   - Return success/error message

### File Rotation Strategy

**Implementation:** `tracing_appender::rolling::RollingFileAppender`

**Configuration:**
- **Trigger:** File size reaches 10MB
- **Retention:** Keep last 5 files
- **Naming Pattern:**
  - `livecaptions-r.log` - Active file
  - `livecaptions-r.1.log` - Most recent rotated
  - `livecaptions-r.5.log` - Oldest (deleted on next rotation)

**Alternative (if needed):**
- Use `tracing-rolling-file` crate for more sophisticated size-based rotation
- Built-in `tracing-appender` may use daily rotation by default

## Logging Integration Points

### What Gets Logged at Each Level

**ERROR Level:**
- Fatal initialization failures (database, config corruption)
- Unrecoverable API errors (invalid credentials, service unavailable)
- Critical state corruption

**WARN Level:**
- Recoverable errors (translation retry, temporary network failure)
- Config load fallback to defaults
- LiveCaptions launch failure (when app continues anyway)
- Token refresh failures with retry

**INFO Level:**
- Translation service initialization with provider selection
- Caption watcher start/stop events
- Session create/load/delete operations
- Config save/load operations
- Successful API requests (summary: provider, duration)

**DEBUG Level:**
- **Full API request/response details:**
  - HTTP method, full URL
  - Request headers (API keys redacted to first 4 chars: `sk-...`)
  - Complete request body
  - HTTP status code
  - Complete response body
  - Request duration in milliseconds
- Caption receive events (text truncated to 200 chars)
- Translation provider negotiation
- Proxy configuration details
- Retry attempts with backoff timing
- Database query parameters

### Key Logging Locations

**1. Translation Service (`src-tauri/src/translation.rs`)**
```rust
// INFO level - service init
info!(provider = ?config.provider, "Translation service initialized");

// DEBUG level - API request
debug!(
    method = "POST",
    url = %api_url,
    headers = ?sanitized_headers,
    request_body = %serde_json::to_string(&request_body)?,
    "Sending translation request"
);

// DEBUG level - API response
debug!(
    status = %response.status(),
    response_body = %response.text().await?,
    duration_ms = %start.elapsed().as_millis(),
    "Received translation response"
);
```

**2. Caption Loops (`src-tauri/src/lib.rs`)**
```rust
// INFO level - start/stop
info!(source = %caption_source, "Caption watcher started");

// DEBUG level - caption received
debug!(
    text_preview = %text.chars().take(200).collect::<String>(),
    user = ?user,
    timestamp = %timestamp,
    "Raw caption received"
);

// WARN level - recoverable errors
warn!(error = %e, "Failed to configure microphone, continuing anyway");
```

**3. Configuration (`src-tauri/src/lib.rs`)**
```rust
// INFO level
info!("Config loaded from file");
info!(theme = %config.theme, provider = %config.provider, "Config saved");

// ERROR level
error!(error = %e, path = %config_path, "Failed to load config");
```

**4. Database Operations (`src-tauri/src/storage.rs`)**
```rust
// INFO level
info!(session_id = %id, session_name = %name, "Session created");

// ERROR level
error!(error = %e, session_id = %id, "Failed to load session");
```

### Sensitive Data Handling

**API Keys:** Redact to first 4 characters
```rust
let sanitized = format!("{}...", &api_key[..4.min(api_key.len())]);
```

**Auth Tokens:** Same redaction pattern

**Request Bodies:** Log full content at DEBUG (needed for debugging)
- User can disable DEBUG in production
- Logs stored locally (not transmitted)

**URLs:** Fully logged (no secrets in URLs per design)

## Frontend Integration

### Settings UI Changes (`src/App.tsx`)

**Log Level Dropdown:**
```tsx
<div className="setting-row">
  <label>{t('settings.logLevel')}</label>
  <select
    value={config.log_level}
    onChange={handleLogLevelChange}
  >
    <option value="error">{t('settings.logLevelError')}</option>
    <option value="warn">{t('settings.logLevelWarn')}</option>
    <option value="info">{t('settings.logLevelInfo')}</option>
    <option value="debug">{t('settings.logLevelDebug')}</option>
  </select>
</div>

<div className="setting-info">
  <small>
    {t('settings.logsLocation')}: %APPDATA%\LiveCaptionsR\logs
  </small>
</div>
```

**Event Handler:**
```tsx
const handleLogLevelChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
  const newLevel = e.target.value;
  try {
    await invoke('update_log_level_command', { level: newLevel });
    setConfig({ ...config, log_level: newLevel });
    showToast('success', t('settings.logLevelUpdated'));
  } catch (error) {
    showToast('error', `Failed to update log level: ${error}`);
  }
};
```

### Localization (`public/locales/en.json`, `public/locales/zh-CN.json`)

```json
{
  "settings": {
    "logLevel": "Log Level",
    "logLevelError": "Error",
    "logLevelWarn": "Warn",
    "logLevelInfo": "Info",
    "logLevelDebug": "Debug",
    "logLevelUpdated": "Log level updated successfully",
    "logsLocation": "Logs location"
  }
}
```

## Performance Considerations

### High-Frequency Path Optimization

**Caption Polling Loop (20Hz):**
- Use `debug!` macro (compile-time checks for disabled levels)
- Avoid expensive string formatting when DEBUG disabled
- Example:
  ```rust
  // Good: Only formats if DEBUG enabled
  debug!(text = %caption_text, "Caption received");

  // Bad: Always formats regardless of level
  let msg = format!("Caption: {}", caption_text);
  debug!("{}", msg);
  ```

### Async File Writing

- `tracing-appender` uses buffered async writes
- No blocking in caption thread
- Flush on process exit handled automatically

### Memory Usage

- File appender buffer: ~8KB per thread
- Rotation: Old files deleted automatically
- Max disk usage: ~50MB (5 files × 10MB)

## Error Handling

### Logger Initialization Failure

**Scenario:** Disk full, permission denied, invalid path

**Handling:**
```rust
match logger::init_logger(&config.log_level) {
    Ok(_) => info!("Logger initialized"),
    Err(e) => {
        eprintln!("WARNING: Failed to initialize logger: {}", e);
        eprintln!("Continuing with stderr-only logging");
        // App continues - fallback to basic logging
    }
}
```

### Log File Write Errors

**Scenario:** Disk full during operation

**Handling:**
- `tracing-appender` silently drops logs on write failure
- App continues normally
- Stderr output still works (ERROR/WARN visible in console)

### Invalid Log Level

**Frontend Validation:**
- Dropdown only allows valid values

**Backend Validation:**
```rust
pub fn update_log_level_command(level: String) -> Result<(), String> {
    let level_filter = match level.as_str() {
        "error" => LevelFilter::ERROR,
        "warn" => LevelFilter::WARN,
        "info" => LevelFilter::INFO,
        "debug" => LevelFilter::DEBUG,
        _ => return Err(format!("Invalid log level: {}", level)),
    };
    // ...
}
```

### Rotation Failures

**Scenario:** Cannot rename/delete old files

**Handling:**
- `tracing-appender` continues writing to current file
- No crash or data loss
- Log rotation attempted on next threshold

## Migration Path

### Phase 1: Initial Deployment
- Add `tracing` dependencies to Cargo.toml
- Implement `logger.rs` module
- Initialize logger at startup
- All existing `eprintln!` statements continue working unchanged

### Phase 2: New Code
- Use `tracing` macros in all new code:
  ```rust
  error!("message")   // replaces eprintln!
  warn!("message")
  info!("message")
  debug!("message")
  ```

### Phase 3: Gradual Migration (Optional)
- Replace critical `eprintln!` with appropriate `tracing` macros
- Priority: translation.rs, lib.rs (main logic)
- Low priority: livecaptions.rs, teams.rs (stable code)

## Testing Strategy

### Manual Testing

1. **Log Level Changes**
   - Start app, set DEBUG level
   - Perform translation → Verify full request/response in log file
   - Change to ERROR level → Verify only errors logged
   - Change back to INFO → Verify immediate effect (no restart)

2. **File Rotation**
   - Generate large volume of logs (batch translations)
   - Verify file rotates at ~10MB
   - Verify only 5 files kept
   - Check oldest file deleted after 6th rotation

3. **Performance**
   - Run caption watcher for 10 minutes with DEBUG level
   - Monitor CPU usage (should be <1% overhead)
   - Verify no UI lag or caption delays

4. **Error Scenarios**
   - Make logs directory read-only → Verify app still starts
   - Fill disk → Verify app continues running
   - Corrupt config.json log_level → Verify fallback to "info"

### Integration Testing

**Test Cases (Cargo tests in `logger.rs`):**
```rust
#[test]
fn test_log_level_parsing() {
    assert!(parse_level("info").is_ok());
    assert!(parse_level("invalid").is_err());
}

#[test]
fn test_logs_directory_creation() {
    // Verify directory created if missing
}
```

## Deployment Checklist

- [ ] Add `tracing` dependencies to `Cargo.toml`
- [ ] Implement `src-tauri/src/logger.rs`
- [ ] Update `AppConfig` in `lib.rs` and `types.ts`
- [ ] Initialize logger in `run()` function
- [ ] Add `update_log_level_command` to Tauri command handler
- [ ] Add Settings UI dropdown in `App.tsx`
- [ ] Add localization strings (en.json, zh-CN.json)
- [ ] Add DEBUG logging to `translation.rs` API calls
- [ ] Test log rotation manually
- [ ] Update `CLAUDE.md` with logging guidelines
- [ ] Update README.md with troubleshooting section (log location)

## Future Enhancements (Out of Scope)

1. **Log Viewer UI** - Built-in log viewer in Settings panel
2. **Log Export** - ZIP and export logs for bug reports
3. **Remote Logging** - Optional telemetry for crash reports
4. **Structured Search** - Query logs by timestamp, level, component
5. **Performance Metrics** - Automatic performance logging (API latency, memory usage)

## Example Log Output

```
2026-01-26T08:30:15.123Z  INFO livecaptions_r_lib: Translation service initialized provider=google
2026-01-26T08:30:16.234Z  INFO livecaptions_r_lib: Caption watcher started source=livecaptions
2026-01-26T08:30:18.456Z DEBUG livecaptions_r_lib::translation: Sending translation request method=POST url=https://translate.googleapis.com/... headers={...} request_body={"q":"Hello world","source":"en","target":"zh-CN"}
2026-01-26T08:30:18.601Z DEBUG livecaptions_r_lib::translation: Received translation response status=200 response_body={"translatedText":"你好世界"} duration_ms=145
2026-01-26T08:30:20.789Z DEBUG livecaptions_r_lib: Raw caption received text_preview="This is a test caption..." user=None timestamp=1706256020
2026-01-26T08:31:05.234Z  WARN livecaptions_r_lib: Translation retry attempt error="Connection timeout" retry=1/3
2026-01-26T08:32:00.567Z ERROR livecaptions_r_lib::storage: Failed to load session error="Database locked" session_id=abc-123
```

---

**End of Design Document**
