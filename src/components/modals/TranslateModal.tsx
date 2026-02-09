import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { IconX } from "../Icons";
import { AppConfig, AIModel, LANGUAGES } from "../../types";

interface TranslateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTranslate: (targetLang: string, providerOverride?: string) => void;
  currentTargetLang: string;
  config: AppConfig;
  isTranslating?: boolean;
}

export function TranslateModal({
  isOpen,
  onClose,
  onTranslate,
  currentTargetLang,
  config,
  isTranslating = false,
}: TranslateModalProps) {
  const { t } = useTranslation();
  const [selectedLang, setSelectedLang] = useState<string>(currentTargetLang);
  const [selectedProvider, setSelectedProvider] = useState<string>('google');

  useEffect(() => {
    if (isOpen) {
      setSelectedLang(currentTargetLang);
      // Initialize from current config
      setSelectedProvider(config.provider);
    }
  }, [isOpen, currentTargetLang, config]);

  const handleTranslate = () => {
    if (isTranslating) return;
    onTranslate(selectedLang, selectedProvider);
    onClose();
  };

  const getProviderLabel = (model: AIModel) => {
    const channel = config.ai_channels.find(c => c.id === model.channel_id);
    return `${model.name} (${channel?.name || 'Unknown'})`;
  };

  if (!isOpen) return null;
  return (
    <div className="settings-overlay open" onClick={onClose}>
      <div className="settings-drawer" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px', width: '90%' }}>
        <header className="settings-header">
          <h2>{t("translateSession.title")}</h2>
          <button className="btn-icon" onClick={onClose}>
            <IconX />
          </button>
        </header>
        <div className="settings-content" style={{ padding: '20px' }}>
          
          {/* Provider Selection */}
          <div className="form-group" style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-primary)', fontWeight: 500 }}>
              {t("settings.translation.provider")}
            </label>
            <select
              value={selectedProvider}
              onChange={e => setSelectedProvider(e.target.value)}
              disabled={isTranslating}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: 'var(--bg-input)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                fontSize: '14px',
                outline: 'none',
                cursor: 'pointer'
              }}
            >
              <option value="google">{t("settings.translation.google")}</option>
              <option value="microsoft">{t("settings.translation.microsoft")}</option>
              {config.ai_models.map(model => (
                <option key={model.id} value={model.id}>
                    {getProviderLabel(model)}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group" style={{ marginBottom: '20px' }}>
            <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-primary)', fontWeight: 500 }}>
              {t("translateSession.targetLanguage")}
            </label>
            <select
              value={selectedLang}
              onChange={e => setSelectedLang(e.target.value)}
              disabled={isTranslating}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: 'var(--bg-input)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                fontSize: '14px',
                outline: 'none',
                cursor: 'pointer'
              }}
            >
              {LANGUAGES.filter(l => l.code !== 'auto').map(lang => (
                <option key={lang.code} value={lang.code}>
                  {lang.name}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
            <button
              className="btn-save"
              onClick={handleTranslate}
              disabled={isTranslating}
              style={{
                flex: 1,
                padding: '10px 16px',
                background: 'var(--primary)',
                color: 'var(--bg-card)',
                border: 'none',
                borderRadius: '6px',
                fontSize: '14px',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'opacity 0.2s'
              }}
              onMouseEnter={e => e.currentTarget.style.opacity = '0.9'}
              onMouseLeave={e => e.currentTarget.style.opacity = '1'}
            >
              {isTranslating ? t("translateSession.translating") : t("translateSession.translate")}
            </button>
            <button
              onClick={onClose}
              style={{
                flex: 1,
                padding: '10px 16px',
                background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'opacity 0.2s'
              }}
              onMouseEnter={e => e.currentTarget.style.opacity = '0.8'}
              onMouseLeave={e => e.currentTarget.style.opacity = '1'}
            >
              {t("translateSession.cancel")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
