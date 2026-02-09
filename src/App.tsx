import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog';
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import "./App.css";
import "./App.legacy.css";
import { 
  AppConfig, 
  DEFAULT_CONFIG, 
  DEFAULT_PROXY,
  DEFAULT_SUMMARY_PROMPT,
  RawCaption, 
  SentenceCard, 
  Session, 
  SessionMetadata, 
  TeamsWindowInfo,
  Toast,
  TranslationStatus,
} from "./types";
import { 
  IconCheck, 
  IconFileText, 
  IconList,
  IconLanguages,
  IconPlay, 
  IconSettings, 
  IconSquare, 
  IconX,
  IconWindowMinimize,
  IconWindowMaximize,
  IconWindowClose,
  IconPin,
  IconEye,
  IconEyeOff,
} from "./components/Icons";
import { Sidebar } from "./components/Sidebar";
import { CaptionsList } from "./components/CaptionsList";
import { CopyButton } from "./components/CopyButton";
import { SettingsForm } from "./components/settings/SettingsForm";
import { SummaryModal } from "./components/modals/SummaryModal";
import { TranslateModal } from "./components/modals/TranslateModal";
import { TeamsSelectionModal } from "./components/modals/TeamsSelectionModal";
import { DeviceAuthModal } from "./components/modals/DeviceAuthModal";
import { 
  shouldOverwrite,
  getLatestCaption,
  generateId
} from "./utils/textUtils";
import { getNewSentences } from "./utils/captionProcessing";

// --- Constants ---
const MAX_IDLE_INTERVAL = 10;
const MAX_SYNC_INTERVAL = 20;
const MAX_TRANSLATION_BATCH_SIZE = 10;

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
  const [tempTranslations, setTempTranslations] = useState<Record<string, { translated: string; status: TranslationStatus }>>({});
  
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
  const [listScrollTop, setListScrollTop] = useState(0);
  const [listViewportHeight, setListViewportHeight] = useState(0);
   
   // Teams Modal State
  const [isTeamsModalOpen, setIsTeamsModalOpen] = useState(false);
  const [teamsWindows, setTeamsWindows] = useState<TeamsWindowInfo[]>([]);
  const [isScanningTeams, setIsScanningTeams] = useState(false);
  const [isDeviceAuthOpen, setDeviceAuthOpen] = useState(false);
  const [authChannelId, setAuthChannelId] = useState<string | null>(null);

  const historyEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<SentenceCard[]>([]);
  const configRef = useRef<AppConfig>(DEFAULT_CONFIG);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lastFullTextRef = useRef<string>("");
  const lastOriginalTextRef = useRef<string>("");
  const lastProcessedCardRef = useRef<SentenceCard | null>(null);
  const pendingTranslationCardIdRef = useRef<string | null>(null); // Teams mode: card waiting for translation
  const translationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleCountRef = useRef<number>(0);
  const syncCountRef = useRef<number>(0);
  const isFirstCaptionRef = useRef<boolean>(true);
  const overlayMouseDownRef = useRef<boolean>(false);


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

  const handleCreateSession = async (name?: string) => {
    try {
      const sessionName = name || `Session ${new Date().toLocaleString()}`;
      const session = await invoke<Session>("create_session", { name: sessionName });
      await refreshSessionList();
      setActiveSessionId(session.id);
      setActiveSessionName(session.name);
      setActiveSessionCreatedAt(session.created_at);
      setCards([]); // Clear cards for new session
      setTempTranslations({}); // Clear temp translations
      setAutoFollow(true);
      lastProcessedCardRef.current = null;

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

      setPartialText("");
    } catch (e) {
      console.error("Failed to load session:", e);
      addToast('error', "Failed to load session data");
    }
  };

  const handleDeleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent selection
    if (!await tauriConfirm(t("session.deleteConfirm"), { title: "Delete Session", kind: 'warning' })) return;
    
    try {
      await invoke("delete_session_data", { id });
      await refreshSessionList();
      if (activeSessionId === id) {
        setActiveSessionId(null);
        setActiveSessionName("");
        setActiveSessionCreatedAt(0);
        setCards([]);
        setTempTranslations({}); // Clear temp translations
        lastProcessedCardRef.current = null;
        setPartialText("");
      }
      addToast('success', t("session.deleted"));
    } catch (err) {
      console.error("Failed to delete session:", err);
      addToast('error', t("session.failedToDelete"));
    }
  };

  const handleClearAllSessions = async () => {
    if (sessions.length === 0) return;
    if (!await tauriConfirm(t("session.clearAllConfirm"), { title: "Clear All Sessions", kind: 'warning' })) return;

    try {
      await invoke("delete_all_sessions_command");
      await refreshSessionList();
      
      // Reset current session state
      setActiveSessionId(null);
      setActiveSessionName("");
      setActiveSessionCreatedAt(0);
      setCards([]);
      setTempTranslations({});
      lastProcessedCardRef.current = null;
      setPartialText("");
      
      addToast('success', t("session.deleted"));
    } catch (e) {
      console.error("Failed to clear all sessions:", e);
      addToast('error', "Failed to clear sessions");
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

    setListViewportHeight(container.clientHeight);

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const distanceToBottom = scrollHeight - scrollTop - clientHeight;
      const threshold = 100; // pixels from bottom to consider "at bottom"

      setListScrollTop(scrollTop);
      setListViewportHeight(prev => (prev === clientHeight ? prev : clientHeight));

      if (distanceToBottom <= threshold) {
        // User is near/at bottom, enable auto-follow
        setAutoFollow(true);
      } else {
        // User is away from bottom, disable auto-follow
        setAutoFollow(false);
      }
    };

    const handleResize = () => {
      const nextHeight = container.clientHeight;
      setListViewportHeight(prev => (prev === nextHeight ? prev : nextHeight));
    };

    container.addEventListener('scroll', handleScroll);
    window.addEventListener('resize', handleResize);

    handleScroll();

    return () => {
      container.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  // Disable Context Menu in Production
  useEffect(() => {
    if (import.meta.env.PROD) {
      const handleContextMenu = (e: MouseEvent) => {
        e.preventDefault();
      };
      
      document.addEventListener('contextmenu', handleContextMenu);

      return () => {
        document.removeEventListener('contextmenu', handleContextMenu);
      };
    }
  }, []);

  // --- Logic ---

  const retryTranslation = async (cardId: string, originalText: string) => {
    setCards(prev => prev.map(c => c.id === cardId ? { ...c, retrying: true } : c));
    try {
      const currentCards = cardsRef.current;
      const currentConfig = configRef.current;
      const cardIndex = currentCards.findIndex(c => c.id === cardId);
      let context: string[] | null = null;

      // Include context for AI models (not Google/Microsoft)
      const isAIModel = currentConfig.provider !== 'google' && currentConfig.provider !== 'microsoft';
      if (isAIModel && currentConfig.openai_context_count > 0 && cardIndex > 0) {
        const startIdx = Math.max(0, cardIndex - currentConfig.openai_context_count);
        context = currentCards.slice(startIdx, cardIndex).map(c => c.original);
      }

      const translated = await invoke<string>("translate_text", { text: originalText, context });
      setCards(prev => prev.map(c => c.id === cardId ? { ...c, translated, retrying: false, status: 'success' as TranslationStatus } : c));
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
      // Include context for AI models (not Google/Microsoft)
      const isAIModel = currentConfig.provider !== 'google' && currentConfig.provider !== 'microsoft';
      if (isAIModel && currentConfig.openai_context_count > 0) {
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
          return { ...c, translated, status: 'success' as TranslationStatus };
        }
        return c;
      }));
    } catch (e) {
      console.error("Translation error:", e);
      setCards(prev => prev.map(c => {
        if (c.id === cardId) {
          if (c.original !== text) return c;
          return { ...c, translated: null, status: 'error' as TranslationStatus };
        }
        return c;
      }));
    }
  };

  const translateAndDisplay = async (originalText: string, allowDuplicate: boolean = false, user?: string) => {
    if (!originalText.trim()) return;

    const lastCard = lastProcessedCardRef.current;
    // Prevent infinite re-translation loop on idle if text hasn't changed
    // BUT allow duplicate if explicitly requested (from new sentences detection)
    if (!allowDuplicate && lastCard && lastCard.original === originalText) {
      return;
    }

    // Always generate a new ID to ensure clean replacement (effectively "deleting" the old one)
    const newId = generateId();
    let isOverwrite = false;

    // Always check overwrite logic, even for new sentences
    // A "new sentence" might be a continuation/completion of a partial sentence
    if (lastCard && shouldOverwrite(lastCard.original, originalText)) {
      isOverwrite = true;
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const newCard: SentenceCard = {
      id: newId,
      original: originalText,
      translated: null,
      status: 'translating',
      user,
      timestamp
    };

    lastProcessedCardRef.current = newCard;
    lastOriginalTextRef.current = originalText;
    syncCountRef.current = 0;


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
        return { ...c, translated: null, status: 'success' as TranslationStatus };
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
      const user = event.payload.user;

      if (isFirstCaptionRef.current) {
        isFirstCaptionRef.current = false;
        lastFullTextRef.current = fullText;
        return;
      }

      // Teams Mode: Delayed translation strategy with Overwrite support & 3s Timeout
      if (configRef.current.caption_source === 'teams') {
        if (fullText !== lastFullTextRef.current && fullText.trim()) {
          // Clear any existing 3s timer
          if (translationTimerRef.current) {
            clearTimeout(translationTimerRef.current);
          }

          const lastCard = lastProcessedCardRef.current;
          
          // Helper to trigger translation for a pending card
          const triggerTranslation = (cardId: string) => {
             if (!configRef.current.translation_enabled) return;
             
             // IMPORTANT: Only now show the loading dots
             setCards(prev => prev.map(c => 
               c.id === cardId ? { ...c, status: 'translating' } : c
             ));

             const card = cardsRef.current.find(c => c.id === cardId);
             if (card) {
               performTranslation(cardId, card.original);
             }
          };

          // Check if this is an incremental update (continuation) of the last card
          if (lastCard && shouldOverwrite(lastCard.original, fullText)) {
            // Update the existing card, but keep status 'success' to hide dots
            setCards(prev => prev.map(c => 
              c.id === lastCard.id ? { ...c, original: fullText, status: 'success', translated: null } : c
            ));
            
            pendingTranslationCardIdRef.current = lastCard.id;
            lastProcessedCardRef.current = { ...lastCard, original: fullText };
          } else {
            // NEW message bubble or person
            // 1. Immediately trigger translation for the PREVIOUS finalized card
            if (pendingTranslationCardIdRef.current) {
              triggerTranslation(pendingTranslationCardIdRef.current);
            }

            // 2. Create NEW card (initially 'success' status to hide dots)
            const newId = generateId();
            const timestamp = Math.floor(Date.now() / 1000);
            const newCard: SentenceCard = {
              id: newId,
              original: fullText,
              translated: null,
              status: 'success', 
              user,
              timestamp
            };

            setCards(prev => [...prev, newCard].slice(-200));
            pendingTranslationCardIdRef.current = newId;
            lastProcessedCardRef.current = newCard;
          }

          // Start a 3-second timer to trigger translation if no more updates arrive
          translationTimerRef.current = setTimeout(() => {
            if (pendingTranslationCardIdRef.current) {
              triggerTranslation(pendingTranslationCardIdRef.current);
              pendingTranslationCardIdRef.current = null; // Mark as done
            }
          }, 3000);

          setPartialText(fullText);
          lastFullTextRef.current = fullText;
        }
        return;
      }

      // LiveCaptions Mode: Use auto-segmentation logic
      const latestCaption = getLatestCaption(fullText);
      setPartialText(latestCaption);

      if (fullText === lastFullTextRef.current) {
        idleCountRef.current++;
        if (idleCountRef.current === MAX_IDLE_INTERVAL && latestCaption.trim()) {
          translateAndDisplay(latestCaption, false, user);
          idleCountRef.current = 0;
        }
      } else {
        idleCountRef.current = 0;

        const newSentences = getNewSentences(fullText, lastFullTextRef.current);

        if (newSentences.length > 0) {
          newSentences.forEach(sentence => { void translateAndDisplay(sentence, true, user); });
        } else {
          syncCountRef.current++;
          if (syncCountRef.current >= MAX_SYNC_INTERVAL && latestCaption.trim()) {
            translateAndDisplay(latestCaption, false, user);
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

  const startCapture = async (sessionName?: string) => {
      // Starting: Create new session
      const sessionId = await handleCreateSession(sessionName);
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
      // Find the Teams window title from the scanned windows list
      const selectedWindow = teamsWindows.find(w => w.hwnd === hwnd);
      // Use Teams window title if available and not empty, otherwise use default datetime format
      const windowTitle = selectedWindow?.title?.trim() ? selectedWindow.title : `Session ${new Date().toLocaleString()}`;

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
      await startCapture(windowTitle);
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


  const saveConfig = async (newConfig: AppConfig, silent = false) => {
    try {
      await invoke("save_config", { config: newConfig });
      setConfig(newConfig);
      if (!silent) {
        addToast('success', t("toast.configSaved"));
      }
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
    const initialTranslations: Record<string, { translated: string; status: TranslationStatus }> = {};
    cards.forEach(card => {
      initialTranslations[card.id] = { translated: '', status: 'translating' };
    });
    setTempTranslations(initialTranslations);

    // Translate cards in bounded batches to avoid creating too many pending promises
    // Backend still applies global concurrency limits via semaphore.
    const configuredConcurrency = config.max_concurrent_translations > 0
      ? config.max_concurrent_translations
      : 2;
    const batchSize = Math.max(1, Math.min(configuredConcurrency, MAX_TRANSLATION_BATCH_SIZE));

    for (let batchStart = 0; batchStart < cards.length; batchStart += batchSize) {
      const batchCards = cards.slice(batchStart, batchStart + batchSize);

      await Promise.all(batchCards.map(async (card, batchOffset) => {
        const cardIndex = batchStart + batchOffset;

        try {
          let context: string[] | null = null;

          // Use override provider or config provider for context logic checks
          const effectiveProvider = providerOverride || config.provider;

          // Include context for AI models (not Google/Microsoft)
          const isAIModel = effectiveProvider !== 'google' && effectiveProvider !== 'microsoft';
          if (isAIModel && config.openai_context_count > 0 && cardIndex > 0) {
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
      }));
    }
  };

  const appWindow = getCurrentWindow();

  const handleToggleAlwaysOnTop = async () => {
    const nextAlwaysOnTop = !config.always_on_top;
    const nextConfig = { ...config, always_on_top: nextAlwaysOnTop };

    try {
      await invoke("set_always_on_top", { alwaysOnTop: nextAlwaysOnTop });
      setConfig(nextConfig);
    } catch (err) {
      console.error("Failed to toggle always on top:", err);
      addToast('error', t("toast.configSaveFailed", { error: String(err) }));
    }
  };

  const handleWindowMinimize = () => appWindow.minimize();
  const handleWindowMaximize = () => appWindow.toggleMaximize();
  const handleWindowClose = () => appWindow.close();

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background font-sans text-text-primary">
      {/* Custom Titlebar */}
      <div data-tauri-drag-region className="h-8 bg-panel flex justify-between items-center select-none border-b border-border z-50">
        <div className="flex-1 h-full flex items-center pl-3" data-tauri-drag-region>
          <span className="text-xs font-semibold text-text-secondary tracking-[0.5px]">LiveCaptions</span>
        </div>
        <div className="flex h-full">
          <button
            onClick={handleToggleAlwaysOnTop}
            className={`w-[46px] h-full bg-transparent border-none flex justify-center items-center cursor-pointer transition-all duration-200 hover:bg-white/5 ${config.always_on_top ? 'text-text-primary bg-white/10' : 'text-text-muted hover:text-text-primary'}`}
            title={t("settings.general.alwaysOnTop")}
          >
            <IconPin />
          </button>
          <button onClick={handleWindowMinimize} className="w-[46px] h-full bg-transparent border-none text-text-muted flex justify-center items-center cursor-pointer transition-all duration-200 hover:bg-white/5 hover:text-text-primary" title={t("titlebar.minimize")}>
            <IconWindowMinimize />
          </button>
          <button onClick={handleWindowMaximize} className="w-[46px] h-full bg-transparent border-none text-text-muted flex justify-center items-center cursor-pointer transition-all duration-200 hover:bg-white/5 hover:text-text-primary" title={t("titlebar.maximize")}>
            <IconWindowMaximize />
          </button>
          <button onClick={handleWindowClose} className="w-[46px] h-full bg-transparent border-none text-text-muted flex justify-center items-center cursor-pointer transition-all duration-200 hover:bg-error hover:text-white" title={t("titlebar.close")}>
            <IconWindowClose />
          </button>
        </div>
      </div>

      <div className="flex flex-row flex-1 overflow-hidden relative">
        <Sidebar 
          sessions={sessions}
          currentId={activeSessionId}
          onSelect={handleSelectSession}
          onDelete={handleDeleteSession}
          onClearAll={handleClearAllSessions}
          isOpen={isSidebarOpen} 
        />

        <div className="flex-1 overflow-hidden flex flex-col relative">
          <div className="h-[60px] px-4 flex justify-between items-center border-b border-border bg-panel">
            <div className="flex items-center">
              <button
                className="bg-transparent border-none text-text-secondary cursor-pointer p-2 rounded-full transition-all flex items-center justify-center hover:bg-card-hover hover:text-text-primary mr-2"
                onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                title={isSidebarOpen ? t("sidebar.closeTooltip") : t("sidebar.openTooltip")}
              >
                <IconList />
              </button>
              <span className="text-[13px] font-semibold text-text-secondary uppercase tracking-[0.5px] flex items-center gap-2">
                <span className={`text-[10px] text-text-muted transition-colors duration-300 ${isRunning ? 'text-success drop-shadow-[0_0_8px_rgba(16,185,129,1)] animate-pulse' : ''}`}>●</span>
                {isRenaming ? (
                    <input
                      autoFocus
                      className="bg-transparent border-b border-primary text-text-primary font-semibold p-1 outline-none"
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
                      className={`transition-colors ${activeSessionId ? 'cursor-text border-b border-dashed border-text-muted hover:text-text-primary' : 'cursor-default'}`}
                    >
                      {activeSessionName || t("session.noSession")}
                    </span>
                )}
                <span className="opacity-50 ml-2">({cards.length})</span>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <CopyButton cards={cards} addToast={addToast} />
              <button
                className={`bg-transparent border-none text-text-muted cursor-not-allowed p-2 rounded-full transition-all flex items-center justify-center ${cards.length > 0 ? 'cursor-pointer text-text-secondary hover:bg-card-hover hover:text-text-primary' : ''}`}
                onClick={() => setIsTranslateModalOpen(true)}
                title="Translate Session"
                disabled={cards.length === 0}
              >
                <IconLanguages />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 scroll-smooth" ref={scrollContainerRef}>
            <CaptionsList
              cards={cards}
              hasActiveSession={!!activeSessionId}
              onRetryTranslation={retryTranslation}
              partialText={partialText}
              scrollTop={listScrollTop}
              viewportHeight={listViewportHeight}
              tempTranslations={tempTranslations}
            />
            <div ref={historyEndRef} />
          </div>

          <footer className="h-[60px] bg-panel border-t border-border flex items-center justify-between px-6 relative z-10">
              <div className="flex items-center gap-2 max-w-[calc(50%-80px)] pr-4">
                <div className={`w-2 h-2 rounded-full shrink-0 ${isRunning ? 'bg-success shadow-[0_0_10px_var(--success)]' : 'bg-text-muted'}`} />
                <span className={`text-[11px] text-text-secondary truncate leading-[1.2] line-clamp-2 hover:line-clamp-none hover:overflow-visible hover:bg-panel hover:z-[100] hover:shadow-lg hover:p-1 hover:rounded ${status.startsWith('Error') ? 'text-error' : ''}`} title={status}>{status}</span>
              </div>
              <div className="flex items-center justify-center absolute left-1/2 -translate-x-1/2 pointer-events-none [&>*]:pointer-events-auto">
              <button
                  className={`h-10 w-10 rounded-[20px] border-none bg-bg-secondary flex items-center justify-center transition-all duration-200 mr-3 ${!isRunning ? 'text-text-muted cursor-not-allowed opacity-50' : (isWindowVisible ? 'text-text-primary' : 'text-text-muted')} ${isRunning ? 'cursor-pointer opacity-100 hover:brightness-110' : ''}`}
                  onClick={toggleVisibility}
                  disabled={!isRunning}
                  title={isWindowVisible ? t("controls.hideWindow") : t("controls.showWindow")}
              >
                  {isWindowVisible ? <IconEye /> : <IconEyeOff />}
              </button>
              <button 
                className={`h-10 px-5 rounded-[20px] border-none flex items-center gap-2.5 font-bold tracking-[0.5px] cursor-pointer transition-all duration-200 shadow-md hover:-translate-y-0.5 hover:shadow-[0_0_20px_var(--primary-glow)] ${isRunning ? 'bg-bg-secondary border border-error text-error hover:bg-error/10' : 'bg-primary text-black'}`} 
                onClick={toggleWatcher}
              >
                  {isRunning ? <IconSquare /> : <IconPlay />}
                  <span>{isRunning ? t("controls.stop") : t("controls.start")}</span>
              </button>
              <button
                  className={`h-10 w-10 rounded-[20px] border-none bg-bg-secondary flex items-center justify-center transition-all duration-200 ml-3 ${cards.length === 0 ? 'text-text-muted cursor-not-allowed' : 'text-text-primary cursor-pointer hover:brightness-110'}`}
                  onClick={handleSummarize}
                  disabled={cards.length === 0}
                  title={t("controls.summarize")}
              >
                  <IconFileText />
              </button>
              </div>
              <div className="w-[120px] flex justify-end items-center gap-3">
              {appVersion && <span className="text-[11px] text-text-muted">v{appVersion}</span>}
              <button className="bg-transparent border-none text-text-secondary cursor-pointer p-2 rounded-full transition-all flex items-center justify-center hover:bg-card-hover hover:text-text-primary" onClick={() => setIsSettingsOpen(true)} title={t("controls.settings")}>
                  <IconSettings />
              </button>
              </div>
          </footer>
        </div>
      </div>

      <div 
        className={`fixed inset-0 bg-black/60 backdrop-blur-[4px] z-[100] transition-opacity duration-300 flex justify-end ${isSettingsOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`} 
        onMouseDown={() => { overlayMouseDownRef.current = true; }}
        onMouseUp={() => { 
          if (overlayMouseDownRef.current) {
            setIsSettingsOpen(false);
          }
          overlayMouseDownRef.current = false;
        }}
      >
        <div className={`w-[600px] bg-panel h-full shadow-[-5px_0_25px_rgba(0,0,0,0.5)] flex flex-col transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${isSettingsOpen ? 'translate-x-0' : 'translate-x-full'}`} onMouseDown={e => e.stopPropagation()} onMouseUp={e => e.stopPropagation()}>
          <header className="px-6 py-2 border-b border-border flex justify-between items-center">
            <h2 className="m-0 text-lg font-semibold">{t("settings.title")}</h2>
            <button className="bg-transparent border-none text-text-secondary cursor-pointer p-2 rounded-full transition-all flex items-center justify-center hover:bg-card-hover hover:text-text-primary" onClick={() => setIsSettingsOpen(false)}>
              <IconX />
            </button>
          </header>
          <div className="flex-1 overflow-y-auto p-4 flex flex-col">
            <SettingsForm
              config={config}
              onSave={saveConfig}
              onConfigChange={setConfig}
              onStartCopilotAuth={(id) => { setAuthChannelId(id); setDeviceAuthOpen(true); }}
              addToast={addToast}
            />
          </div>
        </div>
      </div>
      
      {isDeviceAuthOpen && (
        <DeviceAuthModal 
          isOpen={isDeviceAuthOpen}
          onClose={() => { setDeviceAuthOpen(false); setAuthChannelId(null); }}
          onSuccess={(token) => {
            if (authChannelId) {
                const newConfig = {
                    ...config,
                    ai_channels: config.ai_channels.map(c => c.id === authChannelId ? { ...c, token } : c)
                };
                saveConfig(newConfig);
            }
            setDeviceAuthOpen(false);
            setAuthChannelId(null);
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
      <div className="fixed bottom-[100px] right-6 flex flex-col gap-2 z-[200] pointer-events-none">
        {toasts.map(toast => (
          <div key={toast.id} className={`flex items-center gap-2.5 px-4 py-3 rounded-lg text-sm font-medium shadow-lg animate-toast-in pointer-events-auto max-w-[450px] whitespace-pre-wrap break-words ${toast.type === 'error' ? 'bg-error text-white' : 'bg-success text-white'}`}>
            {toast.type === 'success' ? <IconCheck className="w-[18px] h-[18px] shrink-0" /> : <IconX className="w-[18px] h-[18px] shrink-0" />}
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
