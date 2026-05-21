import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { TFunction } from "i18next";
import type { AIChatMessage, AIChatSession, CaptionChatCardInput } from "../types";
import { generateId } from "../utils/textUtils";
import type { AddToast } from "./useToasts";
import { buildChatSessionTitleFromQuestion } from "./useAIChat";

const CHAT_TYPEWRITER_INTERVAL_MS = 16;
const CHAT_TYPEWRITER_CHARS_PER_TICK = 3;

type ChatStreamEvent = {
  request_id: string;
  status: "chunk" | "done" | "error";
  chunk?: string | null;
  full_text?: string | null;
  error?: string | null;
};

type ChatStreamState = {
  requestId: string | null;
  assistantMessageId: string | null;
  typingQueue: string;
  streamDone: boolean;
  finalText: string;
};

export type UseChatActionsOptions = {
  chatInput: string;
  setChatInput: React.Dispatch<React.SetStateAction<string>>;
  chatModelId: string;
  isChatSending: boolean;
  setIsChatSending: React.Dispatch<React.SetStateAction<boolean>>;
  chatMessagesRef: React.MutableRefObject<AIChatMessage[]>;
  setChatMessages: React.Dispatch<React.SetStateAction<AIChatMessage[]>>;
  chatActiveRequestIdRef: React.MutableRefObject<string | null>;
  activeChatSessionIdRef: React.MutableRefObject<string | null>;
  activeChatSessionNameRef: React.MutableRefObject<string>;
  setActiveChatSessionName: React.Dispatch<React.SetStateAction<string>>;
  ensureActiveChatSession: () => AIChatSession | null;
  saveActiveChatSessionSnapshot: (
    messagesOverride?: AIChatMessage[],
    options?: { refreshList?: boolean },
  ) => Promise<void>;
  loadChatSessionById: (chatSessionId: string) => Promise<void>;
  clearChatSessionState: () => void;
  activateUnsavedChatDraft: (translationSessionId: string, createdAtSec?: number) => AIChatSession;

  activeSessionIdRef: React.MutableRefObject<string | null>;
  buildChatCardsSnapshot: () => CaptionChatCardInput[];
  addToast: AddToast;
  t: TFunction;
};

export type UseChatActionsResult = {
  handleSendChatMessage: () => Promise<void>;
  handleStopChatMessage: () => void;
  handleStartNewChatSession: () => void;
  handleSelectChatSession: (chatSessionId: string) => Promise<void>;
};

/**
 * Chat side-panel interaction handlers: send / stop / start-new /
 * select-session. Sits on top of `useAIChat` (data layer) and the
 * caller's translation-session refs / card snapshot builder.
 *
 * Each handler guards against the well-known races (no active session,
 * stale request id) so the rest of the app can call them naively.
 */
export function useChatActions({
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
}: UseChatActionsOptions): UseChatActionsResult {
  const typingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chatStreamStateRef = useRef<ChatStreamState>({
    requestId: null,
    assistantMessageId: null,
    typingQueue: "",
    streamDone: false,
    finalText: "",
  });

  const stopChatTypewriter = useCallback(() => {
    if (typingTimerRef.current) {
      clearInterval(typingTimerRef.current);
      typingTimerRef.current = null;
    }
  }, []);

  const applyAssistantMessageUpdate = useCallback(
    (
      assistantMessageId: string,
      update: (message: AIChatMessage) => AIChatMessage,
    ): AIChatMessage[] => {
      const nextMessages = chatMessagesRef.current.map(message =>
        message.id === assistantMessageId ? update(message) : message,
      );
      setChatMessages(nextMessages);
      chatMessagesRef.current = nextMessages;
      return nextMessages;
    },
    [chatMessagesRef, setChatMessages],
  );

  const finishChatStreamIfReady = useCallback(() => {
    const streamState = chatStreamStateRef.current;
    if (
      !streamState.requestId
      || !streamState.assistantMessageId
      || !streamState.streamDone
      || streamState.typingQueue.length > 0
    ) {
      return;
    }

    const finishedRequestId = streamState.requestId;
    const assistantMessageId = streamState.assistantMessageId;
    const finalText = streamState.finalText;
    stopChatTypewriter();

    const nextMessages = applyAssistantMessageUpdate(assistantMessageId, message => ({
      ...message,
      content: finalText || message.content,
      status: "done",
    }));

    chatStreamStateRef.current = {
      requestId: null,
      assistantMessageId: null,
      typingQueue: "",
      streamDone: false,
      finalText: "",
    };

    if (chatActiveRequestIdRef.current === finishedRequestId) {
      chatActiveRequestIdRef.current = null;
      setIsChatSending(false);
    }
    void saveActiveChatSessionSnapshot(nextMessages, { refreshList: true });
  }, [
    applyAssistantMessageUpdate,
    chatActiveRequestIdRef,
    saveActiveChatSessionSnapshot,
    setIsChatSending,
    stopChatTypewriter,
  ]);

  const ensureChatTypewriterRunning = useCallback(() => {
    if (typingTimerRef.current) {
      return;
    }

    typingTimerRef.current = setInterval(() => {
      const streamState = chatStreamStateRef.current;
      if (streamState.typingQueue.length === 0) {
        finishChatStreamIfReady();
        return;
      }

      const take = Math.min(CHAT_TYPEWRITER_CHARS_PER_TICK, streamState.typingQueue.length);
      const nextChunk = streamState.typingQueue.slice(0, take);
      streamState.typingQueue = streamState.typingQueue.slice(take);

      if (streamState.assistantMessageId) {
        applyAssistantMessageUpdate(streamState.assistantMessageId, message => ({
          ...message,
          content: message.content + nextChunk,
        }));
      }

      if (streamState.typingQueue.length === 0) {
        finishChatStreamIfReady();
      }
    }, CHAT_TYPEWRITER_INTERVAL_MS);
  }, [applyAssistantMessageUpdate, finishChatStreamIfReady]);

  const failChatStream = useCallback(
    (assistantMessageId: string, errorMessage: string, requestId: string) => {
      stopChatTypewriter();
      chatStreamStateRef.current = {
        requestId: null,
        assistantMessageId: null,
        typingQueue: "",
        streamDone: false,
        finalText: "",
      };

      const nextMessages = applyAssistantMessageUpdate(assistantMessageId, message => ({
        ...message,
        content: errorMessage,
        status: "error",
      }));

      if (chatActiveRequestIdRef.current === requestId) {
        chatActiveRequestIdRef.current = null;
        setIsChatSending(false);
      }
      void saveActiveChatSessionSnapshot(nextMessages, { refreshList: true });
    },
    [
      applyAssistantMessageUpdate,
      chatActiveRequestIdRef,
      saveActiveChatSessionSnapshot,
      setIsChatSending,
      stopChatTypewriter,
    ],
  );

  useEffect(() => {
    const unlistenChatStream = listen<ChatStreamEvent>("chat-stream", event => {
      const payload = event.payload;
      const streamState = chatStreamStateRef.current;
      if (!streamState.requestId || payload.request_id !== streamState.requestId) {
        return;
      }

      if (payload.status === "chunk") {
        if (payload.chunk) {
          streamState.typingQueue += payload.chunk;
          ensureChatTypewriterRunning();
        }
        return;
      }

      if (payload.status === "done") {
        streamState.finalText = payload.full_text ?? streamState.finalText;
        streamState.streamDone = true;
        finishChatStreamIfReady();
        return;
      }

      if (payload.status === "error" && streamState.assistantMessageId) {
        const errorMessage = payload.error
          ? `${t("chat.errorPrefix")} ${payload.error}`
          : t("chat.errorPrefix");
        failChatStream(streamState.assistantMessageId, errorMessage, payload.request_id);
      }
    });

    return () => {
      unlistenChatStream.then(f => f());
      stopChatTypewriter();
    };
  }, [
    ensureChatTypewriterRunning,
    failChatStream,
    finishChatStreamIfReady,
    stopChatTypewriter,
    t,
  ]);

  const handleSendChatMessage = useCallback(async () => {
    if (isChatSending) return;

    if (!activeSessionIdRef.current) {
      addToast("error", t("chat.sessionRequired"));
      return;
    }

    const question = chatInput.trim();
    if (!question) return;

    const providerId = chatModelId.trim();
    if (!providerId) {
      addToast("error", t("chat.modelRequired"));
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
    stopChatTypewriter();
    chatStreamStateRef.current = {
      requestId,
      assistantMessageId,
      typingQueue: "",
      streamDone: false,
      finalText: "",
    };
    setIsChatSending(true);
    await saveActiveChatSessionSnapshot(queuedMessages);

    try {
      await invoke("chat_with_captions_stream", {
        providerId,
        question,
        cards: cardsSnapshot,
        requestId,
      });
    } catch (err) {
      if (chatActiveRequestIdRef.current !== requestId) {
        return;
      }

      const errorMessage = `${t("chat.errorPrefix")} ${String(err)}`;
      failChatStream(assistantMessageId, errorMessage, requestId);
    }
  }, [
    activeChatSessionNameRef,
    activeSessionIdRef,
    addToast,
    buildChatCardsSnapshot,
    chatActiveRequestIdRef,
    chatInput,
    chatMessagesRef,
    chatModelId,
    ensureActiveChatSession,
    failChatStream,
    isChatSending,
    saveActiveChatSessionSnapshot,
    setActiveChatSessionName,
    setChatInput,
    setChatMessages,
    setIsChatSending,
    stopChatTypewriter,
    t,
  ]);

  const handleStopChatMessage = useCallback(() => {
    if (!isChatSending) return;

    chatActiveRequestIdRef.current = null;
    stopChatTypewriter();
    chatStreamStateRef.current = {
      requestId: null,
      assistantMessageId: null,
      typingQueue: "",
      streamDone: false,
      finalText: "",
    };
    setIsChatSending(false);

    const nextMessages = chatMessagesRef.current.map(message =>
      message.role === "assistant" && message.status === "loading"
        ? { ...message, content: t("status.stopped"), status: "done" as const }
        : message,
    );
    setChatMessages(nextMessages);
    chatMessagesRef.current = nextMessages;
    void saveActiveChatSessionSnapshot(nextMessages, { refreshList: true });
  }, [
    chatActiveRequestIdRef,
    chatMessagesRef,
    isChatSending,
    saveActiveChatSessionSnapshot,
    setChatMessages,
    setIsChatSending,
    stopChatTypewriter,
    t,
  ]);

  const handleStartNewChatSession = useCallback(() => {
    const translationSessionId = activeSessionIdRef.current;
    if (!translationSessionId) {
      clearChatSessionState();
      addToast("error", t("chat.sessionRequired"));
      return;
    }

    activateUnsavedChatDraft(translationSessionId);
  }, [activateUnsavedChatDraft, activeSessionIdRef, addToast, clearChatSessionState, t]);

  const handleSelectChatSession = useCallback(
    async (chatSessionId: string) => {
      if (!chatSessionId || chatSessionId === activeChatSessionIdRef.current) {
        return;
      }
      try {
        await loadChatSessionById(chatSessionId);
      } catch (err) {
        console.error("Failed to load AI chat session:", err);
        addToast("error", t("chat.sessionLoadFailed"));
      }
    },
    [activeChatSessionIdRef, addToast, loadChatSessionById, t],
  );

  return {
    handleSendChatMessage,
    handleStopChatMessage,
    handleStartNewChatSession,
    handleSelectChatSession,
  };
}
