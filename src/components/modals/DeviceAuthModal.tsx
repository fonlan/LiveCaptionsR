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
    <div className="fixed inset-0 bg-black/60 backdrop-blur-[4px] z-[100] flex justify-center items-center" onClick={onClose}>
      <div className="bg-panel shadow-2xl flex flex-col rounded-lg overflow-hidden animate-fade-in" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px', width: '90%' }}>
        <header className="px-6 py-3 border-b border-border flex justify-between items-center bg-panel">
          <h2 className="m-0 text-lg font-semibold text-text-primary">{t("deviceAuth.title")}</h2>
          <button className="bg-transparent border-none text-text-secondary cursor-pointer p-2 rounded-full transition-all flex items-center justify-center hover:bg-card-hover hover:text-text-primary" onClick={onClose}><IconX /></button>
        </header>
        <div className="p-6 text-center">
          {error ? (
            <div className="text-error mb-4">
              {t("deviceAuth.error", { error })}
              <button 
                className="mt-3 w-full px-3 py-2 bg-bg-secondary text-text-primary border border-border rounded-md text-xs font-semibold cursor-pointer transition-all hover:bg-card-hover hover:border-text-muted" 
                onClick={startAuth}
              >
                {t("deviceAuth.retry")}
              </button>
            </div>
          ) : authData ? (
            <>
              <p className="mb-4 text-text-primary">
                {t("deviceAuth.instruction")}
              </p>
              <div className="text-2xl font-bold tracking-[4px] bg-input p-4 rounded-lg mb-6 select-all text-primary border border-border">
                {authData.user_code}
              </div>
              <div className="mb-6 text-xs text-text-muted">
                {t("deviceAuth.waiting")}
              </div>
              <a 
                href={authData.verification_uri} 
                target="_blank" 
                rel="noreferrer"
                onClick={handleCopyAndOpen}
                className="block text-decoration-none p-3 rounded-md bg-[#2da44e] text-white font-semibold cursor-pointer hover:brightness-110 transition-all"
              >
                {t("deviceAuth.copyAndOpen")}
              </a>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-[200px]">
               <span className="w-4 h-4 border-2 border-white/10 border-t-current rounded-full animate-spin"></span>
               <div className="mt-3">{t("deviceAuth.connecting")}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
