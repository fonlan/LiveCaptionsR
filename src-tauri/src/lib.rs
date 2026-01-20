use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

mod livecaptions;
mod storage;
mod translation;
mod db;

use translation::{OpenAIEndpoint, ProxyConfig, TranslationConfig, TranslationProvider, TranslationService};

// Simple raw caption event - just the text from LiveCaptions
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RawCaption {
    pub text: String,
    pub timestamp: u64,
}

/// Proxy configuration for frontend
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ProxyConfigDTO {
    pub url: Option<String>,
    pub enabled: bool,
}

/// OpenAI endpoint configuration for frontend
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OpenAIEndpointDTO {
    pub id: String,
    pub name: String,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub proxy: ProxyConfigDTO,
}

impl Default for OpenAIEndpointDTO {
    fn default() -> Self {
        Self {
            id: "default".to_string(),
            name: "OpenAI".to_string(),
            api_key: String::new(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: "gpt-4o-mini".to_string(),
            proxy: ProxyConfigDTO::default(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppConfig {
    /// Provider: "google", "microsoft", or "openai:{endpoint_id}"
    pub provider: String,
    pub source_lang: String,
    pub target_lang: String,
    pub theme: String,
    pub hide_system_window: bool,
    pub always_on_top: bool,
    #[serde(default)]
    pub include_microphone: bool,
    /// Provider for summarization: "openai:{endpoint_id}"
    pub summary_provider: String,
    // Google proxy
    pub google_proxy: ProxyConfigDTO,
    // Microsoft settings
    pub microsoft_api_key: Option<String>,
    pub microsoft_region: Option<String>,
    pub microsoft_proxy: ProxyConfigDTO,
    // Multiple OpenAI endpoints
    pub openai_endpoints: Vec<OpenAIEndpointDTO>,
    /// Window background opacity (0.1 to 1.0)
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    /// Number of previous captions to include as context for OpenAI translation (default: 2)
    #[serde(default = "default_openai_context_count")]
    pub openai_context_count: u32,
}

fn default_opacity() -> f64 {
    1.0
}

fn default_openai_context_count() -> u32 {
    2
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            provider: "google".to_string(),
            source_lang: "en".to_string(),
            target_lang: "zh-CN".to_string(),
            theme: "dark".to_string(),
            hide_system_window: true,
            always_on_top: false,
            include_microphone: false,
            summary_provider: "openai:default".to_string(),
            google_proxy: ProxyConfigDTO::default(),
            microsoft_api_key: None,
            microsoft_region: None,
            microsoft_proxy: ProxyConfigDTO::default(),
            openai_endpoints: vec![OpenAIEndpointDTO::default()],
            opacity: 1.0,
            openai_context_count: 2,
        }
    }
}

static CAPTION_RUNNING: Lazy<Mutex<bool>> = Lazy::new(|| Mutex::new(false));

static APP_CONFIG: Lazy<Mutex<AppConfig>> = Lazy::new(|| Mutex::new(AppConfig::default()));

static TRANSLATION_SERVICE: Lazy<Mutex<Option<TranslationService>>> = Lazy::new(|| Mutex::new(None));

#[tauri::command]
fn get_config() -> AppConfig {
    let mut config = APP_CONFIG.lock().unwrap();
    // Load from file if not yet loaded (first call)
    if let Some(loaded) = load_config_from_file() {
        *config = loaded;
    }
    config.clone()
}

#[tauri::command]
fn save_config(app: AppHandle, config: AppConfig) -> Result<String, String> {
    // Update window always_on_top state
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(config.always_on_top);
    }

    // Update in-memory config
    {
        let mut current = APP_CONFIG.lock().unwrap();
        *current = config.clone();
    }
    
    // Recreate translation service with new config
    {
        let translation_config = config_to_translation_config(&config);
        let mut service = TRANSLATION_SERVICE.lock().unwrap();
        match TranslationService::new(translation_config) {
            Ok(s) => *service = Some(s),
            Err(e) => eprintln!("Warning: Failed to update translation service: {}", e),
        }
    }

    // Persist to file
    if let Err(e) = save_config_to_file(&config) {
        eprintln!("Warning: Failed to persist config: {}", e);
    }

    Ok("Config saved".to_string())
}

#[tauri::command]
fn set_always_on_top(app: AppHandle, always_on_top: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_always_on_top(always_on_top)
            .map_err(|e| e.to_string())?;
        
        {
            let mut config = APP_CONFIG.lock().unwrap();
            config.always_on_top = always_on_top;
            let _ = save_config_to_file(&config);
        }
        
        Ok(())
    } else {
        Err("Main window not found".to_string())
    }
}

fn save_config_to_file(config: &AppConfig) -> anyhow::Result<()> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| anyhow::anyhow!("Could not find config directory"))?
        .join("livecaptions-r");
    std::fs::create_dir_all(&config_dir)?;
    let config_path = config_dir.join("config.json");
    let json = serde_json::to_string_pretty(config)?;
    std::fs::write(config_path, json)?;
    Ok(())
}

fn load_config_from_file() -> Option<AppConfig> {
    let config_path = dirs::config_dir()?.join("livecaptions-r").join("config.json");
    let json = std::fs::read_to_string(config_path).ok()?;
    serde_json::from_str(&json).ok()
}

fn config_to_translation_config(config: &AppConfig) -> TranslationConfig {
    let provider = if config.provider == "google" {
        TranslationProvider::Google
    } else if config.provider == "microsoft" {
        TranslationProvider::Microsoft
    } else if config.provider.starts_with("openai:") {
        let endpoint_id = config.provider.strip_prefix("openai:").unwrap_or("default");
        TranslationProvider::OpenAI(endpoint_id.to_string())
    } else {
        TranslationProvider::Google
    };

    TranslationConfig {
        provider,
        source_lang: config.source_lang.clone(),
        target_lang: config.target_lang.clone(),
        google_proxy: ProxyConfig {
            url: config.google_proxy.url.clone(),
            enabled: config.google_proxy.enabled,
        },
        microsoft_api_key: config.microsoft_api_key.clone(),
        microsoft_region: config.microsoft_region.clone(),
        microsoft_proxy: ProxyConfig {
            url: config.microsoft_proxy.url.clone(),
            enabled: config.microsoft_proxy.enabled,
        },
        openai_endpoints: config.openai_endpoints.iter().map(|e| OpenAIEndpoint {
            id: e.id.clone(),
            name: e.name.clone(),
            api_key: e.api_key.clone(),
            base_url: e.base_url.clone(),
            model: e.model.clone(),
            proxy: ProxyConfig {
                url: e.proxy.url.clone(),
                enabled: e.proxy.enabled,
            },
        }).collect(),
    }
}

/// Translate a single piece of text - called from frontend
/// context: Optional list of previous caption texts for OpenAI context-aware translation
#[tauri::command]
async fn translate_text(text: String, context: Option<Vec<String>>) -> Result<String, String> {
    // Clone service inside a block to release lock immediately
    let svc_clone = {
        let service = TRANSLATION_SERVICE.lock().unwrap();
        match &*service {
            Some(svc) => svc.clone(),
            None => return Err("Translation service not initialized".to_string()),
        }
    };
    
    match svc_clone.translate(&text, context.as_deref()).await {
        Ok(translated) => Ok(translated),
        Err(e) => Err(format!("Translation error: {}", e)),
    }
}

/// Summarize a list of text segments
#[tauri::command]
async fn summarize_text(segments: Vec<String>, provider_id: String) -> Result<String, String> {
    if segments.is_empty() {
        return Ok(String::new());
    }

    let svc_clone = {
        let service = TRANSLATION_SERVICE.lock().unwrap();
        match &*service {
            Some(svc) => svc.clone(),
            None => return Err("Translation service not initialized".to_string()),
        }
    };

    let full_text = segments.join("\n");
    
    match svc_clone.summarize(&full_text, &provider_id).await {
        Ok(summary) => Ok(summary),
        Err(e) => Err(format!("Summarization error: {}", e)),
    }
}

/// Start caption watcher - simplified to only emit raw text
#[tauri::command]
async fn start_caption_watcher(app: AppHandle) -> Result<String, String> {
    use std::time::SystemTime;

    // Load config
    let config = {
        let mut cfg = APP_CONFIG.lock().unwrap();
        if let Some(loaded) = load_config_from_file() {
            *cfg = loaded;
        }
        cfg.clone()
    };

    // Initialize translation service
    {
        let translation_config = config_to_translation_config(&config);
        let mut service = TRANSLATION_SERVICE.lock().unwrap();
        match TranslationService::new(translation_config) {
            Ok(s) => *service = Some(s),
            Err(e) => return Err(format!("Translation init failed: {}", e)),
        }
    }

    // Check if already running
    {
        let mut running = CAPTION_RUNNING.lock().unwrap();
        if *running {
            return Err("Caption watcher already running".to_string());
        }
        *running = true;
    }

    // Launch LiveCaptions automatically
    if let Err(e) = livecaptions::launch_livecaptions(config.hide_system_window) {
        eprintln!("Warning: Failed to launch LiveCaptions: {}", e);
    }

    let app_clone = app.clone();
    let hide_system_window = config.hide_system_window;
    let include_microphone = config.include_microphone;

    std::thread::spawn(move || {
        let mut stream = match livecaptions::CaptionStream::new() {
            Ok(s) => s,
            Err(e) => {
                let _ = app_clone.emit("caption-error", format!("Init failed: {}", e));
                let mut running = CAPTION_RUNNING.lock().unwrap();
                *running = false;
                return;
            }
        };

        match stream.connect(hide_system_window) {
            Ok(msg) => {
                let _ = app_clone.emit("caption-status", msg);
                if include_microphone {
                    if let Err(e) = stream.configure_microphone(include_microphone) {
                        let _ = app_clone.emit("caption-error", format!("Mic config failed: {}", e));
                    }
                }
            }
            Err(e) => {
                let _ = app_clone.emit("caption-error", e.to_string());
                let mut running = CAPTION_RUNNING.lock().unwrap();
                *running = false;
                return;
            }
        }

        let mut last_text = String::new();

        while stream.is_running() {
            {
                let running = CAPTION_RUNNING.lock().unwrap();
                if !*running {
                    stream.stop();
                    break;
                }
            }

            if let Some(text) = stream.get_next_caption() {
                // Skip if text hasn't changed
                if text == last_text {
                    std::thread::sleep(stream.poll_interval());
                    continue;
                }
                last_text = text.clone();

                // Skip error messages
                if text.starts_with("[ERROR]") {
                    let _ = app_clone.emit("caption-error", text);
                    continue;
                }

                let timestamp = SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();

                // Just emit the raw text - frontend handles segmentation
                let caption = RawCaption { text, timestamp };
                let _ = app_clone.emit("caption-raw", caption);
            }

            std::thread::sleep(stream.poll_interval());
        }

        let mut running = CAPTION_RUNNING.lock().unwrap();
        *running = false;
        let _ = app_clone.emit("caption-status", "Stopped");
    });

    Ok("Caption watcher started".to_string())
}

#[tauri::command]
fn stop_caption_watcher() -> Result<String, String> {
    let mut running = CAPTION_RUNNING.lock().unwrap();
    *running = false;
    
    // Close LiveCaptions
    if let Err(e) = livecaptions::close_livecaptions() {
        eprintln!("Warning: Failed to close LiveCaptions: {}", e);
    }
    
    Ok("Stopping caption watcher...".to_string())
}

#[tauri::command]
fn is_watcher_running() -> bool {
    let running = CAPTION_RUNNING.lock().unwrap();
    *running
}


// --- Session Management Commands ---

#[tauri::command]
fn create_session(name: String) -> Result<storage::Session, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    let id = format!("{}", now.as_nanos()); // Use nanos for unique ID
    let created_at = now.as_secs();
    
    let session = storage::Session {
        id,
        name,
        created_at,
        cards: Vec::new(),
    };
    
    storage::save_session(&session).map_err(|e| e.to_string())?;
    Ok(session)
}

#[tauri::command]
fn save_session_data(session: storage::Session) -> Result<(), String> {
    storage::save_session(&session).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_session_data(id: String) -> Result<storage::Session, String> {
    storage::load_session(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_sessions() -> Result<Vec<storage::SessionMetadata>, String> {
    storage::list_sessions().map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_session_data(id: String) -> Result<(), String> {
    storage::delete_session(&id).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize database
    db::init().expect("Failed to initialize database");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            start_caption_watcher,
            stop_caption_watcher,
            is_watcher_running,
            translate_text,
            summarize_text,
            set_always_on_top,
            create_session,
            save_session_data,
            load_session_data,
            get_sessions,
            delete_session_data
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            tauri::RunEvent::Ready => {
                // Restore always_on_top on startup
                if let Some(config) = load_config_from_file() {
                    if config.always_on_top {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.set_always_on_top(true);
                        }
                    }
                }
            }
            tauri::RunEvent::ExitRequested { .. } => {
                // Ensure LiveCaptions is closed on exit
                let mut running = CAPTION_RUNNING.lock().unwrap();
                *running = false;
                let _ = livecaptions::close_livecaptions();
            }
            _ => {}
        });
}
