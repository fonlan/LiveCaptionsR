use crate::error::AppError;
use anyhow::{Context, Result};
use chrono::{DateTime, Local};
use once_cell::sync::Lazy;
use std::{
    fs,
    io::{self, Write},
    path::PathBuf,
    sync::Mutex,
};
use tracing::Level;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_rolling_file::{RollingConditionBase, RollingFileAppenderBase};
use tracing_subscriber::{
    fmt, layer::SubscriberExt, reload, util::SubscriberInitExt, EnvFilter, Layer,
};

type ReloadHandle = reload::Handle<EnvFilter, tracing_subscriber::Registry>;

static RELOAD_HANDLE: Lazy<Mutex<Option<ReloadHandle>>> = Lazy::new(|| Mutex::new(None));
static LOG_GUARD: Lazy<Mutex<Option<WorkerGuard>>> = Lazy::new(|| Mutex::new(None));

const LOG_FILE_PREFIX: &str = "livecaptions-r";
const MAX_LOG_FILE_SIZE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_ROTATED_LOG_FILES: usize = 5;

struct DateBasedRollingWriter {
    log_dir: PathBuf,
    base_name: String,
    max_filecount: usize,
    max_file_size: u64,
    current_date: Option<String>,
    current_appender: Option<RollingFileAppenderBase>,
}

impl DateBasedRollingWriter {
    fn new(
        log_dir: PathBuf,
        base_name: impl Into<String>,
        max_filecount: usize,
        max_file_size: u64,
    ) -> io::Result<Self> {
        let mut writer = Self {
            log_dir,
            base_name: base_name.into(),
            max_filecount,
            max_file_size,
            current_date: None,
            current_appender: None,
        };

        writer.ensure_appender_for_datetime(&Local::now())?;
        Ok(writer)
    }

    fn current_date_string(now: &DateTime<Local>) -> String {
        now.format("%Y-%m-%d").to_string()
    }

    fn filename_for_date(&self, date: &str) -> PathBuf {
        self.log_dir
            .join(format!("{}-{}.log", self.base_name, date))
    }

    fn build_appender(&self, date: &str) -> io::Result<RollingFileAppenderBase> {
        let file_path = self.filename_for_date(date);
        RollingFileAppenderBase::new(
            file_path,
            RollingConditionBase::new().max_size(self.max_file_size),
            self.max_filecount,
        )
    }

    fn ensure_appender_for_datetime(&mut self, now: &DateTime<Local>) -> io::Result<()> {
        let next_date = Self::current_date_string(now);
        let needs_switch = self.current_date.as_deref() != Some(next_date.as_str());

        if needs_switch {
            if let Some(appender) = self.current_appender.as_mut() {
                appender.flush()?;
            }

            self.current_appender = Some(self.build_appender(&next_date)?);
            self.current_date = Some(next_date);
        }

        Ok(())
    }

    fn write_with_datetime(&mut self, buf: &[u8], now: &DateTime<Local>) -> io::Result<usize> {
        self.ensure_appender_for_datetime(now)?;

        match self.current_appender.as_mut() {
            Some(appender) => appender.write(buf),
            None => Err(io::Error::other("log appender is not initialized")),
        }
    }
}

impl Write for DateBasedRollingWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.write_with_datetime(buf, &Local::now())
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.current_appender.as_mut() {
            Some(appender) => appender.flush(),
            None => Ok(()),
        }
    }
}
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
    let log_dir = dirs::config_dir()
        .ok_or_else(|| anyhow::anyhow!("Could not find config directory"))?
        .join("LiveCaptionsR")
        .join("logs");

    fs::create_dir_all(&log_dir).context("Failed to create logs directory")?;

    // Set up date-based file appender with per-day filenames and size-based rotation.
    let file_appender = DateBasedRollingWriter::new(
        log_dir,
        LOG_FILE_PREFIX,
        MAX_ROTATED_LOG_FILES,
        MAX_LOG_FILE_SIZE_BYTES,
    )
    .context("Failed to create date-based rolling file appender")?;

    // Use non-blocking writer for better performance
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

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

    // Store handles to keep runtime logging active
    let mut handle = RELOAD_HANDLE
        .lock()
        .map_err(|_| anyhow::anyhow!("Logger reload handle mutex poisoned"))?;
    *handle = Some(reload_handle);

    let mut log_guard = LOG_GUARD
        .lock()
        .map_err(|_| anyhow::anyhow!("Logger guard mutex poisoned"))?;
    *log_guard = Some(guard);

    tracing::info!("Logger initialized at {} level", log_level);
    Ok(())
}

/// Update log level at runtime (Tauri command)
#[tauri::command]
pub fn update_log_level_command(level: String) -> Result<(), AppError> {
    let parsed_level = parse_level(&level).map_err(|e| AppError::Runtime(e.to_string()))?;

    let handle = RELOAD_HANDLE
        .lock()
        .map_err(|_| AppError::Runtime("Logger reload handle mutex poisoned".to_string()))?;
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
    use chrono::TimeZone;
    use std::{fs, path::Path};

    #[test]
    fn test_parse_level_valid() {
        assert!(parse_level("error").is_ok());
        assert!(parse_level("warn").is_ok());
        assert!(parse_level("info").is_ok());
        assert!(parse_level("debug").is_ok());
        assert!(parse_level("INFO").is_ok());
    }

    #[test]
    fn test_parse_level_invalid() {
        assert!(parse_level("invalid").is_err());
        assert!(parse_level("trace").is_err());
        assert!(parse_level("").is_err());
    }

    #[test]
    fn test_logs_are_split_by_date() {
        let test_dir = std::env::temp_dir().join("livecaptions-test-date-split");
        let _ = fs::remove_dir_all(&test_dir);
        fs::create_dir_all(&test_dir).unwrap();

        let mut writer =
            DateBasedRollingWriter::new(test_dir.clone(), "test-log", 3, 1024).unwrap();
        let day_one = Local.with_ymd_and_hms(2026, 3, 6, 23, 59, 58).unwrap();
        let day_two = Local.with_ymd_and_hms(2026, 3, 7, 0, 0, 1).unwrap();

        writer.write_with_datetime(b"day-one\n", &day_one).unwrap();
        writer.write_with_datetime(b"day-two\n", &day_two).unwrap();
        writer.flush().unwrap();

        let day_one_log = test_dir.join("test-log-2026-03-06.log");
        let day_two_log = test_dir.join("test-log-2026-03-07.log");

        assert!(Path::new(&day_one_log).exists());
        assert!(Path::new(&day_two_log).exists());
        assert!(fs::read_to_string(day_one_log).unwrap().contains("day-one"));
        assert!(fs::read_to_string(day_two_log).unwrap().contains("day-two"));

        let _ = fs::remove_dir_all(&test_dir);
    }

    #[test]
    #[ignore]
    fn test_log_rotation() {
        use tracing::info;

        let test_dir = std::env::temp_dir().join("livecaptions-test-rotation");
        let _ = fs::remove_dir_all(&test_dir);
        fs::create_dir_all(&test_dir).unwrap();

        let file_appender = DateBasedRollingWriter::new(test_dir.clone(), "test", 3, 1024).unwrap();
        let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

        let filter = EnvFilter::new("info");
        let file_layer = fmt::layer()
            .with_writer(non_blocking)
            .with_ansi(false)
            .with_filter(filter);

        let _guard = tracing_subscriber::registry()
            .with(file_layer)
            .set_default();
        for i in 0..100 {
            info!("Test log message number {} - Adding some extra text to make the line longer and fill up the file faster", i);
        }

        std::thread::sleep(std::time::Duration::from_millis(100));

        let entries: Vec<_> = fs::read_dir(&test_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();

        assert!(
            entries.len() > 1,
            "Expected multiple log files, found {}",
            entries.len()
        );

        assert!(
            entries.len() <= 4,
            "Expected at most 4 files (current + 3 archived), found {}",
            entries.len()
        );

        let _ = fs::remove_dir_all(&test_dir);
    }
}
