import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import Markdown from 'react-markdown';
import { IconX, IconCopy, IconCheck } from "../Icons";

interface SummaryModalProps {
  isOpen: boolean;
  onClose: () => void;
  text: string;
  isLoading: boolean;
}

export function SummaryModal({ isOpen, onClose, text, isLoading }: SummaryModalProps) {
  const { t } = useTranslation();
  const [isCopied, setIsCopied] = useState(false);

  useEffect(() => {
    if (isOpen) setIsCopied(false);
  }, [isOpen]);

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
          <h2>{t("summary.title")}</h2>
          <div style={{ display: 'flex', gap: '8px' }}>
            {!isLoading && text && (
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
        <div className="settings-content summary-content">
          {isLoading ? (
            <div className="summary-loading" style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>
              <span className="spinner" style={{ display: 'inline-block', marginBottom: '10px' }}></span>
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
