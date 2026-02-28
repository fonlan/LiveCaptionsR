use serde::{Deserialize, Serialize};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::{debug, error, info};
use uuid::Uuid;

mod db;
mod error;
mod livecaptions;
mod logger;
mod state;
mod storage;
mod teams;
mod translation;

use error::AppError;
use state::AppState;
use teams::TeamsWindowInfo;
use translation::{
    CopilotModel, OpenAIEndpoint, ProxyConfig, TranslationConfig, TranslationProvider,
    TranslationService,
};

// Simple raw caption event - just the text from LiveCaptions
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RawCaption {
    pub text: String,
    pub user: Option<String>,
    pub timestamp: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranslationResultEvent {
    pub request_id: String,
    pub card_id: String,
    pub original_text: String,
    pub translated: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub is_retry: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SummaryStreamEvent {
    pub request_id: String,
    pub status: String, // "chunk" | "done" | "error"
    pub chunk: Option<String>,
    pub full_text: Option<String>,
    pub error: Option<String>,
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIChannelDTO {
    pub id: String,
    #[serde(rename = "type")]
    pub channel_type: String, // "openai" or "copilot"
    pub name: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub token: Option<String>,
    pub proxy: ProxyConfigDTO,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIModelDTO {
    pub id: String,
    pub name: String,
    pub channel_id: String,
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
    // AI Channels and Models
    #[serde(default)]
    pub ai_channels: Vec<AIChannelDTO>,
    #[serde(default)]
    pub ai_models: Vec<AIModelDTO>,
    // Legacy support (optional, can be ignored)
    #[serde(default, skip_serializing)]
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
    /// GitHub Copilot Model
    #[serde(default = "default_copilot_model")]
    pub copilot_model: String,
    /// Log level: "error", "warn", "info", "debug"
    #[serde(default = "default_log_level")]
    pub log_level: String,
}

fn default_language() -> String {
    "en".to_string()
}

fn default_copilot_model() -> String {
    "gpt-4".to_string()
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

fn default_log_level() -> String {
    "info".to_string()
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
            summary_provider: String::new(),
            summary_prompt: None,
            google_proxy: ProxyConfigDTO::default(),
            microsoft_api_key: None,
            microsoft_region: None,
            microsoft_proxy: ProxyConfigDTO::default(),
            ai_channels: vec![],
            ai_models: vec![],
            openai_endpoints: vec![],
            opacity: 1.0,
            openai_context_count: 2,
            language: "en".to_string(),
            translation_enabled: true,
            max_concurrent_translations: 2,
            github_token: None,
            copilot_model: "gpt-4".to_string(),
            log_level: "info".to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub enum CaptionThreadCommand {
    ToggleVisibility,
}

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
}

const GITHUB_CLIENT_ID: &str = "Iv1.b507a08c87ecfe98"; // GitHub CLI Client ID

#[tauri::command]
async fn start_copilot_auth() -> Result<DeviceAuthResponse, AppError> {
    let client = reqwest::Client::new();
    let res = client
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", GITHUB_CLIENT_ID),
            ("scope", "read:user copilot"), // Request copilot scope
        ])
        .send()
        .await?;

    let data: DeviceAuthResponse = res.json().await?;
    Ok(data)
}

#[tauri::command]
async fn poll_copilot_token(device_code: String, interval: u64) -> Result<String, AppError> {
    let client = reqwest::Client::new();
    let interval_duration = std::time::Duration::from_secs(interval.max(5));
    let start_time = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(900); // 15 minutes timeout

    loop {
        if start_time.elapsed() > timeout {
            return Err(AppError::Runtime("Authentication timed out".to_string()));
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
            .await?;

        // Handle raw response to check for errors
        let text = res.text().await?;

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
            return Err(AppError::Runtime("Device code expired".to_string()));
        } else if text.contains("access_denied") {
            return Err(AppError::Runtime("Access denied by user".to_string()));
        } else {
            // Unknown error, return it
            return Err(AppError::Runtime(format!("Auth failed: {}", text)));
        }
    }
}

#[tauri::command]
async fn fetch_copilot_models_command(
    channel_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CopilotModel>, AppError> {
    let svc = get_or_init_translation_service(&state)?;
    svc.fetch_copilot_models_by_channel(&channel_id)
        .await
        .map_err(AppError::Anyhow)
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> AppConfig {
    let mut config = state.config.lock().unwrap();
    // Load from file if not yet loaded (first call)
    if let Some(loaded) = load_config_from_file() {
        *config = loaded;
    }
    config.clone()
}

#[tauri::command]
async fn save_config(
    app: AppHandle,
    config: AppConfig,
    state: State<'_, AppState>,
) -> Result<String, AppError> {
    info!(
        theme = %config.theme,
        provider = %config.provider,
        log_level = %config.log_level,
        "Saving configuration"
    );

    // Update window always_on_top state
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(config.always_on_top);
    }

    // Update in-memory config
    {
        let mut current = state.config.lock().unwrap();
        *current = config.clone();
    }

    // Recreate translation service with new config
    {
        let translation_config = config_to_translation_config(&config);
        let mut service = state.translation_service.lock().unwrap();
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
fn set_always_on_top(
    app: AppHandle,
    always_on_top: bool,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_always_on_top(always_on_top)
            .map_err(|e| AppError::Runtime(e.to_string()))?;

        {
            let mut config = state.config.lock().unwrap();
            config.always_on_top = always_on_top;
            let _ = save_config_to_file(&config);
        }

        Ok(())
    } else {
        Err(AppError::Runtime("Main window not found".to_string()))
    }
}

fn save_config_to_file(config: &AppConfig) -> anyhow::Result<()> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| anyhow::anyhow!("Could not find config directory"))?
        .join("LiveCaptionsR");
    std::fs::create_dir_all(&config_dir)?;
    let config_path = config_dir.join("config.json");
    let json = serde_json::to_string_pretty(config)?;
    std::fs::write(&config_path, json)?;
    debug!(path = %config_path.display(), "Configuration persisted to file");
    Ok(())
}

fn load_config_from_file() -> Option<AppConfig> {
    let config_path = dirs::config_dir()?
        .join("LiveCaptionsR")
        .join("config.json");
    let json = std::fs::read_to_string(&config_path).ok()?;
    let config: AppConfig = serde_json::from_str(&json).ok()?;
    info!(path = %config_path.display(), "Configuration loaded from file");
    Some(config)
}

fn config_to_translation_config(config: &AppConfig) -> TranslationConfig {
    let provider = if config.provider == "google" {
        TranslationProvider::Google
    } else if config.provider == "microsoft" {
        TranslationProvider::Microsoft
    } else if config.provider == "copilot" {
        TranslationProvider::Copilot
    } else if config.provider.starts_with("openai:") {
        let endpoint_id = config.provider.strip_prefix("openai:").unwrap_or("default");
        TranslationProvider::OpenAI(endpoint_id.to_string())
    } else {
        // Check if provider string is a Model ID
        if let Some(model) = config.ai_models.iter().find(|m| m.id == config.provider) {
            if config.ai_channels.iter().any(|c| c.id == model.channel_id) {
                // Both Copilot and OpenAI models use the OpenAI provider variant
                // The translate method will check channel_type to determine which API to use
                TranslationProvider::OpenAI(model.id.clone())
            } else {
                TranslationProvider::Google
            }
        } else {
            TranslationProvider::Google
        }
    };

    // Convert AI Models (OpenAI type) to OpenAIEndpoints
    let openai_endpoints = config
        .ai_models
        .iter()
        .filter_map(|m| {
            let channel = config.ai_channels.iter().find(|c| c.id == m.channel_id)?;
            if channel.channel_type == "openai" {
                Some(OpenAIEndpoint {
                    id: m.id.clone(),
                    name: m.name.clone(), // Use model name as endpoint name for logs
                    api_key: channel.api_key.clone().unwrap_or_default(),
                    base_url: channel.base_url.clone().unwrap_or_default(),
                    model: m.name.clone(),
                    proxy: ProxyConfig {
                        url: channel.proxy.url.clone(),
                        enabled: channel.proxy.enabled,
                    },
                })
            } else {
                None
            }
        })
        .collect();

    // Find Copilot proxy from any Copilot channel (for fetching models, token, etc.)
    let copilot_proxy = config
        .ai_channels
        .iter()
        .find(|c| c.channel_type == "copilot")
        .map(|c| ProxyConfig {
            url: c.proxy.url.clone(),
            enabled: c.proxy.enabled,
        })
        .unwrap_or_default();

    // Convert ai_channels to translation service format
    let ai_channels = config
        .ai_channels
        .iter()
        .map(|c| translation::AIChannel {
            id: c.id.clone(),
            channel_type: c.channel_type.clone(),
            token: c.token.clone(),
            proxy: translation::ProxyConfig {
                url: c.proxy.url.clone(),
                enabled: c.proxy.enabled,
            },
        })
        .collect();

    // Convert ai_models to translation service format
    let ai_models = config
        .ai_models
        .iter()
        .map(|m| translation::AIModel {
            id: m.id.clone(),
            name: m.name.clone(),
            channel_id: m.channel_id.clone(),
        })
        .collect();

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
        openai_endpoints,
        max_concurrent_translations: config.max_concurrent_translations,
        github_token: config.github_token.clone(),
        copilot_model: config.copilot_model.clone(),
        copilot_proxy,
        ai_channels,
        ai_models,
    }
}

fn get_or_init_translation_service(state: &AppState) -> Result<TranslationService, String> {
    // 1. Try to get existing service (fast path)
    {
        let guard = state.translation_service.lock().unwrap();
        if let Some(service) = &*guard {
            return Ok(service.clone());
        }
    }

    // 2. Initialize if missing (slow path)
    let config = {
        let mut cfg = state.config.lock().unwrap();
        // Try to load from file to ensure we have latest persistence
        if let Some(loaded) = load_config_from_file() {
            *cfg = loaded;
        }
        cfg.clone()
    };

    let translation_config = config_to_translation_config(&config);
    let mut guard = state.translation_service.lock().unwrap();

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
async fn translate_text(
    text: String,
    context: Option<Vec<String>>,
    target_lang_override: Option<String>,
    provider_override: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, AppError> {
    let svc = get_or_init_translation_service(&state).map_err(AppError::Runtime)?;

    match svc
        .translate(
            &text,
            context.as_deref(),
            target_lang_override.as_deref(),
            provider_override.as_deref(),
        )
        .await
    {
        Ok(translated) => Ok(translated),
        Err(e) => Err(AppError::Runtime(format!("Translation error: {}", e))),
    }
}

#[tauri::command]
async fn translate_text_async(
    request_id: String,
    card_id: String,
    text: String,
    context: Option<Vec<String>>,
    target_lang_override: Option<String>,
    provider_override: Option<String>,
    is_retry: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let svc = get_or_init_translation_service(&state).map_err(AppError::Runtime)?;

    tokio::spawn(async move {
        let event = match svc
            .translate(
                &text,
                context.as_deref(),
                target_lang_override.as_deref(),
                provider_override.as_deref(),
            )
            .await
        {
            Ok(translated) => TranslationResultEvent {
                request_id,
                card_id,
                original_text: text,
                translated: Some(translated),
                status: "success".to_string(),
                error: None,
                is_retry,
            },
            Err(e) => TranslationResultEvent {
                request_id,
                card_id,
                original_text: text,
                translated: None,
                status: "error".to_string(),
                error: Some(e.to_string()),
                is_retry,
            },
        };

        if let Err(e) = app.emit("translation-result", event) {
            error!("Failed to emit translation-result event: {}", e);
        }
    });

    Ok(())
}

#[tauri::command]
async fn summarize_session_by_id(
    session_id: String,
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<String, AppError> {
    let segments =
        storage::load_session_original_segments(&session_id).map_err(AppError::Anyhow)?;

    if segments.is_empty() {
        return Ok(String::new());
    }

    let svc = get_or_init_translation_service(&state).map_err(AppError::Runtime)?;
    let full_text = segments.join("\n");

    match svc.summarize(&full_text, &provider_id).await {
        Ok(summary) => Ok(summary),
        Err(e) => Err(AppError::Runtime(format!("Summarization error: {}", e))),
    }
}

#[tauri::command]
async fn summarize_session_by_id_stream(
    session_id: String,
    provider_id: String,
    request_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let segments =
        storage::load_session_original_segments(&session_id).map_err(AppError::Anyhow)?;

    if segments.is_empty() {
        app.emit(
            "summary-stream",
            SummaryStreamEvent {
                request_id,
                status: "done".to_string(),
                chunk: None,
                full_text: Some(String::new()),
                error: None,
            },
        )
        .map_err(|e| AppError::Runtime(format!("Failed to emit summary-stream event: {}", e)))?;
        return Ok(());
    }

    let svc = get_or_init_translation_service(&state).map_err(AppError::Runtime)?;
    let full_text = segments.join("\n");
    let app_for_task = app.clone();
    let provider_id_for_task = provider_id.clone();
    let request_id_for_task = request_id.clone();

    tokio::spawn(async move {
        let chunk_request_id = request_id_for_task.clone();
        let result = svc
            .summarize_stream(&full_text, &provider_id_for_task, move |chunk| {
                app_for_task
                    .emit(
                        "summary-stream",
                        SummaryStreamEvent {
                            request_id: chunk_request_id.clone(),
                            status: "chunk".to_string(),
                            chunk: Some(chunk.to_string()),
                            full_text: None,
                            error: None,
                        },
                    )
                    .map_err(|e| anyhow::anyhow!("Failed to emit summary chunk: {}", e))
            })
            .await;

        match result {
            Ok(summary) => {
                let _ = app.emit(
                    "summary-stream",
                    SummaryStreamEvent {
                        request_id,
                        status: "done".to_string(),
                        chunk: None,
                        full_text: Some(summary),
                        error: None,
                    },
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "summary-stream",
                    SummaryStreamEvent {
                        request_id,
                        status: "error".to_string(),
                        chunk: None,
                        full_text: None,
                        error: Some(format!("Summarization error: {}", e)),
                    },
                );
            }
        }
    });

    Ok(())
}

/// Start caption watcher - simplified to only emit raw text
#[tauri::command]
async fn start_caption_watcher(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, AppError> {
    // Load config
    let config = {
        let mut cfg = state.config.lock().unwrap();
        if let Some(loaded) = load_config_from_file() {
            *cfg = loaded;
        }
        cfg.clone()
    };

    info!(
        caption_source = %config.caption_source,
        hide_system_window = config.hide_system_window,
        include_microphone = config.include_microphone,
        "Starting caption watcher"
    );

    // Initialize translation service
    {
        let translation_config = config_to_translation_config(&config);
        let mut service = state.translation_service.lock().unwrap();
        match TranslationService::new(translation_config) {
            Ok(s) => *service = Some(s),
            Err(e) => return Err(AppError::Runtime(format!("Translation init failed: {}", e))),
        }
    }

    // Check if already running
    {
        let mut running = state.caption_running.lock().unwrap();
        if *running {
            return Err(AppError::Runtime(
                "Caption watcher already running".to_string(),
            ));
        }
        *running = true;
    }

    // Create channel for commands
    let (tx, rx) = channel();
    {
        let mut sender = state.caption_command_sender.lock().unwrap();
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
            start_livecaptions_loop(
                app_clone,
                rx,
                hide_system_window,
                include_microphone,
                hwnd_override,
            );
        });
        Ok("LiveCaptions watcher started".to_string())
    }
}

/// LiveCaptions caption polling loop
fn start_livecaptions_loop(
    app: AppHandle,
    rx: Receiver<CaptionThreadCommand>,
    hide_system_window: bool,
    include_microphone: bool,
    hwnd_override: Option<isize>,
) {
    use std::time::SystemTime;

    let mut stream = match livecaptions::CaptionStream::new() {
        Ok(s) => s,
        Err(e) => {
            error!(error = %e, "Failed to initialize LiveCaptions stream");
            let _ = app.emit("caption-error", format!("Init failed: {}", e));
            let state = app.state::<AppState>();
            let mut running = state.caption_running.lock().unwrap();
            *running = false;
            return;
        }
    };

    match stream.connect(hide_system_window, hwnd_override) {
        Ok(msg) => {
            info!("LiveCaptions stream connected successfully");
            let _ = app.emit("caption-status", msg);
            if include_microphone {
                if let Err(e) = stream.configure_microphone(include_microphone) {
                    error!(error = %e, "Failed to configure microphone");
                    let _ = app.emit("caption-error", format!("Mic config failed: {}", e));
                }
            }
        }
        Err(e) => {
            error!(error = %e, "Failed to connect LiveCaptions stream");
            let _ = app.emit("caption-error", e.to_string());
            let state = app.state::<AppState>();
            let mut running = state.caption_running.lock().unwrap();
            *running = false;
            return;
        }
    }

    let mut last_text = String::new();
    let base_interval = stream.poll_interval();
    let max_backoff_interval = Duration::from_millis(250);
    let mut idle_polls: u32 = 0;

    while stream.is_running() {
        {
            let state = app.state::<AppState>();
            let running = state.caption_running.lock().unwrap();
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

        let mut had_activity = false;

        if let Some((user, text)) = stream.get_next_caption() {
            if text == last_text {
                // No effective update, keep backing off progressively
            } else {
                last_text = text.clone();

                if text.starts_with("[ERROR]") {
                    let _ = app.emit("caption-error", text);
                    had_activity = true;
                } else {
                    // Log caption with preview (truncate to 100 chars)
                    let preview = if text.chars().count() > 100 {
                        format!("{}...", text.chars().take(100).collect::<String>())
                    } else {
                        text.clone()
                    };
                    debug!(user = ?user, caption_preview = %preview, "Received LiveCaptions caption");

                    let timestamp = SystemTime::now()
                        .duration_since(SystemTime::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();

                    let caption = RawCaption {
                        text,
                        user,
                        timestamp,
                    };
                    let _ = app.emit("caption-raw", caption);
                    had_activity = true;
                }
            }
        }

        if had_activity {
            idle_polls = 0;
        } else {
            idle_polls = idle_polls.saturating_add(1);
        }

        std::thread::sleep(adaptive_poll_interval(
            base_interval,
            idle_polls,
            max_backoff_interval,
        ));
    }

    let state = app.state::<AppState>();
    let mut running = state.caption_running.lock().unwrap();
    *running = false;
    let _ = app.emit("caption-status", "Stopped");
}

fn adaptive_poll_interval(base: Duration, idle_polls: u32, max_interval: Duration) -> Duration {
    if idle_polls <= 8 {
        return base;
    }

    let step = ((idle_polls - 8) / 15).min(4);
    let factor = 1 + step;
    let scaled = base.checked_mul(factor).unwrap_or(max_interval);

    if scaled > max_interval {
        max_interval
    } else {
        scaled
    }
}

/// Teams caption polling loop
fn start_teams_caption_loop(
    app: AppHandle,
    rx: Receiver<CaptionThreadCommand>,
    selected_hwnd: Option<isize>,
) {
    use std::time::SystemTime;

    let mut stream = match teams::TeamsCaptionStream::new() {
        Ok(s) => s,
        Err(e) => {
            error!(error = %e, "Failed to initialize Teams stream");
            let _ = app.emit("caption-error", format!("Teams init failed: {}", e));
            let state = app.state::<AppState>();
            let mut running = state.caption_running.lock().unwrap();
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
            info!("Teams caption stream connected successfully");
            let _ = app.emit("caption-status", msg);
        }
        Err(e) => {
            error!(error = %e, "Failed to connect Teams stream");
            let _ = app.emit("caption-error", e.to_string());
            let state = app.state::<AppState>();
            let mut running = state.caption_running.lock().unwrap();
            *running = false;
            return;
        }
    }

    let mut last_text = String::new();
    let base_interval = stream.poll_interval();
    let max_backoff_interval = Duration::from_millis(450);
    let mut idle_polls: u32 = 0;

    while stream.is_running() {
        {
            let state = app.state::<AppState>();
            let running = state.caption_running.lock().unwrap();
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

        let mut had_activity = false;

        if let Some((user, text)) = stream.get_next_caption() {
            if text == last_text {
                // No effective update, keep backing off progressively
            } else {
                last_text = text.clone();

                if text.starts_with("[ERROR]") {
                    let _ = app.emit("caption-error", text);
                    had_activity = true;
                } else {
                    // Log caption with preview (truncate to 100 chars)
                    let preview = if text.chars().count() > 100 {
                        format!("{}...", text.chars().take(100).collect::<String>())
                    } else {
                        text.clone()
                    };
                    debug!(user = %user.as_deref().unwrap_or("unknown"), caption_preview = %preview, "Received Teams caption");

                    let timestamp = SystemTime::now()
                        .duration_since(SystemTime::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();

                    let caption = RawCaption {
                        text,
                        user,
                        timestamp,
                    };
                    let _ = app.emit("caption-raw", caption);
                    had_activity = true;
                }
            }
        }

        if had_activity {
            idle_polls = 0;
        } else {
            idle_polls = idle_polls.saturating_add(1);
        }

        std::thread::sleep(adaptive_poll_interval(
            base_interval,
            idle_polls,
            max_backoff_interval,
        ));
    }

    let state = app.state::<AppState>();
    let mut running = state.caption_running.lock().unwrap();
    *running = false;
    let _ = app.emit("caption-status", "Stopped");
}

#[tauri::command]
fn stop_caption_watcher(state: State<'_, AppState>) -> Result<String, AppError> {
    // Get current caption source before stopping
    let caption_source = {
        let config = state.config.lock().unwrap();
        config.caption_source.clone()
    };

    let mut running = state.caption_running.lock().unwrap();
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
fn is_watcher_running(state: State<'_, AppState>) -> bool {
    let running = state.caption_running.lock().unwrap();
    *running
}

// --- Session Management Commands ---

#[tauri::command]
fn create_session(name: String) -> Result<storage::Session, AppError> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    let id = Uuid::new_v4().to_string();
    let created_at = now.as_secs();

    info!(session_id = %id, session_name = %name, "Creating new session");

    let session = storage::Session {
        id,
        name,
        created_at,
        cards: Vec::new(),
    };

    storage::save_session(&session).map_err(AppError::Anyhow)?;
    Ok(session)
}

#[tauri::command]
fn save_session_data(session: storage::Session) -> Result<(), AppError> {
    storage::save_session(&session).map_err(AppError::Anyhow)
}

#[tauri::command]
fn load_session_data(id: String) -> Result<storage::Session, AppError> {
    storage::load_session(&id).map_err(AppError::Anyhow)
}

#[tauri::command]
fn get_sessions() -> Result<Vec<storage::SessionMetadata>, AppError> {
    storage::list_sessions().map_err(AppError::Anyhow)
}

#[tauri::command]
fn delete_session_data(id: String) -> Result<(), AppError> {
    info!(session_id = %id, "Deleting session");
    storage::delete_session(&id).map_err(AppError::Anyhow)
}

#[tauri::command]
fn delete_all_sessions_command() -> Result<(), AppError> {
    storage::delete_all_sessions().map_err(AppError::Anyhow)
}

#[tauri::command]
fn toggle_livecaptions_visibility(state: State<'_, AppState>) -> Result<(), AppError> {
    let sender = state.caption_command_sender.lock().unwrap();
    if let Some(tx) = &*sender {
        tx.send(CaptionThreadCommand::ToggleVisibility)
            .map_err(|e| AppError::Runtime(e.to_string()))?;
        Ok(())
    } else {
        Err(AppError::Runtime("Caption watcher not running".to_string()))
    }
}

/// Get available Teams windows for user selection
#[tauri::command]
fn get_teams_windows() -> Vec<TeamsWindowInfo> {
    teams::find_all_teams_windows()
}

fn duration_to_ms(duration: Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

#[tauri::command]
fn log_startup_metric(
    frontend_init_ms: u64,
    webview_boot_ms: Option<u64>,
    init_source: String,
    config_loaded: bool,
    sessions_loaded: bool,
    watcher_state_loaded: bool,
    app: AppHandle,
) -> Result<(), AppError> {
    let webview_boot_ms_available = webview_boot_ms.is_some();
    let webview_boot_ms = webview_boot_ms.unwrap_or_default();
    info!(
        frontend_init_ms,
        webview_boot_ms,
        webview_boot_ms_available,
        init_source = %init_source,
        config_loaded,
        sessions_loaded,
        watcher_state_loaded,
        "[startup] frontend init completed"
    );

    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.show();
        let _ = main_window.set_focus();
    }

    if let Some(splash_window) = app.get_webview_window("splashscreen") {
        let _ = splash_window.close();
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let native_startup_begin = Instant::now();

    // Install panic hook to catch all panics
    std::panic::set_hook(Box::new(|panic_info| {
        let location = panic_info
            .location()
            .unwrap_or_else(|| panic_info.location().unwrap());
        let msg = panic_info.to_string();
        let backtrace = std::backtrace::Backtrace::capture();

        tracing::error!(
            panic_msg = %msg,
            file = location.file(),
            line = location.line(),
            column = location.column(),
            backtrace = %backtrace,
            "PANIC occurred"
        );

        // Also print to stderr for immediate visibility
        eprintln!("!!! PANIC !!!");
        eprintln!(
            "Location: {}:{}:{}",
            location.file(),
            location.line(),
            location.column()
        );
        eprintln!("Message: {}", msg);
        eprintln!("Backtrace:\n{}", backtrace);
    }));

    let state_init_begin = Instant::now();
    let state = AppState::default();
    let state_init_ms = duration_to_ms(state_init_begin.elapsed());

    let config_load_begin = Instant::now();
    let log_level = {
        let mut config = state.config.lock().unwrap();
        if let Some(loaded) = load_config_from_file() {
            *config = loaded;
        }
        config.log_level.clone()
    };
    let config_load_ms = duration_to_ms(config_load_begin.elapsed());

    let logger_init_begin = Instant::now();
    if let Err(e) = logger::init_logger(&log_level) {
        eprintln!("WARNING: Failed to initialize logger: {}", e);
        eprintln!("Continuing with stderr-only logging");
    }
    let logger_init_ms = duration_to_ms(logger_init_begin.elapsed());

    let build_begin = Instant::now();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            start_caption_watcher,
            stop_caption_watcher,
            is_watcher_running,
            toggle_livecaptions_visibility,
            get_teams_windows,
            translate_text,
            translate_text_async,
            summarize_session_by_id,
            summarize_session_by_id_stream,
            set_always_on_top,
            create_session,
            save_session_data,
            load_session_data,
            get_sessions,
            delete_session_data,
            delete_all_sessions_command,
            start_copilot_auth,
            poll_copilot_token,
            fetch_copilot_models_command,
            log_startup_metric,
            logger::update_log_level_command,
            logger::open_log_directory
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    let build_ms = duration_to_ms(build_begin.elapsed());

    let native_pre_run_ms = duration_to_ms(native_startup_begin.elapsed());
    app.run(move |app_handle, event| match event {
        tauri::RunEvent::Ready => {
            let native_startup_ms = duration_to_ms(native_startup_begin.elapsed());
            info!(
                native_startup_ms,
                native_pre_run_ms,
                state_init_ms,
                config_load_ms,
                logger_init_ms,
                build_ms,
                db_init_mode = "lazy_on_first_use",
                "[startup] native ready"
            );

            #[cfg(any(windows, target_os = "macos"))]
            if let Some(splash_window) = app_handle.get_webview_window("splashscreen") {
                let _ = splash_window.set_shadow(false);
            }

            // Fail-safe: if frontend never reports startup completion, do not keep splash forever.
            let app_handle_for_fallback = app_handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(10));
                if let Some(splash_window) =
                    app_handle_for_fallback.get_webview_window("splashscreen")
                {
                    let _ = splash_window.close();
                    if let Some(main_window) = app_handle_for_fallback.get_webview_window("main") {
                        let _ = main_window.show();
                        let _ = main_window.set_focus();
                    }
                    info!(
                        fallback_timeout_ms = 10_000_u64,
                        "[startup] splash fallback triggered"
                    );
                }
            });

            // Restore always_on_top on startup
            // Access state to get config
            let state = app_handle.state::<AppState>();
            let config = state.config.lock().unwrap();
            if config.always_on_top {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.set_always_on_top(true);
                }
            }
        }
        tauri::RunEvent::ExitRequested { .. } => {
            // Ensure LiveCaptions is closed on exit
            let state = app_handle.state::<AppState>();
            let mut running = state.caption_running.lock().unwrap();
            *running = false;
            let _ = livecaptions::close_livecaptions();
        }
        _ => {}
    });
}
