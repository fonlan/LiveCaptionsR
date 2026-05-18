// --- Domain Types ---

export interface RawCaption {
  text: string;
  user?: string;
  timestamp: number;
  card_id?: string;
  source_id?: string;
}

export type TranslationStatus = 'translating' | 'success' | 'error';

export interface SentenceCard {
  id: string;
  original: string;
  translated: string | null;
  status?: TranslationStatus;
  user?: string;
  retrying?: boolean;
  timestamp: number; // Added timestamp
}

export interface Session {
  id: string;
  name: string;
  created_at: number;
  cards: SentenceCard[];
}

export interface SessionMetadata {
  id: string;
  name: string;
  created_at: number;
  preview: string;
  search_text?: string;
}

export type AIChatRole = "user" | "assistant";
export type AIChatMessageStatus = "done" | "loading" | "error";

export interface AIChatMessage {
  id: string;
  role: AIChatRole;
  content: string;
  status: AIChatMessageStatus;
  created_at: number;
}

export interface AIChatSession {
  id: string;
  session_id: string;
  name: string;
  created_at: number;
  updated_at: number;
  messages: AIChatMessage[];
}

export interface AIChatSessionMetadata {
  id: string;
  session_id: string;
  name: string;
  created_at: number;
  updated_at: number;
  preview: string;
}

export interface CaptionChatCardInput {
  original: string;
  user?: string;
  timestamp: number;
}

export interface TeamsWindowInfo {
  hwnd: number;
  pid: number;
  title: string;
}

export type ToastType = 'success' | 'error';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
}

// --- Configuration Types ---

export interface ProxyConfig {
  url: string | null;
  enabled: boolean;
}

export type AIChannelType = 'openai' | 'copilot';

export interface BaseChannel {
  id: string;
  name: string;
  proxy: ProxyConfig;
}

export interface OpenAIChannel extends BaseChannel {
  type: 'openai';
  api_key: string;
  base_url: string;
}

export interface CopilotChannel extends BaseChannel {
  type: 'copilot';
  token?: string;
}

export type AIChannel = OpenAIChannel | CopilotChannel;

export interface AIModel {
  id: string; // generated ID
  name: string; // actual model name (e.g. gpt-4)
  channel_id: string;
}

export interface CopilotModel {
  id: string;
  name: string;
}

export type ProviderType = 'google' | 'microsoft' | string;
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface AppConfig {
  caption_source: string;
  selected_teams_hwnd: number | null;
  provider: ProviderType;
  source_lang: string;
  target_lang: string;
  theme: string;
  hide_system_window: boolean;
  always_on_top: boolean;
  include_microphone: boolean;
  summary_provider: string;
  summary_prompt: string | null;
  google_proxy: ProxyConfig;
  microsoft_api_key: string | null;
  microsoft_region: string | null;
  microsoft_proxy: ProxyConfig;
  ai_channels: AIChannel[];
  ai_models: AIModel[];
  openai_context_count: number;
  translation_prompt: string;
  opacity: number;
  language: string;
  translation_enabled: boolean;
  max_concurrent_translations: number;
  log_level: LogLevel;
}

export const DEFAULT_PROXY: ProxyConfig = { url: "", enabled: false };

export const DEFAULT_TRANSLATION_PROMPT = "You are a professional translator for live captions and speech-to-text transcripts.\n\nTranslate the current sentence from {source_lang} to {target_lang}.\nIf previous sentences are provided, use them only for context and disambiguation. Do not translate or mention them separately.\nCorrect obvious speech recognition mistakes only when the intended meaning is clear from context.\nPreserve the original meaning, tone, and speaker intent.\n\nReturn only the translation in {target_lang}. Do not include explanations, labels, quotation marks, or extra formatting.";

export const DEFAULT_SUMMARY_PROMPT = "You are an expert summarizer. The input text is a speech-to-text transcript (Windows LiveCaptions) and likely contains recognition errors, missing words, or typos. \n\n Please follow these steps:\n 1. Analyze the context to infer and correct any errors or missing information in the transcript.\n 2. Generate a clear and concise summary of the corrected content in {target_lang}.\n \n Output using Markdown formatting.";

export const DEFAULT_CONFIG: AppConfig = {
  caption_source: "livecaptions",
  selected_teams_hwnd: null,
  provider: "google",
  source_lang: "en",
  target_lang: "zh-CN",
  theme: "dark",
  hide_system_window: true,
  always_on_top: false,
  include_microphone: false,
  summary_provider: "",
  summary_prompt: DEFAULT_SUMMARY_PROMPT,
  google_proxy: DEFAULT_PROXY,
  microsoft_api_key: "",
  microsoft_region: "",
  microsoft_proxy: DEFAULT_PROXY,
  ai_channels: [],
  ai_models: [],
  openai_context_count: 2,
  translation_prompt: DEFAULT_TRANSLATION_PROMPT,
  opacity: 1.0,
  language: "en",
  translation_enabled: true,
  max_concurrent_translations: 2,
  log_level: "info",
};

export const LANGUAGES = [
  { code: "auto", name: "Auto Detect" },
  { code: "en", name: "English" },
  { code: "zh-CN", name: "Chinese (Simplified)" },
  { code: "zh-TW", name: "Chinese (Traditional)" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "it", name: "Italian" },
  { code: "pt", name: "Portuguese" },
  { code: "ru", name: "Russian" },
  { code: "vi", name: "Vietnamese" },
  { code: "th", name: "Thai" },
  { code: "id", name: "Indonesian" },
  { code: "hi", name: "Hindi" },
];
