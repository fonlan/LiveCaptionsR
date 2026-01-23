import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog';
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import Markdown from 'react-markdown';
import "./App.css";
import { 
  AppConfig, 
  DEFAULT_CONFIG, 
  DEFAULT_OPENAI_ENDPOINT, 
  DEFAULT_PROXY,
  DEFAULT_SUMMARY_PROMPT,
  LANGUAGES, 
  OpenAIEndpoint, 
  ProxyConfig, 
  RawCaption, 
  SentenceCard, 
  Session, 
  SessionMetadata, 
  TeamsWindowInfo,
  Toast 
} from "./types";
import { 
  IconCheck, 
  IconCopy, 
  IconChevronDown,
  IconFileText, 
  IconList,
  IconLanguages,
  IconMinus, 
  IconPlay, 
  IconPlus, 
  IconRetry, 
  IconSettings, 
  IconSquare, 
  IconX,
  IconWindowMinimize,
  IconWindowMaximize,
  IconWindowClose,
  IconEye,
  IconEyeOff
} from "./components/Icons";
import { Sidebar } from "./components/Sidebar";
import { 
  shouldOverwrite,
  getLatestCaption,
  generateId
} from "./utils/textUtils";
import { getNewSentences } from "./utils/captionProcessing";

// --- Constants ---
const MAX_IDLE_INTERVAL = 10;
const MAX_SYNC_INTERVAL = 20;

// --- Main App Component ---

function App() {
  const { t, i18n } = useTranslation();
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<string>(t("status.ready"));
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [isWindowVisible, setIsWindowVisible] = useState<boolean>(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isSummaryOpen, setIsSummaryOpen] = useState<boolean>(false);
  const [summaryText, setSummaryText] = useState<string>("");
  const [isSummarizing, setIsSummarizing] = useState<boolean>(false);
  const [appVersion, setAppVersion] = useState<string>("");
  const [isTranslateModalOpen, setIsTranslateModalOpen] = useState<boolean>(false);
  const [tempTranslations, setTempTranslations] = useState<Record<string, { translated: string; status: 'translating' | 'success' | 'error' }>>({});
  
  // Session State
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSessionName, setActiveSessionName] = useState<string>("");
  const [activeSessionCreatedAt, setActiveSessionCreatedAt] = useState<number>(0);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  
   const [cards, setCards] = useState<SentenceCard[]>([]);
   const [partialText, setPartialText] = useState<string>("");
   const [toasts, setToasts] = useState<Toast[]>([]);
   const [autoFollow, setAutoFollow] = useState<boolean>(true);
   
   // Teams Modal State
  const [isTeamsModalOpen, setIsTeamsModalOpen] = useState(false);
  const [teamsWindows, setTeamsWindows] = useState<TeamsWindowInfo[]>([]);
  const [isScanningTeams, setIsScanningTeams] = useState(false);
  const [isDeviceAuthOpen, setDeviceAuthOpen] = useState(false);
  
  const historyEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<SentenceCard[]>([]);
  const configRef = useRef<AppConfig>(DEFAULT_CONFIG);
  const saveTimeoutRef = useRef<number | null>(null);

  const lastFullTextRef = useRef<string>("");
  const lastOriginalTextRef = useRef<string>("");
  const lastProcessedCardRef = useRef<SentenceCard | null>(null);
  const idleCountRef = useRef<number>(0);
  const syncCountRef = useRef<number>(0);
  const isFirstCaptionRef = useRef<boolean>(true);
  const overlayMouseDownRef = useRef<boolean>(false);
  // Track processed sentences to prevent duplicates (especially for Teams mode)
  const processedSentencesRef = useRef<Set<string>>(new Set());

  const addToast = (type: 'success' | 'error', message: string) => {
    const id = generateId();
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3000);
  };

  // --- Session Management ---

  const refreshSessionList = async () => {
    try {
      const list = await invoke<SessionMetadata[]>("get_sessions");
      setSessions(list);
    } catch (e) {
      console.error("Failed to load sessions:", e);
    }
  };

  const handleCreateSession = async () => {
    try {
      const date = new Date();
      const name = `Session ${date.toLocaleString()}`;
      const session = await invoke<Session>("create_session", { name });
      await refreshSessionList();
      setActiveSessionId(session.id);
      setActiveSessionName(session.name);
      setActiveSessionCreatedAt(session.created_at);
      setCards([]); // Clear cards for new session
      setTempTranslations({}); // Clear temp translations
      setAutoFollow(true);
      lastProcessedCardRef.current = null;
      processedSentencesRef.current.clear(); // Clear dedup set for new session
      setPartialText("");
      lastFullTextRef.current = "";
      return session.id;
    } catch (e) {
      console.error("Failed to create session:", e);
      addToast('error', "Failed to create new session");
      return null;
    }
  };

  const handleSelectSession = async (id: string) => {
    if (isRunning) {
      // Optional: Confirm stop? For now just stop if switching
      // Actually, better to block switching while running or stop automatically
      // Let's stop automatically if they switch manually
      if (await tauriConfirm("Stop current capture to switch session?", { title: "Switch Session", kind: 'warning' })) {
        await toggleWatcher();
      } else {
        return;
      }
    }

    try {
      const session = await invoke<Session>("load_session_data", { id });
      setActiveSessionId(session.id);
      setActiveSessionName(session.name);
      setActiveSessionCreatedAt(session.created_at);
      setCards(session.cards);
      setTempTranslations({}); // Clear temp translations
      setAutoFollow(false); // Don't auto-scroll when loading history
      lastProcessedCardRef.current = session.cards.length > 0 ? session.cards[session.cards.length - 1] : null;
      processedSentencesRef.current.clear(); // Clear dedup set when switching sessions
      setPartialText("");
    } catch (e) {
      console.error("Failed to load session:", e);
      addToast('error', "Failed to load session data");
    }
  };

  const handleDeleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent selection
    if (!await tauriConfirm("Are you sure you want to delete this session?", { title: "Delete Session", kind: 'warning' })) return;
    
    try {
      await invoke("delete_session_data", { id });
      await refreshSessionList();
      if (activeSessionId === id) {
        setActiveSessionId(null);
        setActiveSessionName("");
        setCards([]);
        setTempTranslations({}); // Clear temp translations
        lastProcessedCardRef.current = null;
      }
      addToast('success', "Session deleted");
    } catch (err) {
      console.error("Failed to delete session:", err);
      addToast('error', "Failed to delete session");
    }
  };

  const handleRenameSession = async (newName: string) => {
      if (!activeSessionId || !activeSessionCreatedAt || !newName.trim() || newName === activeSessionName) return;
      try {
          const updatedSession: Session = {
              id: activeSessionId,
              name: newName,
              created_at: activeSessionCreatedAt,
              cards: cards
          };
          
          await invoke("save_session_data", { session: updatedSession });
          await refreshSessionList();
          setActiveSessionName(newName);
          addToast('success', "Session renamed");
      } catch (e) {
          console.error("Rename failed", e);
          addToast('error', "Failed to rename session");
      }
  };

  // Auto-save logic
  useEffect(() => {
    if (!activeSessionId || !activeSessionCreatedAt) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
        const sessionToSave: Session = {
            id: activeSessionId,
            name: activeSessionName,
            created_at: activeSessionCreatedAt,
            cards: cards
        };
        invoke("save_session_data", { session: sessionToSave }).catch(e => console.error("Auto-save failed", e));
    }, 2000); // 2 seconds debounce

    return () => {
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [cards, activeSessionId, activeSessionName, activeSessionCreatedAt]); // cards dependency triggers save

  // --- Effects ---

  useEffect(() => {
    cardsRef.current = cards;
    if (autoFollow) {
      historyEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [cards, partialText, autoFollow]);

  // Handle language change from config
  useEffect(() => {
    if (config.language && i18n.language !== config.language) {
      i18n.changeLanguage(config.language);
    }
  }, [config.language]);

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
          setConfig({
            ...DEFAULT_CONFIG,
            ...savedConfig,
            summary_prompt: savedConfig.summary_prompt || DEFAULT_SUMMARY_PROMPT, // Ensure default prompt if empty
            google_proxy: savedConfig.google_proxy || DEFAULT_PROXY,
            microsoft_proxy: savedConfig.microsoft_proxy || DEFAULT_PROXY,
            openai_endpoints: savedConfig.openai_endpoints?.length ? savedConfig.openai_endpoints : [DEFAULT_OPENAI_ENDPOINT],
          });
        }
        const running = await invoke<boolean>("is_watcher_running");
        setIsRunning(running);
        if (running) setStatus("Running");
        
        await refreshSessionList();
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

  // Handle scroll detection for auto-follow
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const distanceToBottom = scrollHeight - scrollTop - clientHeight;
      const threshold = 100; // pixels from bottom to consider "at bottom"

      if (distanceToBottom <= threshold) {
        // User is near/at bottom, enable auto-follow
        setAutoFollow(true);
      } else {
        // User is away from bottom, disable auto-follow
        setAutoFollow(false);
      }
    };

    container.addEventListener('scroll', handleScroll);
    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, []);

  // --- Logic ---

  const retryTranslation = async (cardId: string, originalText: string) => {
    setCards(prev => prev.map(c => c.id === cardId ? { ...c, retrying: true } : c));
    try {
      const currentCards = cardsRef.current;
      const currentConfig = configRef.current;
      const cardIndex = currentCards.findIndex(c => c.id === cardId);
      let context: string[] | null = null;
      
      if (currentConfig.provider.startsWith('openai:') && currentConfig.openai_context_count > 0 && cardIndex > 0) {
        const startIdx = Math.max(0, cardIndex - currentConfig.openai_context_count);
        context = currentCards.slice(startIdx, cardIndex).map(c => c.original);
      }
      
      const translated = await invoke<string>("translate_text", { text: originalText, context });
      setCards(prev => prev.map(c => c.id === cardId ? { ...c, translated, retrying: false, status: 'success' as const } : c));
    } catch (e) {
      console.error("Retry failed:", e);
      setCards(prev => prev.map(c => c.id === cardId ? { ...c, retrying: false } : c));
    }
  };

  const performTranslation = async (cardId: string, text: string) => {
    try {
      const currentCards = cardsRef.current;
      const currentConfig = configRef.current;
      
      let context: string[] | null = null;
      if (currentConfig.provider.startsWith('openai:') && currentConfig.openai_context_count > 0) {
        const cardIndex = currentCards.findIndex(c => c.id === cardId);
        if (cardIndex >= 0) {
          const startIdx = Math.max(0, cardIndex - currentConfig.openai_context_count);
          context = currentCards.slice(startIdx, cardIndex).map(c => c.original);
        } else {
          const startIdx = Math.max(0, currentCards.length - currentConfig.openai_context_count);
          context = currentCards.slice(startIdx).map(c => c.original);
        }
      }

      const translated = await invoke<string>("translate_text", { text, context });

      setCards(prev => prev.map(c => {
        if (c.id === cardId) {
          if (c.original !== text) return c;
          return { ...c, translated, status: 'success' as const };
        }
        return c;
      }));
    } catch (e) {
      console.error("Translation error:", e);
      setCards(prev => prev.map(c => {
        if (c.id === cardId) {
          if (c.original !== text) return c;
          return { ...c, translated: null, status: 'error' as const };
        }
        return c;
      }));
    }
  };

  const translateAndDisplay = async (originalText: string) => {
    if (!originalText.trim()) return;

    // Deduplication: skip if we've already processed this exact sentence
    const normalizedText = originalText.trim();
    if (processedSentencesRef.current.has(normalizedText)) {
      return;
    }

    const lastCard = lastProcessedCardRef.current;
    // Prevent infinite re-translation loop on idle if text hasn't changed
    if (lastCard && lastCard.original === originalText) {
      return;
    }

    // Always generate a new ID to ensure clean replacement (effectively "deleting" the old one)
    const newId = generateId();
    let isOverwrite = false;

    if (lastCard && shouldOverwrite(lastCard.original, originalText)) {
      isOverwrite = true;
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const newCard: SentenceCard = {
      id: newId,
      original: originalText,
      translated: null,
      status: 'translating',
      timestamp
    };

    lastProcessedCardRef.current = newCard;
    lastOriginalTextRef.current = originalText;
    syncCountRef.current = 0;
    // Mark as processed to prevent future duplicates
    processedSentencesRef.current.add(normalizedText);

    setCards(prev => {
      if (isOverwrite && prev.length > 0) {
        // Replace the last card with the NEW card (new ID)
        // This effectively removes the old card and its pending translation UI state
        return [...prev.slice(0, -1), newCard];
      } else {
        return [...prev, newCard].slice(-200);
      }
    });

    // Check if translation is enabled
    if (configRef.current.translation_enabled === false) {
      // Just leave it as null/translating until finalized? 
      // Actually if translation is disabled, we should just mark it as success but with null translation
      // to indicate "processing done, no translation needed"
      setCards(prev => prev.map(c => {
        if (c.id === newId) {
          return { ...c, translated: null, status: 'success' as const };
        }
        return c;
      }));
      return;
    }

    // Start translation for the NEW card
    // The old card's translation (if running) will fail to find the old ID in state and do nothing
    performTranslation(newId, originalText);
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
          translateAndDisplay(latestCaption);
          idleCountRef.current = 0;
        }
      } else {
        idleCountRef.current = 0;

        const newSentences = getNewSentences(fullText, lastFullTextRef.current);
        if (newSentences.length > 0) {
          newSentences.forEach(sentence => { void translateAndDisplay(sentence); });
        } else {
          syncCountRef.current++;
          if (syncCountRef.current >= MAX_SYNC_INTERVAL && latestCaption.trim()) {
            translateAndDisplay(latestCaption);
          }
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

  useEffect(() => {
    const unlistenVisibility = listen<boolean>("caption-visibility", (event) => {
      setIsWindowVisible(event.payload);
    });
    return () => {
        unlistenVisibility.then(f => f());
    }
  }, []);

  useEffect(() => {
      setIsWindowVisible(!config.hide_system_window);
  }, [config.hide_system_window]);

  const toggleVisibility = async () => {
    if (!isRunning) return;
    try {
        await invoke("toggle_livecaptions_visibility");
    } catch (e) {
        console.error("Failed to toggle visibility", e);
    }
  };

  const fetchTeamsWindows = async () => {
    setIsScanningTeams(true);
    try {
      const windows = await invoke<TeamsWindowInfo[]>('get_teams_windows');
      setTeamsWindows(windows);
    } catch (e) {
      console.error('Failed to get Teams windows:', e);
      addToast('error', "Failed to scan Teams windows");
      setTeamsWindows([]);
    } finally {
      setIsScanningTeams(false);
    }
  };

  const startCapture = async () => {
      // Starting: Create new session
      const sessionId = await handleCreateSession();
      if (!sessionId) return; // Failed to create

      isFirstCaptionRef.current = true;
      setStatus("Starting...");
      try {
        await invoke("start_caption_watcher");
        setIsRunning(true);
      } catch (err) {
        setStatus(`Failed to start: ${err}`);
        setIsRunning(false);
      }
  };

  const handleSelectTeamsWindow = async (hwnd: number) => {
      // Update config first
      const newConfig = { ...config, selected_teams_hwnd: hwnd };
      // Save config to backend so start_caption_watcher picks it up
      try {
          await invoke("save_config", { config: newConfig });
          setConfig(newConfig); // Update local state
      } catch (e) {
          console.error("Failed to save config before start:", e);
          setConfig(newConfig); 
      }
      
      setIsTeamsModalOpen(false);
      await startCapture();
  };

  const toggleWatcher = async () => {
    if (isRunning) {
      await invoke("stop_caption_watcher");
      setIsRunning(false);
      setStatus("Stopped");
      setPartialText("");
      
      // Immediate save and refresh list to show preview
      if (activeSessionId && activeSessionCreatedAt) {
        const sessionToSave: Session = {
          id: activeSessionId,
          name: activeSessionName,
          created_at: activeSessionCreatedAt,
          cards: cardsRef.current // Use ref for latest value
        };
        try {
          await invoke("save_session_data", { session: sessionToSave });
          await refreshSessionList();
        } catch (e) {
          console.error("Failed to save on stop:", e);
        }
      }
    } else {
       if (config.caption_source === 'teams') {
           setIsTeamsModalOpen(true);
           fetchTeamsWindows(); // Initial scan
           return;
       }
       await startCapture();
    }
  };


  const saveConfig = async (newConfig: AppConfig) => {
    try {
      await invoke("save_config", { config: newConfig });
      setConfig(newConfig);
      addToast('success', t("toast.configSaved"));
    } catch (err) {
      console.error("Failed to save config:", err);
      addToast('error', t("toast.configSaveFailed", { error: String(err) }));
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

  const handleTranslateSession = async (targetLang: string, providerOverride?: string) => {
    if (cards.length === 0) return;

    // Clear previous temp translations
    setTempTranslations({});

    // Initialize all cards as 'translating'
    const initialTranslations: Record<string, { translated: string; status: 'translating' | 'success' | 'error' }> = {};
    cards.forEach(card => {
      initialTranslations[card.id] = { translated: '', status: 'translating' };
    });
    setTempTranslations(initialTranslations);

    // Translate each card in parallel (backend handles concurrency limit)
    const promises = cards.map(async (card, cardIndex) => {
      try {
        let context: string[] | null = null;

        // Use override provider or config provider for context logic checks
        const effectiveProvider = providerOverride || config.provider;

        if (effectiveProvider.startsWith('openai:') && config.openai_context_count > 0 && cardIndex > 0) {
          const startIdx = Math.max(0, cardIndex - config.openai_context_count);
          context = cards.slice(startIdx, cardIndex).map(c => c.original);
        }

        const translated = await invoke<string>("translate_text", {
          text: card.original,
          context,
          targetLangOverride: targetLang,
          providerOverride
        });

        setTempTranslations(prev => ({
          ...prev,
          [card.id]: { translated, status: 'success' }
        }));
      } catch (e) {
        console.error(`Translation failed for card ${card.id}:`, e);
        setTempTranslations(prev => ({
          ...prev,
          [card.id]: { translated: '', status: 'error' }
        }));
      }
    });

    await Promise.all(promises);
  };

  const appWindow = getCurrentWindow();

  const handleWindowMinimize = () => appWindow.minimize();
  const handleWindowMaximize = () => appWindow.toggleMaximize();
  const handleWindowClose = () => appWindow.close();

  return (
    <div className="app-container" onContextMenu={import.meta.env.PROD ? (e) => e.preventDefault() : undefined}>
      {/* Custom Titlebar */}
      <div className="custom-titlebar">
        <div className="titlebar-drag" data-tauri-drag-region>
          <span className="titlebar-title" data-tauri-drag-region>{t("app.title")}</span>
        </div>
        <div className="titlebar-controls">
          <button className="titlebar-btn" onClick={handleWindowMinimize} title={t("titlebar.minimize")}>
            <IconWindowMinimize />
          </button>
          <button className="titlebar-btn" onClick={handleWindowMaximize} title={t("titlebar.maximize")}>
            <IconWindowMaximize />
          </button>
          <button className="titlebar-btn titlebar-btn-close" onClick={handleWindowClose} title={t("titlebar.close")}>
            <IconWindowClose />
          </button>
        </div>
      </div>

      <div className="app-content">
        <Sidebar 
          sessions={sessions}
          currentId={activeSessionId}
          onSelect={handleSelectSession}
          onDelete={handleDeleteSession}
          isOpen={isSidebarOpen} 
        />

      <div className="history-area">
        <div className="history-header">
          <div className="history-header-left">
            <button
              className="btn-icon"
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              title={isSidebarOpen ? t("sidebar.closeTooltip") : t("sidebar.openTooltip")}
              style={{ marginRight: '8px' }}
            >
              <IconList />
            </button>
            <span className="history-label">
              <span className={`label-icon ${isRunning ? 'active' : ''}`}>●</span>
              {isRenaming ? (
                  <input
                    autoFocus
                    className="session-name-input"
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={() => { handleRenameSession(renameValue); setIsRenaming(false); }}
                    onKeyDown={e => {
                        if (e.key === 'Enter') { handleRenameSession(renameValue); setIsRenaming(false); }
                        if (e.key === 'Escape') setIsRenaming(false);
                    }}
                    onClick={e => e.stopPropagation()}
                  />
                  ) : (
                  <span
                    onClick={() => {
                        if (activeSessionId) {
                            setRenameValue(activeSessionName);
                            setIsRenaming(true);
                        }
                    }}
                    title={activeSessionId ? t("sidebar.renameTooltip") : ""}
                    style={{ cursor: activeSessionId ? 'text' : 'default', borderBottom: activeSessionId ? '1px dashed var(--text-muted)' : 'none' }}
                  >
                    {activeSessionName || t("session.noSession")}
                  </span>
              )}
              <span style={{opacity: 0.5, marginLeft: 8}}>({cards.length})</span>
            </span>
          </div>
          <div className="history-header-right">
            <CopyButton cards={cards} addToast={addToast} />
            <button
              className="btn-icon"
              onClick={() => setIsTranslateModalOpen(true)}
              title="Translate Session"
              disabled={cards.length === 0}
              style={{ 
                color: cards.length > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
                cursor: cards.length > 0 ? 'pointer' : 'not-allowed'
              }}
            >
              <IconLanguages />
            </button>
          </div>
        </div>

        <div className="history-scroll" ref={scrollContainerRef}>
          {cards.length === 0 && !partialText ? (
            <div className="history-empty">
                {activeSessionId ? t("session.waitingForSpeech") : t("session.selectOrStart")}
            </div>
          ) : (
            <>
              {cards.map((item) => {
                // Check tempTranslations first for historical session translations
                const tempTrans = tempTranslations[item.id];
                const displayTranslated = tempTrans?.translated ?? item.translated;
                const displayStatus = tempTrans?.status ?? item.status;

                // Determine if we should show the translation block
                // 1. If temp translation exists (user actively translated this) -> SHOW
                // 2. If historical translation exists (item.translated is not null AND not empty) -> SHOW
                // 3. If running (live capture), respect config.translation_enabled -> SHOW/HIDE
                let shouldShowTranslation = false;
                if (!!tempTrans) {
                  shouldShowTranslation = true;
                } else if (item.translated && item.translated.trim().length > 0) {
                  shouldShowTranslation = true;
                } else if (isRunning && config.translation_enabled) {
                   shouldShowTranslation = true;
                }

                return (
                  <div key={item.id} className={`history-card ${displayStatus === 'error' || (!displayStatus && displayTranslated === null) ? 'failed' : ''}`}>
                    <div className="card-original">{item.original}</div>
                    {shouldShowTranslation && (
                      <>
                        {displayStatus === 'translating' ? (
                          <div className="typing-dots">
                            <span>.</span><span>.</span><span>.</span>
                          </div>
                        ) : displayTranslated ? (
                          <div className="card-translated">{displayTranslated}</div>
                        ) : (
                          <div className="card-failed">
                            <span className="failed-text">{t("translation.failed")}</span>
                            <button
                              className="btn-retry"
                              onClick={() => retryTranslation(item.id, item.original)}
                              disabled={item.retrying}
                              title={t("translation.retry")}
                            >
                              {item.retrying ? <span className="spinner" /> : <IconRetry />}
                            </button>
                          </div>
                        )}
                      </>
                    )}
                    {item.timestamp && (
                        <div style={{
                            position: 'absolute',
                            bottom: '4px',
                            right: '8px',
                            fontSize: '10px',
                            color: 'var(--text-muted)',
                            opacity: 0.7
                        }}>
                            {new Date(item.timestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'})}
                        </div>
                    )}
                  </div>
                );
              })}
              {partialText && (!cards.length || cards[cards.length - 1].original !== partialText) && (
                <div className="history-card partial">
                  <div className="card-original">{partialText}</div>
                  <div className="card-translating">...</div>
                </div>
              )}
            </>
          )}
          <div ref={historyEndRef} />
        </div>

        <footer className="control-bar">
            <div className="status-indicator">
            <div className={`status-dot ${isRunning ? 'active' : 'inactive'}`} />
            <span className={`status-text ${status.startsWith('Error') ? 'error' : ''}`} title={status}>{status}</span>
            </div>
            <div className="controls-center">
            <button
                className="btn-visibility"
                onClick={toggleVisibility}
                disabled={!isRunning}
                title={isWindowVisible ? t("controls.hideWindow") : t("controls.showWindow")}
                style={{ 
                    marginRight: '12px',
                    height: '40px',
                    width: '40px',
                    borderRadius: '20px',
                    border: 'none',
                    background: 'var(--bg-secondary)',
                    color: !isRunning ? 'var(--text-muted)' : (isWindowVisible ? 'var(--text-primary)' : 'var(--text-muted)'),
                    cursor: isRunning ? 'pointer' : 'not-allowed',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'all 0.2s',
                    opacity: isRunning ? 1 : 0.5
                }}
            >
                {isWindowVisible ? <IconEye /> : <IconEyeOff />}
            </button>
            <button className={`fab-main ${isRunning ? 'stop' : 'start'}`} onClick={toggleWatcher}>
                {isRunning ? <IconSquare /> : <IconPlay />}
                <span>{isRunning ? t("controls.stop") : t("controls.start")}</span>
            </button>
            <button
                className="btn-summary"
                onClick={handleSummarize}
                disabled={cards.length === 0}
                title={t("controls.summarize")}
                style={{ 
                marginLeft: '12px',
                height: '40px',
                width: '40px',
                borderRadius: '20px',
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
            <button className="btn-icon settings-btn" onClick={() => setIsSettingsOpen(true)} title={t("controls.settings")}>
                <IconSettings />
            </button>
            </div>
        </footer>
      </div>{/* End history-area */}
      </div>{/* End app-content */}

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
            <h2>{t("settings.title")}</h2>
            <button className="btn-icon" onClick={() => setIsSettingsOpen(false)}>
              <IconX />
            </button>
          </header>
          <div className="settings-content">
            <SettingsForm config={config} onSave={saveConfig} onStartCopilotAuth={() => setDeviceAuthOpen(true)} />
          </div>
        </div>
      </div>
      
      {isDeviceAuthOpen && (
        <DeviceAuthModal 
          isOpen={isDeviceAuthOpen}
          onClose={() => setDeviceAuthOpen(false)}
          onSuccess={(token) => {
            setConfig(prev => ({ ...prev, github_token: token }));
            saveConfig({ ...config, github_token: token });
            setDeviceAuthOpen(false);
          }}
        />
      )}
      
      <TeamsSelectionModal
        isOpen={isTeamsModalOpen}
        onClose={() => setIsTeamsModalOpen(false)}
        onSelect={handleSelectTeamsWindow}
        windows={teamsWindows}
        onRefresh={fetchTeamsWindows}
        isScanning={isScanningTeams}
      />

      <SummaryModal
        isOpen={isSummaryOpen}
        onClose={() => setIsSummaryOpen(false)}
        text={summaryText}
        isLoading={isSummarizing}
      />

      <TranslateModal
        isOpen={isTranslateModalOpen}
        onClose={() => setIsTranslateModalOpen(false)}
        onTranslate={handleTranslateSession}
        currentTargetLang={config.target_lang}
        config={config}
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

// --- Copy Button Component ---
function CopyButton({ cards, addToast }: { cards: SentenceCard[], addToast: (type: 'success' | 'error', msg: string) => void }) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const handleCopy = async (mode: 'all' | 'original' | 'translated') => {
    if (cards.length === 0) return;

    let text = "";
    cards.forEach(card => {
      const original = card.original?.trim() || "";
      const translated = card.translated?.trim() || "";
      
      if (mode === 'all') {
        // Format: Original\n**Translated**
        text += `${original}\n**${translated}**\n\n`;
      } else if (mode === 'original') {
        text += `${original}\n\n`;
      } else if (mode === 'translated') {
         if (translated) text += `${translated}\n\n`;
      }
    });

    try {
      await navigator.clipboard.writeText(text.trim());
      addToast('success', t("toast.copySuccess"));
    } catch (err) {
      console.error('Failed to copy:', err);
      addToast('error', t("toast.copyFailed"));
    }
    setIsOpen(false);
  };

  return (
    <div className="copy-split-btn" ref={menuRef}>
      <button 
        className="copy-main-btn"
        onClick={() => handleCopy('all')}
        title={t("copy.tooltip")}
        disabled={cards.length === 0}
      >
        <IconCopy />
      </button>
      <button 
        className="copy-dropdown-trigger"
        onClick={() => setIsOpen(!isOpen)}
        disabled={cards.length === 0}
        title={t("copy.moreOptions")}
      >
        <IconChevronDown />
      </button>
      
      {isOpen && (
        <div className="copy-dropdown-menu">
          <button className="copy-dropdown-item" onClick={() => handleCopy('original')}>
            {t("copy.originalOnly")}
          </button>
          <button className="copy-dropdown-item" onClick={() => handleCopy('translated')}>
             {t("copy.translationOnly")}
          </button>
        </div>
      )}
    </div>
  );
}

// --- Proxy Config Component ---

function ProxyConfigForm({ proxy, onChange, label }: { proxy: ProxyConfig; onChange: (p: ProxyConfig) => void; label: string }) {
  const { t } = useTranslation();
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
          <label>{t("settings.translation.proxyUrl")}</label>
          <input
            type="text"
            value={proxy.url || ''}
            onChange={e => onChange({ ...proxy, url: e.target.value })}
            placeholder={t("settings.translation.proxyUrlPlaceholder")}
          />
        </div>
      )}
    </div>
  );
}

// --- Summary Modal Component ---
function SummaryModal({ isOpen, onClose, text, isLoading }: { isOpen: boolean; onClose: () => void; text: string; isLoading: boolean }) {
  const { t } = useTranslation();
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
          <h2>{t("summary.title")}</h2>
          <div style={{ display: 'flex', gap: '8px' }}>
            {!isLoading && text && (
              <button
                className="btn-icon"
                onClick={handleCopy}
                title={t("summary.copyToClipboard")}
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
              <div>{t("summary.generating")}</div>
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

// --- Translate Modal Component ---
function TranslateModal({
  isOpen,
  onClose,
  onTranslate,
  currentTargetLang,
  config
}: {
  isOpen: boolean;
  onClose: () => void;
  onTranslate: (targetLang: string, providerOverride?: string) => void;
  currentTargetLang: string;
  config: AppConfig;
}) {
  const { t } = useTranslation();
  const [selectedLang, setSelectedLang] = useState<string>(currentTargetLang);
  const [selectedProvider, setSelectedProvider] = useState<string>('google');
  const [selectedEndpointId, setSelectedEndpointId] = useState<string>('default');

  useEffect(() => {
    if (isOpen) {
      setSelectedLang(currentTargetLang);
      // Initialize from current config
      if (config.provider.startsWith('openai:')) {
          setSelectedProvider('openai');
          setSelectedEndpointId(config.provider.slice(7) || 'default');
      } else {
          setSelectedProvider(config.provider);
      }
    }
  }, [isOpen, currentTargetLang, config]);

  const handleTranslate = () => {
    let providerString = selectedProvider;
    if (selectedProvider === 'openai') {
        providerString = `openai:${selectedEndpointId}`;
    }
    onTranslate(selectedLang, providerString);
    onClose();
  };

  if (!isOpen) return null;
  return (
    <div className="settings-overlay open" onClick={onClose}>
      <div className="settings-drawer" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px', width: '90%' }}>
        <header className="settings-header">
          <h2>{t("translateSession.title")}</h2>
          <button className="btn-icon" onClick={onClose}>
            <IconX />
          </button>
        </header>
        <div className="settings-content" style={{ padding: '20px' }}>
          
          {/* Provider Selection */}
          <div className="form-group" style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-primary)', fontWeight: 500 }}>
              {t("settings.translation.provider")}
            </label>
            <select
              value={selectedProvider}
              onChange={e => setSelectedProvider(e.target.value)}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: 'var(--bg-input)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                fontSize: '14px',
                outline: 'none',
                cursor: 'pointer'
              }}
            >
              <option value="google">{t("settings.translation.google")}</option>
              <option value="microsoft">{t("settings.translation.microsoft")}</option>
              <option value="openai">{t("settings.translation.openai")}</option>
              <option value="copilot">GitHub Copilot</option>
            </select>
          </div>

          {/* OpenAI Endpoint Selection */}
          {selectedProvider === 'openai' && config.openai_endpoints.length > 1 && (
            <div className="form-group" style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-primary)', fontWeight: 500 }}>
                {t("settings.translation.endpoint")}
              </label>
              <select
                value={selectedEndpointId}
                onChange={e => setSelectedEndpointId(e.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  background: 'var(--bg-input)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '6px',
                  fontSize: '14px',
                  outline: 'none',
                  cursor: 'pointer'
                }}
              >
                {config.openai_endpoints.map(ep => (
                  <option key={ep.id} value={ep.id}>
                    {ep.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="form-group" style={{ marginBottom: '20px' }}>
            <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-primary)', fontWeight: 500 }}>
              {t("translateSession.targetLanguage")}
            </label>
            <select
              value={selectedLang}
              onChange={e => setSelectedLang(e.target.value)}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: 'var(--bg-input)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                fontSize: '14px',
                outline: 'none',
                cursor: 'pointer'
              }}
            >
              {LANGUAGES.filter(l => l.code !== 'auto').map(lang => (
                <option key={lang.code} value={lang.code}>
                  {lang.name}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
            <button
              className="btn-save"
              onClick={handleTranslate}
              style={{
                flex: 1,
                padding: '10px 16px',
                background: 'var(--primary)',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'opacity 0.2s'
              }}
              onMouseEnter={e => e.currentTarget.style.opacity = '0.9'}
              onMouseLeave={e => e.currentTarget.style.opacity = '1'}
            >
              {t("translateSession.translate")}
            </button>
            <button
              onClick={onClose}
              style={{
                flex: 1,
                padding: '10px 16px',
                background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'opacity 0.2s'
              }}
              onMouseEnter={e => e.currentTarget.style.opacity = '0.8'}
              onMouseLeave={e => e.currentTarget.style.opacity = '1'}
            >
              {t("translateSession.cancel")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Teams Selection Modal ---
function TeamsSelectionModal({
  isOpen,
  onClose,
  onSelect,
  windows,
  onRefresh,
  isScanning
}: {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (hwnd: number) => void;
  windows: TeamsWindowInfo[];
  onRefresh: () => void;
  isScanning: boolean;
}) {
  const { t } = useTranslation();
  
  if (!isOpen) return null;

  return (
    <div className="settings-overlay open" onClick={onClose}>
      <div className="settings-drawer" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px', width: '90%' }}>
        <header className="settings-header">
          <h2>{t("teams.selectWindow")}</h2>
          <button className="btn-icon" onClick={onClose}>
            <IconX />
          </button>
        </header>
        <div className="settings-content" style={{ padding: '20px' }}>
          <p style={{ marginBottom: '16px', color: 'var(--text-primary)', fontSize: '14px' }}>
            {t("teams.description")}
          </p>

          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <label style={{ display: 'block', color: 'var(--text-primary)', fontWeight: 500 }}>
                {t("teams.availableWindows")}
              </label>
              <button 
                type="button" 
                onClick={onRefresh} 
                disabled={isScanning}
                style={{ 
                  padding: '2px 8px', 
                  fontSize: '11px', 
                  background: 'transparent', 
                  border: '1px solid var(--border-color)',
                  borderRadius: '4px',
                  cursor: isScanning ? 'default' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  color: 'var(--text-primary)'
                }}
              >
                {isScanning ? <IconRetry className="spin" size={12} /> : <IconRetry size={12} />}
                <span style={{ marginLeft: '4px' }}>{t("teams.refresh")}</span>
              </button>
            </div>

            {windows.length === 0 ? (
              <div style={{ 
                padding: '12px', 
                background: 'var(--bg-input)', 
                border: '1px dashed var(--border-color)', 
                borderRadius: '6px',
                color: 'var(--text-muted)',
                fontSize: '13px',
                textAlign: 'center'
              }}>
                {isScanning ? t("teams.scanning") : t("teams.noWindows")}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {windows.map(win => (
                  <button
                    key={win.hwnd}
                    onClick={() => onSelect(win.hwnd)}
                    style={{
                      padding: '10px',
                      background: 'var(--bg-input)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '6px',
                      textAlign: 'left',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      color: 'var(--text-primary)'
                    }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--primary)'}
                    onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-color)'}
                  >
                    <div style={{ fontWeight: 500, fontSize: '14px' }}>{win.title}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>PID: {win.pid}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'flex-end' }}>
             <button
              onClick={onClose}
              style={{
                padding: '8px 16px',
                background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer'
              }}
            >
              {t("teams.cancel")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Settings Form ---
function SettingsForm({ config, onSave, onStartCopilotAuth }: { config: AppConfig; onSave: (c: AppConfig) => void; onStartCopilotAuth: () => void }) {
  const { t, i18n } = useTranslation();
  const [formData, setFormData] = useState<AppConfig>(config);
  const [activeTab, setActiveTab] = useState<'general' | 'translation' | 'ai' | 'summary'>('general');

  useEffect(() => {
    setFormData(config);
  }, [config]);

  // Handle immediate language change
  useEffect(() => {
    if (formData.language && i18n.language !== formData.language) {
      i18n.changeLanguage(formData.language);
    }
  }, [formData.language, i18n]);

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
       {/* Caption Source */}
       <div className="form-group">
        <label>{t("settings.general.captionSource")}</label>
        <select
          value={formData.caption_source || 'livecaptions'}
          onChange={e => setFormData(prev => ({ ...prev, caption_source: e.target.value }))}
        >
          <option value="livecaptions">{t("settings.general.captionSourceLiveCaptions")}</option>
          <option value="teams">{t("settings.general.captionSourceTeams")}</option>
        </select>
        
        {/* Teams selection moved to start workflow */}
        {formData.caption_source === 'teams' && (
          <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
            Teams window selection will appear when you click Start.
          </div>
        )}
      </div>


       {/* Language Settings */}
       <div className="form-group">
        <label>{t("settings.general.language")}</label>
        <select
          value={formData.language || 'en'}
          onChange={e => setFormData(prev => ({ ...prev, language: e.target.value }))}
        >
          <option value="en">English</option>
          <option value="zh-CN">简体中文</option>
        </select>
      </div>

       {/* Theme Settings */}
       <div className="form-group">
        <label>{t("settings.general.theme")}</label>
        <select
          value={formData.theme || 'dark'}
          onChange={e => setFormData(prev => ({ ...prev, theme: e.target.value }))}
        >
          <option value="dark">{t("settings.general.themeDark")}</option>
          <option value="light">{t("settings.general.themeLight")}</option>
        </select>
      </div>

      {/* Opacity Settings */}
      <div className="form-group">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
          <label>{t("settings.general.backgroundOpacity")}</label>
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

      {/* Hide Window & Include Microphone - Only for LiveCaptions */}
      {formData.caption_source !== 'teams' && (
        <>
          <div className="form-group checkbox-group">
            <label className="switch">
              <input type="checkbox" checked={formData.hide_system_window} onChange={e => setFormData(prev => ({ ...prev, hide_system_window: e.target.checked }))} />
              <span className="slider round"></span>
            </label>
            <span>{t("settings.general.hideSystemWindow")}</span>
          </div>

          <div className="form-group checkbox-group">
            <label className="switch">
              <input type="checkbox" checked={formData.include_microphone} onChange={e => setFormData(prev => ({ ...prev, include_microphone: e.target.checked }))} />
              <span className="slider round"></span>
            </label>
            <span>{t("settings.general.includeMicrophone")}</span>
          </div>
        </>
      )}

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
        <span>{t("settings.general.alwaysOnTop")}</span>
      </div>
    </div>
  );

  const renderTranslationTab = () => (
    <div className="tab-panel">
      {/* Enable Translation Toggle */}
      <div className="form-group checkbox-group" style={{ marginBottom: '16px' }}>
        <label className="switch">
          <input
            type="checkbox"
            checked={formData.translation_enabled !== false} // Default to true if undefined
            onChange={e => setFormData(prev => ({ ...prev, translation_enabled: e.target.checked }))}
          />
          <span className="slider round"></span>
        </label>
        <span>{t("settings.translation.enableTranslation")}</span>
      </div>

      {/* Max Concurrent Translations */}
      <div className="form-group">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
          <label>{t("settings.translation.maxConcurrent")}</label>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{formData.max_concurrent_translations ?? 2}</span>
        </div>
        <input
          type="range"
          min="1"
          max="10"
          step="1"
          value={formData.max_concurrent_translations ?? 2}
          onChange={e => setFormData(prev => ({ ...prev, max_concurrent_translations: parseInt(e.target.value) }))}
          style={{ width: '100%', accentColor: 'var(--primary)', cursor: 'pointer' }}
        />
      </div>

      {/* Language Settings */}
      <div className="form-row">
        <div className="form-group">
          <label>{t("settings.translation.sourceLanguage")}</label>
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
          <label>{t("settings.translation.targetLanguage")}</label>
          <select
            value={formData.target_lang}
            onChange={e => setFormData(prev => ({ ...prev, target_lang: e.target.value }))}
          >
            {LANGUAGES.filter(l => l.code !== 'auto').map(lang => (
              <option key={lang.code} value={lang.code}>
                {lang.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Provider Selection */}
      <div className="form-group">
        <label>{t("settings.translation.provider")}</label>
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
          <option value="google">{t("settings.translation.google")}</option>
          <option value="microsoft">{t("settings.translation.microsoft")}</option>
          <option value="openai">{t("settings.translation.openai")}</option>
          <option value="copilot">GitHub Copilot</option>
        </select>
      </div>

      {/* Copilot Auth */}
      {formData.provider === 'copilot' && (
        <div className="form-group" style={{ padding: '16px', background: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: 600, marginBottom: '4px', color: 'var(--text-primary)' }}>GitHub Copilot</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  {formData.github_token ? "Logged in" : "Not logged in"}
                </div>
              </div>
              {formData.github_token ? (
                <button 
                  className="btn-secondary"
                  onClick={() => setFormData(prev => ({ ...prev, github_token: null }))}
                  style={{ fontSize: '13px', padding: '6px 12px', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', cursor: 'pointer' }}
                >
                  Logout
                </button>
              ) : (
                <button 
                  className="btn-primary"
                  onClick={onStartCopilotAuth}
                  style={{ fontSize: '13px', padding: '6px 12px', background: '#2da44e', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
                >
                  Login with GitHub
                </button>
              )}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
              Authenticate with your GitHub account to use Copilot models.
            </div>
        </div>
      )}

      {/* OpenAI Endpoint Selection */}
      {selectedProvider.type === 'openai' && formData.openai_endpoints.length > 1 && (
        <div className="form-group">
          <label>{t("settings.translation.selectEndpoint")}</label>
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
              <label style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{t("settings.translation.contextMemory")}</label>
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
                {formData.openai_context_count ?? 2} {t("settings.translation.contextMemoryUnit")}
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
              {t("settings.translation.contextMemoryNote")}
              { (formData.openai_context_count ?? 2) > 4 &&
                <span style={{ color: 'var(--warning)', marginLeft: '6px' }}>
                  {t("settings.translation.contextMemoryWarning")}
                </span>
              }
            </div>
          </div>
        </div>
      )}

      {/* Google Settings */}
      {formData.provider === 'google' && (
        <>
          <div className="divider">{t("settings.translation.googleSettings")}</div>
          <ProxyConfigForm
            proxy={formData.google_proxy}
            onChange={p => setFormData(prev => ({ ...prev, google_proxy: p }))}
            label={t("settings.translation.useProxy")}
          />
        </>
      )}

      {/* Microsoft Settings */}
      {formData.provider === 'microsoft' && (
        <>
          <div className="divider">{t("settings.translation.microsoftSettings")}</div>
          <div className="form-group">
            <label>{t("settings.translation.apiKey")}</label>
            <input type="password" value={formData.microsoft_api_key || ''} onChange={e => setFormData(prev => ({ ...prev, microsoft_api_key: e.target.value }))} />
          </div>
          <div className="form-group">
            <label>{t("settings.translation.region")}</label>
            <input type="text" value={formData.microsoft_region || ''} onChange={e => setFormData(prev => ({ ...prev, microsoft_region: e.target.value }))} placeholder={t("settings.translation.regionPlaceholder")} />
          </div>
          <ProxyConfigForm
            proxy={formData.microsoft_proxy}
            onChange={p => setFormData(prev => ({ ...prev, microsoft_proxy: p }))}
            label={t("settings.translation.useProxy")}
          />
        </>
      )}
    </div>
  );

  const renderAIConfigTab = () => (
    <div className="tab-panel">
      <div className="divider">
        {t("settings.ai.title")}
        <button className="btn-add-endpoint" onClick={addEndpoint} title={t("settings.ai.addEndpoint")}>
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
              placeholder={t("settings.ai.endpointNamePlaceholder")}
            />
            {formData.openai_endpoints.length > 1 && (
              <button className="btn-remove-endpoint" onClick={() => removeEndpoint(idx)} title={t("settings.ai.removeEndpoint")}>
                <IconMinus />
              </button>
            )}
          </div>
          <div className="form-group">
            <label>{t("settings.translation.apiKey")}</label>
            <input type="password" value={ep.api_key} onChange={e => updateEndpoint(idx, { api_key: e.target.value })} />
          </div>
          <div className="form-group">
            <label>{t("settings.ai.baseUrl")}</label>
            <input type="text" value={ep.base_url} onChange={e => updateEndpoint(idx, { base_url: e.target.value })} placeholder={t("settings.ai.baseUrlPlaceholder")} />
          </div>
          <div className="form-group">
            <label>{t("settings.ai.model")}</label>
            <input type="text" value={ep.model} onChange={e => updateEndpoint(idx, { model: e.target.value })} placeholder={t("settings.ai.modelPlaceholder")} />
          </div>
          <ProxyConfigForm
            proxy={ep.proxy}
            onChange={p => updateEndpoint(idx, { proxy: p })}
            label={t("settings.translation.useProxy")}
          />
        </div>
      ))}
    </div>
  );

  const renderSummaryTab = () => (
    <div className="tab-panel">
      <div className="form-group">
        <label>{t("settings.summary.provider")}</label>
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
          {t("settings.summary.description")}
        </div>
      </div>

      <div className="form-group">
        <label>{t("settings.summary.prompt")}</label>
        <textarea
          value={formData.summary_prompt || ''}
          onChange={e => setFormData(prev => ({ ...prev, summary_prompt: e.target.value }))}
          placeholder={t("settings.summary.promptPlaceholder")}
          rows={10}
          style={{ 
            width: '100%', 
            resize: 'vertical', 
            fontFamily: 'inherit',
            background: 'var(--bg-input)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-color)',
            borderRadius: '6px',
            padding: '10px 12px',
            fontSize: '14px',
            outline: 'none',
            transition: 'border-color 0.2s',
            lineHeight: '1.5'
          }}
          onFocus={e => e.target.style.borderColor = 'var(--primary)'}
          onBlur={e => e.target.style.borderColor = 'var(--border-color)'}
        />
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
          {t("settings.tabs.general")}
        </button>
        <button
          className={`tab-btn ${activeTab === 'translation' ? 'active' : ''}`}
          onClick={() => setActiveTab('translation')}
        >
          {t("settings.tabs.translation")}
        </button>
        <button
          className={`tab-btn ${activeTab === 'ai' ? 'active' : ''}`}
          onClick={() => setActiveTab('ai')}
        >
          {t("settings.tabs.ai")}
        </button>
        <button
          className={`tab-btn ${activeTab === 'summary' ? 'active' : ''}`}
          onClick={() => setActiveTab('summary')}
        >
          {t("settings.tabs.summary")}
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
          <IconCheck /> {t("settings.save")}
        </button>
      </div>
    </div>
  );
}


interface DeviceAuthData {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
}

function DeviceAuthModal({ isOpen, onClose, onSuccess }: { isOpen: boolean; onClose: () => void; onSuccess: (token: string) => void }) {
  const [authData, setAuthData] = useState<DeviceAuthData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);

  useEffect(() => {
    if (isOpen && !authData && !isPolling) {
      startAuth();
    }
  }, [isOpen]);

  const startAuth = async () => {
    try {
      setError(null);
      const data = await invoke<DeviceAuthData>('start_copilot_auth');
      setAuthData(data);
      pollToken(data.device_code, data.interval);
    } catch (e) {
      setError(String(e));
    }
  };

  const pollToken = async (deviceCode: string, interval: number) => {
    setIsPolling(true);
    try {
      const token = await invoke<string>('poll_copilot_token', { deviceCode, interval });
      onSuccess(token);
    } catch (e) {
      if (String(e).includes('cancelled') || !isOpen) return; // Stopped by user
      setError(String(e));
    } finally {
      setIsPolling(false);
    }
  };

  const copyCode = async () => {
    if (authData?.user_code) {
      await navigator.clipboard.writeText(authData.user_code);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="settings-overlay open" onClick={onClose}>
      <div className="settings-drawer" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px', width: '90%' }}>
        <header className="settings-header">
          <h2>Login to GitHub</h2>
          <button className="btn-icon" onClick={onClose}><IconX /></button>
        </header>
        <div className="settings-content" style={{ padding: '24px', textAlign: 'center' }}>
          {error ? (
            <div style={{ color: 'var(--error)', marginBottom: '16px' }}>
              Error: {error}
              <button className="btn-secondary" onClick={startAuth} style={{ marginTop: '12px', width: '100%' }}>Retry</button>
            </div>
          ) : authData ? (
            <>
              <p style={{ marginBottom: '16px', color: 'var(--text-primary)' }}>
                Please enter the following code at GitHub:
              </p>
              <div style={{ 
                fontSize: '24px', 
                fontWeight: 'bold', 
                letterSpacing: '4px', 
                background: 'var(--bg-input)', 
                padding: '16px', 
                borderRadius: '8px',
                marginBottom: '24px',
                userSelect: 'all',
                color: 'var(--primary)'
              }}>
                {authData.user_code}
              </div>
              <div style={{ marginBottom: '24px', fontSize: '12px', color: 'var(--text-muted)' }}>
                Waiting for authentication...
              </div>
              <a 
                href={authData.verification_uri} 
                target="_blank" 
                rel="noreferrer"
                onClick={copyCode}
                className="btn-primary"
                style={{ 
                  display: 'block', 
                  textDecoration: 'none', 
                  padding: '12px', 
                  borderRadius: '6px',
                  background: '#2da44e',
                  color: 'white',
                  fontWeight: 600
                }}
              >
                Copy Code & Open GitHub
              </a>
            </>
          ) : (
            <div className="summary-loading">
               <span className="spinner"></span>
               <div style={{ marginTop: '12px' }}>Connecting to GitHub...</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
