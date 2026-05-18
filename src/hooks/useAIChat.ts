import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  AIChatMessage,
  AIChatSession,
  AIChatSessionMetadata,
  AIModel,
} from "../types";
import { generateId } from "../utils/textUtils";

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

export const buildDefaultChatSessionName = (
  timestampSec: number = Math.floor(Date.now() / 1000),
): string => `[${formatChatSessionTimestamp(timestampSec)}]`;

export const buildChatSessionTitleFromQuestion = (
  question: string,
  timestampSec: number = Math.floor(Date.now() / 1000),
): string => {
  const compactQuestion = question.replace(/\s+/g, " ").trim();
  const titleQuestion =
    compactQuestion.length > 48 ? `${compactQuestion.slice(0, 48)}...` : compactQuestion;
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

export type UseAIChatOptions = {
  /** Active translation session id from useSessions. */
  activeSessionId: string | null;
  /** Read-only access to the active translation session id (hot paths). */
  activeSessionIdRef: React.MutableRefObject<string | null>;
  /** Available AI models, drives the default chatModelId. */
  availableModels: AIModel[];
  /** Configured summary provider; preferred fallback for chatModelId. */
  summaryProvider: string | undefined;
  /** Called when chat resets (active session change, draft activation, load). */
  onResetHighlightedCard: () => void;
};

export type UseAIChatResult = {
  isChatOpen: boolean;
  setIsChatOpen: React.Dispatch<React.SetStateAction<boolean>>;

  chatMessages: AIChatMessage[];
  setChatMessages: React.Dispatch<React.SetStateAction<AIChatMessage[]>>;
  chatMessagesRef: React.MutableRefObject<AIChatMessage[]>;

  chatInput: string;
  setChatInput: React.Dispatch<React.SetStateAction<string>>;

  chatModelId: string;
  setChatModelId: React.Dispatch<React.SetStateAction<string>>;

  isChatSending: boolean;
  setIsChatSending: React.Dispatch<React.SetStateAction<boolean>>;
  chatActiveRequestIdRef: React.MutableRefObject<string | null>;

  chatSessions: AIChatSessionMetadata[];
  setChatSessions: React.Dispatch<React.SetStateAction<AIChatSessionMetadata[]>>;

  activeChatSessionId: string | null;
  activeChatSessionName: string;
  activeChatSessionCreatedAt: number;
  setActiveChatSessionName: React.Dispatch<React.SetStateAction<string>>;
  activeChatSessionIdRef: React.MutableRefObject<string | null>;
  activeChatSessionNameRef: React.MutableRefObject<string>;
  activeChatSessionCreatedAtRef: React.MutableRefObject<number>;

  /**
   * Wipe every piece of chat state (sessions list, draft triple,
   * messages, input). Used when the caller can't keep the chat alive
   * any more (e.g. no active translation session).
   */
  clearChatSessionState: () => void;
  refreshChatSessionList: (sessionId: string) => Promise<AIChatSessionMetadata[]>;
  saveActiveChatSessionSnapshot: (
    messagesOverride?: AIChatMessage[],
    options?: { refreshList?: boolean },
  ) => Promise<void>;
  loadChatSessionById: (chatSessionId: string) => Promise<void>;
  activateUnsavedChatDraft: (
    translationSessionId: string,
    createdAtSec?: number,
  ) => AIChatSession;
  ensureActiveChatSession: () => AIChatSession | null;
};

/**
 * Owns the AI chat side-panel state machine: the open/closed flag,
 * the live message buffer (+ mirror ref), draft input, model selector,
 * the chat-session list, and the active chat-session triple with its
 * mirror refs. Also encapsulates the storage helpers
 * (refresh/save/load/draft/ensure) that the caller wires into its
 * higher-level send/rename/delete flows.
 *
 * Outbound side-effects the caller must own (clearing card highlights,
 * sending a message, scrolling the message list, etc.) stay in the
 * caller; this hook only models the data layer.
 */
export function useAIChat({
  activeSessionId,
  activeSessionIdRef,
  availableModels,
  summaryProvider,
  onResetHighlightedCard,
}: UseAIChatOptions): UseAIChatResult {
  const [isChatOpen, setIsChatOpen] = useState<boolean>(false);
  const [chatMessages, setChatMessages] = useState<AIChatMessage[]>([]);
  const [chatInput, setChatInput] = useState<string>("");
  const [chatModelId, setChatModelId] = useState<string>("");
  const [isChatSending, setIsChatSending] = useState<boolean>(false);
  const [chatSessions, setChatSessions] = useState<AIChatSessionMetadata[]>([]);
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(null);
  const [activeChatSessionName, setActiveChatSessionName] = useState<string>("");
  const [activeChatSessionCreatedAt, setActiveChatSessionCreatedAt] = useState<number>(0);

  const chatActiveRequestIdRef = useRef<string | null>(null);
  const activeChatSessionIdRef = useRef<string | null>(null);
  const activeChatSessionNameRef = useRef<string>("");
  const activeChatSessionCreatedAtRef = useRef<number>(0);
  const chatMessagesRef = useRef<AIChatMessage[]>([]);

  useEffect(() => {
    activeChatSessionIdRef.current = activeChatSessionId;
    activeChatSessionNameRef.current = activeChatSessionName;
    activeChatSessionCreatedAtRef.current = activeChatSessionCreatedAt;
  }, [activeChatSessionId, activeChatSessionName, activeChatSessionCreatedAt]);

  useEffect(() => {
    chatMessagesRef.current = chatMessages;
  }, [chatMessages]);

  // Keep chatModelId pointed at a valid model. Prefer the existing
  // selection, then the configured summary provider, then the first
  // available model.
  useEffect(() => {
    setChatModelId(prev => {
      if (prev && availableModels.some(model => model.id === prev)) {
        return prev;
      }

      const trimmedSummaryProvider = summaryProvider?.trim();
      if (
        trimmedSummaryProvider &&
        availableModels.some(model => model.id === trimmedSummaryProvider)
      ) {
        return trimmedSummaryProvider;
      }

      return availableModels[0]?.id || "";
    });
  }, [availableModels, summaryProvider]);

  const clearChatSessionState = useCallback(() => {
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
    chatActiveRequestIdRef.current = null;
    setIsChatSending(false);
    onResetHighlightedCard();
  }, [onResetHighlightedCard]);

  const refreshChatSessionList = useCallback(
    async (sessionId: string) => {
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
    },
    [activeSessionIdRef],
  );

  const saveActiveChatSessionSnapshot = useCallback(
    async (
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
    },
    [activeSessionIdRef, refreshChatSessionList],
  );

  const loadChatSessionById = useCallback(
    async (chatSessionId: string) => {
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
      onResetHighlightedCard();
      setIsChatSending(false);
      chatActiveRequestIdRef.current = null;

      if (normalized.changed) {
        await saveActiveChatSessionSnapshot(normalized.messages, { refreshList: true });
      }
    },
    [onResetHighlightedCard, saveActiveChatSessionSnapshot],
  );

  const activateUnsavedChatDraft = useCallback(
    (
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
      onResetHighlightedCard();
      return draft;
    },
    [onResetHighlightedCard],
  );

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
  }, [activateUnsavedChatDraft, activeSessionIdRef]);

  // Reset chat when the active translation session changes, then either
  // clear (no session) or activate a fresh draft and load the session
  // list for the new session id.
  useEffect(() => {
    chatActiveRequestIdRef.current = null;
    setIsChatSending(false);

    const loadChatSessionsForActiveSession = async () => {
      if (!activeSessionId) {
        clearChatSessionState();
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
  }, [
    activeSessionId,
    activateUnsavedChatDraft,
    clearChatSessionState,
    refreshChatSessionList,
  ]);

  return {
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
    setChatSessions,

    activeChatSessionId,
    activeChatSessionName,
    activeChatSessionCreatedAt,
    setActiveChatSessionName,
    activeChatSessionIdRef,
    activeChatSessionNameRef,
    activeChatSessionCreatedAtRef,

    clearChatSessionState,
    refreshChatSessionList,
    saveActiveChatSessionSnapshot,
    loadChatSessionById,
    activateUnsavedChatDraft,
    ensureActiveChatSession,
  };
}
