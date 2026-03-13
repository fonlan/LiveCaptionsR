import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog';
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import "./App.css";
import "./App.legacy.css";
import { 
  AIChatMessage,
  AIChatSession,
  AIChatSessionMetadata,
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
import { ChatSidebar } from "./components/ChatSidebar";
import {
  calculateSimilarity,
  shouldOverwrite,
  getLatestCaption,
  generateId
} from "./utils/textUtils";
import { filterDuplicateSentences, getNewSentences } from "./utils/captionProcessing";

// --- Constants ---
const MAX_IDLE_INTERVAL = 10;
const MAX_SYNC_INTERVAL = 20;
const MAX_TRANSLATION_BATCH_SIZE = 10;
const STICK_TO_BOTTOM_EPSILON = 4;
const AUTO_FOLLOW_ENABLE_THRESHOLD = 8;
const AUTO_FOLLOW_DISABLE_THRESHOLD = 120;
const WHEEL_LINE_HEIGHT_PX = 20;
const WHEEL_PAGE_RATIO = 0.88;
const WHEEL_CLASSIC_DELTA_THRESHOLD = 40;
const WHEEL_MAX_STEP_PX = 92;
const RECENT_SENTENCE_DEDUP_WINDOW_MS = 45_000;
const RECENT_SENTENCE_MAX_TRACKED = 800;
const RECENT_SENTENCE_MIN_LENGTH = 8;
const TEAMS_REWRITE_MAX_AGE_SECONDS = 15;
const TEAMS_REWRITE_SIMILARITY_THRESHOLD = 0.72;
const TEAMS_REWRITE_EDGE_SIMILARITY_THRESHOLD = 0.58;
const TEAMS_REWRITE_MIN_TOKEN_COUNT = 5;
const TEAMS_REWRITE_MAX_TOKEN_EDITS = 2;
const SUMMARY_TYPEWRITER_INTERVAL_MS = 16;
const SUMMARY_TYPEWRITER_CHARS_PER_TICK = 3;
const SESSION_SIDEBAR_MIN_MAIN_WIDTH = 360;
const CHAT_SIDEBAR_DEFAULT_WIDTH = SESSION_SIDEBAR_DEFAULT_WIDTH;
const CHAT_SIDEBAR_MIN_WIDTH = SESSION_SIDEBAR_DEFAULT_WIDTH;
const CHAT_SIDEBAR_MAX_WIDTH = 920;

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

type TranslationResultEvent = {
  request_id: string;
  card_id: string;
  original_text: string;
  translated: string | null;
  status: TranslationStatus | 'error';
  error?: string | null;
  is_retry: boolean;
};

type SummaryStreamEvent = {
  request_id: string;
  status: 'chunk' | 'done' | 'error';
  chunk?: string | null;
  full_text?: string | null;
  error?: string | null;
};

type CaptionChatCardInput = {
  original: string;
  user?: string;
  timestamp: number;
};

type PendingTranslationRequest = {
  cardId: string;
  text: string;
  isRetry: boolean;
  mode: 'live' | 'manual' | 'session';
  batchId?: string;
};

type CardSearchMatch = {
  cardId: string;
  cardNumber: number;
};

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

const normalizeCardSearchKeyword = (value: string): string => value.trim().toLocaleLowerCase();

const buildCardSearchHaystack = (card: SentenceCard, translatedText?: string | null): string => {
  return `${card.user ?? ""}\n${card.original}\n${translatedText ?? ""}`.toLocaleLowerCase();
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
  const [isWindowVisible, setIsWindowVisible] = useState<boolean>(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isSummaryOpen, setIsSummaryOpen] = useState<boolean>(false);
  const [summaryText, setSummaryText] = useState<string>("");
  const [isSummarizing, setIsSummarizing] = useState<boolean>(false);
  const [isChatOpen, setIsChatOpen] = useState<boolean>(false);
  const [chatMessages, setChatMessages] = useState<AIChatMessage[]>([]);
  const [chatInput, setChatInput] = useState<string>("");
  const [chatModelId, setChatModelId] = useState<string>("");
  const [isChatSending, setIsChatSending] = useState<boolean>(false);
  const [chatSessions, setChatSessions] = useState<AIChatSessionMetadata[]>([]);
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(null);
  const [activeChatSessionName, setActiveChatSessionName] = useState<string>("");
  const [activeChatSessionCreatedAt, setActiveChatSessionCreatedAt] = useState<number>(0);
  const [sessionSidebarWidth, setSessionSidebarWidth] = useState<number>(SESSION_SIDEBAR_DEFAULT_WIDTH);
  const [isSessionSidebarResizing, setIsSessionSidebarResizing] = useState<boolean>(false);
  const [chatSidebarWidth, setChatSidebarWidth] = useState<number>(CHAT_SIDEBAR_DEFAULT_WIDTH);
  const [isChatSidebarResizing, setIsChatSidebarResizing] = useState<boolean>(false);
  const [appVersion, setAppVersion] = useState<string>("");
  const [isTranslateModalOpen, setIsTranslateModalOpen] = useState<boolean>(false);
  const [tempTranslations, setTempTranslations] = useState<Record<string, { translated: string; status: TranslationStatus }>>({});
  const [isSessionTranslating, setIsSessionTranslating] = useState(false);
  const [sessionTranslationTotal, setSessionTranslationTotal] = useState(0);
  const [sessionTranslationCompleted, setSessionTranslationCompleted] = useState(0);
  
  // Session State
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSessionName, setActiveSessionName] = useState<string>("");
  const [activeSessionCreatedAt, setActiveSessionCreatedAt] = useState<number>(0);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  
  const [cardsState, dispatchCards] = useReducer(cardsReducer, EMPTY_CARDS_STATE);
  const cards = cardsState.cards;
  const [partialText, setPartialText] = useState<string>("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [autoFollow, setAutoFollow] = useState<boolean>(true);
  const [listScrollTop, setListScrollTop] = useState(0);
  const [listViewportHeight, setListViewportHeight] = useState(0);
  const [highlightedCardId, setHighlightedCardId] = useState<string | null>(null);
  const [isCardSearchOpen, setIsCardSearchOpen] = useState(false);
  const [cardSearchQuery, setCardSearchQuery] = useState("");
  const [activeCardSearchMatchIndex, setActiveCardSearchMatchIndex] = useState(-1);
   
   // Teams Modal State
  const [isTeamsModalOpen, setIsTeamsModalOpen] = useState(false);
  const [teamsWindows, setTeamsWindows] = useState<TeamsWindowInfo[]>([]);
  const [isScanningTeams, setIsScanningTeams] = useState(false);
  const [isDeviceAuthOpen, setDeviceAuthOpen] = useState(false);
  const [authChannelId, setAuthChannelId] = useState<string | null>(null);

  const historyEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const cardSearchInputRef = useRef<HTMLInputElement>(null);
  const cardsRef = useRef<SentenceCard[]>([]);
  const cardIndexRef = useRef<Record<string, number>>({});
  const pendingTranslationRequestsRef = useRef<Record<string, PendingTranslationRequest>>({});
  const activeSessionTranslationBatchIdRef = useRef<string | null>(null);
  const sessionTranslationTotalRef = useRef(0);
  const sessionTranslationCompletedRef = useRef(0);
  const configRef = useRef<AppConfig>(DEFAULT_CONFIG);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSummaryRequestIdRef = useRef<string | null>(null);
  const summaryTypingQueueRef = useRef("");
  const summaryTypingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const summaryStreamDoneRef = useRef(false);
  const summaryFinalTextRef = useRef("");

  const lastFullTextRef = useRef<string>("");
  const lastCaptionUserRef = useRef<string | null>(null);
  const lastOriginalTextRef = useRef<string>("");
  const lastProcessedCardRef = useRef<SentenceCard | null>(null);
  const pendingTranslationCardIdRef = useRef<string | null>(null); // Teams mode: card waiting for translation
  const translationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleCountRef = useRef<number>(0);
  const syncCountRef = useRef<number>(0);
  const isFirstCaptionRef = useRef<boolean>(true);
  const overlayMouseDownRef = useRef<boolean>(false);
  const sessionSidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const chatSidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const chatCardJumpTimerRef = useRef<number | null>(null);
  const chatCardHighlightClearTimerRef = useRef<number | null>(null);
  const chatActiveRequestIdRef = useRef<string | null>(null);
  const activeChatSessionIdRef = useRef<string | null>(null);
  const activeChatSessionNameRef = useRef<string>("");
  const activeChatSessionCreatedAtRef = useRef<number>(0);
  const chatMessagesRef = useRef<AIChatMessage[]>([]);
  const recentSentenceSeenAtRef = useRef<Map<string, number>>(new Map());
  const autoFollowRef = useRef<boolean>(true);
  const lastScrollTopRef = useRef<number>(0);
  const scrollRafRef = useRef<number | null>(null);
  const queuedScrollTopRef = useRef<number>(0);
  const queuedViewportHeightRef = useRef<number>(0);
  const isRunningRef = useRef<boolean>(false);
  const activeSessionIdRef = useRef<string | null>(null);

  const normalizedCardSearchQuery = useMemo(
    () => normalizeCardSearchKeyword(cardSearchQuery),
    [cardSearchQuery],
  );

  const cardSearchMatches = useMemo<CardSearchMatch[]>(() => {
    if (!isCardSearchOpen || !normalizedCardSearchQuery) {
      return [];
    }

    return cards.reduce<CardSearchMatch[]>((matches, card, index) => {
      const translatedText = tempTranslations[card.id]?.translated ?? card.translated;
      const haystack = buildCardSearchHaystack(card, translatedText);

      if (haystack.includes(normalizedCardSearchQuery)) {
        matches.push({
          cardId: card.id,
          cardNumber: index + 1,
        });
      }

      return matches;
    }, []);
  }, [cards, isCardSearchOpen, normalizedCardSearchQuery, tempTranslations]);
  const activeSessionNameRef = useRef<string>("");
  const activeSessionCreatedAtRef = useRef<number>(0);
  const stopFinalizeInFlightRef = useRef<Promise<void> | null>(null);


  const addToast = useCallback((type: 'success' | 'error', message: string) => {
    const id = generateId();
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3000);
  }, []);

  const stopSummaryTypewriter = () => {
    if (summaryTypingTimerRef.current) {
      clearInterval(summaryTypingTimerRef.current);
      summaryTypingTimerRef.current = null;
    }
  };

  const finishSummaryStreamIfReady = () => {
    if (!summaryStreamDoneRef.current || summaryTypingQueueRef.current.length > 0) {
      return;
    }

    stopSummaryTypewriter();
    activeSummaryRequestIdRef.current = null;
    const finalText = summaryFinalTextRef.current;
    setSummaryText(currentText => {
      if (currentText !== finalText) {
        return finalText;
      }
      return currentText;
    });
    setIsSummarizing(false);
  };

  const ensureSummaryTypewriterRunning = () => {
    if (summaryTypingTimerRef.current) {
      return;
    }

    summaryTypingTimerRef.current = setInterval(() => {
      const queue = summaryTypingQueueRef.current;
      if (queue.length === 0) {
        finishSummaryStreamIfReady();
        return;
      }

      const take = Math.min(SUMMARY_TYPEWRITER_CHARS_PER_TICK, queue.length);
      const nextChunk = queue.slice(0, take);
      summaryTypingQueueRef.current = queue.slice(take);
      setSummaryText(prev => prev + nextChunk);

      if (summaryTypingQueueRef.current.length === 0) {
        finishSummaryStreamIfReady();
      }
    }, SUMMARY_TYPEWRITER_INTERVAL_MS);
  };

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

  const normalizeSentenceForDedup = (text: string): string => {
    return text
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .replace(/[.!?。！？,，;；:：]+$/g, "")
      .trim()
      .toLowerCase();
  };

  const tokenizeTeamsRewriteText = (text: string): string[] => {
    const normalized = text
      .normalize("NFKC")
      .replace(/[’]/g, "'")
      .toLowerCase();

    return normalized.match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];
  };

  const normalizeTeamsRewriteText = (text: string): string => {
    return tokenizeTeamsRewriteText(text).join(" ");
  };

  const countSharedTokenPrefix = (left: string[], right: string[]): number => {
    const limit = Math.min(left.length, right.length);
    let count = 0;
    while (count < limit && left[count] === right[count]) {
      count += 1;
    }
    return count;
  };

  const countSharedTokenSuffix = (left: string[], right: string[]): number => {
    const limit = Math.min(left.length, right.length);
    let count = 0;
    while (
      count < limit &&
      left[left.length - 1 - count] === right[right.length - 1 - count]
    ) {
      count += 1;
    }
    return count;
  };

  const calculateSequenceSimilarity = (left: string[], right: string[]): number => {
    if (left.length === 0 && right.length === 0) {
      return 1;
    }
    if (left.length === 0 || right.length === 0) {
      return 0;
    }

    const matrix = Array.from({ length: left.length + 1 }, (_, rowIndex) =>
      Array.from({ length: right.length + 1 }, (_, columnIndex) => {
        if (rowIndex === 0) return columnIndex;
        if (columnIndex === 0) return rowIndex;
        return 0;
      }),
    );

    for (let i = 1; i <= left.length; i += 1) {
      for (let j = 1; j <= right.length; j += 1) {
        const cost = left[i - 1] === right[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost,
        );
      }
    }

    const distance = matrix[left.length][right.length];
    const maxLength = Math.max(left.length, right.length);
    return 1 - distance / maxLength;
  };
  const shouldOverwriteTeamsCard = (
    previousText: string,
    nextText: string,
    ageSeconds: number,
  ): boolean => {
    if (ageSeconds > TEAMS_REWRITE_MAX_AGE_SECONDS) {
      return false;
    }

    const previousNormalized = normalizeTeamsRewriteText(previousText);
    const nextNormalized = normalizeTeamsRewriteText(nextText);
    if (!previousNormalized || !nextNormalized) {
      return false;
    }

    if (previousNormalized === nextNormalized) {
      return true;
    }

    const previousTokens = tokenizeTeamsRewriteText(previousText);
    const nextTokens = tokenizeTeamsRewriteText(nextText);
    const minTokenCount = Math.min(previousTokens.length, nextTokens.length);
    const sharedPrefixTokens = countSharedTokenPrefix(previousTokens, nextTokens);
    const sharedSuffixTokens = countSharedTokenSuffix(previousTokens, nextTokens);
    const sharedEdgeTokens = Math.min(minTokenCount, sharedPrefixTokens + sharedSuffixTokens);
    const shorterText = previousNormalized.length <= nextNormalized.length
      ? previousNormalized
      : nextNormalized;
    const longerText = previousNormalized.length > nextNormalized.length
      ? previousNormalized
      : nextNormalized;
    const hasContainment = shorterText.length >= 8 && longerText.includes(shorterText);
    const fullySharedEdge = minTokenCount > 0 && (
      sharedPrefixTokens === minTokenCount || sharedSuffixTokens === minTokenCount
    );
    const hasDominantEdgeCoverage =
      minTokenCount >= TEAMS_REWRITE_MIN_TOKEN_COUNT &&
      sharedEdgeTokens + TEAMS_REWRITE_MAX_TOKEN_EDITS >= minTokenCount;
    const normalizedSimilarity = calculateSimilarity(previousNormalized, nextNormalized);
    const tokenSimilarity = calculateSequenceSimilarity(previousTokens, nextTokens);
    const hasStrongSimilarity = normalizedSimilarity >= TEAMS_REWRITE_SIMILARITY_THRESHOLD;
    const hasEdgeBackedSimilarity =
      normalizedSimilarity >= TEAMS_REWRITE_EDGE_SIMILARITY_THRESHOLD && (
        hasContainment ||
        fullySharedEdge ||
        hasDominantEdgeCoverage ||
        sharedPrefixTokens >= 2 ||
        sharedSuffixTokens >= 2
      );

    const hasStrongTokenSimilarity =
      minTokenCount >= TEAMS_REWRITE_MIN_TOKEN_COUNT &&
      tokenSimilarity >= TEAMS_REWRITE_SIMILARITY_THRESHOLD;
    const hasEdgeBackedTokenSimilarity =
      minTokenCount >= TEAMS_REWRITE_MIN_TOKEN_COUNT &&
      tokenSimilarity >= TEAMS_REWRITE_EDGE_SIMILARITY_THRESHOLD && (
        hasContainment ||
        hasDominantEdgeCoverage ||
        sharedPrefixTokens >= 3 ||
        sharedSuffixTokens >= 3
      );
    if (
      hasStrongSimilarity ||
      hasEdgeBackedSimilarity ||
      hasStrongTokenSimilarity ||
      hasEdgeBackedTokenSimilarity ||
      hasDominantEdgeCoverage
    ) {
      return true;
    }

    return shouldOverwrite(previousText, nextText) && (
      hasContainment ||
      fullySharedEdge ||
      hasDominantEdgeCoverage ||
      sharedPrefixTokens >= 3 ||
      sharedSuffixTokens >= 3
    );
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

  const normalizeWheelDelta = (event: ReactWheelEvent<HTMLDivElement>, container: HTMLDivElement): number => {
    if (event.deltaMode === 1) {
      return event.deltaY * WHEEL_LINE_HEIGHT_PX;
    }
    if (event.deltaMode === 2) {
      return event.deltaY * container.clientHeight * WHEEL_PAGE_RATIO;
    }
    return event.deltaY;
  };

  const handleScrollWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey) return;

    const container = scrollContainerRef.current;
    if (!container) return;

    const normalizedDelta = normalizeWheelDelta(event, container);
    const isClassicWheel =
      event.deltaMode !== 0 || Math.abs(normalizedDelta) >= WHEEL_CLASSIC_DELTA_THRESHOLD;

    if (!isClassicWheel) return;

    event.preventDefault();

    const appliedDelta = Math.max(-WHEEL_MAX_STEP_PX, Math.min(WHEEL_MAX_STEP_PX, normalizedDelta));
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const nextScrollTop = Math.max(0, Math.min(maxScrollTop, container.scrollTop + appliedDelta));

    container.scrollTo({ top: nextScrollTop, behavior: "auto" });
  };

  const resetSessionTranslationProgress = () => {
    activeSessionTranslationBatchIdRef.current = null;
    sessionTranslationTotalRef.current = 0;
    sessionTranslationCompletedRef.current = 0;
    setIsSessionTranslating(false);
    setSessionTranslationTotal(0);
    setSessionTranslationCompleted(0);
  };

  const startSessionTranslationProgress = (batchId: string, total: number) => {
    activeSessionTranslationBatchIdRef.current = batchId;
    sessionTranslationTotalRef.current = total;
    sessionTranslationCompletedRef.current = 0;
    setIsSessionTranslating(total > 0);
    setSessionTranslationTotal(total);
    setSessionTranslationCompleted(0);
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

  const finalizePendingLiveTranslationsOnStop = (): SentenceCard[] => {
    const pendingCards = new Map<string, string | undefined>();

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
        pendingCards.set(pending.cardId, pending.text);
      } else {
        retainedRequests[requestId] = pending;
      }
    }
    pendingTranslationRequestsRef.current = retainedRequests;

    if (pendingCards.size === 0) {
      return cardsRef.current;
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
      return nextCards;
    }

    return cardsRef.current;
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
      const finalizedCards = finalizePendingLiveTranslationsOnStop();
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

  const markSessionTranslationProgressStep = (batchId: string) => {
    if (activeSessionTranslationBatchIdRef.current !== batchId) return;

    const total = sessionTranslationTotalRef.current;
    if (total <= 0) return;

    const next = Math.min(total, sessionTranslationCompletedRef.current + 1);
    sessionTranslationCompletedRef.current = next;
    setSessionTranslationCompleted(next);

    if (next >= total) {
      setIsSessionTranslating(false);
      addToast('success', t("toast.sessionTranslationComplete", { completed: next, total }));
    }
  };

  const formatChatSessionTimestamp = (timestampSec: number): string => {
    const date = new Date(timestampSec * 1000);
    const pad = (value: number): string => String(value).padStart(2, "0");
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  };

  const buildDefaultChatSessionName = (timestampSec: number = Math.floor(Date.now() / 1000)): string =>
    `[${formatChatSessionTimestamp(timestampSec)}]`;

  const buildChatSessionTitleFromQuestion = (
    question: string,
    timestampSec: number = Math.floor(Date.now() / 1000),
  ): string => {
    const compactQuestion = question.replace(/\s+/g, " ").trim();
    const titleQuestion =
      compactQuestion.length > 48
        ? `${compactQuestion.slice(0, 48)}...`
        : compactQuestion;
    return `[${formatChatSessionTimestamp(timestampSec)}] ${titleQuestion}`;
  };

  const normalizeLoadedChatMessages = (
    messages: AIChatMessage[],
  ): { messages: AIChatMessage[]; changed: boolean } => {
    let changed = false;
    const normalized = messages.map((message, index) => {
      const nextStatus = message.status === "loading" ? "error" : message.status;
      const nextCreatedAt = message.created_at || Math.floor(Date.now() / 1000) + index;
      if (nextStatus !== message.status || nextCreatedAt !== message.created_at) {
        changed = true;
      }
      return {
        ...message,
        status: nextStatus,
        created_at: nextCreatedAt,
      };
    });
    return { messages: normalized, changed };
  };

  const refreshChatSessionList = useCallback(async (sessionId: string) => {
    try {
      const list = await invoke<AIChatSessionMetadata[]>("get_ai_chat_sessions", { sessionId });
      if (activeSessionIdRef.current === sessionId) {
        setChatSessions(list);
      }
      return list;
    } catch (e) {
      console.error("Failed to load AI chat sessions:", e);
      return [] as AIChatSessionMetadata[];
    }
  }, []);

  const saveActiveChatSessionSnapshot = useCallback(async (
    messagesOverride?: AIChatMessage[],
    options?: { refreshList?: boolean },
  ) => {
    const translationSessionId = activeSessionIdRef.current;
    const chatSessionId = activeChatSessionIdRef.current;
    if (!translationSessionId || !chatSessionId) {
      return;
    }

    const createdAt = activeChatSessionCreatedAtRef.current || Math.floor(Date.now() / 1000);
    const updatedAt = Math.floor(Date.now() / 1000);
    const sessionToSave: AIChatSession = {
      id: chatSessionId,
      session_id: translationSessionId,
      name: activeChatSessionNameRef.current || buildDefaultChatSessionName(),
      created_at: createdAt,
      updated_at: updatedAt,
      messages: messagesOverride ?? chatMessagesRef.current,
    };

    try {
      await invoke("save_ai_chat_session_data", { chatSession: sessionToSave });
      if (options?.refreshList) {
        await refreshChatSessionList(translationSessionId);
      }
    } catch (e) {
      console.error("Failed to save AI chat session:", e);
    }
  }, [refreshChatSessionList]);

  const loadChatSessionById = useCallback(async (chatSessionId: string) => {
    const chatSession = await invoke<AIChatSession>("load_ai_chat_session_data", {
      id: chatSessionId,
    });
    const normalized = normalizeLoadedChatMessages(chatSession.messages);

    setActiveChatSessionId(chatSession.id);
    setActiveChatSessionName(chatSession.name);
    setActiveChatSessionCreatedAt(chatSession.created_at);
    activeChatSessionIdRef.current = chatSession.id;
    activeChatSessionNameRef.current = chatSession.name;
    activeChatSessionCreatedAtRef.current = chatSession.created_at;

    setChatMessages(normalized.messages);
    chatMessagesRef.current = normalized.messages;
    setChatInput("");
    setHighlightedCardId(null);
    setIsChatSending(false);
    chatActiveRequestIdRef.current = null;

    if (normalized.changed) {
      await saveActiveChatSessionSnapshot(normalized.messages, { refreshList: true });
    }
  }, [saveActiveChatSessionSnapshot]);

  const activateUnsavedChatDraft = useCallback((
    translationSessionId: string,
    createdAtSec: number = Math.floor(Date.now() / 1000),
  ): AIChatSession => {
    const draftId = generateId();
    const draftName = buildDefaultChatSessionName(createdAtSec);
    const draft: AIChatSession = {
      id: draftId,
      session_id: translationSessionId,
      name: draftName,
      created_at: createdAtSec,
      updated_at: createdAtSec,
      messages: [],
    };

    setActiveChatSessionId(draft.id);
    setActiveChatSessionName(draft.name);
    setActiveChatSessionCreatedAt(draft.created_at);
    activeChatSessionIdRef.current = draft.id;
    activeChatSessionNameRef.current = draft.name;
    activeChatSessionCreatedAtRef.current = draft.created_at;
    chatActiveRequestIdRef.current = null;
    setIsChatSending(false);
    setChatMessages([]);
    chatMessagesRef.current = [];
    setChatInput("");
    setHighlightedCardId(null);
    return draft;
  }, []);

  const ensureActiveChatSession = useCallback(() => {
    const translationSessionId = activeSessionIdRef.current;
    if (!translationSessionId) {
      return null;
    }

    const currentId = activeChatSessionIdRef.current;
    if (currentId && activeChatSessionCreatedAtRef.current) {
      return {
        id: currentId,
        session_id: translationSessionId,
        name: activeChatSessionNameRef.current || buildDefaultChatSessionName(),
        created_at: activeChatSessionCreatedAtRef.current,
        updated_at: Math.floor(Date.now() / 1000),
        messages: chatMessagesRef.current,
      } as AIChatSession;
    }

    return activateUnsavedChatDraft(translationSessionId);
  }, [activateUnsavedChatDraft]);

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
      dispatchCards({ type: "reset", cards: [] }); // Clear cards for new session
      setTempTranslations({}); // Clear temp translations
      setAutoFollow(true);
      lastProcessedCardRef.current = null;
      resetRecentSentenceDedup();

      setPartialText("");
      lastFullTextRef.current = "";
      lastCaptionUserRef.current = null;
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
      setActiveSessionId(session.id);
      setActiveSessionName(session.name);
      setActiveSessionCreatedAt(session.created_at);
      dispatchCards({ type: "reset", cards: normalized.cards });
      setTempTranslations({}); // Clear temp translations
      setAutoFollow(false); // Don't auto-scroll when loading history
      lastProcessedCardRef.current = normalized.cards.length > 0 ? normalized.cards[normalized.cards.length - 1] : null;
      resetRecentSentenceDedup();

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
        dispatchCards({ type: "reset", cards: [] });
        setTempTranslations({}); // Clear temp translations
        lastProcessedCardRef.current = null;
        resetRecentSentenceDedup();
        setPartialText("");
        lastCaptionUserRef.current = null;
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
      dispatchCards({ type: "reset", cards: [] });
      setTempTranslations({});
      lastProcessedCardRef.current = null;
      resetRecentSentenceDedup();
      setPartialText("");
      lastCaptionUserRef.current = null;
      
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
    cardIndexRef.current = cardsState.indexById;
    if (autoFollow) {
      const container = scrollContainerRef.current;
      if (container) {
        const targetTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const distanceToBottom = targetTop - container.scrollTop;
        if (distanceToBottom > STICK_TO_BOTTOM_EPSILON) {
          container.scrollTo({ top: targetTop, behavior: "auto" });
        }
      }
    }
  }, [cards, cardsState.indexById, partialText, autoFollow]);

  useEffect(() => {
    autoFollowRef.current = autoFollow;
  }, [autoFollow]);

  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    activeSessionNameRef.current = activeSessionName;
    activeSessionCreatedAtRef.current = activeSessionCreatedAt;
  }, [activeSessionId, activeSessionName, activeSessionCreatedAt]);

  useEffect(() => {
    activeChatSessionIdRef.current = activeChatSessionId;
    activeChatSessionNameRef.current = activeChatSessionName;
    activeChatSessionCreatedAtRef.current = activeChatSessionCreatedAt;
  }, [activeChatSessionId, activeChatSessionName, activeChatSessionCreatedAt]);

  useEffect(() => {
    chatMessagesRef.current = chatMessages;
  }, [chatMessages]);

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
    setChatModelId(prev => {
      if (prev && config.ai_models.some(model => model.id === prev)) {
        return prev;
      }

      const summaryProvider = config.summary_provider?.trim();
      if (summaryProvider && config.ai_models.some(model => model.id === summaryProvider)) {
        return summaryProvider;
      }

      return config.ai_models[0]?.id || "";
    });
  }, [config.ai_models, config.summary_provider]);

  useEffect(() => {
    chatActiveRequestIdRef.current = null;
    setIsChatSending(false);

    const loadChatSessionsForActiveSession = async () => {
      if (!activeSessionId) {
        setChatSessions([]);
        setActiveChatSessionId(null);
        setActiveChatSessionName("");
        setActiveChatSessionCreatedAt(0);
        activeChatSessionIdRef.current = null;
        activeChatSessionNameRef.current = "";
        activeChatSessionCreatedAtRef.current = 0;
        setChatMessages([]);
        chatMessagesRef.current = [];
        setChatInput("");
        setHighlightedCardId(null);
        return;
      }

      activateUnsavedChatDraft(activeSessionId);

      try {
        await refreshChatSessionList(activeSessionId);
      } catch (e) {
        console.error("Failed to load AI chat sessions:", e);
      }
    };

    void loadChatSessionsForActiveSession();
  }, [activeSessionId, activateUnsavedChatDraft, refreshChatSessionList]);

  useEffect(() => {
    return () => {
      if (chatCardJumpTimerRef.current !== null) {
        window.clearTimeout(chatCardJumpTimerRef.current);
      }
      if (chatCardHighlightClearTimerRef.current !== null) {
        window.clearTimeout(chatCardHighlightClearTimerRef.current);
      }
    };
  }, []);

  const clampChatSidebarWidth = useCallback((value: number): number => {
    const viewportMax = Math.floor(window.innerWidth * 0.85);
    const maxWidth = Math.max(CHAT_SIDEBAR_MIN_WIDTH, Math.min(CHAT_SIDEBAR_MAX_WIDTH, viewportMax));
    return Math.max(CHAT_SIDEBAR_MIN_WIDTH, Math.min(maxWidth, Math.round(value)));
  }, []);

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

  useEffect(() => {
    setIsCardSearchOpen(false);
    setCardSearchQuery("");
    setActiveCardSearchMatchIndex(-1);
  }, [activeSessionId]);

  useEffect(() => {
    if (!isCardSearchOpen) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      cardSearchInputRef.current?.focus();
      cardSearchInputRef.current?.select();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [isCardSearchOpen]);

  useEffect(() => {
    setActiveCardSearchMatchIndex(-1);
  }, [normalizedCardSearchQuery]);

  useEffect(() => {
    setActiveCardSearchMatchIndex(prev => {
      if (!normalizedCardSearchQuery || cardSearchMatches.length === 0) {
        return -1;
      }

      if (prev < 0) {
        return prev;
      }

      return Math.min(prev, cardSearchMatches.length - 1);
    });
  }, [cardSearchMatches.length]);



  // Handle scroll detection for auto-follow
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    setListViewportHeight(container.clientHeight);
    lastScrollTopRef.current = container.scrollTop;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const distanceToBottom = scrollHeight - scrollTop - clientHeight;
      const scrollingUp = scrollTop + 2 < lastScrollTopRef.current;
      lastScrollTopRef.current = scrollTop;

      queuedScrollTopRef.current = scrollTop;
      queuedViewportHeightRef.current = clientHeight;
      if (scrollRafRef.current === null) {
        scrollRafRef.current = window.requestAnimationFrame(() => {
          setListScrollTop(queuedScrollTopRef.current);
          setListViewportHeight(prev => (
            prev === queuedViewportHeightRef.current ? prev : queuedViewportHeightRef.current
          ));
          scrollRafRef.current = null;
        });
      }

      if (autoFollowRef.current) {
        if (scrollingUp && distanceToBottom > AUTO_FOLLOW_ENABLE_THRESHOLD) {
          autoFollowRef.current = false;
          setAutoFollow(false);
          return;
        }
        if (distanceToBottom > AUTO_FOLLOW_DISABLE_THRESHOLD) {
          autoFollowRef.current = false;
          setAutoFollow(false);
        }
      } else if (distanceToBottom <= AUTO_FOLLOW_ENABLE_THRESHOLD) {
        autoFollowRef.current = true;
        setAutoFollow(true);
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
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
      }
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
    lastOriginalTextRef.current = originalText;
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

    const unlistenSummaryStream = listen<SummaryStreamEvent>("summary-stream", (event) => {
      const payload = event.payload;
      if (!activeSummaryRequestIdRef.current || payload.request_id !== activeSummaryRequestIdRef.current) {
        return;
      }

      if (payload.status === 'chunk') {
        if (payload.chunk) {
          summaryTypingQueueRef.current += payload.chunk;
          ensureSummaryTypewriterRunning();
        }
        return;
      }

      if (payload.status === 'done') {
        summaryFinalTextRef.current = payload.full_text ?? summaryFinalTextRef.current;
        summaryStreamDoneRef.current = true;
        finishSummaryStreamIfReady();
        return;
      }

      if (payload.status === 'error') {
        stopSummaryTypewriter();
        summaryTypingQueueRef.current = "";
        summaryStreamDoneRef.current = true;
        activeSummaryRequestIdRef.current = null;
        const errorMessage = payload.error
          ? `Error generating summary: ${payload.error}`
          : "Error generating summary";
        summaryFinalTextRef.current = errorMessage;
        setSummaryText(errorMessage);
        setIsSummarizing(false);
      }
    });

    const unlistenRaw = listen<RawCaption>("caption-raw", async (event) => {
      const fullText = event.payload.text;
      const user = event.payload.user;

      if (isFirstCaptionRef.current) {
        isFirstCaptionRef.current = false;
        lastFullTextRef.current = fullText;
        const initialUser = (user ?? "").trim();
        lastCaptionUserRef.current = initialUser ? initialUser : null;
        return;
      }

      // Teams Mode: Delayed translation strategy with Overwrite support & 3s Timeout
      if (configRef.current.caption_source === 'teams') {
        const normalizedUser = (user ?? "").trim();
        const hasKnownSpeaker = normalizedUser.length > 0;
        const lastUser = (lastCaptionUserRef.current ?? "").trim();
        const hasSpeakerChanged = hasKnownSpeaker && normalizedUser !== lastUser;

        if ((fullText !== lastFullTextRef.current || hasSpeakerChanged) && fullText.trim()) {
          // Clear any existing 3s timer
          if (translationTimerRef.current) {
            clearTimeout(translationTimerRef.current);
          }

          const lastCard = lastProcessedCardRef.current;
          const lastCardUser = (lastCard?.user ?? "").trim();
          const continuationUser = hasKnownSpeaker ? normalizedUser : lastCardUser;
          const sanitizedUser = continuationUser ? continuationUser : undefined;
          const cardAgeSeconds = lastCard
            ? Math.max(0, Math.floor(Date.now() / 1000) - lastCard.timestamp)
            : Number.POSITIVE_INFINITY;
          const shouldTreatAsContinuation =
            !!lastCard &&
            !hasSpeakerChanged &&
            (!hasKnownSpeaker || normalizedUser === lastCardUser) &&
            shouldOverwriteTeamsCard(lastCard.original, fullText, cardAgeSeconds);
          
          // Helper to trigger translation for a pending card
          const triggerTranslation = (cardId: string) => {
             if (!configRef.current.translation_enabled) return;
             
             // IMPORTANT: Only now show the loading dots
             dispatchCards({ type: "patch", cardId, patch: { status: 'translating' } });

             const cardIndex = cardIndexRef.current[cardId];
             const card = cardIndex === undefined ? undefined : cardsRef.current[cardIndex];
             if (card) {
               performTranslation(cardId, card.original);
             }
          };

          // Check if this is an incremental update (continuation) of the last card
          if (shouldTreatAsContinuation && lastCard) {
            // Update the existing card, but keep status 'success' to hide dots
            dispatchCards({
              type: "patch",
              cardId: lastCard.id,
              patch: { original: fullText, user: sanitizedUser, status: 'success', translated: null },
            });
            
            pendingTranslationCardIdRef.current = lastCard.id;
            lastProcessedCardRef.current = { ...lastCard, original: fullText, user: sanitizedUser };
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
              user: sanitizedUser,
              timestamp
            };

            dispatchCards({ type: "append", card: newCard });
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
          if (hasKnownSpeaker) {
            lastCaptionUserRef.current = normalizedUser;
          }
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
      unlistenSummaryStream.then(f => f());
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
    return () => {
      stopSummaryTypewriter();
    };
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
    const summaryProvider = config.summary_provider?.trim();
    if (!summaryProvider) {
      addToast('error', t("settings.summary.selectProvider"));
      return;
    }

    if (cards.length === 0 || !activeSessionId || !activeSessionCreatedAt) return;
    setIsSummaryOpen(true);
    setIsSummarizing(true);
    setSummaryText("");
    stopSummaryTypewriter();
    summaryTypingQueueRef.current = "";
    summaryStreamDoneRef.current = false;
    summaryFinalTextRef.current = "";
    const requestId = generateId();
    activeSummaryRequestIdRef.current = requestId;

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
      activeSummaryRequestIdRef.current = null;
      summaryTypingQueueRef.current = "";
      summaryFinalTextRef.current = "";
      summaryStreamDoneRef.current = true;
      stopSummaryTypewriter();
      setSummaryText(`Error generating summary: ${err}`);
      setIsSummarizing(false);
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

  const buildChatCardsSnapshot = (): CaptionChatCardInput[] => {
    return cardsRef.current
      .filter(card => card.original.trim().length > 0)
      .map(card => ({
        original: card.original,
        user: card.user,
        timestamp: card.timestamp,
      }));
  };

  const setJumpHighlightedCard = (cardId: string) => {
    setHighlightedCardId(cardId);
    if (chatCardHighlightClearTimerRef.current !== null) {
      window.clearTimeout(chatCardHighlightClearTimerRef.current);
    }
    chatCardHighlightClearTimerRef.current = window.setTimeout(() => {
      setHighlightedCardId(prev => (prev === cardId ? null : prev));
      chatCardHighlightClearTimerRef.current = null;
    }, 1800);
  };

  const clampCardJumpScrollTop = (container: HTMLDivElement, top: number): number => {
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    return Math.max(0, Math.min(maxScrollTop, Math.round(top)));
  };

  const estimateCardJumpScrollTop = (
    container: HTMLDivElement,
    targetIndex: number,
    totalCards: number,
  ): number => {
    if (totalCards <= 1) return 0;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const ratio = targetIndex / Math.max(1, totalCards - 1);
    return clampCardJumpScrollTop(container, maxScrollTop * ratio - container.clientHeight * 0.45);
  };

  const collectRenderedCardEntries = (container: HTMLDivElement): Array<{ number: number; element: HTMLElement }> => {
    return Array.from(container.querySelectorAll<HTMLElement>("[data-card-number]"))
      .map(element => ({
        number: Number.parseInt(element.dataset.cardNumber ?? "", 10),
        element,
      }))
      .filter(item => Number.isFinite(item.number) && item.number > 0)
      .sort((a, b) => a.number - b.number);
  };

  const triggerCardJumpAnimation = (node: HTMLElement) => {
    node.classList.remove("chat-card-jump-anim");
    void node.offsetWidth;
    node.classList.add("chat-card-jump-anim");
    window.setTimeout(() => {
      node.classList.remove("chat-card-jump-anim");
    }, 1100);
  };

  const jumpToCardByNumber = useCallback((cardNumber: number) => {
    if (!Number.isInteger(cardNumber) || cardNumber <= 0) {
      return false;
    }

    const targetIndex = cardNumber - 1;
    const targetCard = cardsRef.current[targetIndex];
    if (!targetCard) {
      addToast("error", t("chat.cardNotFound", { number: cardNumber }));
      return false;
    }

    const container = scrollContainerRef.current;
    if (!container) {
      return false;
    }

    if (chatCardJumpTimerRef.current !== null) {
      window.clearTimeout(chatCardJumpTimerRef.current);
      chatCardJumpTimerRef.current = null;
    }

    setAutoFollow(false);
    autoFollowRef.current = false;

    const totalCards = cardsRef.current.length;
    const maxAttempts = 48;
    const targetScrollTop = estimateCardJumpScrollTop(container, targetIndex, totalCards);
    container.scrollTo({ top: targetScrollTop, behavior: "auto" });

    const locateAndScroll = (attempt: number) => {
      const node = container.querySelector<HTMLElement>(`[data-card-number="${cardNumber}"]`);
      if (node) {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        triggerCardJumpAnimation(node);
        setJumpHighlightedCard(targetCard.id);
        return;
      }

      if (attempt >= maxAttempts) {
        addToast("error", t("chat.cardJumpFailed", { number: cardNumber }));
        return;
      }

      const renderedEntries = collectRenderedCardEntries(container);

      if (renderedEntries.length === 0) {
        container.scrollTo({
          top: estimateCardJumpScrollTop(container, targetIndex, totalCards),
          behavior: "auto",
        });
      } else {
        const firstVisible = renderedEntries[0];
        const lastVisible = renderedEntries[renderedEntries.length - 1];
        const minVisible = firstVisible.number;
        const maxVisible = lastVisible.number;

        if (cardNumber < minVisible) {
          const estimated = estimateCardJumpScrollTop(container, targetIndex, totalCards);
          const nextTop = container.scrollTop - Math.max(240, Math.abs(container.scrollTop - estimated) * 0.7);
          container.scrollTo({ top: clampCardJumpScrollTop(container, nextTop), behavior: "auto" });
        } else if (cardNumber > maxVisible) {
          const estimated = estimateCardJumpScrollTop(container, targetIndex, totalCards);
          const nextTop = container.scrollTop + Math.max(240, Math.abs(estimated - container.scrollTop) * 0.7);
          container.scrollTo({ top: clampCardJumpScrollTop(container, nextTop), behavior: "auto" });
        } else {
          const cardSpan = Math.max(1, lastVisible.number - firstVisible.number);
          const pixelSpan = Math.max(1, lastVisible.element.offsetTop - firstVisible.element.offsetTop);
          const pixelsPerCard = pixelSpan / cardSpan;
          const estimatedOffsetTop =
            firstVisible.element.offsetTop + (cardNumber - firstVisible.number) * pixelsPerCard;
          const desiredTop = estimatedOffsetTop - container.clientHeight * 0.45;
          container.scrollTo({
            top: clampCardJumpScrollTop(container, desiredTop),
            behavior: "auto",
          });
        }
      }

      chatCardJumpTimerRef.current = window.setTimeout(() => {
        chatCardJumpTimerRef.current = null;
        locateAndScroll(attempt + 1);
      }, 24);
    };

    locateAndScroll(0);
    return true;
  }, [addToast, t]);

  const handleChatCardReferenceClick = (cardNumber: number) => {
    jumpToCardByNumber(cardNumber);
  };

  const handleOpenCardSearch = useCallback(() => {
    setIsCardSearchOpen(true);

    window.requestAnimationFrame(() => {
      cardSearchInputRef.current?.focus();
      cardSearchInputRef.current?.select();
    });
  }, []);

  const handleCloseCardSearch = useCallback(() => {
    setIsCardSearchOpen(false);
    cardSearchInputRef.current?.blur();
  }, []);

  const handleToggleCardSearch = useCallback(() => {
    setIsCardSearchOpen(prev => {
      const next = !prev;
      if (next) {
        window.requestAnimationFrame(() => {
          cardSearchInputRef.current?.focus();
          cardSearchInputRef.current?.select();
        });
      }
      return next;
    });
  }, []);

  const handleNavigateCardSearch = useCallback((direction: 'next' | 'prev') => {
    if (!normalizedCardSearchQuery) {
      cardSearchInputRef.current?.focus();
      return;
    }

    if (cardSearchMatches.length === 0) {
      addToast('error', t('headerSearch.noResults'));
      return;
    }

    const nextIndex = activeCardSearchMatchIndex < 0
      ? (direction === 'next' ? 0 : cardSearchMatches.length - 1)
      : (activeCardSearchMatchIndex + (direction === 'next' ? 1 : -1) + cardSearchMatches.length) % cardSearchMatches.length;

    setActiveCardSearchMatchIndex(nextIndex);
    jumpToCardByNumber(cardSearchMatches[nextIndex].cardNumber);
  }, [activeCardSearchMatchIndex, addToast, cardSearchMatches, jumpToCardByNumber, normalizedCardSearchQuery, t]);

  const handleCardSearchKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') {
      return;
    }

    event.preventDefault();
    handleNavigateCardSearch(event.shiftKey ? 'prev' : 'next');
  }, [handleNavigateCardSearch]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (isSettingsOpen || isSummaryOpen || isTranslateModalOpen || isTeamsModalOpen || isDeviceAuthOpen) {
        return;
      }

      if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.key === 'Escape' || event.key === 'Esc') && isCardSearchOpen) {
        event.preventDefault();
        handleCloseCardSearch();
        return;
      }

      const isFindShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f';
      if (!isFindShortcut) {
        return;
      }

      event.preventDefault();
      handleOpenCardSearch();
    };

    document.addEventListener('keydown', handleGlobalKeyDown);

    return () => {
      document.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [handleCloseCardSearch, handleOpenCardSearch, isCardSearchOpen, isDeviceAuthOpen, isSettingsOpen, isSummaryOpen, isTeamsModalOpen, isTranslateModalOpen]);

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

    setAutoFollow(false);
    autoFollowRef.current = false;
    container.scrollTo({ top: 0, behavior: "smooth" });

    const firstCardId = cardsRef.current[0]?.id;
    if (firstCardId) {
      setJumpHighlightedCard(firstCardId);
    }
  };

  const handleSendChatMessage = async () => {
    if (isChatSending) return;

    if (!activeSessionIdRef.current) {
      addToast("error", t("chat.sessionRequired"));
      return;
    }

    const question = chatInput.trim();
    if (!question) return;

    const providerId = chatModelId.trim();
    if (!providerId) {
      addToast('error', t("chat.modelRequired"));
      return;
    }

    const cardsSnapshot = buildChatCardsSnapshot();
    const userMessageId = generateId();
    const assistantMessageId = generateId();
    const requestId = generateId();

    const chatSession = ensureActiveChatSession();
    if (!chatSession) {
      addToast("error", t("chat.sessionRequired"));
      return;
    }

    const createdAt = Math.floor(Date.now() / 1000);
    const shouldUpdateTitle = chatMessagesRef.current.length === 0;
    if (shouldUpdateTitle) {
      const nextTitle = buildChatSessionTitleFromQuestion(question, createdAt);
      setActiveChatSessionName(nextTitle);
      activeChatSessionNameRef.current = nextTitle;
    }

    const queuedMessages: AIChatMessage[] = [
      ...chatMessagesRef.current,
      { id: userMessageId, role: "user", content: question, status: "done", created_at: createdAt },
      {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        status: "loading",
        created_at: createdAt + 1,
      },
    ];

    setChatInput("");
    setChatMessages(queuedMessages);
    chatMessagesRef.current = queuedMessages;
    chatActiveRequestIdRef.current = requestId;
    setIsChatSending(true);
    await saveActiveChatSessionSnapshot(queuedMessages);

    try {
      const response = await invoke<string>("chat_with_captions", {
        providerId,
        question,
        cards: cardsSnapshot,
      });

      if (chatActiveRequestIdRef.current !== requestId) {
        return;
      }

      const nextMessages = chatMessagesRef.current.map(message =>
        message.id === assistantMessageId
          ? { ...message, content: response, status: "done" as const }
          : message
      );
      setChatMessages(nextMessages);
      chatMessagesRef.current = nextMessages;
      await saveActiveChatSessionSnapshot(nextMessages, { refreshList: true });
    } catch (err) {
      if (chatActiveRequestIdRef.current !== requestId) {
        return;
      }

      const errorMessage = `${t("chat.errorPrefix")} ${String(err)}`;
      const nextMessages = chatMessagesRef.current.map(message =>
        message.id === assistantMessageId
          ? { ...message, content: errorMessage, status: "error" as const }
          : message
      );
      setChatMessages(nextMessages);
      chatMessagesRef.current = nextMessages;
      await saveActiveChatSessionSnapshot(nextMessages, { refreshList: true });
    } finally {
      if (chatActiveRequestIdRef.current === requestId) {
        chatActiveRequestIdRef.current = null;
        setIsChatSending(false);
      }
    }
  };

  const handleStopChatMessage = () => {
    if (!isChatSending) return;

    chatActiveRequestIdRef.current = null;
    setIsChatSending(false);

    const nextMessages = chatMessagesRef.current.map(message =>
      message.role === "assistant" && message.status === "loading"
        ? { ...message, content: t("status.stopped"), status: "done" as const }
        : message
    );
    setChatMessages(nextMessages);
    chatMessagesRef.current = nextMessages;
    void saveActiveChatSessionSnapshot(nextMessages, { refreshList: true });
  };

  const handleStartNewChatSession = () => {
    chatActiveRequestIdRef.current = null;
    setIsChatSending(false);

    const translationSessionId = activeSessionIdRef.current;
    if (!translationSessionId) {
      setChatSessions([]);
      setActiveChatSessionId(null);
      setActiveChatSessionName("");
      setActiveChatSessionCreatedAt(0);
      setChatMessages([]);
      chatMessagesRef.current = [];
      addToast("error", t("chat.sessionRequired"));
      return;
    }

    activateUnsavedChatDraft(translationSessionId);
  };

  const handleSelectChatSession = async (chatSessionId: string) => {
    if (!chatSessionId || chatSessionId === activeChatSessionIdRef.current) {
      return;
    }
    try {
      await loadChatSessionById(chatSessionId);
    } catch (err) {
      console.error("Failed to load AI chat session:", err);
      addToast("error", t("chat.sessionLoadFailed"));
    }
  };

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

  const runWindowAction = async (action: (appWindow: ReturnType<typeof getCurrentWindow>) => Promise<void>) => {
    try {
      const appWindow = getCurrentWindow();
      await action(appWindow);
    } catch (err) {
      console.error("Window action failed:", err);
    }
  };

  const handleWindowMinimize = () => {
    void runWindowAction(window => window.minimize());
  };
  const handleWindowMaximize = () => {
    void runWindowAction(window => window.toggleMaximize());
  };
  const handleWindowClose = () => {
    void runWindowAction(window => window.close());
  };

  const sessionTranslationProgressPercent = sessionTranslationTotal > 0
    ? Math.round((sessionTranslationCompleted / sessionTranslationTotal) * 100)
    : 0;

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
                title={t("chat.tooltip")}
              >
                <IconMessageSquare />
              </button>
            </div>
            </div>

          </div>

          <div className="flex-1 overflow-hidden relative">
            {isCardSearchOpen && (
              <div
                className="pointer-events-none absolute right-4 top-4 z-20 max-w-[calc(100%-2rem)] animate-slide-in"
                style={{
                  right: isChatOpen ? `${chatSidebarWidth + 16}px` : '16px',
                }}
              >
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
              className="h-full overflow-y-auto p-4 flex flex-col transition-[padding-right] duration-300"
              ref={scrollContainerRef}
              onWheel={handleScrollWheel}
              style={{
                overflowAnchor: 'none',
                paddingRight: isChatOpen ? `${chatSidebarWidth + 16}px` : undefined,
              }}
            >
              <CaptionsList
                addToast={addToast}
                cards={cards}
                hasActiveSession={!!activeSessionId}
                isTeamsMode={config.caption_source === 'teams'}
                onRetryTranslation={retryTranslation}
                partialText={partialText}
                scrollTop={listScrollTop}
                viewportHeight={listViewportHeight}
                tempTranslations={tempTranslations}
                highlightedCardId={highlightedCardId}
              />
              <div ref={historyEndRef} />
            </div>
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
          </div>

          <footer className="h-[60px] bg-panel border-t border-border flex items-center justify-between px-6 relative z-10">
              <div className="flex items-center gap-2 max-w-[calc(50%-80px)] pr-4">
                <div className={`w-2 h-2 rounded-full shrink-0 ${isRunning ? 'bg-success shadow-[0_0_10px_var(--success)]' : 'bg-text-muted'}`} />
                <span className={`text-[11px] text-text-secondary truncate leading-[1.2] line-clamp-2 hover:line-clamp-none hover:overflow-visible hover:bg-panel hover:z-[100] hover:shadow-lg hover:p-1 hover:rounded ${status.startsWith('Error') ? 'text-error' : ''}`} title={status}>{status}</span>
              </div>
              <div className="flex items-center justify-center absolute left-1/2 -translate-x-1/2 pointer-events-none [&>*]:pointer-events-auto">
              {config.caption_source !== 'teams' ? (
                <button
                    className={`h-10 w-10 rounded-[20px] border-none bg-bg-secondary flex items-center justify-center transition-all duration-200 mr-3 ${!isRunning ? 'text-text-muted cursor-not-allowed opacity-50' : (isWindowVisible ? 'text-text-primary' : 'text-text-muted')} ${isRunning ? 'cursor-pointer opacity-100 hover:brightness-110' : ''}`}
                    onClick={toggleVisibility}
                    disabled={!isRunning}
                    title={isWindowVisible ? t("controls.hideWindow") : t("controls.showWindow")}
                >
                    {isWindowVisible ? <IconEye /> : <IconEyeOff />}
                </button>
              ) : (
                <div className="h-10 w-10 mr-3" aria-hidden="true" />
              )}
              <button 
                className={`h-10 px-5 rounded-[20px] border-none flex items-center gap-2.5 font-bold tracking-[0.5px] cursor-pointer transition-all duration-200 shadow-md hover:-translate-y-0.5 hover:shadow-[0_0_20px_var(--primary-glow)] ${isRunning ? 'bg-bg-secondary border border-error text-error hover:bg-error/10' : 'bg-primary text-black'}`} 
                onClick={toggleWatcher}
              >
                  {isRunning ? <IconSquare /> : <IconPlay />}
                  <span>{isRunning ? t("controls.stop") : t("controls.start")}</span>
              </button>
              <button
                  className={`h-10 w-10 rounded-[20px] border-none bg-bg-secondary flex items-center justify-center transition-all duration-200 ml-3 ${(cards.length === 0 || !config.summary_provider?.trim()) ? 'text-text-muted cursor-not-allowed' : 'text-text-primary cursor-pointer hover:brightness-110'}`}
                  onClick={handleSummarize}
                  disabled={cards.length === 0 || !config.summary_provider?.trim()}
                  title={config.summary_provider?.trim() ? t("controls.summarize") : t("settings.summary.selectProvider")}
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
