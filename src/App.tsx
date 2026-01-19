import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import Markdown from 'react-markdown';
import "./App.css";

// --- Types ---

interface RawCaption {
  text: string;
  timestamp: number;
}

interface SentenceCard {
  id: string;
  original: string;
  translated: string | null;
  status?: 'translating' | 'success' | 'error';
  retrying?: boolean;
}

interface Toast {
  id: string;
  type: 'success' | 'error';
  message: string;
}

interface ProxyConfig {
  url: string | null;
  enabled: boolean;
}

interface OpenAIEndpoint {
  id: string;
  name: string;
  api_key: string;
  base_url: string;
  model: string;
  proxy: ProxyConfig;
}

interface AppConfig {
  provider: string;
  source_lang: string;
  target_lang: string;
  theme: string;
  hide_system_window: boolean;
  always_on_top: boolean;
  summary_provider: string;
  google_proxy: ProxyConfig;
  microsoft_api_key: string | null;
  microsoft_region: string | null;
  microsoft_proxy: ProxyConfig;
  openai_endpoints: OpenAIEndpoint[];
  openai_context_count: number;
  opacity: number;
}

const DEFAULT_PROXY: ProxyConfig = { url: "", enabled: false };

const DEFAULT_OPENAI_ENDPOINT: OpenAIEndpoint = {
  id: "default",
  name: "OpenAI",
  api_key: "",
  base_url: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  proxy: { url: "", enabled: false },
};

const DEFAULT_CONFIG: AppConfig = {
  provider: "google",
  source_lang: "en",
  target_lang: "zh-CN",
  theme: "dark",
  hide_system_window: true,
  always_on_top: false,
  summary_provider: "openai:default",
  google_proxy: DEFAULT_PROXY,
  microsoft_api_key: "",
  microsoft_region: "",
  microsoft_proxy: DEFAULT_PROXY,
  openai_endpoints: [DEFAULT_OPENAI_ENDPOINT],
  openai_context_count: 2,
  opacity: 1.0,
};

const LANGUAGES = [
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

// --- Icons (SVG) ---

const IconSettings = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"></circle>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
  </svg>
);

const IconFileText = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path>
    <polyline points="14 2 14 8 20 8"></polyline>
    <line x1="16" y1="13" x2="8" y2="13"></line>
    <line x1="16" y1="17" x2="8" y2="17"></line>
    <line x1="10" y1="9" x2="8" y2="9"></line>
  </svg>
);

const IconCopy = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
  </svg>
);

const IconPlay = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="5 3 19 12 5 21 5 3"></polygon>
  </svg>
);

const IconSquare = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
  </svg>
);

const IconX = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"></line>
    <line x1="6" y1="6" x2="18" y2="18"></line>
  </svg>
);

const IconCheck = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>
);

const IconTrash = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6"></polyline>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
  </svg>
);

const IconRetry = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10"></polyline>
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
  </svg>
);

const IconPlus = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"></line>
    <line x1="5" y1="12" x2="19" y2="12"></line>
  </svg>
);

const IconMinus = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="5" y1="12" x2="19" y2="12"></line>
  </svg>
);

// --- Constants (matching C# original) ---
const MAX_IDLE_INTERVAL = 10;
const MAX_SYNC_INTERVAL = 20;
const SIMILARITY_THRESHOLD = 0.66;

// --- Utility Functions ---

function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) matrix[i] = [i];
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[a.length][b.length];
}

function calculateSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const distance = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
  const maxLength = Math.max(a.length, b.length);
  return 1 - distance / maxLength;
}

function stripTrailingPunctuation(text: string): string {
  return text.replace(/[.!?。！？，,;；:：\s]+$/, '');
}

function isContinuation(oldText: string, newText: string): boolean {
  if (!oldText || !newText) return false;
  const oldStripped = stripTrailingPunctuation(oldText).toLowerCase();
  const newLower = newText.toLowerCase();
  return newLower.startsWith(oldStripped) && newLower.length > oldStripped.length;
}

function shouldOverwrite(oldText: string, newText: string): boolean {
  if (!oldText || !newText) return false;
  if (isContinuation(oldText, newText)) return true;
  return calculateSimilarity(oldText, newText) > SIMILARITY_THRESHOLD;
}

function isDecimalPoint(text: string, dotIndex: number): boolean {
  if (dotIndex <= 0 || dotIndex >= text.length - 1) return false;
  return /\d/.test(text[dotIndex - 1]) && /\d/.test(text[dotIndex + 1]);
}

function isEOSPunctuation(text: string, index: number): boolean {
  const char = text[index];
  if (char === '!' || char === '?' || char === '。' || char === '！' || char === '？') return true;
  if (char === '.') return !isDecimalPoint(text, index);
  return false;
}

function findLastEOSIndex(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (isEOSPunctuation(text, i)) return i;
  }
  return -1;
}

function getLatestCaption(text: string): string {
  if (!text.trim()) return "";
  const lastEOS = findLastEOSIndex(text);
  return lastEOS >= 0 ? text.slice(lastEOS + 1).trim() : text.trim();
}

function endsWithEOS(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && isEOSPunctuation(trimmed, trimmed.length - 1);
}

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// --- Components ---

function App() {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<string>("Ready");
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isSummaryOpen, setIsSummaryOpen] = useState<boolean>(false);
  const [summaryText, setSummaryText] = useState<string>("");
  const [isSummarizing, setIsSummarizing] = useState<boolean>(false);
  const [appVersion, setAppVersion] = useState<string>("");
  const [cards, setCards] = useState<SentenceCard[]>([]);
  const [partialText, setPartialText] = useState<string>("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const historyEndRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<SentenceCard[]>([]);
  const configRef = useRef<AppConfig>(DEFAULT_CONFIG);

  const lastFullTextRef = useRef<string>("");
  const lastOriginalTextRef = useRef<string>("");
  const idleCountRef = useRef<number>(0);
  const syncCountRef = useRef<number>(0);
  const isFirstCaptionRef = useRef<boolean>(true);
  const isTranslatingRef = useRef<boolean>(false);
  const overlayMouseDownRef = useRef<boolean>(false);

  const addToast = (type: 'success' | 'error', message: string) => {
    const id = generateId();
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3000);
  };

  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ behavior: "smooth" });
    cardsRef.current = cards;
  }, [cards, partialText]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    async function init() {
      try {
        const v = await getVersion();
        setAppVersion(v);
        const savedConfig = await invoke<AppConfig>("get_config");
        if (savedConfig) {
          // Ensure backwards compatibility
          setConfig({
            ...DEFAULT_CONFIG,
            ...savedConfig,
            google_proxy: savedConfig.google_proxy || DEFAULT_PROXY,
            microsoft_proxy: savedConfig.microsoft_proxy || DEFAULT_PROXY,
            openai_endpoints: savedConfig.openai_endpoints?.length ? savedConfig.openai_endpoints : [DEFAULT_OPENAI_ENDPOINT],
          });
        }
        const running = await invoke<boolean>("is_watcher_running");
        setIsRunning(running);
        if (running) setStatus("Running");
      } catch (e) {
        console.error("Failed to init:", e);
      }
    }
    init();
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', config.theme || 'dark');
  }, [config.theme]);

  useEffect(() => {
    document.documentElement.style.setProperty('--app-opacity', (config.opacity ?? 1.0).toString());
  }, [config.opacity]);

  const retryTranslation = async (cardId: string, originalText: string) => {
    setCards(prev => prev.map(c => c.id === cardId ? { ...c, retrying: true } : c));
    try {
      // Get context for OpenAI translation
      const currentCards = cardsRef.current;
      const currentConfig = configRef.current;
      const cardIndex = currentCards.findIndex(c => c.id === cardId);
      let context: string[] | null = null;
      
      if (currentConfig.provider.startsWith('openai:') && currentConfig.openai_context_count > 0 && cardIndex > 0) {
        const startIdx = Math.max(0, cardIndex - currentConfig.openai_context_count);
        context = currentCards.slice(startIdx, cardIndex).map(c => c.original);
      }
      
      const translated = await invoke<string>("translate_text", { text: originalText, context });
      setCards(prev => prev.map(c => c.id === cardId ? { ...c, translated, retrying: false } : c));
    } catch (e) {
      console.error("Retry failed:", e);
      setCards(prev => prev.map(c => c.id === cardId ? { ...c, retrying: false } : c));
    }
  };

  const translateAndDisplay = async (originalText: string) => {
    if (!originalText.trim() || isTranslatingRef.current) return;
    isTranslatingRef.current = true;
    const newId = generateId();

    // Optimistic update: Add card immediately
    setCards(prev => {
      const newCard: SentenceCard = { id: newId, original: originalText, translated: null, status: 'translating' };
      if (prev.length === 0) return [newCard];

      const lastCard = prev[prev.length - 1];
      if (shouldOverwrite(lastCard.original, originalText)) {
        const newCards = [...prev];
        newCards[newCards.length - 1] = newCard;
        return newCards;
      }
      return [...prev, newCard].slice(-200);
    });

    try {
      // Get context for OpenAI translation (previous N cards' original text)
      let context: string[] | null = null;
      const currentCards = cardsRef.current;
      const currentConfig = configRef.current;
      
      if (currentConfig.provider.startsWith('openai:') && currentConfig.openai_context_count > 0 && currentCards.length > 0) {
        const startIdx = Math.max(0, currentCards.length - currentConfig.openai_context_count);
        context = currentCards.slice(startIdx).map(c => c.original);
      }
      
      const translated = await invoke<string>("translate_text", { text: originalText, context });
      
      setCards(prev => prev.map(c => 
        c.id === newId ? { ...c, translated, status: 'success' } : c
      ));
      lastOriginalTextRef.current = originalText;
    } catch (e) {
      console.error("Translation error:", e);
      setCards(prev => prev.map(c => 
        c.id === newId ? { ...c, translated: null, status: 'error' } : c
      ));
      lastOriginalTextRef.current = originalText;
    } finally {
      isTranslatingRef.current = false;
      syncCountRef.current = 0;
    }
  };

  useEffect(() => {
    const unlistenRaw = listen<RawCaption>("caption-raw", async (event) => {
      const fullText = event.payload.text;
      const latestCaption = getLatestCaption(fullText);
      setPartialText(latestCaption);

      if (isFirstCaptionRef.current) {
        isFirstCaptionRef.current = false;
        lastFullTextRef.current = fullText;
        return;
      }

      if (fullText === lastFullTextRef.current) {
        idleCountRef.current++;
        if (idleCountRef.current === MAX_IDLE_INTERVAL && latestCaption.trim()) {
          await translateAndDisplay(latestCaption);
          idleCountRef.current = 0;
        }
      } else {
        idleCountRef.current = 0;
        syncCountRef.current++;

        if (endsWithEOS(fullText)) {
          const lastEOS = findLastEOSIndex(fullText);
          let prevEOS = -1;
          for (let i = lastEOS - 1; i >= 0; i--) {
            if (isEOSPunctuation(fullText, i)) { prevEOS = i; break; }
          }
          const completeSentence = fullText.slice(prevEOS + 1, lastEOS + 1).trim();
          if (completeSentence) await translateAndDisplay(completeSentence);
        } else if (syncCountRef.current >= MAX_SYNC_INTERVAL && latestCaption.trim()) {
          await translateAndDisplay(latestCaption);
        }
        lastFullTextRef.current = fullText;
      }
    });

    const unlistenStatus = listen<string>("caption-status", (event) => setStatus(event.payload));
    const unlistenError = listen<string>("caption-error", (event) => {
      setStatus(`Error: ${event.payload}`);
      setIsRunning(false);
    });

    return () => {
      unlistenRaw.then(f => f());
      unlistenStatus.then(f => f());
      unlistenError.then(f => f());
    };
  }, []);

  const toggleWatcher = async () => {
    if (isRunning) {
      await invoke("stop_caption_watcher");
      setIsRunning(false);
      setStatus("Stopped");
      setPartialText("");
    } else {
      isFirstCaptionRef.current = true;
      setStatus("Starting...");
      try {
        await invoke("start_caption_watcher");
        setIsRunning(true);
      } catch (err) {
        setStatus(`Failed to start: ${err}`);
      }
    }
  };

  const clearHistory = () => {
    setCards([]);
    setPartialText("");
    lastFullTextRef.current = "";
    lastOriginalTextRef.current = "";
    idleCountRef.current = 0;
    syncCountRef.current = 0;
  };

  const saveConfig = async (newConfig: AppConfig) => {
    try {
      await invoke("save_config", { config: newConfig });
      setConfig(newConfig);
      addToast('success', 'Configuration saved successfully');
    } catch (err) {
      console.error("Failed to save config:", err);
      addToast('error', `Failed to save configuration: ${err}`);
    }
  };

  const handleSummarize = async () => {
    if (cards.length === 0) return;
    setIsSummaryOpen(true);
    setIsSummarizing(true);
    setSummaryText("");

    try {
      const segments = cards.map(c => c.original);
      const result = await invoke<string>("summarize_text", { 
        segments,
        providerId: config.summary_provider
      });
      setSummaryText(result);
    } catch (err) {
      console.error("Summary error:", err);
      setSummaryText(`Error generating summary: ${err}`);
    } finally {
      setIsSummarizing(false);
    }
  };

  return (
    <div className="app-container" onContextMenu={(e) => e.preventDefault()}>
      <div className="history-area">
        <div className="history-header">
          <div className="history-header-left">
            <span className="history-label">
              <span className={`label-icon ${isRunning ? 'active' : ''}`}>●</span>
              Captions ({cards.length})
            </span>
          </div>
          <button className="btn-clear" onClick={clearHistory} title="Clear">
            <IconTrash />
          </button>
        </div>

        <div className="history-scroll">
          {cards.length === 0 && !partialText ? (
            <div className="history-empty">Waiting for speech...</div>
          ) : (
            <>
              {cards.map((item) => (
                <div key={item.id} className={`history-card ${item.status === 'error' || (!item.status && item.translated === null) ? 'failed' : ''}`}>
                  <div className="card-original">{item.original}</div>
                  {item.status === 'translating' ? (
                    <div className="typing-dots">
                      <span>.</span><span>.</span><span>.</span>
                    </div>
                  ) : item.translated ? (
                    <div className="card-translated">{item.translated}</div>
                  ) : (
                    <div className="card-failed">
                      <span className="failed-text">Translation failed</span>
                      <button
                        className="btn-retry"
                        onClick={() => retryTranslation(item.id, item.original)}
                        disabled={item.retrying}
                        title="Retry translation"
                      >
                        {item.retrying ? <span className="spinner" /> : <IconRetry />}
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {partialText && (
                <div className="history-card partial">
                  <div className="card-original">{partialText}</div>
                  <div className="card-translating">...</div>
                </div>
              )}
            </>
          )}
          <div ref={historyEndRef} />
        </div>
      </div>

      <footer className="control-bar">
        <div className="status-indicator">
          <div className={`status-dot ${isRunning ? 'active' : 'inactive'}`} />
          <span className={`status-text ${status.startsWith('Error') ? 'error' : ''}`} title={status}>{status}</span>
        </div>
        <div className="controls-center">
          <button className={`fab-main ${isRunning ? 'stop' : 'start'}`} onClick={toggleWatcher}>
            {isRunning ? <IconSquare /> : <IconPlay />}
            <span>{isRunning ? "STOP" : "START"}</span>
          </button>
          <button 
            className="btn-summary"
            onClick={handleSummarize}
            disabled={cards.length === 0}
            title="Summarize Captions"
            style={{ 
              marginLeft: '12px',
              height: '48px',
              width: '48px',
              borderRadius: '24px',
              border: 'none',
              background: 'var(--bg-secondary)',
              color: cards.length > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
              cursor: cards.length > 0 ? 'pointer' : 'not-allowed',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.2s'
            }}
          >
            <IconFileText />
          </button>
        </div>
        <div className="controls-right">
          {appVersion && <span className="app-version">v{appVersion}</span>}
          <button className="btn-icon settings-btn" onClick={() => setIsSettingsOpen(true)} title="Settings">
            <IconSettings />
          </button>
        </div>
      </footer>

      <div 
        className={`settings-overlay ${isSettingsOpen ? 'open' : ''}`} 
        onMouseDown={() => { overlayMouseDownRef.current = true; }}
        onMouseUp={() => { 
          if (overlayMouseDownRef.current) {
            setIsSettingsOpen(false);
          }
          overlayMouseDownRef.current = false;
        }}
      >
        <div className="settings-drawer" onMouseDown={e => e.stopPropagation()} onMouseUp={e => e.stopPropagation()}>
          <header className="settings-header">
            <h2>Configuration</h2>
            <button className="btn-icon" onClick={() => setIsSettingsOpen(false)}>
              <IconX />
            </button>
          </header>
          <div className="settings-content">
            <SettingsForm config={config} onSave={saveConfig} />
          </div>
        </div>
      </div>
      
      <SummaryModal 
        isOpen={isSummaryOpen} 
        onClose={() => setIsSummaryOpen(false)} 
        text={summaryText} 
        isLoading={isSummarizing} 
      />

      {/* Toast Container */}
      <div className="toast-container">
        {toasts.map(toast => (
          <div key={toast.id} className={`toast toast-${toast.type}`}>
            {toast.type === 'success' ? <IconCheck /> : <IconX />}
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Proxy Config Component ---
function ProxyConfigForm({ proxy, onChange, label }: { proxy: ProxyConfig; onChange: (p: ProxyConfig) => void; label: string }) {
  return (
    <div className="proxy-config">
      <div className="form-group checkbox-group">
        <label className="switch">
          <input type="checkbox" checked={proxy.enabled} onChange={e => onChange({ ...proxy, enabled: e.target.checked })} />
          <span className="slider round"></span>
        </label>
        <span>{label}</span>
      </div>
      {proxy.enabled && (
        <div className="form-group">
          <label>Proxy URL</label>
          <input
            type="text"
            value={proxy.url || ''}
            onChange={e => onChange({ ...proxy, url: e.target.value })}
            placeholder="http://127.0.0.1:7890 or socks5://127.0.0.1:1080"
          />
        </div>
      )}
    </div>
  );
}

// --- Summary Modal Component ---
function SummaryModal({ isOpen, onClose, text, isLoading }: { isOpen: boolean; onClose: () => void; text: string; isLoading: boolean }) {
  const [isCopied, setIsCopied] = useState(false);

  useEffect(() => {
    if (isOpen) setIsCopied(false);
  }, [isOpen]);

  const handleCopy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  if (!isOpen) return null;
  return (
    <div className="settings-overlay open" onClick={onClose}>
      <div className="settings-drawer summary-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '800px', width: '90%' }}>
        <header className="settings-header">
          <h2>AI Summary</h2>
          <div style={{ display: 'flex', gap: '8px' }}>
            {!isLoading && text && (
              <button 
                className="btn-icon" 
                onClick={handleCopy} 
                title="Copy to Clipboard"
                style={{ color: isCopied ? '#4ade80' : 'currentColor' }}
              >
                {isCopied ? <IconCheck /> : <IconCopy />}
              </button>
            )}
            <button className="btn-icon" onClick={onClose}>
              <IconX />
            </button>
          </div>
        </header>
        <div className="settings-content summary-content">
          {isLoading ? (
            <div className="summary-loading" style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>
              <span className="spinner" style={{ display: 'inline-block', marginBottom: '10px' }}></span>
              <div>Generating summary...</div>
            </div>
          ) : (
             <div className="summary-text markdown-body" style={{ lineHeight: '1.6', fontSize: '15px', color: 'var(--text-primary)', padding: '0 5px' }}>
               <Markdown>{text}</Markdown>
             </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Settings Form ---
function SettingsForm({ config, onSave }: { config: AppConfig; onSave: (c: AppConfig) => void }) {
  const [formData, setFormData] = useState<AppConfig>(config);
  const [activeTab, setActiveTab] = useState<'general' | 'translation' | 'ai' | 'summary'>('general');

  useEffect(() => {
    setFormData(config);
  }, [config]);

  const getSelectedProvider = (): { type: string; endpointId?: string } => {
    if (formData.provider.startsWith('openai:')) {
      return { type: 'openai', endpointId: formData.provider.slice(7) };
    }
    return { type: formData.provider };
  };

  const setProvider = (type: string, endpointId?: string) => {
    if (type === 'openai' && endpointId) {
      setFormData(prev => ({ ...prev, provider: `openai:${endpointId}` }));
    } else {
      setFormData(prev => ({ ...prev, provider: type }));
    }
  };

  const updateEndpoint = (index: number, updates: Partial<OpenAIEndpoint>) => {
    const newEndpoints = [...formData.openai_endpoints];
    newEndpoints[index] = { ...newEndpoints[index], ...updates };
    setFormData(prev => ({ ...prev, openai_endpoints: newEndpoints }));
  };

  const addEndpoint = () => {
    const newId = `endpoint_${Date.now()}`;
    const newEndpoint: OpenAIEndpoint = {
      id: newId,
      name: `Endpoint ${formData.openai_endpoints.length + 1}`,
      api_key: "",
      base_url: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      proxy: { url: "", enabled: false },
    };
    setFormData(prev => ({ ...prev, openai_endpoints: [...prev.openai_endpoints, newEndpoint] }));
  };

  const removeEndpoint = (index: number) => {
    if (formData.openai_endpoints.length <= 1) return;
    const newEndpoints = formData.openai_endpoints.filter((_, i) => i !== index);
    setFormData(prev => {
      const removedId = prev.openai_endpoints[index].id;
      let newProvider = prev.provider;
      if (prev.provider === `openai:${removedId}`) {
        newProvider = `openai:${newEndpoints[0].id}`;
      }
      let newSummaryProvider = prev.summary_provider;
      if (prev.summary_provider === `openai:${removedId}`) {
        newSummaryProvider = `openai:${newEndpoints[0].id}`;
      }
      return { ...prev, openai_endpoints: newEndpoints, provider: newProvider, summary_provider: newSummaryProvider };
    });
  };

  const selectedProvider = getSelectedProvider();

  const renderGeneralTab = () => (
    <div className="tab-panel">
       {/* Theme Settings */}
       <div className="form-group">
        <label>Theme</label>
        <select
          value={formData.theme || 'dark'}
          onChange={e => setFormData(prev => ({ ...prev, theme: e.target.value }))}
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </div>

      {/* Opacity Settings */}
      <div className="form-group">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
          <label>Background Opacity</label>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{Math.round((formData.opacity ?? 1.0) * 100)}%</span>
        </div>
        <input
          type="range"
          min="0.1"
          max="1.0"
          step="0.05"
          value={formData.opacity ?? 1.0}
          onChange={e => setFormData(prev => ({ ...prev, opacity: parseFloat(e.target.value) }))}
          style={{ width: '100%', accentColor: 'var(--primary)', cursor: 'pointer' }}
        />
      </div>

      {/* Hide Window */}
      <div className="form-group checkbox-group">
        <label className="switch">
          <input type="checkbox" checked={formData.hide_system_window} onChange={e => setFormData(prev => ({ ...prev, hide_system_window: e.target.checked }))} />
          <span className="slider round"></span>
        </label>
        <span>Hide System LiveCaptions Window</span>
      </div>

      {/* Always On Top */}
      <div className="form-group checkbox-group">
        <label className="switch">
          <input 
            type="checkbox" 
            checked={formData.always_on_top} 
            onChange={async e => {
              const checked = e.target.checked;
              setFormData(prev => ({ ...prev, always_on_top: checked }));
              // Apply immediately for UX
              try {
                await invoke("set_always_on_top", { alwaysOnTop: checked });
              } catch (err) {
                console.error("Failed to set always on top:", err);
              }
            }} 
          />
          <span className="slider round"></span>
        </label>
        <span>Always on Top</span>
      </div>
    </div>
  );

  const renderTranslationTab = () => (
    <div className="tab-panel">
      {/* Language Settings */}
      <div className="form-row">
        <div className="form-group">
          <label>Source Language</label>
          <select
            value={formData.source_lang}
            onChange={e => setFormData(prev => ({ ...prev, source_lang: e.target.value }))}
          >
            {LANGUAGES.map(lang => (
              <option key={lang.code} value={lang.code}>
                {lang.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>Target Language</label>
          <select
            value={formData.target_lang}
            onChange={e => setFormData(prev => ({ ...prev, target_lang: e.target.value }))}
          >
            {LANGUAGES.map(lang => (
              <option key={lang.code} value={lang.code}>
                {lang.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Provider Selection */}
      <div className="form-group">
        <label>Translation Provider</label>
        <select
          value={selectedProvider.type === 'openai' ? 'openai' : formData.provider}
          onChange={e => {
            const val = e.target.value;
            if (val === 'openai') {
              setProvider('openai', formData.openai_endpoints[0]?.id || 'default');
            } else {
              setProvider(val);
            }
          }}
        >
          <option value="google">Google Translate (Free)</option>
          <option value="microsoft">Microsoft Azure</option>
          <option value="openai">OpenAI Compatible</option>
        </select>
      </div>

      {/* OpenAI Endpoint Selection */}
      {selectedProvider.type === 'openai' && formData.openai_endpoints.length > 1 && (
        <div className="form-group">
          <label>Select Endpoint</label>
          <select
            value={selectedProvider.endpointId}
            onChange={e => setProvider('openai', e.target.value)}
          >
            {formData.openai_endpoints.map(ep => (
              <option key={ep.id} value={ep.id}>{ep.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* OpenAI Context Count */}
      {selectedProvider.type === 'openai' && (
        <div className="endpoint-card" style={{ marginTop: '0px' }}>
          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <label style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Context Memory</label>
              <span style={{ 
                color: 'var(--primary)', 
                background: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                padding: '2px 8px',
                borderRadius: '4px',
                fontSize: '12px',
                fontWeight: 600,
                minWidth: '100px',
                textAlign: 'center'
              }}>
                {formData.openai_context_count ?? 2} previous cards
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="10"
              step="1"
              value={formData.openai_context_count ?? 2}
              onChange={e => setFormData(prev => ({ ...prev, openai_context_count: parseInt(e.target.value) }))}
              style={{ 
                width: '100%', 
                accentColor: 'var(--primary)',
                cursor: 'pointer',
                marginTop: '8px',
                marginBottom: '8px'
              }}
            />
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.4' }}>
              Includes previous captions in the translation prompt. 
              { (formData.openai_context_count ?? 2) > 4 && 
                <span style={{ color: 'var(--warning)', marginLeft: '6px' }}>
                  High context may increase latency.
                </span>
              }
            </div>
          </div>
        </div>
      )}

      {/* Google Settings */}
      {formData.provider === 'google' && (
        <>
          <div className="divider">Google Translate Settings</div>
          <ProxyConfigForm
            proxy={formData.google_proxy}
            onChange={p => setFormData(prev => ({ ...prev, google_proxy: p }))}
            label="Use Proxy"
          />
        </>
      )}

      {/* Microsoft Settings */}
      {formData.provider === 'microsoft' && (
        <>
          <div className="divider">Microsoft Azure Settings</div>
          <div className="form-group">
            <label>API Key</label>
            <input type="password" value={formData.microsoft_api_key || ''} onChange={e => setFormData(prev => ({ ...prev, microsoft_api_key: e.target.value }))} />
          </div>
          <div className="form-group">
            <label>Region</label>
            <input type="text" value={formData.microsoft_region || ''} onChange={e => setFormData(prev => ({ ...prev, microsoft_region: e.target.value }))} placeholder="eastus" />
          </div>
          <ProxyConfigForm
            proxy={formData.microsoft_proxy}
            onChange={p => setFormData(prev => ({ ...prev, microsoft_proxy: p }))}
            label="Use Proxy"
          />
        </>
      )}
    </div>
  );

  const renderAIConfigTab = () => (
    <div className="tab-panel">
      <div className="divider">
        AI Providers Configuration
        <button className="btn-add-endpoint" onClick={addEndpoint} title="Add Endpoint">
          <IconPlus />
        </button>
      </div>
      {formData.openai_endpoints.map((ep, idx) => (
        <div key={ep.id} className="endpoint-card">
          <div className="endpoint-header">
            <input
              type="text"
              value={ep.name}
              onChange={e => updateEndpoint(idx, { name: e.target.value })}
              className="endpoint-name-input"
              placeholder="Endpoint Name"
            />
            {formData.openai_endpoints.length > 1 && (
              <button className="btn-remove-endpoint" onClick={() => removeEndpoint(idx)} title="Remove">
                <IconMinus />
              </button>
            )}
          </div>
          <div className="form-group">
            <label>API Key</label>
            <input type="password" value={ep.api_key} onChange={e => updateEndpoint(idx, { api_key: e.target.value })} />
          </div>
          <div className="form-group">
            <label>Base URL</label>
            <input type="text" value={ep.base_url} onChange={e => updateEndpoint(idx, { base_url: e.target.value })} placeholder="https://api.openai.com/v1" />
          </div>
          <div className="form-group">
            <label>Model</label>
            <input type="text" value={ep.model} onChange={e => updateEndpoint(idx, { model: e.target.value })} placeholder="gpt-4o-mini" />
          </div>
          <ProxyConfigForm
            proxy={ep.proxy}
            onChange={p => updateEndpoint(idx, { proxy: p })}
            label="Use Proxy"
          />
        </div>
      ))}
    </div>
  );

  const renderSummaryTab = () => (
    <div className="tab-panel">
      <div className="form-group">
        <label>Summary Provider (OpenAI Only)</label>
        <select
          value={formData.summary_provider || (formData.openai_endpoints[0] ? `openai:${formData.openai_endpoints[0].id}` : '')}
          onChange={e => setFormData(prev => ({ ...prev, summary_provider: e.target.value }))}
        >
          {formData.openai_endpoints.map(ep => (
            <option key={ep.id} value={`openai:${ep.id}`}>
              {ep.name} ({ep.model})
            </option>
          ))}
        </select>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px' }}>
          Configures which AI model generates summaries of your captions. Ensure the selected provider is configured in the "AI Config" tab.
        </div>
      </div>
    </div>
  );

  return (
    <div className="form-stack">
      {/* Tabs */}
      <div className="settings-tabs">
        <button 
          className={`tab-btn ${activeTab === 'general' ? 'active' : ''}`}
          onClick={() => setActiveTab('general')}
        >
          General
        </button>
        <button 
          className={`tab-btn ${activeTab === 'translation' ? 'active' : ''}`}
          onClick={() => setActiveTab('translation')}
        >
          Translation
        </button>
        <button 
          className={`tab-btn ${activeTab === 'ai' ? 'active' : ''}`}
          onClick={() => setActiveTab('ai')}
        >
          AI Config
        </button>
        <button 
          className={`tab-btn ${activeTab === 'summary' ? 'active' : ''}`}
          onClick={() => setActiveTab('summary')}
        >
          Summary
        </button>
      </div>

      {/* Tab Content */}
      <div className="tab-content-container" style={{ flex: 1, minHeight: 0 }}>
        {activeTab === 'general' && renderGeneralTab()}
        {activeTab === 'translation' && renderTranslationTab()}
        {activeTab === 'ai' && renderAIConfigTab()}
        {activeTab === 'summary' && renderSummaryTab()}
      </div>

      {/* Save Button */}
      <div className="form-actions" style={{ marginTop: 'auto', paddingTop: '20px', borderTop: '1px solid var(--border-color)' }}>
        <button className="btn-save" onClick={() => onSave(formData)}>
          <IconCheck /> Save Configuration
        </button>
      </div>
    </div>
  );
}

export default App;
