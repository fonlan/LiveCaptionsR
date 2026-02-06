#![cfg(windows)]

use anyhow::{Context, Result};
use reqwest::{Client, Proxy};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use tokio::sync::Semaphore;
use tracing::{debug, error, info};

/// Proxy configuration for translation services
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProxyConfig {
    /// Proxy URL (e.g., "http://127.0.0.1:7890" or "socks5://127.0.0.1:1080")
    pub url: Option<String>,
    /// Whether proxy is enabled
    pub enabled: bool,
}

impl ProxyConfig {
    pub fn is_active(&self) -> bool {
        self.enabled && self.url.as_ref().map(|u| !u.trim().is_empty()).unwrap_or(false)
    }
}

/// OpenAI-compatible endpoint configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIEndpoint {
    /// Unique identifier for this endpoint
    pub id: String,
    /// Display name for UI
    pub name: String,
    /// API key
    pub api_key: String,
    /// Base URL (e.g., "https://api.openai.com/v1")
    pub base_url: String,
    /// Model name
    pub model: String,
    /// Proxy configuration for this endpoint
    pub proxy: ProxyConfig,
}

impl Default for OpenAIEndpoint {
    fn default() -> Self {
        Self {
            id: "default".to_string(),
            name: "OpenAI".to_string(),
            api_key: String::new(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: "gpt-4o-mini".to_string(),
            proxy: ProxyConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TranslationProvider {
    Google,
    Microsoft,
    OpenAI(String), // Contains the endpoint ID
    Copilot,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CopilotModel {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationConfig {
    pub provider: TranslationProvider,
    pub source_lang: String,
    pub target_lang: String,
    pub summary_prompt: Option<String>,
    // Google Translate proxy
    pub google_proxy: ProxyConfig,
    // Microsoft Translator
    pub microsoft_api_key: Option<String>,
    pub microsoft_region: Option<String>,
    pub microsoft_proxy: ProxyConfig,
    // Multiple OpenAI-compatible endpoints
    pub openai_endpoints: Vec<OpenAIEndpoint>,
    /// Maximum concurrent translation requests
    pub max_concurrent_translations: u32,
    /// GitHub OAuth Token for Copilot (legacy, for backward compatibility)
    pub github_token: Option<String>,
    /// GitHub Copilot Model
    pub copilot_model: String,
    /// Copilot proxy configuration
    pub copilot_proxy: ProxyConfig,
    /// AI channels for Copilot token lookup
    pub ai_channels: Vec<AIChannel>,
    /// AI models for model type lookup
    pub ai_models: Vec<AIModel>,
}

/// AI Channel for Copilot/OpenAI credentials
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIChannel {
    pub id: String,
    #[serde(rename = "type")]
    pub channel_type: String,
    pub token: Option<String>,
    pub proxy: ProxyConfig,
}

/// AI Model mapping
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIModel {
    pub id: String,
    pub name: String,
    pub channel_id: String,
}

impl Default for TranslationConfig {
    fn default() -> Self {
        Self {
            provider: TranslationProvider::Google,
            source_lang: "en".to_string(),
            target_lang: "zh-CN".to_string(),
            summary_prompt: None,
            google_proxy: ProxyConfig::default(),
            microsoft_api_key: None,
            microsoft_region: None,
            microsoft_proxy: ProxyConfig::default(),
            openai_endpoints: vec![OpenAIEndpoint::default()],
            max_concurrent_translations: 2,
            github_token: None,
            copilot_model: "gpt-4".to_string(),
            copilot_proxy: ProxyConfig::default(),
            ai_channels: vec![],
            ai_models: vec![],
        }
    }
}

/// Build HTTP client with optional proxy
fn build_client(proxy_config: &ProxyConfig) -> Result<Client> {
    let mut builder = Client::builder()
        .timeout(std::time::Duration::from_secs(30));
    
    if proxy_config.is_active() {
        if let Some(ref url) = proxy_config.url {
            let proxy = Proxy::all(url)
                .context(format!("Invalid proxy URL: {}", url))?;
            builder = builder.proxy(proxy);
        }
    }
    
    builder.build().context("Failed to create HTTP client")
}

#[derive(Clone)]
pub struct TranslationService {
    config: TranslationConfig,
    semaphore: Arc<Semaphore>,
    // Map PersistentToken -> (ShortLivedToken, Expiry)
    copilot_tokens: Arc<Mutex<HashMap<String, (String, u64)>>>,
}

impl TranslationService {
    pub fn new(config: TranslationConfig) -> Result<Self> {
        let max_permits = if config.max_concurrent_translations > 0 {
            config.max_concurrent_translations as usize
        } else {
            2 // Safety fallback
        };

        info!(
            provider = ?config.provider,
            max_concurrent = config.max_concurrent_translations,
            "Translation service initialized"
        );

        Ok(Self {
            config,
            semaphore: Arc::new(Semaphore::new(max_permits)),
            copilot_tokens: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    #[allow(dead_code)]
    pub fn update_config(&mut self, config: TranslationConfig) {
        self.config = config;
    }

    pub fn parse_provider(provider_str: &str) -> TranslationProvider {
        if provider_str == "google" {
            TranslationProvider::Google
        } else if provider_str == "microsoft" {
            TranslationProvider::Microsoft
        } else if provider_str.starts_with("openai:") {
            let endpoint_id = provider_str.strip_prefix("openai:").unwrap_or("default");
            TranslationProvider::OpenAI(endpoint_id.to_string())
        } else if provider_str == "copilot" {
            TranslationProvider::Copilot
        } else {
            // Treat as OpenAI model ID by default (for new ai_models architecture)
            TranslationProvider::OpenAI(provider_str.to_string())
        }
    }

    pub async fn translate(&self, text: &str, context: Option<&[String]>, target_lang_override: Option<&str>, provider_override: Option<&str>) -> Result<String> {
        if text.trim().is_empty() {
            return Ok(String::new());
        }

        // Acquire permit to limit concurrency
        let _permit = self.semaphore.acquire().await.context("Failed to acquire translation permit")?;

        let target_lang = target_lang_override.unwrap_or(&self.config.target_lang);

        let provider = if let Some(p_str) = provider_override {
            Self::parse_provider(p_str)
        } else {
            self.config.provider.clone()
        };

        match &provider {
            TranslationProvider::Google => {
                debug!(
                    provider = "google",
                    text_len = text.len(),
                    source_lang = %self.config.source_lang,
                    target_lang = %target_lang,
                    "Starting translation"
                );
                let result = self.translate_google(text, target_lang).await;
                match &result {
                    Ok(translated) => debug!(
                        provider = "google",
                        result_len = translated.len(),
                        "Translation completed successfully"
                    ),
                    Err(e) => error!(
                        provider = "google",
                        error = %e,
                        "Translation failed"
                    ),
                }
                result
            }
            TranslationProvider::Microsoft => {
                debug!(
                    provider = "microsoft",
                    text_len = text.len(),
                    source_lang = %self.config.source_lang,
                    target_lang = %target_lang,
                    "Starting translation"
                );
                let result = self.translate_microsoft(text, target_lang).await;
                match &result {
                    Ok(translated) => debug!(
                        provider = "microsoft",
                        result_len = translated.len(),
                        "Translation completed successfully"
                    ),
                    Err(e) => error!(
                        provider = "microsoft",
                        error = %e,
                        "Translation failed"
                    ),
                }
                result
            }
            TranslationProvider::OpenAI(endpoint_id) => {
                debug!(
                    provider = "openai",
                    endpoint_id = %endpoint_id,
                    text_len = text.len(),
                    target_lang = %target_lang,
                    "Starting translation"
                );
                // Check if this is a Copilot model ID by looking up in ai_models
                if let Some(model) = self.config.ai_models.iter().find(|m| m.id == *endpoint_id) {
                    if let Some(channel) = self.config.ai_channels.iter().find(|c| c.id == model.channel_id && c.channel_type == "copilot") {
                        let result = self.translate_copilot(text, context, target_lang, channel.token.as_deref(), Some(&model.name)).await;
                        match &result {
                            Ok(translated) => debug!(
                                provider = "copilot",
                                model = %model.name,
                                result_len = translated.len(),
                                "Translation completed successfully"
                            ),
                            Err(e) => error!(
                                provider = "copilot",
                                model = %model.name,
                                error = %e,
                                "Translation failed"
                            ),
                        }
                        return result;
                    }
                }
                let result = self.translate_openai(text, endpoint_id, context, target_lang).await;
                match &result {
                    Ok(translated) => debug!(
                        provider = "openai",
                        endpoint_id = %endpoint_id,
                        result_len = translated.len(),
                        "Translation completed successfully"
                    ),
                    Err(e) => error!(
                        provider = "openai",
                        endpoint_id = %endpoint_id,
                        error = %e,
                        "Translation failed"
                    ),
                }
                result
            }
            TranslationProvider::Copilot => {
                debug!(
                    provider = "copilot",
                    text_len = text.len(),
                    target_lang = %target_lang,
                    "Starting translation"
                );
                let result = self.translate_copilot(text, context, target_lang, None, None).await;
                match &result {
                    Ok(translated) => debug!(
                        provider = "copilot",
                        result_len = translated.len(),
                        "Translation completed successfully"
                    ),
                    Err(e) => error!(
                        provider = "copilot",
                        error = %e,
                        "Translation failed"
                    ),
                }
                result
            }
        }
    }

    fn get_lang_name(code: &str) -> String {
        match code {
            "en" => "English".to_string(),
            "zh-CN" => "Simplified Chinese".to_string(),
            "zh-TW" => "Traditional Chinese".to_string(),
            "ja" => "Japanese".to_string(),
            "ko" => "Korean".to_string(),
            "es" => "Spanish".to_string(),
            "fr" => "French".to_string(),
            "de" => "German".to_string(),
            "it" => "Italian".to_string(),
            "pt" => "Portuguese".to_string(),
            "ru" => "Russian".to_string(),
            "vi" => "Vietnamese".to_string(),
            "th" => "Thai".to_string(),
            "id" => "Indonesian".to_string(),
            "hi" => "Hindi".to_string(),
            _ => code.to_string(),
        }
    }

    async fn translate_google(&self, text: &str, target_lang: &str) -> Result<String> {
        let client = build_client(&self.config.google_proxy)?;

        let url = format!(
            "https://translate.googleapis.com/translate_a/single?client=gtx&sl={}&tl={}&dt=t&q={}",
            self.config.source_lang,
            target_lang,
            urlencoding::encode(text)
        );

        debug!(
            method = "GET",
            url = %url,
            text_preview = %text.chars().take(100).collect::<String>(),
            "Sending Google Translate request"
        );

        let start = std::time::Instant::now();
        let response = client
            .get(&url)
            .header("User-Agent", "Mozilla/5.0")
            .send()
            .await
            .context("Failed to send request to Google Translate")?;

        let status = response.status();
        debug!(
            status = %status,
            duration_ms = %start.elapsed().as_millis(),
            "Received Google Translate response"
        );

        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
            error!(
                status = %status,
                error_body = %error_text,
                "Google Translate API error"
            );
            return Err(anyhow::anyhow!("Translation failed: {} - {}", status, error_text));
        }

        let body = response.text().await.context("Failed to read response body")?;

        debug!(
            response_body_preview = %body.chars().take(200).collect::<String>(),
            "Google Translate response body"
        );

        let json: serde_json::Value = serde_json::from_str(&body)
            .context("Failed to parse Google Translate response")?;

        let mut result = String::new();
        if let Some(sentences) = json.get(0).and_then(|v| v.as_array()) {
            for sentence in sentences {
                if let Some(translated) = sentence.get(0).and_then(|v| v.as_str()) {
                    result.push_str(translated);
                }
            }
        }

        if result.is_empty() {
            anyhow::bail!("Empty response from Google Translate");
        }

        Ok(result)
    }

    async fn translate_microsoft(&self, text: &str, target_lang: &str) -> Result<String> {
        let client = build_client(&self.config.microsoft_proxy)?;

        let api_key = self
            .config
            .microsoft_api_key
            .as_ref()
            .context("Microsoft API key not configured")?;
        let region = self
            .config
            .microsoft_region
            .as_ref()
            .map(|s| s.as_str())
            .unwrap_or("global");

        let url = if self.config.source_lang == "auto" {
            format!(
                "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to={}",
                target_lang
            )
        } else {
            format!(
                "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from={}&to={}",
                self.config.source_lang, target_lang
            )
        };

        // Sanitize API key for logging (show only first 4 chars)
        let api_key_preview = if api_key.chars().count() >= 4 {
            format!("{}...", api_key.chars().take(4).collect::<String>())
        } else {
            "***".to_string()
        };

        #[derive(Serialize)]
        struct RequestBody {
            #[serde(rename = "Text")]
            text: String,
        }

        #[derive(Deserialize)]
        struct TranslationResult {
            translations: Vec<Translation>,
        }

        #[derive(Deserialize)]
        struct Translation {
            text: String,
        }

        let body = vec![RequestBody {
            text: text.to_string(),
        }];

        debug!(
            method = "POST",
            url = %url,
            api_key = %api_key_preview,
            region = %region,
            text_preview = %text.chars().take(100).collect::<String>(),
            "Sending Microsoft Translator request"
        );

        let start = std::time::Instant::now();
        let response = client
            .post(&url)
            .header("Ocp-Apim-Subscription-Key", api_key)
            .header("Ocp-Apim-Subscription-Region", region)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .context("Failed to send request to Microsoft Translator")?;

        let status = response.status();
        debug!(
            status = %status,
            duration_ms = %start.elapsed().as_millis(),
            "Received Microsoft Translator response"
        );

        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
            error!(
                status = %status,
                error_body = %error_text,
                "Microsoft Translator API error"
            );
            return Err(anyhow::anyhow!("Translation failed: {} - {}", status, error_text));
        }

        let response_text = response.text().await.context("Failed to read response body")?;

        debug!(
            response_body_preview = %response_text.chars().take(200).collect::<String>(),
            "Microsoft Translator response body"
        );

        let results: Vec<TranslationResult> = serde_json::from_str(&response_text)
            .context("Failed to parse Microsoft Translator response")?;

        results
            .first()
            .and_then(|r| r.translations.first())
            .map(|t| t.text.clone())
            .context("Empty response from Microsoft Translator")
    }

    async fn get_copilot_token(&self, github_token: &str) -> Result<String> {
        // Check cache
        {
            let guard = self.copilot_tokens.lock().unwrap();
            if let Some((token, expiry)) = guard.get(github_token) {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs();
                if now < *expiry {
                    debug!("Using cached Copilot token (expires in {}s)", expiry - now);
                    return Ok(token.clone());
                }
            }
        }

        // Fetch new token using proxy if configured
        debug!("Fetching new Copilot token from GitHub");
        let client = build_client(&self.config.copilot_proxy)?;
        let start = std::time::Instant::now();
        let res = client
            .get("https://api.github.com/copilot_internal/v2/token")
            .header("Authorization", format!("token {}", github_token))
            .header("User-Agent", "GitHubCopilot/1.155.0")
            .header("Accept", "application/json")
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| {
                if self.config.copilot_proxy.is_active() {
                    let err = anyhow::anyhow!("Network request failed via proxy {}: {} (URL: https://api.github.com/copilot_internal/v2/token)", self.config.copilot_proxy.url.as_ref().unwrap_or(&"?".to_string()), e);
                    error!("{}", err);
                    err
                } else {
                    let err = anyhow::anyhow!("Network request failed (no proxy): {} (URL: https://api.github.com/copilot_internal/v2/token)", e);
                    error!("{}", err);
                    err
                }
            })?;

        let status = res.status();
        debug!(
            status = %status,
            duration_ms = %start.elapsed().as_millis(),
            "Received Copilot token response"
        );

        if !status.is_success() {
            let text = res.text().await.unwrap_or_default();
            error!(
                status = %status,
                error_body = %text,
                "Failed to get Copilot token"
            );
            anyhow::bail!("Copilot token error {}: {}", status, text);
        }

        #[derive(Deserialize)]
        struct CopilotTokenRes {
            token: String,
            expires_at: u64,
        }

        let token_data: CopilotTokenRes = res.json().await.context("Failed to parse Copilot token")?;

        // Update cache
        {
            let mut guard = self.copilot_tokens.lock().unwrap();
            guard.insert(github_token.to_string(), (token_data.token.clone(), token_data.expires_at - 60)); // Buffer 60s
        }

        debug!("Successfully obtained new Copilot token");
        Ok(token_data.token)
    }

    async fn send_copilot_request(&self, system_prompt: &str, user_content: &str, github_token: &str, model_override: Option<&str>) -> Result<String> {
        let token = self.get_copilot_token(github_token).await?;

        let client = build_client(&self.config.copilot_proxy)?;
        let url = "https://api.githubcopilot.com/chat/completions";

        let model = model_override.unwrap_or(&self.config.copilot_model);
        let request = ChatRequest {
            model: model.to_string(),
            messages: vec![
                ChatMessage { role: "system".to_string(), content: system_prompt.to_string() },
                ChatMessage { role: "user".to_string(), content: user_content.to_string() },
            ],
            temperature: 0.1,
        };

        // Log request details at DEBUG level
        debug!(
            method = "POST",
            url = %url,
            model = %model,
            message_count = request.messages.len(),
            "Sending Copilot API request"
        );

        let start = std::time::Instant::now();
        let response = client
            .post(url)
            .header("Authorization", format!("Bearer {}", token))
            .header("User-Agent", "GitHubCopilot/1.155.0")
            .header("Editor-Version", "vscode/1.85.0")
            .header("Copilot-Integration-Id", "vscode-chat")
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .context("Failed to send request to Copilot")?;

        let status = response.status();
        debug!(
            status = %status,
            duration_ms = %start.elapsed().as_millis(),
            "Received Copilot API response"
        );

        if !status.is_success() {
             let text = response.text().await.unwrap_or_default();
             error!(
                 status = %status,
                 error_body = %text,
                 "Copilot API error"
             );
             anyhow::bail!("Copilot API error {}: {}", status, text);
        }

        let result: ChatResponse = response
            .json()
            .await
            .context("Failed to parse Copilot response")?;

        result
            .choices
            .first()
            .map(|c| Self::clean_thinking_content(&c.message.content))
            .context("Empty response from Copilot")
    }

    pub async fn fetch_copilot_models(&self, github_token: &str) -> Result<Vec<CopilotModel>> {
        debug!("Fetching Copilot models list");

        let token = self.get_copilot_token(github_token).await
            .map_err(|e| anyhow::anyhow!("Failed to get Copilot token: {}", e))?;

        // Use proxy if configured
        let client = build_client(&self.config.copilot_proxy)
            .map_err(|e| anyhow::anyhow!("Failed to build HTTP client: {}", e))?;

        // Try the official endpoint first
        let url = "https://api.githubcopilot.com/models";

        debug!(
            method = "GET",
            url = %url,
            "Sending Copilot models request"
        );

        let start = std::time::Instant::now();
        let response = client
            .get(url)
            .header("Authorization", format!("Bearer {}", token))
            .header("User-Agent", "GitHubCopilot/1.155.0")
            .header("Copilot-Integration-Id", "vscode-chat")
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| {
                if self.config.copilot_proxy.is_active() {
                    let err = anyhow::anyhow!("Network request failed via proxy {}: {} (URL: {})", self.config.copilot_proxy.url.as_ref().unwrap_or(&"?".to_string()), e, url);
                    error!("{}", err);
                    err
                } else {
                    let err = anyhow::anyhow!("Network request failed (no proxy): {} (URL: {})", e, url);
                    error!("{}", err);
                    err
                }
            })?;

        let status = response.status();
        debug!(
            status = %status,
            duration_ms = %start.elapsed().as_millis(),
            "Received Copilot models response"
        );

        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_default();
            error!(
                status = %status,
                error_body = %error_text,
                "Failed to fetch Copilot models"
            );
            anyhow::bail!("Failed to fetch models: {} - {}", status, error_text);
        }

        let response_text = response.text().await.context("Failed to read models response")?;

        debug!(
            response_body_len = response_text.len(),
            "Parsing Copilot models response"
        );

        #[derive(Deserialize, Debug)]
        struct ModelsResponse {
            data: Vec<serde_json::Value>,
        }

        let res: ModelsResponse = serde_json::from_str(&response_text)
            .with_context(|| {
                error!("Failed to parse models JSON: {}", response_text);
                format!("Failed to parse models response. Response: {}", response_text)
            })?;

        let mut models_map = std::collections::HashMap::new();

        for m in res.data {
            // Check type="chat"
            let capabilities = match m.get("capabilities") {
                Some(c) => c,
                None => continue,
            };

            let model_type = match capabilities.get("type").and_then(|t| t.as_str()) {
                Some(t) => t,
                None => continue,
            };

            if model_type != "chat" {
                continue;
            }

            // Check model_picker_enabled=true
            let model_picker_enabled = m.get("model_picker_enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if !model_picker_enabled {
                continue;
            }

            let id = match m.get("id").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };

            let name = m.get("name").and_then(|v| v.as_str()).unwrap_or(&id).to_string();

            // Insert into map to deduplicate by ID
            models_map.insert(id.clone(), CopilotModel {
                id,
                name,
            });
        }

        // If no models found, return fallback models
        if models_map.is_empty() {
            info!("No models found in Copilot API response, using fallback models");
            return Ok(vec![
                CopilotModel { id: "gpt-4".to_string(), name: "GPT-4".to_string() },
                CopilotModel { id: "gpt-4o".to_string(), name: "GPT-4o".to_string() },
                CopilotModel { id: "gpt-4o-mini".to_string(), name: "GPT-4o Mini".to_string() },
            ]);
        }

        let mut models: Vec<CopilotModel> = models_map.into_values().collect();
        // Sort by ID to ensure stable order
        models.sort_by(|a, b| a.id.cmp(&b.id));

        info!(
            model_count = models.len(),
            models = ?models.iter().map(|m| &m.id).collect::<Vec<_>>(),
            "Successfully fetched Copilot models"
        );

        Ok(models)
    }

    async fn translate_copilot(&self, text: &str, context: Option<&[String]>, target_lang: &str, github_token: Option<&str>, model_name: Option<&str>) -> Result<String> {
        let github_token = github_token.or(self.config.github_token.as_deref())
            .context("GitHub Copilot not logged in")?;
        let source_lang_desc = if self.config.source_lang == "auto" {
            "any language".to_string()
        } else {
            self.config.source_lang.clone()
        };
        let target_lang_name = Self::get_lang_name(target_lang);

        let system_prompt = if context.map(|c| !c.is_empty()).unwrap_or(false) {
             format!(
                "You are a translator. Translate the current sentence from {} to {}. \
                 The previous sentences are provided ONLY for context/disambiguation. \
                 IGNORE the language of the previous sentences. \
                 Your output MUST be in {}. \
                 Output ONLY the translation of the current sentence, no labels or explanations.",
                source_lang_desc, target_lang_name, target_lang_name
            )
        } else {
            format!(
                "You are a translator. Translate from {} to {}. Output ONLY the translation.",
                source_lang_desc, target_lang_name
            )
        };

        let user_content = if let Some(ctx) = context {
            if ctx.is_empty() {
                text.to_string()
            } else {
                let context_text = ctx.iter()
                    .enumerate()
                    .map(|(i, s)| format!("{}. {}", i + 1, s))
                    .collect::<Vec<_>>()
                    .join("\n");
                format!("Previous sentences for context:\n{}\n\nCurrent sentence to translate:\n{}", context_text, text)
            }
        } else {
            text.to_string()
        };

        self.send_copilot_request(&system_prompt, &user_content, github_token, model_name).await
    }

    async fn translate_openai(&self, text: &str, endpoint_id: &str, context: Option<&[String]>, target_lang: &str) -> Result<String> {
        let endpoint = self
            .config
            .openai_endpoints
            .iter()
            .find(|e| e.id == endpoint_id)
            .context(format!("OpenAI endpoint '{}' not found", endpoint_id))?;

        if endpoint.api_key.trim().is_empty() {
            anyhow::bail!("OpenAI API key not configured for endpoint '{}'", endpoint.name);
        }

        // Build user content with context if provided
        let user_content = if let Some(ctx) = context {
            if ctx.is_empty() {
                text.to_string()
            } else {
                // Format: context as numbered previous sentences, then current text
                let context_text = ctx.iter()
                    .enumerate()
                    .map(|(i, s)| format!("{}. {}", i + 1, s))
                    .collect::<Vec<_>>()
                    .join("\n");
                format!("Previous sentences for context:\n{}\n\nCurrent sentence to translate:\n{}", context_text, text)
            }
        } else {
            text.to_string()
        };

        let source_lang_desc = if self.config.source_lang == "auto" {
            "any language".to_string()
        } else {
            self.config.source_lang.clone()
        };

        let target_lang_name = Self::get_lang_name(target_lang);

        let system_prompt = if context.map(|c| !c.is_empty()).unwrap_or(false) {
            format!(
                "You are a translator. Translate the current sentence from {} to {}. \
                 The previous sentences are provided ONLY for context/disambiguation. \
                 IGNORE the language of the previous sentences. \
                 Your output MUST be in {}. \
                 Output ONLY the translation of the current sentence, no labels or explanations.",
                source_lang_desc, target_lang_name, target_lang_name
            )
        } else {
            format!(
                "You are a translator. Translate from {} to {}. Output ONLY the translation.",
                source_lang_desc, target_lang_name
            )
        };

        self.send_openai_request(endpoint, &system_prompt, &user_content).await
    }

    /// Remove <think>...</think> blocks from content
    fn clean_thinking_content(content: &str) -> String {
        let mut result = content.to_string();
        while let Some(start) = result.find("<think>") {
            if let Some(end_offset) = result[start..].find("</think>") {
                let end = start + end_offset + 8;
                result.replace_range(start..end, "");
            } else {
                result.replace_range(start.., "");
                break;
            }
        }
        result.trim().to_string()
    }

    /// Helper for OpenAI requests
    async fn send_openai_request(
        &self,
        endpoint: &OpenAIEndpoint,
        system_prompt: &str,
        user_content: &str,
    ) -> Result<String> {
        if endpoint.api_key.trim().is_empty() {
            anyhow::bail!("OpenAI API key not configured for endpoint '{}'", endpoint.name);
        }

        let client = build_client(&endpoint.proxy)?;
        let url = format!("{}/chat/completions", endpoint.base_url.trim_end_matches('/'));

        let request = ChatRequest {
            model: endpoint.model.clone(),
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: system_prompt.to_string(),
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: user_content.to_string(),
                },
            ],
            temperature: 0.3,
        };

        // Sanitize API key for logging (show only first 4 chars)
        let api_key_preview = if endpoint.api_key.chars().count() >= 4 {
            format!("{}...", endpoint.api_key.chars().take(4).collect::<String>())
        } else {
            "***".to_string()
        };

        debug!(
            method = "POST",
            url = %url,
            api_key = %api_key_preview,
            model = %endpoint.model,
            message_count = request.messages.len(),
            "Sending OpenAI API request"
        );

        let start = std::time::Instant::now();
        let response = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", endpoint.api_key))
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .context("Failed to send request to OpenAI")?;

        let status = response.status();
        debug!(
            status = %status,
            duration_ms = %start.elapsed().as_millis(),
            "Received OpenAI API response"
        );

        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
            error!(
                status = %status,
                error_body = %error_text,
                "OpenAI API error"
            );
            return Err(anyhow::anyhow!("Translation failed: {} - {}", status, error_text));
        }

        let response_text = response.text().await.context("Failed to read response body")?;

        debug!(
            response_body_preview = %response_text.chars().take(200).collect::<String>(),
            "OpenAI API response body"
        );

        let result: ChatResponse = serde_json::from_str(&response_text)
            .context("Failed to parse OpenAI response")?;

        result
            .choices
            .first()
            .map(|c| Self::clean_thinking_content(&c.message.content))
            .context("Empty response from OpenAI")
    }

    pub async fn summarize(&self, text: &str, provider_id: &str) -> Result<String> {
        let system_prompt = if let Some(prompt) = &self.config.summary_prompt {
            if prompt.trim().is_empty() {
                // Fallback if empty string provided
                format!(
                    "You are an expert summarizer. The input text is a speech-to-text transcript (Windows LiveCaptions) and likely contains recognition errors, missing words, or typos. \
                     \n\n\
                     Please follow these steps:\n\
                     1. Analyze the context to infer and correct any errors or missing information in the transcript.\n\
                     2. Generate a clear and concise summary of the corrected content in {}.\n\
                     \n\
                     Output using Markdown formatting.",
                    self.config.target_lang
                )
            } else {
                // Replace {target_lang} placeholder if present
                prompt.replace("{target_lang}", &self.config.target_lang)
            }
        } else {
             format!(
                "You are an expert summarizer. The input text is a speech-to-text transcript (Windows LiveCaptions) and likely contains recognition errors, missing words, or typos. \
                 \n\n\
                 Please follow these steps:\n\
                 1. Analyze the context to infer and correct any errors or missing information in the transcript.\n\
                 2. Generate a clear and concise summary of the corrected content in {}.\n\
                 \n\
                 Output using Markdown formatting.",
                self.config.target_lang
            )
        };

        // Check if provider_id is a Copilot model ID
        if let Some(model) = self.config.ai_models.iter().find(|m| m.id == provider_id) {
            if let Some(channel) = self.config.ai_channels.iter().find(|c| c.id == model.channel_id && c.channel_type == "copilot") {
                let github_token = channel.token.as_ref().context("Copilot channel not logged in")?;
                return self.send_copilot_request(&system_prompt, text, github_token, Some(&model.name)).await;
            }
        }

        // Legacy copilot provider
        if provider_id == "copilot" {
            let github_token = self.config.github_token.as_ref().context("GitHub Copilot not logged in")?;
            return self.send_copilot_request(&system_prompt, text, github_token, None).await;
        }

        // OpenAI or compatible model
        let endpoint_id = if provider_id.starts_with("openai:") {
            provider_id.strip_prefix("openai:").unwrap_or("default")
        } else {
            provider_id
        };

        let endpoint = self
            .config
            .openai_endpoints
            .iter()
            .find(|e| e.id == endpoint_id)
            .context(format!("OpenAI endpoint '{}' not found", endpoint_id))?;

        self.send_openai_request(endpoint, &system_prompt, text).await
    }
}

// --- OpenAI DTOs (Moved to module level) ---

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f32,
}

#[derive(Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: ResponseMessage,
}

#[derive(Deserialize)]
struct ResponseMessage {
    content: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clean_thinking_content() {
        assert_eq!(TranslationService::clean_thinking_content("Hello"), "Hello");
        assert_eq!(TranslationService::clean_thinking_content("<think>thinking...</think> Hello"), "Hello");
        assert_eq!(TranslationService::clean_thinking_content("Hello <think>thinking...</think> World"), "Hello  World");
        assert_eq!(TranslationService::clean_thinking_content("<think>thinking...</think>"), "");
        assert_eq!(TranslationService::clean_thinking_content("<think>thinking..."), ""); // Truncated
        assert_eq!(TranslationService::clean_thinking_content("Start <think>1</think> Mid <think>2</think> End"), "Start  Mid  End");
        
        // Multiline check
        let multiline = "Result\n<think>\nLine 1\nLine 2\n</think>\nFinal";
        assert_eq!(TranslationService::clean_thinking_content(multiline), "Result\n\nFinal");
    }
}

