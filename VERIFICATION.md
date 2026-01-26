# Logging System Verification Checklist

This document provides a comprehensive checklist for verifying the logging system implementation in LiveCaptionsR.

## 1. Build & Tests

- [ ] **Cargo Build**: Run `cargo build` in `src-tauri/` - should compile without errors
- [ ] **Cargo Test**: Run `cargo test` in `src-tauri/` - all tests should pass
  - [ ] `test_parse_level_valid` passes
  - [ ] `test_parse_level_invalid` passes
  - [ ] `test_clean_thinking_content` passes
  - [ ] `test_log_rotation` ignored (manual test only)
- [ ] **Type Checking**: Run `npx tsc --noEmit` - no type errors
- [ ] **Clippy**: Run `cargo clippy` in `src-tauri/` - no warnings

## 2. Fresh Install

- [ ] **Clean Install**: Delete `%APPDATA%\LiveCaptionsR` folder
- [ ] **First Launch**: Start application
  - [ ] App launches successfully
  - [ ] `livecaptions_r.log` created in `%APPDATA%\LiveCaptionsR\logs\`
  - [ ] Log file contains startup messages
  - [ ] No errors in log file during initialization

## 3. UI Functionality

### Log Viewer Settings
- [ ] **Open Settings**: Navigate to Settings page
- [ ] **Log Level Dropdown**: Verify dropdown shows all levels
  - [ ] TRACE
  - [ ] DEBUG
  - [ ] INFO (default)
  - [ ] WARN
  - [ ] ERROR
- [ ] **Level Selection**: Change log level to DEBUG
  - [ ] Selection persists after app restart
  - [ ] Log output reflects new level

### Log Viewer Page
- [ ] **Navigate to Logs**: Click "View Logs" button/menu item
- [ ] **Log Display**: Verify log viewer shows content
  - [ ] Logs are displayed in reverse chronological order (newest first)
  - [ ] Each log entry shows timestamp, level, and message
  - [ ] Syntax highlighting for log levels (colors)
- [ ] **Auto-scroll**: New logs appear at the top automatically
- [ ] **Refresh Button**: Click refresh to reload logs manually
- [ ] **Open Folder Button**: Click "Open Log Folder" button
  - [ ] Windows Explorer opens to `%APPDATA%\LiveCaptionsR\logs\`

## 4. Logging Output

### Application Lifecycle
- [ ] **Startup Logs**: Application startup logged
  - [ ] App version logged
  - [ ] Configuration loaded message
  - [ ] Database initialization message
- [ ] **Shutdown Logs**: Application shutdown logged cleanly

### Caption Processing
- [ ] **Start Caption Watcher**: Enable caption capture
  - [ ] "Starting caption watcher" logged
  - [ ] LiveCaptions.exe launch logged (if applicable)
- [ ] **Caption Detection**: Speak into microphone
  - [ ] Raw captions logged at DEBUG level
  - [ ] Caption processing steps logged
- [ ] **Stop Caption Watcher**: Disable caption capture
  - [ ] "Stopping caption watcher" logged

### Translation Operations
- [ ] **Translation Request**: Translate a caption
  - [ ] Translation request logged with source text
  - [ ] Selected provider logged
  - [ ] Translation response logged
  - [ ] Any errors logged with full context

### Session Management
- [ ] **Create Session**: Create a new session
  - [ ] Session creation logged with session ID
- [ ] **Save Session**: Save session data
  - [ ] Save operation logged
- [ ] **Load Session**: Load existing session
  - [ ] Load operation logged with record count

## 5. API Request Logging

### Google Translate
- [ ] **Configure Google**: Set provider to Google Translate
- [ ] **Translate Text**: Perform translation
  - [ ] Request URL logged (at DEBUG level)
  - [ ] Request parameters logged (source/target language)
  - [ ] Response status logged
  - [ ] API errors logged with details

### Microsoft Azure
- [ ] **Configure Azure**: Set provider to Microsoft Azure
  - [ ] API key and region required
- [ ] **Translate Text**: Perform translation
  - [ ] Request URL logged
  - [ ] Request headers logged (API key redacted)
  - [ ] Response logged
  - [ ] Rate limit errors logged

### OpenAI/Copilot
- [ ] **Configure OpenAI**: Set provider to OpenAI-compatible API
- [ ] **Translate Text**: Perform translation
  - [ ] Request URL logged
  - [ ] Model name logged
  - [ ] Context messages logged (if enabled)
  - [ ] Token usage logged
  - [ ] Thinking content cleaned from response (if present)
  - [ ] API errors logged with full response body

### Proxy Configuration
- [ ] **Configure Proxy**: Set HTTP/SOCKS5 proxy
  - [ ] Proxy configuration logged
  - [ ] Proxy connection attempts logged
  - [ ] Proxy errors logged with details

## 6. File Rotation

- [ ] **Log File Size**: Check current log file size
  - [ ] Default max size is 10 MB
- [ ] **Rotation Trigger**: Generate logs until file exceeds 10 MB
  - [ ] Old log renamed to `livecaptions_r.log.1`
  - [ ] New `livecaptions_r.log` created
  - [ ] No logs lost during rotation
- [ ] **Multiple Rotations**: Trigger multiple rotations
  - [ ] Up to 5 backup files created (.1 through .5)
  - [ ] Oldest backup deleted when limit exceeded
- [ ] **Rotation Logging**: Rotation events logged
  - [ ] "Rotating log file" message appears

## 7. Performance

- [ ] **High-Frequency Logging**: Enable DEBUG level during caption capture
  - [ ] App remains responsive
  - [ ] No lag in UI
  - [ ] CPU usage reasonable (check Task Manager)
- [ ] **Large Log Files**: Open log viewer with large log file (>1 MB)
  - [ ] Viewer loads without freezing
  - [ ] Scrolling is smooth
- [ ] **Long-Running Session**: Run app for extended period (30+ minutes)
  - [ ] No memory leaks
  - [ ] Log file grows at expected rate
  - [ ] No performance degradation

## 8. Documentation

- [ ] **LOGGING.md**: Review `docs/LOGGING.md`
  - [ ] All sections complete
  - [ ] Examples are clear
  - [ ] Log level descriptions accurate
  - [ ] File rotation explained
  - [ ] Troubleshooting section helpful
- [ ] **CLAUDE.md**: Review updates to `CLAUDE.md`
  - [ ] Logging system mentioned in architecture
  - [ ] Log file location documented
  - [ ] Development commands include log testing
- [ ] **Code Comments**: Review `src-tauri/src/logger.rs`
  - [ ] Public functions documented
  - [ ] Module-level documentation present
  - [ ] Examples provided where helpful

## 9. Error Scenarios

### Configuration Errors
- [ ] **Invalid Log Level**: Manually edit config with invalid level
  - [ ] Falls back to INFO level
  - [ ] Warning logged about invalid value

### File System Errors
- [ ] **Read-Only Log Directory**: Make log directory read-only (manually)
  - [ ] Error logged to stderr
  - [ ] App continues running (fallback to console logging)
- [ ] **Disk Full**: Fill disk to capacity (not recommended for production)
  - [ ] Graceful error handling
  - [ ] User notified of issue

### Translation Errors
- [ ] **Invalid API Key**: Configure Azure with invalid key
  - [ ] Authentication error logged with status code
  - [ ] Error message shown to user
- [ ] **Network Error**: Disconnect internet during translation
  - [ ] Connection error logged
  - [ ] Retry behavior logged (if applicable)
- [ ] **Malformed Response**: Trigger API to return invalid JSON
  - [ ] Parse error logged with response excerpt
  - [ ] User notified of failure

## 10. Multi-Language Support

- [ ] **English UI**: Set application language to English
  - [ ] Log viewer labels in English
  - [ ] Settings labels in English
- [ ] **Chinese UI**: Set application language to Chinese
  - [ ] Log viewer labels in Chinese
  - [ ] Settings labels in Chinese
  - [ ] Log file content still in English (technical logs)

---

## Test Results

### Test Date: ___________
### Tester: ___________
### Version: ___________

### Summary
- **Total Items**: 80+
- **Passed**: _____
- **Failed**: _____
- **Skipped**: _____

### Notes
(Add any observations, issues found, or suggestions here)

---

## Sign-Off

- [ ] All critical tests passed
- [ ] No blocking issues found
- [ ] Documentation is complete and accurate
- [ ] Ready for production release

**Approved By**: ___________
**Date**: ___________
