#![cfg(windows)]

use anyhow::{Context, Result};
use reqwest::{Client, Proxy};
use serde::{Deserialize, Serialize};

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationConfig {
    pub provider: TranslationProvider,
    pub source_lang: String,
    pub target_lang: String,
    // Google Translate proxy
    pub google_proxy: ProxyConfig,
    // Microsoft Translator
    pub microsoft_api_key: Option<String>,
    pub microsoft_region: Option<String>,
    pub microsoft_proxy: ProxyConfig,
    // Multiple OpenAI-compatible endpoints
    pub openai_endpoints: Vec<OpenAIEndpoint>,
}

impl Default for TranslationConfig {
    fn default() -> Self {
        Self {
            provider: TranslationProvider::Google,
            source_lang: "en".to_string(),
            target_lang: "zh-CN".to_string(),
            google_proxy: ProxyConfig::default(),
            microsoft_api_key: None,
            microsoft_region: None,
            microsoft_proxy: ProxyConfig::default(),
            openai_endpoints: vec![OpenAIEndpoint::default()],
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
}

impl TranslationService {
    pub fn new(config: TranslationConfig) -> Result<Self> {
        Ok(Self { config })
    }

    #[allow(dead_code)]
    pub fn update_config(&mut self, config: TranslationConfig) {
        self.config = config;
    }

    pub async fn translate(&self, text: &str, context: Option<&[String]>) -> Result<String> {
        if text.trim().is_empty() {
            return Ok(String::new());
        }

        match &self.config.provider {
            TranslationProvider::Google => self.translate_google(text).await,
            TranslationProvider::Microsoft => self.translate_microsoft(text).await,
            TranslationProvider::OpenAI(endpoint_id) => {
                self.translate_openai(text, endpoint_id, context).await
            }
        }
    }

    async fn translate_google(&self, text: &str) -> Result<String> {
        let client = build_client(&self.config.google_proxy)?;
        
        let url = format!(
            "https://translate.googleapis.com/translate_a/single?client=gtx&sl={}&tl={}&dt=t&q={}",
            self.config.source_lang,
            self.config.target_lang,
            urlencoding::encode(text)
        );

        let response = client
            .get(&url)
            .header("User-Agent", "Mozilla/5.0")
            .send()
            .await
            .context("Failed to send request to Google Translate")?;

        let json: serde_json::Value = response
            .json()
            .await
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

    async fn translate_microsoft(&self, text: &str) -> Result<String> {
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

        let url = format!(
            "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from={}&to={}",
            self.config.source_lang, self.config.target_lang
        );

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

        let response = client
            .post(&url)
            .header("Ocp-Apim-Subscription-Key", api_key)
            .header("Ocp-Apim-Subscription-Region", region)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .context("Failed to send request to Microsoft Translator")?;

        let results: Vec<TranslationResult> = response
            .json()
            .await
            .context("Failed to parse Microsoft Translator response")?;

        results
            .first()
            .and_then(|r| r.translations.first())
            .map(|t| t.text.clone())
            .context("Empty response from Microsoft Translator")
    }

    async fn translate_openai(&self, text: &str, endpoint_id: &str, context: Option<&[String]>) -> Result<String> {
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

        let system_prompt = if context.map(|c| !c.is_empty()).unwrap_or(false) {
            format!(
                "You are a translator. Translate the current sentence from {} to {}. \
                 Use the previous sentences only as context to ensure consistency. \
                 Output ONLY the translation of the current sentence, no labels or explanations.",
                self.config.source_lang, self.config.target_lang
            )
        } else {
            format!(
                "You are a translator. Translate from {} to {}. Output ONLY the translation.",
                self.config.source_lang, self.config.target_lang
            )
        };

        self.send_openai_request(endpoint, &system_prompt, &user_content).await
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

        let response = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", endpoint.api_key))
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .context("Failed to send request to OpenAI")?;

        let result: ChatResponse = response
            .json()
            .await
            .context("Failed to parse OpenAI response")?;

        result
            .choices
            .first()
            .map(|c| c.message.content.trim().to_string())
            .context("Empty response from OpenAI")
    }

    pub async fn summarize(&self, text: &str, provider_id: &str) -> Result<String> {
        // Only OpenAI supports summarization for now
        let endpoint_id = if provider_id.starts_with("openai:") {
            provider_id.strip_prefix("openai:").unwrap_or("default")
        } else {
            // Fallback or error if other providers selected (UI should prevent this)
            return Err(anyhow::anyhow!("Summarization only supported with OpenAI providers"));
        };

        let endpoint = self
            .config
            .openai_endpoints
            .iter()
            .find(|e| e.id == endpoint_id)
            .context(format!("OpenAI endpoint '{}' not found", endpoint_id))?;

        let system_prompt = format!(
            "You are an expert summarizer. The input text is a speech-to-text transcript (Windows LiveCaptions) and likely contains recognition errors, missing words, or typos. \
             \n\n\
             Please follow these steps:\n\
             1. Analyze the context to infer and correct any errors or missing information in the transcript.\n\
             2. Generate a clear and concise summary of the corrected content in {}.\n\
             \n\
             Output using Markdown formatting.",
            self.config.target_lang
        );

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

