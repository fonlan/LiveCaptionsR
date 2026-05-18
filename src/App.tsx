import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog';
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import "./App.css";
import "./App.legacy.css";
import { 
  AppConfig, 
  CaptionChatCardInput,
  DEFAULT_CONFIG, 
  DEFAULT_PROXY,
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_TRANSLATION_PROMPT,
  RawCaption, 
  SentenceCard, 
  Session, 
  SessionMetadata, 
  TeamsWindowInfo,
  TranslationStatus,
} from "./types";
import { 
  IconCheck, 
  IconChevronDown,
  IconFileText, 
  IconList,
  IconLanguages,
  IconSearch,
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
  IconMessageSquare,
} from "./components/Icons";
import {
  Sidebar,
  SESSION_SIDEBAR_DEFAULT_WIDTH,
  SESSION_SIDEBAR_MAX_WIDTH,
  SESSION_SIDEBAR_MIN_WIDTH,
} from "./components/Sidebar";
import { CaptionsList } from "./components/CaptionsList";
import { CopyButton } from "./components/CopyButton";
import {
  shouldOverwrite,
  getLatestCaption,
  generateId
} from "./utils/textUtils";
import { filterDuplicateSentences, getNewSentences } from "./utils/captionProcessing";
import { useToasts } from "./hooks/useToasts";
import { useFooterLayout } from "./hooks/useFooterLayout";
import { useCardSearch } from "./hooks/useCardSearch";
import { useAutoFollowScroll } from "./hooks/useAutoFollowScroll";
import { useSessions } from "./hooks/useSessions";
import { useAIChat } from "./hooks/useAIChat";
import { useCaptionVisibility } from "./hooks/useCaptionVisibility";
import { useSummaryStream } from "./hooks/useSummaryStream";
import { useCardJump } from "./hooks/useCardJump";
import { useSessionTranslationProgress } from "./hooks/useSessionTranslationProgress";
import { useWindowActions } from "./hooks/useWindowActions";
import { useChatActions } from "./hooks/useChatActions";

// --- Constants ---
const MAX_IDLE_INTERVAL = 10;
const MAX_SYNC_INTERVAL = 20;
const MAX_TRANSLATION_BATCH_SIZE = 10;
const RECENT_SENTENCE_DEDUP_WINDOW_MS = 45_000;
const RECENT_SENTENCE_MAX_TRACKED = 800;
const RECENT_SENTENCE_MIN_LENGTH = 8;
const SESSION_SIDEBAR_MIN_MAIN_WIDTH = 360;
const CHAT_SIDEBAR_DEFAULT_WIDTH = SESSION_SIDEBAR_DEFAULT_WIDTH;
const CHAT_SIDEBAR_MIN_WIDTH = SESSION_SIDEBAR_DEFAULT_WIDTH;
const CHAT_SIDEBAR_MAX_WIDTH = 920;
const loadChatSidebar = () => import("./components/ChatSidebar");

const SettingsForm = lazy(async () => {
  const module = await import("./components/settings/SettingsForm");
  return { default: module.SettingsForm };
});
const SummaryModal = lazy(async () => {
  const module = await import("./components/modals/SummaryModal");
  return { default: module.SummaryModal };
});
const TranslateModal = lazy(async () => {
  const module = await import("./components/modals/TranslateModal");
  return { default: module.TranslateModal };
});
const TeamsSelectionModal = lazy(async () => {
  const module = await import("./components/modals/TeamsSelectionModal");
  return { default: module.TeamsSelectionModal };
});
const DeviceAuthModal = lazy(async () => {
  const module = await import("./components/modals/DeviceAuthModal");
  return { default: module.DeviceAuthModal };
});
const ChatSidebar = lazy(async () => {
  const module = await loadChatSidebar();
  return { default: module.ChatSidebar };
});

type TranslationResultEvent = {
  request_id: string;
  card_id: string;
  original_text: string;
  translated: string | null;
  status: TranslationStatus | 'error';
  error?: string | null;
  is_retry: boolean;
};

type PendingTranslationRequest = {
  cardId: string;
  text: string;
  isRetry: boolean;
  mode: 'live' | 'manual' | 'session';
  batchId?: string;
};

type LiveTranslationRestartRequest = Pick<PendingTranslationRequest, "cardId" | "text" | "isRetry">;

type ChatSidebarFallbackProps = {
  width: number;
};

function ChatSidebarFallback({ width }: ChatSidebarFallbackProps) {
  return (
    <aside
      className="relative h-full shrink-0 max-w-[85vw] bg-panel/95 backdrop-blur-sm flex flex-col overflow-hidden border-l border-border"
      style={{ width: `${width}px` }}
      aria-hidden="true"
    >
      <div className="flex-1 p-4">
        <div className="h-full min-h-[180px] rounded-2xl border border-border/70 bg-card/55 animate-pulse" />
      </div>
      <div className="shrink-0 border-t border-border p-3 bg-panel">
        <div className="h-9 rounded-lg border border-border/70 bg-input/70 animate-pulse" />
        <div className="mt-2 h-[84px] rounded-xl border border-border/70 bg-input/70 animate-pulse" />
      </div>
    </aside>
  );
}

type CardsState = {
  cards: SentenceCard[];
  indexById: Record<string, number>;
};

type CardPatch = Partial<Pick<SentenceCard, "original" | "translated" | "status" | "retrying" | "user" | "timestamp">>;

type CardsAction =
  | { type: "reset"; cards: SentenceCard[] }
  | { type: "append"; card: SentenceCard }
  | { type: "replace_last"; card: SentenceCard }
  | { type: "patch"; cardId: string; patch: CardPatch; expectedOriginal?: string };

const EMPTY_CARDS_STATE: CardsState = {
  cards: [],
  indexById: {},
};

const buildCardIndex = (cards: SentenceCard[]): Record<string, number> => {
  const indexById: Record<string, number> = {};
  for (let i = 0; i < cards.length; i++) {
    indexById[cards[i].id] = i;
  }
  return indexById;
};

const cardsReducer = (state: CardsState, action: CardsAction): CardsState => {
  switch (action.type) {
    case "reset": {
      return {
        cards: action.cards,
        indexById: buildCardIndex(action.cards),
      };
    }
    case "append": {
      const nextCards = [...state.cards, action.card];
      return {
        cards: nextCards,
        indexById: {
          ...state.indexById,
          [action.card.id]: state.cards.length,
        },
      };
    }
    case "replace_last": {
      if (state.cards.length === 0) {
        return {
          cards: [action.card],
          indexById: { [action.card.id]: 0 },
        };
      }

      const lastIndex = state.cards.length - 1;
      const previousId = state.cards[lastIndex].id;
      const nextCards = state.cards.slice();
      nextCards[lastIndex] = action.card;
      const nextIndexById = { ...state.indexById };
      delete nextIndexById[previousId];
      nextIndexById[action.card.id] = lastIndex;

      return {
        cards: nextCards,
        indexById: nextIndexById,
      };
    }
    case "patch": {
      const index = state.indexById[action.cardId];
      if (index === undefined) return state;

      const current = state.cards[index];
      if (action.expectedOriginal !== undefined && current.original !== action.expectedOriginal) {
        return state;
      }

      let changed = false;
      for (const key in action.patch) {
        const patchKey = key as keyof CardPatch;
        if (current[patchKey] !== action.patch[patchKey]) {
          changed = true;
          break;
        }
      }

      if (!changed) return state;

      const nextCards = state.cards.slice();
      nextCards[index] = { ...current, ...action.patch };

      return {
        cards: nextCards,
        indexById: state.indexById,
      };
    }
    default:
      return state;
  }
};

// --- Main App Component ---

function App() {
  const { t, i18n } = useTranslation();
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<string>(t("status.ready"));
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isSummaryOpen, setIsSummaryOpen] = useState<boolean>(false);
  const [appVersion, setAppVersion] = useState<string>("");
  const [isTranslateModalOpen, setIsTranslateModalOpen] = useState<boolean>(false);
  const [tempTranslations, setTempTranslations] = useState<Record<string, { translated: string; status: TranslationStatus }>>({});
  
  // Session State
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [sessionSidebarWidth, setSessionSidebarWidth] = useState<number>(SESSION_SIDEBAR_DEFAULT_WIDTH);
  const [isSessionSidebarResizing, setIsSessionSidebarResizing] = useState<boolean>(false);
  const [chatSidebarWidth, setChatSidebarWidth] = useState<number>(CHAT_SIDEBAR_DEFAULT_WIDTH);
  const [isChatSidebarResizing, setIsChatSidebarResizing] = useState<boolean>(false);

  const [cardsState, dispatchCards] = useReducer(cardsReducer, EMPTY_CARDS_STATE);
  const cards = cardsState.cards;
  const [partialText, setPartialText] = useState<string>("");
  const { toasts, addToast } = useToasts();
   
   // Teams Modal State
  const [isTeamsModalOpen, setIsTeamsModalOpen] = useState(false);
  const [teamsWindows, setTeamsWindows] = useState<TeamsWindowInfo[]>([]);
  const [isScanningTeams, setIsScanningTeams] = useState(false);
  const [isDeviceAuthOpen, setDeviceAuthOpen] = useState(false);
  const [authChannelId, setAuthChannelId] = useState<string | null>(null);

  const historyEndRef = useRef<HTMLDivElement>(null);
  const sessionSidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const chatSidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const cardsRef = useRef<SentenceCard[]>([]);
  const cardIndexRef = useRef<Record<string, number>>({});
  const pendingTranslationRequestsRef = useRef<Record<string, PendingTranslationRequest>>({});
  const configRef = useRef<AppConfig>(DEFAULT_CONFIG);

  const lastFullTextRef = useRef<string>("");
  const lastProcessedCardRef = useRef<SentenceCard | null>(null);
  const pendingTranslationCardIdRef = useRef<string | null>(null); // Teams mode: card waiting for translation
  const translationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleCountRef = useRef<number>(0);
  const syncCountRef = useRef<number>(0);
  const isFirstCaptionRef = useRef<boolean>(true);
  const overlayMouseDownRef = useRef<boolean>(false);
  const recentSentenceSeenAtRef = useRef<Map<string, number>>(new Map());
  const isRunningRef = useRef<boolean>(false);
  const stopFinalizeInFlightRef = useRef<Promise<void> | null>(null);

  const toggleWatcherLabel = isRunning ? t("controls.stop") : t("controls.start");
  const isSummaryDisabled = cards.length === 0 || !config.summary_provider?.trim();

  const {
    footerRef,
    footerStatusRef,
    footerTrailingRef,
    footerExpandedControlsMeasureRef,
    isFooterToggleLabelCollapsed,
  } = useFooterLayout({
    signals: [appVersion, i18n.language, status, toggleWatcherLabel],
  });

  const {
    scrollContainerRef,
    autoFollow,
    setAutoFollow,
    disableAutoFollow,
    listScrollTop,
    listViewportHeight,
    handleScrollWheel,
  } = useAutoFollowScroll({
    contentSignals: [cards, cardsState.indexById, partialText],
  });

  const {
    sessions,
    setSessions,
    refreshSessionList,
    activeSessionId,
    activeSessionName,
    activeSessionCreatedAt,
    activeSessionIdRef,
    activeSessionNameRef,
    activeSessionCreatedAtRef,
    setActiveSession,
    clearActiveSession,
    setActiveSessionName,
  } = useSessions({ cards });

  const clearPendingSessionRequests = () => {
    const filtered: Record<string, PendingTranslationRequest> = {};
    for (const requestId in pendingTranslationRequestsRef.current) {
      const pending = pendingTranslationRequestsRef.current[requestId];
      if (pending.mode !== 'session') {
        filtered[requestId] = pending;
      }
    }
    pendingTranslationRequestsRef.current = filtered;
  };

  const removePendingTranslationRequests = (requestIds: string[]) => {
    if (requestIds.length === 0) {
      return;
    }

    const cancelledIds = new Set(requestIds);
    const retainedRequests: Record<string, PendingTranslationRequest> = {};

    for (const requestId in pendingTranslationRequestsRef.current) {
      if (!cancelledIds.has(requestId)) {
        retainedRequests[requestId] = pendingTranslationRequestsRef.current[requestId];
      }
    }

    pendingTranslationRequestsRef.current = retainedRequests;
  };

  const cancelTranslationRequests = async (requestIds: string[]) => {
    if (requestIds.length === 0) {
      return;
    }

    try {
      await invoke<number>("cancel_translation_requests", { requestIds });
    } catch (error) {
      console.error("Failed to cancel translation requests:", error);
    }
  };

  const collectRestartableLiveTranslations = (): {
    requestIds: string[];
    restartRequests: LiveTranslationRestartRequest[];
  } => {
    const requestIds: string[] = [];
    const restartByCardId = new Map<string, LiveTranslationRestartRequest>();

    for (const requestId in pendingTranslationRequestsRef.current) {
      const pending = pendingTranslationRequestsRef.current[requestId];
      if (pending.mode !== 'live') {
        continue;
      }

      requestIds.push(requestId);

      const cardIndex = cardIndexRef.current[pending.cardId];
      const card = cardIndex === undefined ? undefined : cardsRef.current[cardIndex];
      if (!card || card.original !== pending.text || restartByCardId.has(pending.cardId)) {
        continue;
      }

      restartByCardId.set(pending.cardId, {
        cardId: pending.cardId,
        text: pending.text,
        isRetry: pending.isRetry,
      });
    }

    return {
      requestIds,
      restartRequests: Array.from(restartByCardId.values()),
    };
  };

  const rerouteLiveTranslationsToProvider = async (providerId: string) => {
    const { requestIds, restartRequests } = collectRestartableLiveTranslations();
    if (requestIds.length === 0) {
      return;
    }

    removePendingTranslationRequests(requestIds);
    await cancelTranslationRequests(requestIds);

    await Promise.all(
      restartRequests.map(request =>
        enqueueTranslation(
          request.cardId,
          request.text,
          request.isRetry,
          'live',
          undefined,
          providerId,
        ),
      ),
    );
  };

  const normalizeSentenceForDedup = (text: string): string => {
    return text
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .replace(/[.!?。！？,，;；:：]+$/g, "")
      .trim()
      .toLowerCase();
  };



  const shouldSkipRecentSentence = (text: string, user?: string): boolean => {
    const normalizedText = normalizeSentenceForDedup(text);
    if (normalizedText.length < RECENT_SENTENCE_MIN_LENGTH) {
      return false;
    }

    const now = Date.now();
    const seenMap = recentSentenceSeenAtRef.current;
    for (const [key, seenAt] of seenMap) {
      if (now - seenAt > RECENT_SENTENCE_DEDUP_WINDOW_MS) {
        seenMap.delete(key);
      }
    }

    const normalizedUser = (user || "").trim().toLowerCase();
    const dedupKey = `${normalizedUser}|${normalizedText}`;
    const seenAt = seenMap.get(dedupKey);
    seenMap.set(dedupKey, now);

    while (seenMap.size > RECENT_SENTENCE_MAX_TRACKED) {
      const oldestKey = seenMap.keys().next().value;
      if (!oldestKey) break;
      seenMap.delete(oldestKey);
    }

    return seenAt !== undefined && now - seenAt < RECENT_SENTENCE_DEDUP_WINDOW_MS;
  };

  const resetRecentSentenceDedup = () => {
    recentSentenceSeenAtRef.current.clear();
  };

  const hasPendingLiveTranslations = (): boolean => {
    if (pendingTranslationCardIdRef.current) return true;

    for (const requestId in pendingTranslationRequestsRef.current) {
      if (pendingTranslationRequestsRef.current[requestId].mode === 'live') {
        return true;
      }
    }

    return false;
  };

  const finalizePendingLiveTranslationsOnStop = (): {
    cards: SentenceCard[];
    requestIds: string[];
  } => {
    const pendingCards = new Map<string, string | undefined>();
    const requestIds: string[] = [];

    if (translationTimerRef.current) {
      clearTimeout(translationTimerRef.current);
      translationTimerRef.current = null;
    }

    if (pendingTranslationCardIdRef.current) {
      const cardId = pendingTranslationCardIdRef.current;
      const cardIndex = cardIndexRef.current[cardId];
      const card = cardIndex === undefined ? undefined : cardsRef.current[cardIndex];
      pendingCards.set(cardId, card?.original);
      pendingTranslationCardIdRef.current = null;
    }

    const retainedRequests: Record<string, PendingTranslationRequest> = {};
    for (const requestId in pendingTranslationRequestsRef.current) {
      const pending = pendingTranslationRequestsRef.current[requestId];
      if (pending.mode === 'live') {
        requestIds.push(requestId);
        pendingCards.set(pending.cardId, pending.text);
      } else {
        retainedRequests[requestId] = pending;
      }
    }
    pendingTranslationRequestsRef.current = retainedRequests;

    if (pendingCards.size === 0) {
      return { cards: cardsRef.current, requestIds };
    }

    let changed = false;
    const nextCards = cardsRef.current.map(card => {
      if (!pendingCards.has(card.id)) {
        return card;
      }

      const expectedOriginal = pendingCards.get(card.id);
      if (expectedOriginal !== undefined && card.original !== expectedOriginal) {
        return card;
      }

      if (card.status === 'error' && card.translated === null && !card.retrying) {
        return card;
      }

      changed = true;
      return {
        ...card,
        translated: null,
        status: 'error' as TranslationStatus,
        retrying: false,
      };
    });

    if (changed) {
      dispatchCards({ type: "reset", cards: nextCards });
      return { cards: nextCards, requestIds };
    }

    return { cards: cardsRef.current, requestIds };
  };

  const saveActiveSessionSnapshot = async (cardsOverride?: SentenceCard[]) => {
    const sessionId = activeSessionIdRef.current;
    const createdAt = activeSessionCreatedAtRef.current;
    if (!sessionId || !createdAt) return;

    const sessionToSave: Session = {
      id: sessionId,
      name: activeSessionNameRef.current,
      created_at: createdAt,
      cards: cardsOverride ?? cardsRef.current,
    };

    try {
      await invoke("save_session_data", { session: sessionToSave });
      await refreshSessionList();
    } catch (e) {
      console.error("Failed to save on stop:", e);
    }
  };

  const finalizeCaptureStop = async (nextStatus?: string) => {
    if (nextStatus) {
      setStatus(nextStatus);
    }

    if (stopFinalizeInFlightRef.current) {
      await stopFinalizeInFlightRef.current;
      return;
    }

    const stopTask = (async () => {
      const { cards: finalizedCards, requestIds } = finalizePendingLiveTranslationsOnStop();
      await cancelTranslationRequests(requestIds);
      setIsRunning(false);
      isRunningRef.current = false;
      setPartialText("");
      resetSessionTranslationProgress();
      await saveActiveSessionSnapshot(finalizedCards);
    })();

    stopFinalizeInFlightRef.current = stopTask;
    try {
      await stopTask;
    } finally {
      stopFinalizeInFlightRef.current = null;
    }
  };

  const normalizeLoadedCards = (sessionCards: SentenceCard[]): { cards: SentenceCard[]; changed: boolean } => {
    let changed = false;
    const cards = sessionCards.map(card => {
      if (card.status === 'translating') {
        changed = true;
        return {
          ...card,
          translated: null,
          status: 'error' as TranslationStatus,
          retrying: false,
        };
      }
      return card;
    });

    return { cards, changed };
  };

  const {
    highlightedCardId,
    clearHighlightedCard,
    setJumpHighlightedCard,
    jumpToCardByNumber,
  } = useCardJump({
    scrollContainerRef,
    cardsRef,
    disableAutoFollow,
    addToast,
    t,
  });

  const {
    isChatOpen,
    setIsChatOpen,
    chatMessages,
    setChatMessages,
    chatMessagesRef,
    chatInput,
    setChatInput,
    chatModelId,
    setChatModelId,
    isChatSending,
    setIsChatSending,
    chatActiveRequestIdRef,
    chatSessions,
    activeChatSessionId,
    setActiveChatSessionName,
    activeChatSessionIdRef,
    activeChatSessionNameRef,
    clearChatSessionState,
    saveActiveChatSessionSnapshot,
    loadChatSessionById,
    activateUnsavedChatDraft,
    ensureActiveChatSession,
  } = useAIChat({
    activeSessionId,
    activeSessionIdRef,
    availableModels: config.ai_models,
    summaryProvider: config.summary_provider,
    onResetHighlightedCard: clearHighlightedCard,
  });

  // --- Session Management ---

  const handleCreateSession = async (name?: string) => {
    try {
      const sessionName = name || `Session ${new Date().toLocaleString()}`;
      const session = await invoke<Session>("create_session", { name: sessionName });
      await refreshSessionList();
      setActiveSession({
        id: session.id,
        name: session.name,
        createdAt: session.created_at,
      });
      dispatchCards({ type: "reset", cards: [] }); // Clear cards for new session
      setTempTranslations({}); // Clear temp translations
      setAutoFollow(true);
      lastProcessedCardRef.current = null;
      resetRecentSentenceDedup();

      setPartialText("");
      lastFullTextRef.current = "";
      pendingTranslationCardIdRef.current = null;
      clearTeamsTranslationTimer();
      return session.id;
    } catch (e) {
      console.error("Failed to create session:", e);
      addToast('error', "Failed to create new session");
      return null;
    }
  };

  const handleSelectSession = async (id: string) => {
    if (!id || id === activeSessionIdRef.current) {
      return;
    }

    if (isRunningRef.current) {
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
      const normalized = normalizeLoadedCards(session.cards);
      if (normalized.changed) {
        void invoke("save_session_data", {
          session: {
            ...session,
            cards: normalized.cards,
          },
        }).catch(e => console.error("Failed to normalize loaded session:", e));
      }
      setActiveSession({
        id: session.id,
        name: session.name,
        createdAt: session.created_at,
      });
      dispatchCards({ type: "reset", cards: normalized.cards });
      setTempTranslations({}); // Clear temp translations
      setAutoFollow(false); // Don't auto-scroll when loading history
      lastProcessedCardRef.current = normalized.cards.length > 0 ? normalized.cards[normalized.cards.length - 1] : null;
      resetRecentSentenceDedup();

      setPartialText("");
      pendingTranslationCardIdRef.current = null;
      clearTeamsTranslationTimer();
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
        clearActiveSession();
        dispatchCards({ type: "reset", cards: [] });
        setTempTranslations({}); // Clear temp translations
        lastProcessedCardRef.current = null;
        resetRecentSentenceDedup();
        setPartialText("");
        pendingTranslationCardIdRef.current = null;
        clearTeamsTranslationTimer();
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
      clearActiveSession();
      dispatchCards({ type: "reset", cards: [] });
      setTempTranslations({});
      lastProcessedCardRef.current = null;
      resetRecentSentenceDedup();
      setPartialText("");
      pendingTranslationCardIdRef.current = null;
      clearTeamsTranslationTimer();
      
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

  // --- Effects ---

  useEffect(() => {
    cardsRef.current = cards;
    cardIndexRef.current = cardsState.indexById;
  }, [cards, cardsState.indexById]);

  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  // Handle language change from config
  useEffect(() => {
    if (config.language && i18n.language !== config.language) {
      i18n.changeLanguage(config.language);
    }
  }, [config.language, i18n]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const clampChatSidebarWidth = useCallback((value: number): number => {
    const viewportMax = Math.floor(window.innerWidth * 0.85);
    const occupiedSessionSidebarWidth = isSidebarOpen ? sessionSidebarWidth : 0;
    const layoutMax = Math.max(
      0,
      Math.floor(window.innerWidth - occupiedSessionSidebarWidth - SESSION_SIDEBAR_MIN_MAIN_WIDTH),
    );
    const maxWidth = Math.min(CHAT_SIDEBAR_MAX_WIDTH, viewportMax, layoutMax);
    const minWidth = Math.min(CHAT_SIDEBAR_MIN_WIDTH, maxWidth);

    return Math.max(minWidth, Math.min(maxWidth, Math.round(value)));
  }, [isSidebarOpen, sessionSidebarWidth]);

  const clampSessionSidebarWidth = useCallback((value: number): number => {
    const availableWidth = window.innerWidth - (isChatOpen ? chatSidebarWidth : 0) - SESSION_SIDEBAR_MIN_MAIN_WIDTH;
    const maxWidth = Math.max(
      SESSION_SIDEBAR_MIN_WIDTH,
      Math.min(SESSION_SIDEBAR_MAX_WIDTH, Math.floor(availableWidth)),
    );

    return Math.max(SESSION_SIDEBAR_MIN_WIDTH, Math.min(maxWidth, Math.round(value)));
  }, [chatSidebarWidth, isChatOpen]);

  useEffect(() => {
    setSessionSidebarWidth(prev => clampSessionSidebarWidth(prev));
  }, [clampSessionSidebarWidth]);

  useEffect(() => {
    const handleWindowResize = () => {
      setSessionSidebarWidth(prev => clampSessionSidebarWidth(prev));
      setChatSidebarWidth(prev => clampChatSidebarWidth(prev));
    };

    handleWindowResize();
    window.addEventListener("resize", handleWindowResize);
    return () => {
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [clampChatSidebarWidth, clampSessionSidebarWidth]);

  useEffect(() => {
    if (!isSessionSidebarResizing) return;

    const handleMouseMove = (event: MouseEvent) => {
      const resizeState = sessionSidebarResizeRef.current;
      if (!resizeState) return;
      const deltaX = event.clientX - resizeState.startX;
      setSessionSidebarWidth(clampSessionSidebarWidth(resizeState.startWidth + deltaX));
    };

    const handleMouseUp = () => {
      setIsSessionSidebarResizing(false);
      sessionSidebarResizeRef.current = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [clampSessionSidebarWidth, isSessionSidebarResizing]);

  useEffect(() => {
    if (!isChatSidebarResizing) return;

    const handleMouseMove = (event: MouseEvent) => {
      const resizeState = chatSidebarResizeRef.current;
      if (!resizeState) return;
      const deltaX = resizeState.startX - event.clientX;
      setChatSidebarWidth(clampChatSidebarWidth(resizeState.startWidth + deltaX));
    };

    const handleMouseUp = () => {
      setIsChatSidebarResizing(false);
      chatSidebarResizeRef.current = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isChatSidebarResizing]);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      const frontendInitBegin = performance.now();
      const bootMark = (window as Window & { __LCR_BOOT_TS__?: number }).__LCR_BOOT_TS__;
      const webviewBootMs =
        typeof bootMark === "number" && Number.isFinite(bootMark)
          ? Math.max(0, Math.round(frontendInitBegin - bootMark))
          : null;
      const [versionResult, configResult, runningResult, sessionsResult] = await Promise.allSettled([
        getVersion(),
        invoke<AppConfig>("get_config"),
        invoke<boolean>("is_watcher_running"),
        invoke<SessionMetadata[]>("get_sessions"),
      ]);

      if (cancelled) {
        return;
      }

      if (versionResult.status === "fulfilled") {
        setAppVersion(versionResult.value);
      } else {
        console.error("Failed to load app version:", versionResult.reason);
      }

      if (configResult.status === "fulfilled") {
        const savedConfig = configResult.value;
        setConfig({
          ...DEFAULT_CONFIG,
          ...savedConfig,
          summary_prompt: savedConfig.summary_prompt || DEFAULT_SUMMARY_PROMPT, // Ensure default prompt if empty
          translation_prompt: savedConfig.translation_prompt ?? DEFAULT_TRANSLATION_PROMPT,
          google_proxy: savedConfig.google_proxy || DEFAULT_PROXY,
          microsoft_proxy: savedConfig.microsoft_proxy || DEFAULT_PROXY,
        });
      } else {
        console.error("Failed to load config:", configResult.reason);
      }

      if (runningResult.status === "fulfilled") {
        const running = runningResult.value;
        setIsRunning(running);
        isRunningRef.current = running;
        if (running) setStatus("Running");
      } else {
        console.error("Failed to query watcher status:", runningResult.reason);
      }

      if (sessionsResult.status === "fulfilled") {
        setSessions(sessionsResult.value);
      } else {
        console.error("Failed to load sessions:", sessionsResult.reason);
      }

      const frontendInitMs = Math.max(0, Math.round(performance.now() - frontendInitBegin));
      const perceivedStartupMs = frontendInitMs + (webviewBootMs ?? 0);
      console.info(
        `[startup] frontend init completed in ${frontendInitMs}ms (webview_boot_ms=${webviewBootMs ?? "unknown"}, perceived_startup_ms=${perceivedStartupMs})`,
      );
      void invoke("log_startup_metric", {
        frontendInitMs,
        webviewBootMs,
        initSource: "frontend",
        configLoaded: configResult.status === "fulfilled",
        sessionsLoaded: sessionsResult.status === "fulfilled",
        watcherStateLoaded: runningResult.status === "fulfilled",
      }).catch(err => {
        console.warn("Failed to report startup metric:", err);
      });
    }

    void init();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', config.theme || 'dark');
  }, [config.theme]);

  useEffect(() => {
    document.documentElement.style.setProperty('--app-opacity', (config.opacity ?? 1.0).toString());
  }, [config.opacity]);

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

  const buildTranslationContext = (
    cardId: string,
    providerOverride?: string,
  ): string[] | null => {
    const currentCards = cardsRef.current;
    const currentConfig = configRef.current;
    const effectiveProvider = providerOverride || currentConfig.provider;
    const isAIModel = effectiveProvider !== 'google' && effectiveProvider !== 'microsoft';

    if (!isAIModel || currentConfig.openai_context_count <= 0) {
      return null;
    }

    const cardIndex = cardIndexRef.current[cardId] ?? -1;
    if (cardIndex >= 0) {
      const startIdx = Math.max(0, cardIndex - currentConfig.openai_context_count);
      return currentCards.slice(startIdx, cardIndex).map(c => c.original);
    }

    const startIdx = Math.max(0, currentCards.length - currentConfig.openai_context_count);
    return currentCards.slice(startIdx).map(c => c.original);
  };

  const enqueueTranslation = async (
    cardId: string,
    text: string,
    isRetry: boolean,
    mode: 'live' | 'manual' | 'session' = 'live',
    targetLangOverride?: string,
    providerOverride?: string,
  ) => {
    const requestId = generateId();
    const context = buildTranslationContext(cardId, providerOverride);

    pendingTranslationRequestsRef.current[requestId] = { cardId, text, isRetry, mode };

    try {
      await invoke("translate_text_async", {
        requestId,
        cardId,
        text,
        context,
        targetLangOverride,
        providerOverride,
        isRetry,
      });
    } catch (e) {
      delete pendingTranslationRequestsRef.current[requestId];
      console.error("Translation enqueue error:", e);
      dispatchCards({
        type: "patch",
        cardId,
        patch: { translated: null, status: 'error' as TranslationStatus, retrying: false },
        expectedOriginal: text,
      });
    }
  };

  const retryTranslation = async (cardId: string, originalText: string) => {
    dispatchCards({ type: "patch", cardId, patch: { retrying: true } });
    const retryMode = isRunningRef.current ? 'live' : 'manual';
    await enqueueTranslation(cardId, originalText, true, retryMode);
  };

  const performTranslation = async (cardId: string, text: string) => {
    await enqueueTranslation(cardId, text, false, 'live');
  };
  const appendCardLocally = (card: SentenceCard) => {
    const nextCards = [...cardsRef.current, card];
    cardsRef.current = nextCards;
    cardIndexRef.current = {
      ...cardIndexRef.current,
      [card.id]: nextCards.length - 1,
    };
    lastProcessedCardRef.current = card;
    dispatchCards({ type: "append", card });
  };
  const patchCardLocally = (
    cardId: string,
    patch: CardPatch,
    expectedOriginal?: string,
  ): SentenceCard | null => {
    const index = cardIndexRef.current[cardId];
    if (index === undefined) return null;
    const current = cardsRef.current[index];
    if (expectedOriginal !== undefined && current.original !== expectedOriginal) {
      return null;
    }
    let changed = false;
    for (const key in patch) {
      const patchKey = key as keyof CardPatch;
      if (current[patchKey] !== patch[patchKey]) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      return null;
    }
    const nextCard = { ...current, ...patch };
    const nextCards = cardsRef.current.slice();
    nextCards[index] = nextCard;
    cardsRef.current = nextCards;
    if (index === nextCards.length - 1) {
      lastProcessedCardRef.current = nextCard;
    }
    dispatchCards({ type: "patch", cardId, patch, expectedOriginal });
    return nextCard;
  };
  const clearTeamsTranslationTimer = () => {
    if (translationTimerRef.current) {
      clearTimeout(translationTimerRef.current);
      translationTimerRef.current = null;
    }
  };
  const triggerTeamsCardTranslation = (cardId: string) => {
    if (!configRef.current.translation_enabled) return;
    const cardIndex = cardIndexRef.current[cardId];
    const card = cardIndex === undefined ? undefined : cardsRef.current[cardIndex];
    if (!card) return;
    patchCardLocally(cardId, { translated: null, status: 'translating' });
    void performTranslation(cardId, card.original);
  };
  const queueTeamsCardForDelayedTranslation = (cardId: string | null) => {
    clearTeamsTranslationTimer();
    if (!configRef.current.translation_enabled || !cardId) {
      pendingTranslationCardIdRef.current = null;
      return;
    }
    pendingTranslationCardIdRef.current = cardId;
    translationTimerRef.current = setTimeout(() => {
      const pendingCardId = pendingTranslationCardIdRef.current;
      pendingTranslationCardIdRef.current = null;
      clearTeamsTranslationTimer();
      if (!pendingCardId) {
        return;
      }
      triggerTeamsCardTranslation(pendingCardId);
    }, 3000);
  };

  const translateAndDisplay = async (originalText: string, allowDuplicate: boolean = false, user?: string) => {
    if (!originalText.trim()) return;

    if (shouldSkipRecentSentence(originalText, user)) {
      return;
    }

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
    syncCountRef.current = 0;


    if (isOverwrite && cardsRef.current.length > 0) {
      // Replace the last card with the NEW card (new ID)
      // This effectively removes the old card and its pending translation UI state
      dispatchCards({ type: "replace_last", card: newCard });
    } else {
      dispatchCards({ type: "append", card: newCard });
    }

    // Check if translation is enabled
    if (configRef.current.translation_enabled === false) {
      // Just leave it as null/translating until finalized? 
    // Actually if translation is disabled, we should just mark it as success but with null translation
    // to indicate "processing done, no translation needed"
    dispatchCards({
      type: "patch",
      cardId: newId,
      patch: { translated: null, status: 'success' as TranslationStatus },
    });
    return;
    }

    // Start translation for the NEW card
    // The old card's translation (if running) will fail to find the old ID in state and do nothing
    performTranslation(newId, originalText);
  };

  useEffect(() => {
    const unlistenTranslationResult = listen<TranslationResultEvent>("translation-result", (event) => {
      const payload = event.payload;
      const pending = pendingTranslationRequestsRef.current[payload.request_id];

      if (!pending) {
        return;
      }

      delete pendingTranslationRequestsRef.current[payload.request_id];

      if (pending.mode === 'session') {
        if (pending.batchId) {
          markSessionTranslationProgressStep(pending.batchId);
        }

        if (payload.status === 'success') {
          setTempTranslations(prev => ({
            ...prev,
            [pending.cardId]: { translated: payload.translated ?? '', status: 'success' },
          }));
        } else {
          setTempTranslations(prev => ({
            ...prev,
            [pending.cardId]: { translated: '', status: 'error' },
          }));
        }
        return;
      }

      if (pending.isRetry) {
        if (payload.status === 'success') {
          const cardIndex = cardIndexRef.current[pending.cardId];
          const currentCard = cardIndex === undefined ? undefined : cardsRef.current[cardIndex];
          const canPersistPatchedRetry =
            pending.mode === 'manual'
            && !!currentCard
            && currentCard.original === pending.text;
          const persistedCards = canPersistPatchedRetry && currentCard
            ? cardsRef.current.map(card => {
              if (card.id !== pending.cardId || card.original !== pending.text) {
                return card;
              }
              return {
                ...card,
                translated: payload.translated,
                retrying: false,
                status: 'success' as TranslationStatus,
              };
            })
            : null;

          dispatchCards({
            type: "patch",
            cardId: pending.cardId,
            patch: {
              translated: payload.translated,
              retrying: false,
              status: 'success' as TranslationStatus,
            },
            expectedOriginal: pending.text,
          });

          if (persistedCards) {
            void saveActiveSessionSnapshot(persistedCards);
          }
        } else {
          dispatchCards({
            type: "patch",
            cardId: pending.cardId,
            patch: { retrying: false },
            expectedOriginal: pending.text,
          });
        }
        return;
      }

      if (payload.status === 'success') {
        dispatchCards({
          type: "patch",
          cardId: pending.cardId,
          patch: { translated: payload.translated, status: 'success' as TranslationStatus },
          expectedOriginal: pending.text,
        });
      } else {
        dispatchCards({
          type: "patch",
          cardId: pending.cardId,
          patch: { translated: null, status: 'error' as TranslationStatus },
          expectedOriginal: pending.text,
        });
      }
    });

    const unlistenRaw = listen<RawCaption>("caption-raw", async (event) => {
      const fullText = event.payload.text;
      const user = event.payload.user;
      if (configRef.current.caption_source === 'teams') {
        const backendCardId = event.payload.card_id?.trim();
        if (!backendCardId || !fullText.trim()) {
          return;
        }

        const normalizedUser = (user ?? "").trim();
        const nextUser = normalizedUser ? normalizedUser : undefined;
        const existingIndex = cardIndexRef.current[backendCardId];

        if (existingIndex !== undefined) {
          const currentCard = cardsRef.current[existingIndex];
          const isLatestCard = existingIndex === cardsRef.current.length - 1;
          const updatedCard = patchCardLocally(backendCardId, {
            original: fullText,
            translated: null,
            status: 'success',
            user: nextUser ?? currentCard.user,
          });

          if (!updatedCard) {
            return;
          }

          if (isLatestCard) {
            setPartialText(updatedCard.original);
            queueTeamsCardForDelayedTranslation(backendCardId);
          } else if (configRef.current.translation_enabled) {
            triggerTeamsCardTranslation(backendCardId);
          }
          return;
        }

        if (pendingTranslationCardIdRef.current && pendingTranslationCardIdRef.current !== backendCardId) {
          const previousPendingCardId = pendingTranslationCardIdRef.current;
          pendingTranslationCardIdRef.current = null;
          clearTeamsTranslationTimer();
          triggerTeamsCardTranslation(previousPendingCardId);
        }

        const newCard: SentenceCard = {
          id: backendCardId,
          original: fullText,
          translated: null,
          status: 'success',
          user: nextUser,
          timestamp: event.payload.timestamp,
        };
        appendCardLocally(newCard);
        setPartialText(fullText);
        queueTeamsCardForDelayedTranslation(newCard.id);
        return;
      }

      if (isFirstCaptionRef.current) {
        isFirstCaptionRef.current = false;
        lastFullTextRef.current = fullText;
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
          const recentOriginals = cardsRef.current
            .slice(-120)
            .map(card => card.original);
          const dedupedSentences = filterDuplicateSentences(recentOriginals, newSentences);

          if (dedupedSentences.length > 0) {
            dedupedSentences.forEach(sentence => { void translateAndDisplay(sentence, true, user); });
          }
        } else {
          syncCountRef.current++;
          if (syncCountRef.current >= MAX_SYNC_INTERVAL && latestCaption.trim()) {
            translateAndDisplay(latestCaption, false, user);
          }
        }
        lastFullTextRef.current = fullText;
      }
    });

    const unlistenStatus = listen<string>("caption-status", (event) => {
      const nextStatus = event.payload;
      setStatus(nextStatus);

      if (nextStatus === "Stopped" && (isRunningRef.current || hasPendingLiveTranslations())) {
        void finalizeCaptureStop(nextStatus);
      }
    });
    const unlistenError = listen<string>("caption-error", (event) => {
      void finalizeCaptureStop(`Error: ${event.payload}`);
    });

    return () => {
      unlistenTranslationResult.then(f => f());
      unlistenRaw.then(f => f());
      unlistenStatus.then(f => f());
      unlistenError.then(f => f());
    };
  }, []);

  const { isWindowVisible } = useCaptionVisibility({
    hideSystemWindow: config.hide_system_window ?? false,
  });

  const {
    summaryText,
    isSummarizing,
    beginSummary,
    failSummary: failSummaryStream,
  } = useSummaryStream();

  const {
    isSessionTranslating,
    sessionTranslationTotal,
    sessionTranslationCompleted,
    sessionTranslationProgressPercent,
    startSessionTranslationProgress,
    markSessionTranslationProgressStep,
    resetSessionTranslationProgress,
  } = useSessionTranslationProgress({ addToast, t });

  const {
    handleWindowMinimize,
    handleWindowMaximize,
    handleWindowClose,
  } = useWindowActions();

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
      isRunningRef.current = true;
      pendingTranslationRequestsRef.current = {};
      resetSessionTranslationProgress();
      } catch (err) {
        setStatus(`Failed to start: ${err}`);
        setIsRunning(false);
        isRunningRef.current = false;
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
      try {
        await invoke("stop_caption_watcher");
      } catch (e) {
        console.error("Failed to stop watcher:", e);
      }
      await finalizeCaptureStop("Stopped");
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
    const previousConfig = configRef.current;
    const shouldRerouteLiveTranslations =
      isRunningRef.current
      && previousConfig.provider !== newConfig.provider
      && newConfig.translation_enabled !== false;

    try {
      await invoke("save_config", { config: newConfig });
      configRef.current = newConfig;
      setConfig(newConfig);
      if (shouldRerouteLiveTranslations) {
        await rerouteLiveTranslationsToProvider(newConfig.provider);
      }
      if (!silent) {
        addToast('success', t("toast.configSaved"));
      }
    } catch (err) {
      console.error("Failed to save config:", err);
      addToast('error', t("toast.configSaveFailed", { error: String(err) }));
    }
  };

  const handleSummarize = async () => {
    const summaryProvider = config.summary_provider?.trim();
    if (!summaryProvider) {
      addToast('error', t("settings.summary.selectProvider"));
      return;
    }

    if (cards.length === 0 || !activeSessionId || !activeSessionCreatedAt) return;
    setIsSummaryOpen(true);
    const requestId = beginSummary();

    try {
      const sessionToSave: Session = {
        id: activeSessionId,
        name: activeSessionName,
        created_at: activeSessionCreatedAt,
        cards: cardsRef.current,
      };

      await invoke("save_session_data", { session: sessionToSave });

      await invoke("summarize_session_by_id_stream", {
        sessionId: activeSessionId,
        providerId: summaryProvider,
        requestId,
      });
    } catch (err) {
      console.error("Summary error:", err);
      failSummaryStream(`Error generating summary: ${err}`);
    }
  };

  const getAIModelLabel = (modelId: string): string => {
    const model = config.ai_models.find(item => item.id === modelId);
    if (!model) return modelId;
    const channel = config.ai_channels.find(item => item.id === model.channel_id);
    return `${model.name} (${channel?.name || 'Unknown'})`;
  };

  const handleSessionSidebarResizeStart = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    sessionSidebarResizeRef.current = {
      startX: event.clientX,
      startWidth: sessionSidebarWidth,
    };
    setIsSessionSidebarResizing(true);
  };

  const handleChatSidebarResizeStart = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    chatSidebarResizeRef.current = {
      startX: event.clientX,
      startWidth: chatSidebarWidth,
    };
    setIsChatSidebarResizing(true);
  };

  const preloadChatSidebar = useCallback(() => {
    void loadChatSidebar();
  }, []);

  const buildChatCardsSnapshot = (): CaptionChatCardInput[] => {
    return cardsRef.current
      .filter(card => card.original.trim().length > 0)
      .map(card => ({
        original: card.original,
        user: card.user,
        timestamp: card.timestamp,
      }));
  };

  const handleChatCardReferenceClick = (cardNumber: number) => {
    jumpToCardByNumber(cardNumber);
  };

  const {
    isCardSearchOpen,
    cardSearchQuery,
    setCardSearchQuery,
    normalizedCardSearchQuery,
    cardSearchMatches,
    cardSearchInputRef,
    handleToggleCardSearch,
    handleNavigateCardSearch,
    handleCardSearchKeyDown,
  } = useCardSearch({
    cards,
    tempTranslations,
    activeSessionId,
    jumpToCardByNumber,
    addToast,
    t,
    modalFlags: [isSettingsOpen, isSummaryOpen, isTranslateModalOpen, isTeamsModalOpen, isDeviceAuthOpen],
  });

  const handleHeaderBlankDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }

    if (cardsRef.current.length === 0) {
      return;
    }

    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    disableAutoFollow();
    container.scrollTo({ top: 0, behavior: "smooth" });

    const firstCardId = cardsRef.current[0]?.id;
    if (firstCardId) {
      setJumpHighlightedCard(firstCardId);
    }
  };

  const {
    handleSendChatMessage,
    handleStopChatMessage,
    handleStartNewChatSession,
    handleSelectChatSession,
  } = useChatActions({
    chatInput,
    setChatInput,
    chatModelId,
    isChatSending,
    setIsChatSending,
    chatMessagesRef,
    setChatMessages,
    chatActiveRequestIdRef,
    activeChatSessionIdRef,
    activeChatSessionNameRef,
    setActiveChatSessionName,
    ensureActiveChatSession,
    saveActiveChatSessionSnapshot,
    loadChatSessionById,
    clearChatSessionState,
    activateUnsavedChatDraft,
    activeSessionIdRef,
    buildChatCardsSnapshot,
    addToast,
    t,
  });

  const handleTranslateSession = async (targetLang: string, providerOverride?: string) => {
    if (cards.length === 0) return;

    clearPendingSessionRequests();
    const batchId = generateId();
    startSessionTranslationProgress(batchId, cards.length);

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

    const effectiveProvider = providerOverride || config.provider;
    const isAIModel = effectiveProvider !== 'google' && effectiveProvider !== 'microsoft';

    for (let batchStart = 0; batchStart < cards.length; batchStart += batchSize) {
      const batchCards = cards.slice(batchStart, batchStart + batchSize);

      await Promise.all(batchCards.map(async (card, batchOffset) => {
        const cardIndex = batchStart + batchOffset;

        let context: string[] | null = null;
        if (isAIModel && config.openai_context_count > 0 && cardIndex > 0) {
          const startIdx = Math.max(0, cardIndex - config.openai_context_count);
          context = cards.slice(startIdx, cardIndex).map(c => c.original);
        }

        const requestId = generateId();
        pendingTranslationRequestsRef.current[requestId] = {
          cardId: card.id,
          text: card.original,
          isRetry: false,
          mode: 'session',
          batchId,
        };

        try {
          await invoke("translate_text_async", {
            requestId,
            cardId: card.id,
            text: card.original,
            context,
            targetLangOverride: targetLang,
            providerOverride,
            isRetry: false,
          });
        } catch (e) {
          delete pendingTranslationRequestsRef.current[requestId];
          console.error(`Translation enqueue failed for card ${card.id}:`, e);
          markSessionTranslationProgressStep(batchId);
          setTempTranslations(prev => ({
            ...prev,
            [card.id]: { translated: '', status: 'error' }
          }));
        }
      }));
    }
  };

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

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background font-sans text-text-primary">
      {/* Custom Titlebar */}
      <div data-tauri-drag-region className="h-8 bg-panel flex justify-between items-center select-none border-b border-border z-50">
        <div className="flex-1 h-full flex items-center pl-3" data-tauri-drag-region>
          <span className="text-xs font-semibold text-text-secondary tracking-[0.5px]">{t("app.title")}</span>
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
          width={sessionSidebarWidth}
          onSelect={handleSelectSession}
          onDelete={handleDeleteSession}
          onResizeStart={handleSessionSidebarResizeStart}
          isOpen={isSidebarOpen}
          isResizing={isSessionSidebarResizing}
        />

        <div className="flex-1 overflow-hidden flex flex-col relative">
          <div className="border-b border-border bg-panel overflow-hidden">
            <div
              className="h-[60px] px-4 flex justify-between items-center overflow-hidden"
              onDoubleClick={handleHeaderBlankDoubleClick}
            >
            <div className="flex items-center flex-1 min-w-0">
              <button
                className="bg-transparent border-none text-text-secondary cursor-pointer p-2 rounded-full transition-all flex items-center justify-center hover:bg-card-hover hover:text-text-primary mr-2"
                onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                title={isSidebarOpen ? t("sidebar.closeTooltip") : t("sidebar.openTooltip")}
              >
                <IconList />
              </button>
              <span className="text-[13px] font-semibold text-text-secondary uppercase tracking-[0.5px] flex items-center gap-2 min-w-0">
                <span className={`text-[10px] text-text-muted transition-colors duration-300 ${isRunning ? 'text-success drop-shadow-[0_0_8px_rgba(16,185,129,1)] animate-pulse' : ''}`}>●</span>
                {isRenaming ? (
                    <input
                      autoFocus
                      className="bg-transparent border-b border-primary text-text-primary font-semibold p-1 outline-none max-w-full"
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
                      className={`transition-colors min-w-0 truncate ${activeSessionId ? 'cursor-text border-b border-dashed border-text-muted hover:text-text-primary' : 'cursor-default'}`}
                    >
                      {activeSessionName || t("session.noSession")}
                    </span>
                )}
                <span className="opacity-50 ml-2 shrink-0">({cards.length})</span>
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0 pl-2">
              {isSessionTranslating && (
                <span
                  className="text-xs text-text-secondary px-2 py-1 rounded-md bg-bg-secondary border border-border"
                  title={t("translateSession.progressTitle", {
                    completed: sessionTranslationCompleted,
                    total: sessionTranslationTotal,
                  })}
                >
                  {sessionTranslationCompleted}/{sessionTranslationTotal} ({sessionTranslationProgressPercent}%)
                </span>
              )}
              <CopyButton
                cards={cards}
                addToast={addToast}
                isTeamsMode={config.caption_source === 'teams'}
              />
              <button
                className={`bg-transparent border-none text-text-muted p-2 rounded-full transition-all flex items-center justify-center ${(cards.length > 0) ? 'cursor-pointer text-text-secondary hover:bg-card-hover hover:text-text-primary' : 'cursor-not-allowed'} ${isCardSearchOpen ? 'bg-card-hover text-text-primary' : ''}`}
                onClick={handleToggleCardSearch}
                title={t("headerSearch.tooltip")}
                aria-label={t("headerSearch.tooltip")}
                aria-expanded={isCardSearchOpen}
                aria-controls="caption-card-search"
                disabled={cards.length === 0}
              >
                <IconSearch />
              </button>
              <button
                className={`bg-transparent border-none text-text-muted cursor-not-allowed p-2 rounded-full transition-all flex items-center justify-center ${(cards.length > 0 && !isSessionTranslating) ? 'cursor-pointer text-text-secondary hover:bg-card-hover hover:text-text-primary' : ''}`}
                onClick={() => {
                  if (isSessionTranslating) return;
                  setIsTranslateModalOpen(true);
                }}
                title={t("translateSession.tooltip")}
                disabled={cards.length === 0 || isSessionTranslating}
              >
                <IconLanguages />
              </button>
              <button
                className={`bg-transparent border-none text-text-muted p-2 rounded-full transition-all flex items-center justify-center ${config.ai_models.length > 0 ? 'cursor-pointer text-text-secondary hover:bg-card-hover hover:text-text-primary' : 'cursor-not-allowed'} ${isChatOpen ? 'bg-card-hover text-text-primary' : ''}`}
                onClick={() => {
                  if (config.ai_models.length === 0) {
                    addToast('error', t("chat.noModelsConfigured"));
                    return;
                  }
                  setIsChatOpen(prev => !prev);
                }}
                onMouseEnter={config.ai_models.length > 0 ? preloadChatSidebar : undefined}
                onFocus={config.ai_models.length > 0 ? preloadChatSidebar : undefined}
                title={t("chat.tooltip")}
              >
                <IconMessageSquare />
              </button>
            </div>
            </div>

          </div>

          <div className="flex-1 overflow-hidden">
            <div className="flex h-full overflow-hidden">
              <div className="relative flex-1 min-w-0 overflow-hidden">
                {isCardSearchOpen && (
                  <div className="pointer-events-none absolute right-4 top-4 z-20 max-w-[calc(100%-2rem)] animate-slide-in">
                    <div className="pointer-events-auto relative h-10 w-[320px] max-w-full overflow-hidden rounded-xl border border-border/90 bg-input/95 shadow-[0_12px_28px_rgba(0,0,0,0.35)] backdrop-blur-sm transition-colors focus-within:border-primary">
                      <input
                        id="caption-card-search"
                        ref={cardSearchInputRef}
                        type="text"
                        className="h-full w-full border-none bg-transparent pl-3 pr-14 text-sm text-text-primary outline-none placeholder:text-text-muted"
                        value={cardSearchQuery}
                        onChange={event => setCardSearchQuery(event.target.value)}
                        onKeyDown={handleCardSearchKeyDown}
                        placeholder={t('headerSearch.placeholder')}
                        aria-label={t('headerSearch.placeholder')}
                      />
                      <div className="absolute inset-y-0 right-0 flex w-8 flex-col overflow-hidden border-l border-border bg-bg-secondary/85">
                        <button
                          type="button"
                          className="flex flex-1 items-center justify-center border-none bg-transparent text-text-secondary transition-colors hover:bg-card-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() => handleNavigateCardSearch('prev')}
                          title={t('headerSearch.previous')}
                          aria-label={t('headerSearch.previous')}
                          disabled={!normalizedCardSearchQuery || cardSearchMatches.length === 0}
                        >
                          <IconChevronDown className="rotate-180" size={16} />
                        </button>
                        <button
                          type="button"
                          className="flex flex-1 items-center justify-center border-none border-t border-border bg-transparent text-text-secondary transition-colors hover:bg-card-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() => handleNavigateCardSearch('next')}
                          title={t('headerSearch.next')}
                          aria-label={t('headerSearch.next')}
                          disabled={!normalizedCardSearchQuery || cardSearchMatches.length === 0}
                        >
                          <IconChevronDown size={16} />
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                <div
                  className="h-full overflow-y-auto p-4 flex flex-col"
                  ref={scrollContainerRef}
                  onWheel={handleScrollWheel}
                  style={{
                    overflowAnchor: autoFollow ? 'none' : 'auto',
                  }}
                >
                  <CaptionsList
                    addToast={addToast}
                    autoFollow={autoFollow}
                    cards={cards}
                    hasActiveSession={!!activeSessionId}
                    isTeamsMode={config.caption_source === 'teams'}
                    onRetryTranslation={retryTranslation}
                    partialText={partialText}
                    scrollContainerRef={scrollContainerRef}
                    scrollTop={listScrollTop}
                    viewportHeight={listViewportHeight}
                    tempTranslations={tempTranslations}
                    highlightedCardId={highlightedCardId}
                  />
                  <div ref={historyEndRef} />
                </div>
              </div>
              {isChatOpen && (
                <Suspense fallback={<ChatSidebarFallback width={chatSidebarWidth} />}>
                  <ChatSidebar
                    isOpen={isChatOpen}
                    width={chatSidebarWidth}
                    messages={chatMessages}
                    input={chatInput}
                    isSending={isChatSending}
                    models={config.ai_models}
                    chatSessions={chatSessions}
                    activeChatSessionId={activeChatSessionId}
                    hasActiveSession={!!activeSessionId}
                    selectedModelId={chatModelId}
                    addToast={addToast}
                    onInputChange={setChatInput}
                    onModelChange={setChatModelId}
                    onNewSession={() => void handleStartNewChatSession()}
                    onSelectChatSession={id => void handleSelectChatSession(id)}
                    onSend={() => void handleSendChatMessage()}
                    onStop={handleStopChatMessage}
                    onResizeStart={handleChatSidebarResizeStart}
                    onCardReferenceClick={handleChatCardReferenceClick}
                    getModelLabel={model => getAIModelLabel(model.id)}
                  />
                </Suspense>
              )}
            </div>
          </div>

          <footer ref={footerRef} className="h-[60px] bg-panel border-t border-border flex items-center justify-between px-6 relative z-10">
              <div ref={footerStatusRef} className="flex items-center gap-2 max-w-[calc(50%-80px)] pr-4">
                <div className={`w-2 h-2 rounded-full shrink-0 ${isRunning ? 'bg-success shadow-[0_0_10px_var(--success)]' : 'bg-text-muted'}`} />
                <span className={`text-[11px] text-text-secondary truncate leading-[1.2] line-clamp-2 hover:line-clamp-none hover:overflow-visible hover:bg-panel hover:z-[100] hover:shadow-lg hover:p-1 hover:rounded ${status.startsWith('Error') ? 'text-error' : ''}`} title={status}>{status}</span>
              </div>
              <div aria-hidden="true" className="absolute inset-0 overflow-hidden pointer-events-none">
                <div ref={footerExpandedControlsMeasureRef} className="absolute left-0 top-0 invisible flex items-center">
                  <div className="h-10 w-10 mr-3 shrink-0" />
                  <div
                    className={`h-10 rounded-[20px] border-none flex shrink-0 items-center gap-2.5 px-5 font-bold tracking-[0.5px] whitespace-nowrap ${isRunning ? 'bg-bg-secondary border border-error text-error' : 'bg-primary text-black'}`}
                  >
                    {isRunning ? <IconSquare /> : <IconPlay />}
                    <span className="whitespace-nowrap">{toggleWatcherLabel}</span>
                  </div>
                  <div className="h-10 w-10 ml-3 shrink-0" />
                </div>
              </div>
              <div className="absolute inset-x-0 flex justify-center px-6 pointer-events-none">
                <div className="flex items-center justify-center [&>*]:pointer-events-auto">
                {config.caption_source !== 'teams' ? (
                  <button
                      className={`h-10 w-10 shrink-0 rounded-[20px] border-none bg-bg-secondary flex items-center justify-center transition-all duration-200 mr-3 ${!isRunning ? 'text-text-muted cursor-not-allowed opacity-50' : (isWindowVisible ? 'text-text-primary' : 'text-text-muted')} ${isRunning ? 'cursor-pointer opacity-100 hover:brightness-110' : ''}`}
                      onClick={toggleVisibility}
                      disabled={!isRunning}
                      title={isWindowVisible ? t("controls.hideWindow") : t("controls.showWindow")}
                  >
                      {isWindowVisible ? <IconEye /> : <IconEyeOff />}
                  </button>
                ) : (
                  <div className="h-10 w-10 mr-3 shrink-0" aria-hidden="true" />
                )}
                <button 
                  className={`h-10 rounded-[20px] border-none flex shrink-0 items-center font-bold tracking-[0.5px] whitespace-nowrap cursor-pointer transition-all duration-200 shadow-md hover:-translate-y-0.5 hover:shadow-[0_0_20px_var(--primary-glow)] ${isFooterToggleLabelCollapsed ? 'w-10 justify-center' : 'gap-2.5 px-5'} ${isRunning ? 'bg-bg-secondary border border-error text-error hover:bg-error/10' : 'bg-primary text-black'}`} 
                  onClick={toggleWatcher}
                  title={toggleWatcherLabel}
                  aria-label={toggleWatcherLabel}
                >
                    {isRunning ? <IconSquare /> : <IconPlay />}
                    {!isFooterToggleLabelCollapsed && <span className="whitespace-nowrap">{toggleWatcherLabel}</span>}
                </button>
                <button
                    className={`h-10 w-10 shrink-0 rounded-[20px] border-none bg-bg-secondary flex items-center justify-center transition-all duration-200 ml-3 ${isSummaryDisabled ? 'text-text-muted cursor-not-allowed' : 'text-text-primary cursor-pointer hover:brightness-110'}`}
                    onClick={handleSummarize}
                    disabled={isSummaryDisabled}
                    title={config.summary_provider?.trim() ? t("controls.summarize") : t("settings.summary.selectProvider")}
                >
                    <IconFileText />
                </button>
                </div>
              </div>
              <div ref={footerTrailingRef} className="w-[120px] flex justify-end items-center gap-3">
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
            {isSettingsOpen && (
              <Suspense fallback={null}>
                <SettingsForm
                  config={config}
                  onSave={saveConfig}
                  onConfigChange={setConfig}
                  onStartCopilotAuth={(id) => { setAuthChannelId(id); setDeviceAuthOpen(true); }}
                  addToast={addToast}
                  onClearAllSessions={handleClearAllSessions}
                  hasSessions={sessions.length > 0}
                />
              </Suspense>
            )}
          </div>
        </div>
      </div>
      
      {isDeviceAuthOpen && (
        <Suspense fallback={null}>
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
        </Suspense>
      )}

      {isTeamsModalOpen && (
        <Suspense fallback={null}>
          <TeamsSelectionModal
            isOpen={isTeamsModalOpen}
            onClose={() => setIsTeamsModalOpen(false)}
            onSelect={handleSelectTeamsWindow}
            windows={teamsWindows}
            onRefresh={fetchTeamsWindows}
            isScanning={isScanningTeams}
          />
        </Suspense>
      )}

      {isSummaryOpen && (
        <Suspense fallback={null}>
          <SummaryModal
            isOpen={isSummaryOpen}
            onClose={() => setIsSummaryOpen(false)}
            text={summaryText}
            isLoading={isSummarizing}
          />
        </Suspense>
      )}

      {isTranslateModalOpen && (
        <Suspense fallback={null}>
          <TranslateModal
            isOpen={isTranslateModalOpen}
            onClose={() => setIsTranslateModalOpen(false)}
            onTranslate={handleTranslateSession}
            currentTargetLang={config.target_lang}
            config={config}
            isTranslating={isSessionTranslating}
          />
        </Suspense>
      )}

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
