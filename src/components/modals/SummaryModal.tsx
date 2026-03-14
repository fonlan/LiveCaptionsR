import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import Markdown from 'react-markdown';
import { IconX, IconCopy, IconCheck } from "../Icons";

const SUMMARY_STICK_TO_BOTTOM_EPSILON = 8;
const SUMMARY_AUTO_FOLLOW_DISABLE_THRESHOLD = 120;

interface SummaryModalProps {
  isOpen: boolean;
  onClose: () => void;
  text: string;
  isLoading: boolean;
}

export function SummaryModal({ isOpen, onClose, text, isLoading }: SummaryModalProps) {
  const { t } = useTranslation();
  const [isCopied, setIsCopied] = useState(false);
  const hasText = text.trim().length > 0;
  const contentRef = useRef<HTMLDivElement>(null);
  const summaryAutoFollowRef = useRef(true);
  const lastSummaryScrollTopRef = useRef(0);

  useEffect(() => {
    if (!isOpen) return;
    setIsCopied(false);
    summaryAutoFollowRef.current = true;
    const container = contentRef.current;
    if (container) {
      const targetTop = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTo({ top: targetTop, behavior: "auto" });
      lastSummaryScrollTopRef.current = container.scrollTop;
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !summaryAutoFollowRef.current) return;
    const container = contentRef.current;
    if (!container) return;
    const targetTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const distanceToBottom = targetTop - container.scrollTop;
    if (distanceToBottom > SUMMARY_STICK_TO_BOTTOM_EPSILON) {
      container.scrollTo({ top: targetTop, behavior: "auto" });
    }
  }, [isOpen, text, isLoading]);

  const handleSummaryScroll = () => {
    const container = contentRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceToBottom = scrollHeight - scrollTop - clientHeight;
    const scrollingUp = scrollTop + 2 < lastSummaryScrollTopRef.current;
    lastSummaryScrollTopRef.current = scrollTop;

    if (summaryAutoFollowRef.current) {
      if (
        (scrollingUp && distanceToBottom > SUMMARY_STICK_TO_BOTTOM_EPSILON) ||
        distanceToBottom > SUMMARY_AUTO_FOLLOW_DISABLE_THRESHOLD
      ) {
        summaryAutoFollowRef.current = false;
      }
    } else if (distanceToBottom <= SUMMARY_STICK_TO_BOTTOM_EPSILON) {
      summaryAutoFollowRef.current = true;
    }
  };

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
          <div className="summary-header-title">
            <h2>{t("summary.title")}</h2>
            {isLoading && (
              <span className="summary-header-status" aria-live="polite">
                <span className="spinner" aria-hidden="true"></span>
                <span>{t("summary.generating")}</span>
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
            {hasText && (
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
        <div className="settings-content summary-content" ref={contentRef} onScroll={handleSummaryScroll}>
          {isLoading && !hasText ? (
            <div className="summary-loading summary-loading-empty" style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>
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
