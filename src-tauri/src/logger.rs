use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use std::sync::Mutex;
use tracing::Level;
use tracing_subscriber::{
    fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Layer, reload,
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

    std::fs::create_dir_all(&config_dir)
        .context("Failed to create logs directory")?;

    // Set up file appender with daily rotation
    let file_appender = tracing_appender::rolling::daily(config_dir, "livecaptions-r.log");

    // Create filter
    let filter = EnvFilter::new(format!("livecaptions_r_lib={}", level));
    let (filter, reload_handle) = reload::Layer::new(filter);

    // File layer - all logs at configured level
    let file_layer = fmt::layer()
        .with_writer(file_appender)
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
pub fn update_log_level_command(level: String) -> Result<(), String> {
    let parsed_level = parse_level(&level).map_err(|e| e.to_string())?;

    let handle = RELOAD_HANDLE.lock().unwrap();
    if let Some(reload_handle) = &*handle {
        let new_filter = EnvFilter::new(format!("livecaptions_r_lib={}", parsed_level));
        reload_handle.reload(new_filter).map_err(|e| e.to_string())?;
        tracing::info!("Log level updated to {}", level);
        Ok(())
    } else {
        Err("Logger not initialized".to_string())
    }
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
}
