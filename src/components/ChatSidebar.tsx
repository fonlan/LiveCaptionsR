import { useEffect, useRef, type KeyboardEventHandler, type MouseEventHandler } from "react";
import Markdown from "react-markdown";
import { useTranslation } from "react-i18next";
import remarkGfm from "remark-gfm";

import { AIModel } from "../types";
import { IconCopy } from "./Icons";

export interface AIChatBubble {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "done" | "loading" | "error";
}

interface ChatSidebarProps {
  isOpen: boolean;
  width: number;
  messages: AIChatBubble[];
  input: string;
  isSending: boolean;
  models: AIModel[];
  selectedModelId: string;
  addToast: (type: "success" | "error", message: string) => void;
  onInputChange: (value: string) => void;
  onModelChange: (modelId: string) => void;
  onSend: () => void;
  onResizeStart: MouseEventHandler<HTMLDivElement>;
  getModelLabel: (model: AIModel) => string;
}

export function ChatSidebar({
  isOpen,
  width,
  messages,
  input,
  isSending,
  models,
  selectedModelId,
  addToast,
  onInputChange,
  onModelChange,
  onSend,
  onResizeStart,
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

  const handleCopyMessage = async (content: string) => {
    if (content.trim().length === 0) return;

    try {
      await navigator.clipboard.writeText(content);
      addToast("success", t("toast.copySuccess"));
    } catch (err) {
      console.error("Failed to copy chat message:", err);
      addToast("error", t("toast.copyFailed"));
    }
  };

  const canSend = input.trim().length > 0 && selectedModelId.trim().length > 0 && !isSending;

  return (
    <aside
      className={`absolute top-0 right-0 h-full max-w-[85vw] border-l border-border bg-panel/95 backdrop-blur-sm flex flex-col shadow-[-8px_0_24px_rgba(0,0,0,0.2)] transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${isOpen ? "translate-x-0" : "translate-x-full pointer-events-none"}`}
      style={{ width: `${width}px` }}
    >
      <div
        className="absolute left-0 top-0 h-full w-2 -translate-x-1 cursor-col-resize select-none"
        onMouseDown={onResizeStart}
        title={t("chat.resize")}
      />

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
              <div className={`flex items-start gap-1.5 max-w-full ${message.role === "user" ? "flex-row-reverse" : ""}`}>
                <button
                  className={`mt-1 h-7 w-7 rounded-full border-none flex items-center justify-center transition-all ${message.status === "loading" ? "text-text-muted cursor-not-allowed" : "text-text-secondary cursor-pointer hover:bg-card-hover hover:text-text-primary"}`}
                  onClick={() => void handleCopyMessage(message.content)}
                  disabled={message.status === "loading" || message.content.trim().length === 0}
                  title={t("chat.copyMessage")}
                >
                  <IconCopy size={14} />
                </button>
                <div
                  className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-sm leading-6 border select-text ${message.role === "user" ? "bg-primary-dim border-primary/30 text-text-primary" : "bg-card border-border text-text-primary"} ${message.status === "error" ? "border-error/70" : ""}`}
                >
                  {message.role === "assistant" ? (
                    message.status === "loading" ? (
                      <div className="text-text-secondary flex items-center gap-2 select-none">
                        <span className="spinner inline-block" />
                        <span>{t("chat.thinking")}</span>
                      </div>
                    ) : (
                      <div className="markdown-body select-text">
                        <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
                      </div>
                    )
                  ) : (
                    <span className="whitespace-pre-wrap break-words select-text">{message.content}</span>
                  )}
                </div>
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
