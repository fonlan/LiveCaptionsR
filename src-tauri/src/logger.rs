use crate::error::AppError;
use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use std::sync::Mutex;
use tracing::Level;
use tracing_rolling_file::RollingFileAppenderBase;
use tracing_subscriber::{
    fmt, layer::SubscriberExt, reload, util::SubscriberInitExt, EnvFilter, Layer,
};

type ReloadHandle = reload::Handle<EnvFilter, tracing_subscriber::Registry>;

static RELOAD_HANDLE: Lazy<Mutex<Option<ReloadHandle>>> = Lazy::new(|| Mutex::new(None));

/// Parse log level string to tracing Level
fn parse_level(level: &str) -> Result<Level> {
    match level.to_lowercase().as_str() {
        "error" => Ok(Level::ERROR),
        "warn" => Ok(Level::WARN),
        "info" => Ok(Level::INFO),
        "debug" => Ok(Level::DEBUG),
        _ => Err(anyhow::anyhow!("Invalid log level: {}", level)),
    }
}

/// Initialize logger with file and stderr output
pub fn init_logger(log_level: &str) -> Result<()> {
    let level = parse_level(log_level)?;

    // Get logs directory: %APPDATA%/LiveCaptionsR/logs
    let config_dir = dirs::config_dir()
        .ok_or_else(|| anyhow::anyhow!("Could not find config directory"))?
        .join("LiveCaptionsR")
        .join("logs");

    std::fs::create_dir_all(&config_dir).context("Failed to create logs directory")?;

    // Set up file appender with size-based rotation
    // 10MB file size limit, keep last 5 rotated files
    let file_path = config_dir.join("livecaptions-r.log");
    let file_appender = RollingFileAppenderBase::builder()
        .filename(file_path.to_string_lossy().to_string())
        .max_filecount(5)
        .condition_max_file_size(10 * 1024 * 1024) // 10MB in bytes
        .build()
        .map_err(|e| anyhow::anyhow!("Failed to create rolling file appender: {}", e))?;

    // Use non-blocking writer for better performance
    let (non_blocking, _guard) = file_appender.get_non_blocking_appender();

    // Store the guard to prevent it from being dropped
    std::mem::forget(_guard);

    // Create filter
    let filter = EnvFilter::new(format!("livecaptions_r_lib={}", level));
    let (filter, reload_handle) = reload::Layer::new(filter);

    // File layer - all logs at configured level
    let file_layer = fmt::layer()
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_target(true)
        .with_filter(filter);

    // Stderr layer - only ERROR and WARN
    let stderr_filter = EnvFilter::new("livecaptions_r_lib=warn");
    let stderr_layer = fmt::layer()
        .with_writer(std::io::stderr)
        .with_target(true)
        .with_filter(stderr_filter);

    // Initialize subscriber
    tracing_subscriber::registry()
        .with(file_layer)
        .with(stderr_layer)
        .init();

    // Store reload handle
    let mut handle = RELOAD_HANDLE.lock().unwrap();
    *handle = Some(reload_handle);

    tracing::info!("Logger initialized at {} level", log_level);
    Ok(())
}

/// Update log level at runtime (Tauri command)
#[tauri::command]
pub fn update_log_level_command(level: String) -> Result<(), AppError> {
    let parsed_level = parse_level(&level).map_err(|e| AppError::Runtime(e.to_string()))?;

    let handle = RELOAD_HANDLE.lock().unwrap();
    if let Some(reload_handle) = &*handle {
        let new_filter = EnvFilter::new(format!("livecaptions_r_lib={}", parsed_level));
        reload_handle
            .reload(new_filter)
            .map_err(|e| AppError::Runtime(e.to_string()))?;
        tracing::info!("Log level updated to {}", level);
        Ok(())
    } else {
        Err(AppError::Runtime("Logger not initialized".to_string()))
    }
}

/// Open log directory in file explorer (Tauri command)
#[tauri::command]
pub fn open_log_directory() -> Result<(), AppError> {
    let log_dir = dirs::config_dir()
        .ok_or_else(|| AppError::Runtime("Could not find config directory".to_string()))?
        .join("LiveCaptionsR")
        .join("logs");

    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&log_dir)
            .spawn()
            .map_err(|e| AppError::Runtime(format!("Failed to open explorer: {}", e)))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&log_dir)
            .spawn()
            .map_err(|e| AppError::Runtime(format!("Failed to open finder: {}", e)))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&log_dir)
            .spawn()
            .map_err(|e| AppError::Runtime(format!("Failed to open file manager: {}", e)))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_level_valid() {
        assert!(parse_level("error").is_ok());
        assert!(parse_level("warn").is_ok());
        assert!(parse_level("info").is_ok());
        assert!(parse_level("debug").is_ok());
        assert!(parse_level("INFO").is_ok()); // case insensitive
    }

    #[test]
    fn test_parse_level_invalid() {
        assert!(parse_level("invalid").is_err());
        assert!(parse_level("trace").is_err());
        assert!(parse_level("").is_err());
    }

    #[test]
    #[ignore]
    fn test_log_rotation() {
        // This test verifies that log rotation works correctly
        // Run manually with: cargo test test_log_rotation -- --ignored

        use std::fs;
        use tracing::info;

        // Create a temporary directory for testing
        let test_dir = std::env::temp_dir().join("livecaptions-test-rotation");
        let _ = fs::remove_dir_all(&test_dir); // Clean up if exists
        fs::create_dir_all(&test_dir).unwrap();

        // Create appender with small size limit for testing (1KB)
        let test_file = test_dir.join("test.log");
        let file_appender = RollingFileAppenderBase::builder()
            .filename(test_file.to_string_lossy().to_string())
            .max_filecount(3)
            .condition_max_file_size(1024) // 1KB for quick rotation
            .build()
            .unwrap();

        let (non_blocking, _guard) = file_appender.get_non_blocking_appender();

        let filter = EnvFilter::new("info");
        let file_layer = fmt::layer()
            .with_writer(non_blocking)
            .with_ansi(false)
            .with_filter(filter);

        // Initialize subscriber for this test
        let _guard = tracing_subscriber::registry()
            .with(file_layer)
            .set_default();

        // Write enough logs to trigger rotation
        for i in 0..100 {
            info!("Test log message number {} - Adding some extra text to make the line longer and fill up the file faster", i);
        }

        // Give time for file operations to complete
        std::thread::sleep(std::time::Duration::from_millis(100));

        // Check that rotation happened
        let entries: Vec<_> = fs::read_dir(&test_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();

        // Should have multiple files due to rotation
        assert!(
            entries.len() > 1,
            "Expected multiple log files, found {}",
            entries.len()
        );

        // Verify we don't exceed max_log_files + 1 (current + archived)
        assert!(
            entries.len() <= 4,
            "Expected at most 4 files (current + 3 archived), found {}",
            entries.len()
        );

        // Clean up
        let _ = fs::remove_dir_all(&test_dir);
    }
}
