import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TFunction } from "i18next";
import type { AIChatMessage, AIChatSession, CaptionChatCardInput } from "../types";
import { generateId } from "../utils/textUtils";
import type { AddToast } from "./useToasts";
import { buildChatSessionTitleFromQuestion } from "./useAIChat";

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
          : message,
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
          : message,
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
    isChatSending,
    saveActiveChatSessionSnapshot,
    setActiveChatSessionName,
    setChatInput,
    setChatMessages,
    setIsChatSending,
    t,
  ]);

  const handleStopChatMessage = useCallback(() => {
    if (!isChatSending) return;

    chatActiveRequestIdRef.current = null;
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
