import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconX } from "../Icons";

interface ErrorDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  errorDetails: string | null;
}

export function ErrorDetailModal({ isOpen, onClose, errorDetails }: ErrorDetailModalProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (errorDetails) {
      await navigator.clipboard.writeText(errorDetails);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!isOpen || !errorDetails) return null;

  return (
    <div className="settings-overlay open" onClick={onClose}>
      <div className="settings-drawer" onClick={e => e.stopPropagation()} style={{ maxWidth: '600px', width: '90%' }}>
        <header className="settings-header">
          <h2>Error Details</h2>
          <button className="btn-icon" onClick={onClose}><IconX /></button>
        </header>
        <div className="settings-content" style={{ padding: '24px' }}>
          <p style={{ marginBottom: '12px', color: 'var(--text-muted)' }}>
            {t("settings.models.toast.failed", { error: "" }).replace(": undefined", "")}
          </p>
          <div style={{
            background: 'var(--bg-input)',
            padding: '16px',
            borderRadius: '8px',
            fontFamily: 'monospace',
            fontSize: '12px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: '300px',
            overflow: 'auto',
            border: '1px solid var(--border-color)'
          }}>
            {errorDetails}
          </div>
          <div style={{ marginTop: '16px', display: 'flex', gap: '8px' }}>
            <button className="btn-secondary" onClick={handleCopy} style={{ flex: 1 }}>
              {copied ? "Copied!" : "Copy Error"}
            </button>
            <button className="btn-primary" onClick={onClose} style={{ flex: 1 }}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
