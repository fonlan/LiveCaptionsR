import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import Markdown, { type Components } from "react-markdown";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import remarkGfm from "remark-gfm";

import { AIChatMessage, AIChatSessionMetadata, AIModel } from "../types";
import { IconClock, IconCopy, IconPlus, IconSend, IconSquare } from "./Icons";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

interface ChatSidebarProps {
  isOpen: boolean;
  width: number;
  messages: AIChatMessage[];
  input: string;
  isSending: boolean;
  models: AIModel[];
  chatSessions: AIChatSessionMetadata[];
  activeChatSessionId: string | null;
  hasActiveSession: boolean;
  selectedModelId: string;
  addToast: (type: "success" | "error", message: string) => void;
  onInputChange: (value: string) => void;
  onModelChange: (modelId: string) => void;
  onNewSession: () => void;
  onSelectChatSession: (chatSessionId: string) => void;
  onSend: () => void;
  onStop: () => void;
  onResizeStart: MouseEventHandler<HTMLDivElement>;
  onCardReferenceClick: (cardNumber: number) => void;
  getModelLabel: (model: AIModel) => string;
}

const CARD_REFERENCE_SCHEME = "card://";
const CARD_REFERENCE_PATTERN = /(^|[^\w`\\])#(\d+)\b/g;

const parseCardReferenceFromHref = (href?: string): number | null => {
  if (!href) return null;

  const trimmedHref = href.trim();
  const decodedHref = (() => {
    try {
      return decodeURIComponent(trimmedHref);
    } catch {
      return trimmedHref;
    }
  })();

  const match =
    decodedHref.match(/^card:\/\/\s*(\d+)\b/i)
    ?? decodedHref.match(/^#\s*(\d+)\b/);

  if (!match) return null;

  const cardNumber = Number.parseInt(match[1], 10);
  if (!Number.isFinite(cardNumber) || cardNumber <= 0) {
    return null;
  }

  return cardNumber;
};

const flattenNodeText = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(item => flattenNodeText(item)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return flattenNodeText(node.props.children);
  }
  return "";
};

const parseCardReferenceFromChildren = (children: ReactNode): number | null => {
  const text = Children.toArray(children)
    .map(node => flattenNodeText(node))
    .join("")
    .trim();

  const match = text.match(/^#\s*(\d+)\b/);
  if (!match) return null;

  const cardNumber = Number.parseInt(match[1], 10);
  if (!Number.isFinite(cardNumber) || cardNumber <= 0) {
    return null;
  }

  return cardNumber;
};

const splitTextIntoCardReferenceNodes = (value: string): MarkdownNode[] => {
  const fragments: MarkdownNode[] = [];
  let cursor = 0;
  CARD_REFERENCE_PATTERN.lastIndex = 0;

  let match = CARD_REFERENCE_PATTERN.exec(value);
  while (match !== null) {
    const leading = match[1] ?? "";
    const cardNumber = match[2];
    const hashStart = match.index + leading.length;

    if (hashStart > cursor) {
      fragments.push({ type: "text", value: value.slice(cursor, hashStart) });
    }

    fragments.push({
      type: "link",
      url: `${CARD_REFERENCE_SCHEME}${cardNumber}`,
      children: [{ type: "text", value: `#${cardNumber}` }],
    });
    cursor = hashStart + cardNumber.length + 1;
    match = CARD_REFERENCE_PATTERN.exec(value);
  }

  if (fragments.length === 0) {
    return [{ type: "text", value }];
  }

  if (cursor < value.length) {
    fragments.push({ type: "text", value: value.slice(cursor) });
  }

  return fragments;
};

const remarkCardReference = () => (tree: MarkdownNode) => {
  const walk = (node: MarkdownNode): void => {
    if (!Array.isArray(node.children) || node.children.length === 0) {
      return;
    }

    if (node.type === "code" || node.type === "inlineCode" || node.type === "link") {
      return;
    }

    for (let i = 0; i < node.children.length; i += 1) {
      const child = node.children[i];
      if (child.type === "text" && typeof child.value === "string") {
        const replacements = splitTextIntoCardReferenceNodes(child.value);
        if (
          replacements.length !== 1
          || replacements[0].type !== child.type
          || replacements[0].value !== child.value
        ) {
          node.children.splice(i, 1, ...replacements);
          i += replacements.length - 1;
        }
        continue;
      }

      walk(child);
    }
  };

  walk(tree);
};

export function ChatSidebar({
  isOpen,
  width,
  messages,
  input,
  isSending,
  models,
  chatSessions,
  activeChatSessionId,
  hasActiveSession,
  selectedModelId,
  addToast,
  onInputChange,
  onModelChange,
  onNewSession,
  onSelectChatSession,
  onSend,
  onStop,
  onResizeStart,
  onCardReferenceClick,
  getModelLabel,
}: ChatSidebarProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  const markdownComponents = useMemo<Components>(() => ({
    a: ({ href, children, ...props }) => {
      const cardNumber =
        parseCardReferenceFromHref(href)
        ?? parseCardReferenceFromChildren(children);
      if (cardNumber !== null) {
        return (
          <button
            type="button"
            className="inline border-none bg-transparent p-0 text-primary cursor-pointer underline underline-offset-2 hover:opacity-85"
            onMouseDown={event => event.stopPropagation()}
            onClick={event => {
              event.preventDefault();
              event.stopPropagation();
              event.nativeEvent.stopImmediatePropagation();
              onCardReferenceClick(cardNumber);
            }}
            title={t("chat.cardRefTitle", { number: cardNumber })}
          >
            {children}
          </button>
        );
      }

      return (
        <a
          href={href}
          {...props}
          onMouseDown={event => event.stopPropagation()}
          onClick={event => {
            event.preventDefault();
            event.stopPropagation();
            event.nativeEvent.stopImmediatePropagation();
            if (!href) return;
            void openUrl(href).catch(err => {
              console.error("Failed to open chat link:", err);
            });
          }}
        >
          {children}
        </a>
      );
    },
  }), [onCardReferenceClick, t]);

  useEffect(() => {
    if (!isOpen) return;
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [isOpen, messages]);

  useEffect(() => {
    if (!isOpen) {
      setIsHistoryOpen(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isHistoryOpen) return;

    const handleOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (historyMenuRef.current?.contains(target) || historyButtonRef.current?.contains(target)) {
        return;
      }
      setIsHistoryOpen(false);
    };

    document.addEventListener("mousedown", handleOutside);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
    };
  }, [isHistoryOpen]);

  const handleInputKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = event => {
    if (event.key === "Enter" && !event.shiftKey && !isSending) {
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

  const canSend =
    hasActiveSession
    && input.trim().length > 0
    && selectedModelId.trim().length > 0
    && !isSending;
  const canTriggerAction = isSending || canSend;
  const actionTitle = isSending ? t("controls.stop") : t("chat.send");
  const historyDisabled = !hasActiveSession || chatSessions.length === 0 || isSending;

  return (
    <aside
      className={`relative h-full shrink-0 max-w-[85vw] bg-panel/95 backdrop-blur-sm flex flex-col overflow-hidden shadow-[-8px_0_24px_rgba(0,0,0,0.2)] transition-[width,opacity,border-color] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${isOpen ? "border-l border-border opacity-100" : "border-l-0 opacity-0 pointer-events-none"}`}
      style={{ width: isOpen ? `${width}px` : "0px" }}
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
                        <Markdown remarkPlugins={[remarkGfm, remarkCardReference]} components={markdownComponents}>
                          {message.content}
                        </Markdown>
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
        <div className="flex min-w-0 items-center gap-2">
          <select
            className="min-w-0 flex-1 h-9 rounded-lg border border-border bg-input text-text-primary px-3 text-sm outline-none focus:border-primary"
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
          <button
            type="button"
            className={`h-9 w-9 shrink-0 rounded-lg border border-border bg-card transition-all flex items-center justify-center ${!hasActiveSession || isSending ? "text-text-muted cursor-not-allowed" : "text-text-secondary cursor-pointer hover:bg-card-hover hover:text-text-primary"}`}
            onClick={onNewSession}
            title={t("chat.newSession")}
            aria-label={t("chat.newSession")}
            disabled={!hasActiveSession || isSending}
          >
            <IconPlus size={14} />
          </button>
          <div className="relative">
            <button
              ref={historyButtonRef}
              type="button"
              className={`h-9 w-9 shrink-0 rounded-lg border border-border bg-card transition-all flex items-center justify-center ${historyDisabled ? "text-text-muted cursor-not-allowed" : "text-text-secondary cursor-pointer hover:bg-card-hover hover:text-text-primary"}`}
              onClick={() => {
                if (historyDisabled) return;
                setIsHistoryOpen(prev => !prev);
              }}
              title={t("chat.switchSession")}
              aria-label={t("chat.switchSession")}
              disabled={historyDisabled}
            >
              <IconClock size={14} />
            </button>
            {isHistoryOpen && (
              <div
                ref={historyMenuRef}
                className="absolute right-0 bottom-[calc(100%+8px)] w-[290px] rounded-xl border border-border bg-panel shadow-2xl p-1 z-30"
              >
                {chatSessions.length === 0 ? (
                  <div className="px-3 py-2.5 text-xs text-text-muted">
                    {t("chat.historyEmpty")}
                  </div>
                ) : (
                  <div className="max-h-[260px] overflow-y-auto space-y-1">
                    {chatSessions.map(session => (
                      <button
                        key={session.id}
                        type="button"
                        className={`w-full text-left px-3 py-2 rounded-lg border border-transparent transition-all ${session.id === activeChatSessionId ? "bg-primary-dim text-text-primary border-primary/30" : "text-text-secondary hover:bg-card-hover hover:text-text-primary"}`}
                        onClick={() => {
                          onSelectChatSession(session.id);
                          setIsHistoryOpen(false);
                        }}
                      >
                        <div className="text-xs font-medium truncate">{session.name}</div>
                        <div className="text-[11px] mt-0.5 text-text-muted truncate">
                          {session.preview || t("chat.historyNoPreview")}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="relative mt-2">
          <textarea
            className="w-full min-h-[84px] max-h-[180px] resize-y rounded-xl border border-border bg-input px-3 py-2.5 pr-20 text-sm text-text-primary leading-5 outline-none focus:border-primary"
            value={input}
            onChange={event => onInputChange(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={t("chat.inputPlaceholder")}
          />
          <button
            type="button"
            className={`absolute right-2 top-1/2 -translate-y-1/2 h-8 min-w-[34px] px-2 rounded-lg border border-transparent bg-transparent transition-all flex items-center justify-center ${isSending ? "text-error cursor-pointer hover:bg-error/12 hover:border-error/45" : canSend ? "text-primary cursor-pointer hover:bg-primary/12 hover:border-primary/45" : "text-text-muted cursor-not-allowed"}`}
            onClick={isSending ? onStop : onSend}
            disabled={!canTriggerAction}
            title={actionTitle}
            aria-label={actionTitle}
          >
            {isSending ? <IconSquare size={12} /> : <IconSend size={14} />}
          </button>
        </div>
      </div>
    </aside>
  );
}
