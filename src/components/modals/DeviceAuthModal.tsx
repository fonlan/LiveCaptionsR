import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from '@tauri-apps/plugin-opener';
import { IconX } from "../Icons";

interface DeviceAuthData {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
}

interface DeviceAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (token: string) => void;
}

export function DeviceAuthModal({ isOpen, onClose, onSuccess }: DeviceAuthModalProps) {
  const [authData, setAuthData] = useState<DeviceAuthData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    if (isOpen && !authData && !isPolling) {
      startAuth();
    }
  }, [isOpen]);

  const startAuth = async () => {
    try {
      setError(null);
      const data = await invoke<DeviceAuthData>('start_copilot_auth');
      setAuthData(data);
      pollToken(data.device_code, data.interval);
    } catch (e) {
      setError(String(e));
    }
  };

  const pollToken = async (deviceCode: string, interval: number) => {
    setIsPolling(true);
    try {
      const token = await invoke<string>('poll_copilot_token', { deviceCode, interval });
      onSuccess(token);
    } catch (e) {
      if (String(e).includes('cancelled') || !isOpen) return; // Stopped by user
      setError(String(e));
    } finally {
      setIsPolling(false);
    }
  };

  const handleCopyAndOpen = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (authData?.user_code) {
      await navigator.clipboard.writeText(authData.user_code);
    }
    if (authData?.verification_uri) {
      await openUrl(authData.verification_uri);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="settings-overlay open" onClick={onClose}>
      <div className="settings-drawer" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px', width: '90%' }}>
        <header className="settings-header">
          <h2>{t("deviceAuth.title")}</h2>
          <button className="btn-icon" onClick={onClose}><IconX /></button>
        </header>
        <div className="settings-content" style={{ padding: '24px', textAlign: 'center' }}>
          {error ? (
            <div style={{ color: 'var(--error)', marginBottom: '16px' }}>
              {t("deviceAuth.error", { error })}
              <button className="btn-secondary" onClick={startAuth} style={{ marginTop: '12px', width: '100%' }}>{t("deviceAuth.retry")}</button>
            </div>
          ) : authData ? (
            <>
              <p style={{ marginBottom: '16px', color: 'var(--text-primary)' }}>
                {t("deviceAuth.instruction")}
              </p>
              <div style={{ 
                fontSize: '24px', 
                fontWeight: 'bold', 
                letterSpacing: '4px', 
                background: 'var(--bg-input)', 
                padding: '16px', 
                borderRadius: '8px', 
                marginBottom: '24px',
                userSelect: 'all',
                color: 'var(--primary)'
              }}>
                {authData.user_code}
              </div>
              <div style={{ marginBottom: '24px', fontSize: '12px', color: 'var(--text-muted)' }}>
                {t("deviceAuth.waiting")}
              </div>
              <a 
                href={authData.verification_uri} 
                target="_blank" 
                rel="noreferrer"
                onClick={handleCopyAndOpen}
                className="btn-primary"
                style={{ 
                  display: 'block', 
                  textDecoration: 'none', 
                  padding: '12px', 
                  borderRadius: '6px', 
                  background: '#2da44e',
                  color: 'white',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                {t("deviceAuth.copyAndOpen")}
              </a>
            </>
          ) : (
            <div className="summary-loading">
               <span className="spinner"></span>
               <div style={{ marginTop: '12px' }}>{t("deviceAuth.connecting")}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
