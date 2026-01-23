use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::sync::mpsc::{channel, Sender};
use tauri::{AppHandle, Emitter, Manager};

mod livecaptions;
mod teams;
mod storage;
mod translation;
mod db;

use teams::TeamsWindowInfo;

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
    /// Caption source: "livecaptions" or "teams"
    #[serde(default = "default_caption_source")]
    pub caption_source: String,
    /// Selected Teams window handle (when using teams caption source)
    #[serde(default)]
    pub selected_teams_hwnd: Option<isize>,
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
    /// Custom system prompt for summarization
    pub summary_prompt: Option<String>,
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
    /// UI Language (en, zh-CN)
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default = "default_translation_enabled")]
    pub translation_enabled: bool,
    /// Maximum concurrent translation requests (default: 2)
    #[serde(default = "default_max_concurrent_translations")]
    pub max_concurrent_translations: u32,
    /// GitHub OAuth Token for Copilot
    pub github_token: Option<String>,
}

fn default_language() -> String {
    "en".to_string()
}

fn default_caption_source() -> String {
    "livecaptions".to_string()
}

fn default_translation_enabled() -> bool {
    true
}

fn default_max_concurrent_translations() -> u32 {
    2
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
            caption_source: "livecaptions".to_string(),
            selected_teams_hwnd: None,
            provider: "google".to_string(),
            source_lang: "en".to_string(),
            target_lang: "zh-CN".to_string(),
            theme: "dark".to_string(),
            hide_system_window: true,
            always_on_top: false,
            include_microphone: false,
            summary_provider: "openai:default".to_string(),
            summary_prompt: None,
            google_proxy: ProxyConfigDTO::default(),
            microsoft_api_key: None,
            microsoft_region: None,
            microsoft_proxy: ProxyConfigDTO::default(),
            openai_endpoints: vec![OpenAIEndpointDTO::default()],
            opacity: 1.0,
            openai_context_count: 2,
            language: "en".to_string(),
            translation_enabled: true,
            max_concurrent_translations: 2,
            github_token: None,
        }
    }
}

static CAPTION_RUNNING: Lazy<Mutex<bool>> = Lazy::new(|| Mutex::new(false));

static APP_CONFIG: Lazy<Mutex<AppConfig>> = Lazy::new(|| Mutex::new(AppConfig::default()));

static TRANSLATION_SERVICE: Lazy<Mutex<Option<TranslationService>>> = Lazy::new(|| Mutex::new(None));

enum CaptionThreadCommand {
    ToggleVisibility,
}

static CAPTION_COMMAND_SENDER: Lazy<Mutex<Option<Sender<CaptionThreadCommand>>>> = Lazy::new(|| Mutex::new(None));

#[derive(Debug, Serialize, Deserialize)]
struct DeviceAuthResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    scope: String,
}

const GITHUB_CLIENT_ID: &str = "Iv1.b507a08c87ecfe98"; // GitHub CLI Client ID

#[tauri::command]
async fn start_copilot_auth() -> Result<DeviceAuthResponse, String> {
    let client = reqwest::Client::new();
    let res = client
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", GITHUB_CLIENT_ID),
            ("scope", "read:user copilot"), // Request copilot scope
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let data: DeviceAuthResponse = res.json().await.map_err(|e| e.to_string())?;
    Ok(data)
}

#[tauri::command]
async fn poll_copilot_token(device_code: String, interval: u64) -> Result<String, String> {
    let client = reqwest::Client::new();
    let interval_duration = std::time::Duration::from_secs(interval.max(5));
    let start_time = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(900); // 15 minutes timeout

    loop {
        if start_time.elapsed() > timeout {
            return Err("Authentication timed out".to_string());
        }

        tokio::time::sleep(interval_duration).await;

        let res = client
            .post("https://github.com/login/oauth/access_token")
            .header("Accept", "application/json")
            .form(&[
                ("client_id", GITHUB_CLIENT_ID),
                ("device_code", &device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await
            .map_err(|e| e.to_string())?;
        
        // Handle raw response to check for errors
        let text = res.text().await.map_err(|e| e.to_string())?;
        
        // Try parsing success
        if let Ok(token_res) = serde_json::from_str::<TokenResponse>(&text) {
            return Ok(token_res.access_token);
        }

        // Check for specific errors
        if text.contains("authorization_pending") {
            continue;
        } else if text.contains("slow_down") {
             tokio::time::sleep(std::time::Duration::from_secs(5)).await;
             continue;
        } else if text.contains("expired_token") {
            return Err("Device code expired".to_string());
        } else if text.contains("access_denied") {
            return Err("Access denied by user".to_string());
        } else {
             // Unknown error, return it
             return Err(format!("Auth failed: {}", text));
        }
    }
}

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
        .join("LiveCaptionsR");
    std::fs::create_dir_all(&config_dir)?;
    let config_path = config_dir.join("config.json");
    let json = serde_json::to_string_pretty(config)?;
    std::fs::write(config_path, json)?;
    Ok(())
}

fn load_config_from_file() -> Option<AppConfig> {
    let config_path = dirs::config_dir()?.join("LiveCaptionsR").join("config.json");
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
        summary_prompt: config.summary_prompt.clone(),
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
        max_concurrent_translations: config.max_concurrent_translations,
        github_token: config.github_token.clone(),
    }
}

fn get_or_init_translation_service() -> Result<TranslationService, String> {
    // 1. Try to get existing service (fast path)
    {
        let guard = TRANSLATION_SERVICE.lock().unwrap();
        if let Some(service) = &*guard {
            return Ok(service.clone());
        }
    }

    // 2. Initialize if missing (slow path)
    let config = {
        let mut cfg = APP_CONFIG.lock().unwrap();
        // Try to load from file to ensure we have latest persistence
        if let Some(loaded) = load_config_from_file() {
            *cfg = loaded;
        }
        cfg.clone()
    };

    let translation_config = config_to_translation_config(&config);
    let mut guard = TRANSLATION_SERVICE.lock().unwrap();
    
    // Double-check in case another thread initialized it while we were getting config
    if let Some(service) = &*guard {
        return Ok(service.clone());
    }

    match TranslationService::new(translation_config) {
        Ok(service) => {
            *guard = Some(service.clone());
            Ok(service)
        }
        Err(e) => Err(format!("Failed to initialize translation service: {}", e)),
    }
}

/// Translate a single piece of text - called from frontend
/// context: Optional list of previous caption texts for OpenAI context-aware translation
#[tauri::command]
async fn translate_text(text: String, context: Option<Vec<String>>, target_lang_override: Option<String>, provider_override: Option<String>) -> Result<String, String> {
    let svc = get_or_init_translation_service()?;
    
    match svc.translate(&text, context.as_deref(), target_lang_override.as_deref(), provider_override.as_deref()).await {
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

    let svc = get_or_init_translation_service()?;

    let full_text = segments.join("\n");
    
    match svc.summarize(&full_text, &provider_id).await {
        Ok(summary) => Ok(summary),
        Err(e) => Err(format!("Summarization error: {}", e)),
    }
}

/// Start caption watcher - simplified to only emit raw text
#[tauri::command]
async fn start_caption_watcher(app: AppHandle) -> Result<String, String> {
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

    // Create channel for commands
    let (tx, rx) = channel();
    {
        let mut sender = CAPTION_COMMAND_SENDER.lock().unwrap();
        *sender = Some(tx);
    }

    let caption_source = config.caption_source.clone();
    let app_clone = app.clone();
    let hide_system_window = config.hide_system_window;
    let include_microphone = config.include_microphone;
    let selected_teams_hwnd = config.selected_teams_hwnd;

    // Branch based on caption source
    if caption_source == "teams" {
        // Teams caption source
        std::thread::spawn(move || {
            start_teams_caption_loop(app_clone, rx, selected_teams_hwnd);
        });
        Ok("Teams caption watcher started".to_string())
    } else {
        // LiveCaptions source (default)
        // Launch LiveCaptions automatically
        let launch_result = livecaptions::launch_livecaptions(hide_system_window);
        let hwnd_override = match launch_result {
            Ok(hwnd) => Some(hwnd),
            Err(e) => {
                eprintln!("Warning: Failed to launch LiveCaptions: {}", e);
                None
            }
        };

        std::thread::spawn(move || {
            start_livecaptions_loop(app_clone, rx, hide_system_window, include_microphone, hwnd_override);
        });
        Ok("LiveCaptions watcher started".to_string())
    }
}

/// LiveCaptions caption polling loop
fn start_livecaptions_loop(
    app: AppHandle,
    rx: std::sync::mpsc::Receiver<CaptionThreadCommand>,
    hide_system_window: bool,
    include_microphone: bool,
    hwnd_override: Option<isize>,
) {
    use std::time::SystemTime;

    let mut stream = match livecaptions::CaptionStream::new() {
        Ok(s) => s,
        Err(e) => {
            let _ = app.emit("caption-error", format!("Init failed: {}", e));
            let mut running = CAPTION_RUNNING.lock().unwrap();
            *running = false;
            return;
        }
    };

    match stream.connect(hide_system_window, hwnd_override) {
        Ok(msg) => {
            let _ = app.emit("caption-status", msg);
            if include_microphone {
                if let Err(e) = stream.configure_microphone(include_microphone) {
                    let _ = app.emit("caption-error", format!("Mic config failed: {}", e));
                }
            }
        }
        Err(e) => {
            let _ = app.emit("caption-error", e.to_string());
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

        // Check for commands
        if let Ok(cmd) = rx.try_recv() {
            match cmd {
                CaptionThreadCommand::ToggleVisibility => {
                    let visible = stream.toggle_visibility();
                    let _ = app.emit("caption-visibility", visible);
                }
            }
        }

        if let Some(text) = stream.get_next_caption() {
            if text == last_text {
                std::thread::sleep(stream.poll_interval());
                continue;
            }
            last_text = text.clone();

            if text.starts_with("[ERROR]") {
                let _ = app.emit("caption-error", text);
                continue;
            }

            let timestamp = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();

            let caption = RawCaption { text, timestamp };
            let _ = app.emit("caption-raw", caption);
        }

        std::thread::sleep(stream.poll_interval());
    }

    let mut running = CAPTION_RUNNING.lock().unwrap();
    *running = false;
    let _ = app.emit("caption-status", "Stopped");
}

/// Teams caption polling loop
fn start_teams_caption_loop(
    app: AppHandle,
    rx: std::sync::mpsc::Receiver<CaptionThreadCommand>,
    selected_hwnd: Option<isize>,
) {
    use std::time::SystemTime;

    let mut stream = match teams::TeamsCaptionStream::new() {
        Ok(s) => s,
        Err(e) => {
            let _ = app.emit("caption-error", format!("Teams init failed: {}", e));
            let mut running = CAPTION_RUNNING.lock().unwrap();
            *running = false;
            return;
        }
    };

    // Set specific window if provided
    if let Some(hwnd) = selected_hwnd {
        stream.set_window(hwnd);
    }

    match stream.connect() {
        Ok(msg) => {
            let _ = app.emit("caption-status", msg);
        }
        Err(e) => {
            let _ = app.emit("caption-error", e.to_string());
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

        // Check for commands (Teams doesn't support toggle visibility)
        if let Ok(cmd) = rx.try_recv() {
            match cmd {
                CaptionThreadCommand::ToggleVisibility => {
                    // Teams window visibility is not controlled by us
                    // Just ignore this command
                    eprintln!("Toggle visibility not supported for Teams");
                }
            }
        }

        if let Some(text) = stream.get_next_caption() {
            if text == last_text {
                std::thread::sleep(stream.poll_interval());
                continue;
            }
            last_text = text.clone();

            if text.starts_with("[ERROR]") {
                let _ = app.emit("caption-error", text);
                continue;
            }

            let timestamp = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();

            let caption = RawCaption { text, timestamp };
            let _ = app.emit("caption-raw", caption);
        }

        std::thread::sleep(stream.poll_interval());
    }

    let mut running = CAPTION_RUNNING.lock().unwrap();
    *running = false;
    let _ = app.emit("caption-status", "Stopped");
}

#[tauri::command]
fn stop_caption_watcher() -> Result<String, String> {
    // Get current caption source before stopping
    let caption_source = {
        let config = APP_CONFIG.lock().unwrap();
        config.caption_source.clone()
    };
    
    let mut running = CAPTION_RUNNING.lock().unwrap();
    *running = false;
    
    // Only close LiveCaptions if that was the source
    if caption_source != "teams" {
        if let Err(e) = livecaptions::close_livecaptions() {
            eprintln!("Warning: Failed to close LiveCaptions: {}", e);
        }
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

#[tauri::command]
fn toggle_livecaptions_visibility() -> Result<(), String> {
    let sender = CAPTION_COMMAND_SENDER.lock().unwrap();
    if let Some(tx) = &*sender {
        tx.send(CaptionThreadCommand::ToggleVisibility).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Caption watcher not running".to_string())
    }
}

/// Get available Teams windows for user selection
#[tauri::command]
fn get_teams_windows() -> Vec<TeamsWindowInfo> {
    teams::find_all_teams_windows()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize database
    db::init().expect("Failed to initialize database");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            start_caption_watcher,
            stop_caption_watcher,
            is_watcher_running,
            toggle_livecaptions_visibility,
            get_teams_windows,
            translate_text,
            summarize_text,
            set_always_on_top,
            create_session,
            save_session_data,
            load_session_data,
            get_sessions,
            delete_session_data,
            start_copilot_auth,
            poll_copilot_token
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
