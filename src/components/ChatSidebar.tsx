import { useEffect, useRef, type KeyboardEventHandler } from "react";
import Markdown from "react-markdown";
import { useTranslation } from "react-i18next";
import remarkGfm from "remark-gfm";

import { AIModel } from "../types";
import { IconMessageSquare, IconX } from "./Icons";

export interface AIChatBubble {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "done" | "loading" | "error";
}

interface ChatSidebarProps {
  isOpen: boolean;
  messages: AIChatBubble[];
  input: string;
  isSending: boolean;
  models: AIModel[];
  selectedModelId: string;
  onClose: () => void;
  onInputChange: (value: string) => void;
  onModelChange: (modelId: string) => void;
  onSend: () => void;
  getModelLabel: (model: AIModel) => string;
}

export function ChatSidebar({
  isOpen,
  messages,
  input,
  isSending,
  models,
  selectedModelId,
  onClose,
  onInputChange,
  onModelChange,
  onSend,
  getModelLabel,
}: ChatSidebarProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [isOpen, messages]);

  const handleInputKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSend();
    }
  };

  const canSend = input.trim().length > 0 && selectedModelId.trim().length > 0 && !isSending;

  return (
    <aside
      className={`absolute top-0 right-0 h-full w-[420px] max-w-[85vw] border-l border-border bg-panel/95 backdrop-blur-sm flex flex-col shadow-[-8px_0_24px_rgba(0,0,0,0.2)] transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${isOpen ? "translate-x-0" : "translate-x-full pointer-events-none"}`}
    >
      <header className="h-12 px-4 border-b border-border flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 text-sm font-semibold text-text-secondary">
          <IconMessageSquare size={16} />
          <span>{t("chat.title")}</span>
        </div>
        <button
          className="bg-transparent border-none text-text-secondary cursor-pointer p-2 rounded-full transition-all flex items-center justify-center hover:bg-card-hover hover:text-text-primary"
          onClick={onClose}
          title={t("chat.close")}
        >
          <IconX size={16} />
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 ? (
          <div className="h-full min-h-[180px] flex items-center justify-center text-center text-text-muted text-sm leading-6">
            {t("chat.empty")}
          </div>
        ) : (
          messages.map(message => (
            <div
              key={message.id}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-sm leading-6 border ${message.role === "user" ? "bg-primary-dim border-primary/30 text-text-primary" : "bg-card border-border text-text-primary"} ${message.status === "error" ? "border-error/70" : ""}`}
              >
                {message.role === "assistant" ? (
                  message.status === "loading" ? (
                    <div className="text-text-secondary flex items-center gap-2">
                      <span className="spinner inline-block" />
                      <span>{t("chat.thinking")}</span>
                    </div>
                  ) : (
                    <div className="markdown-body">
                      <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
                    </div>
                  )
                ) : (
                  <span className="whitespace-pre-wrap break-words">{message.content}</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="shrink-0 border-t border-border p-3 bg-panel">
        <label className="text-[12px] text-text-secondary block mb-1">{t("chat.model")}</label>
        <select
          className="w-full h-9 rounded-lg border border-border bg-input text-text-primary px-3 text-sm outline-none focus:border-primary"
          value={selectedModelId}
          onChange={event => onModelChange(event.target.value)}
        >
          <option value="">{t("chat.selectModel")}</option>
          {models.map(model => (
            <option key={model.id} value={model.id}>
              {getModelLabel(model)}
            </option>
          ))}
        </select>

        <div className="relative mt-2">
          <textarea
            className="w-full min-h-[84px] max-h-[180px] resize-y rounded-xl border border-border bg-input px-3 py-2.5 pr-20 text-sm text-text-primary leading-5 outline-none focus:border-primary"
            value={input}
            onChange={event => onInputChange(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={t("chat.inputPlaceholder")}
          />
          <button
            className={`absolute right-2 bottom-2 h-8 px-3 rounded-lg border-none text-xs font-semibold transition-all ${canSend ? "bg-primary text-black cursor-pointer" : "bg-bg-secondary text-text-muted cursor-not-allowed"}`}
            onClick={onSend}
            disabled={!canSend}
            title={t("chat.send")}
          >
            {isSending ? t("chat.sending") : t("chat.send")}
          </button>
        </div>
      </div>
    </aside>
  );
}
