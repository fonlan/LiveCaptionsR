import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { AppConfig, DEFAULT_TRANSLATION_PROMPT, LANGUAGES, LogLevel } from "../../types";
import { ProxyConfigForm } from "./ProxyConfigForm";
import { ChannelsTab } from "./ChannelsTab";
import { ModelsTab } from "./ModelsTab";

interface SettingsFormProps {
  config: AppConfig;
  onSave: (c: AppConfig, silent?: boolean) => void;
  onConfigChange?: (c: AppConfig) => void;
  onStartCopilotAuth: (id: string) => void;
  addToast: (type: 'success' | 'error', msg: string) => void;
  onClearAllSessions: () => void;
  hasSessions: boolean;
}

export function SettingsForm({ config, onSave, onConfigChange, onStartCopilotAuth, addToast, onClearAllSessions, hasSessions }: SettingsFormProps) {
  const { t, i18n } = useTranslation();
  const [formData, setFormData] = useState<AppConfig>(config);
  const [activeTab, setActiveTab] = useState<'general' | 'translation' | 'channels' | 'models' | 'summary'>('general');
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setFormData(config);
  }, [config]);

  useEffect(() => {
    if (formData.language && i18n.language !== formData.language) {
      i18n.changeLanguage(formData.language);
    }
  }, [formData.language, i18n]);

  // Debounced auto-save function
  const autoSave = useRef((newConfig: AppConfig, immediate = false) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    if (immediate) {
      onSave(newConfig, true);
    } else {
      saveTimeoutRef.current = setTimeout(() => {
        onSave(newConfig, true);
      }, 500); // 500ms debounce
    }
  }).current;

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  const renderGeneralTab = () => (
    <div className="tab-panel">
       <div className="form-group">
        <label>{t("settings.general.captionSource")}</label>
        <select
          value={formData.caption_source || 'livecaptions'}
          onChange={e => {
            const newConfig = { ...formData, caption_source: e.target.value };
            setFormData(newConfig);
            autoSave(newConfig);
          }}
        >
          <option value="livecaptions">{t("settings.general.captionSourceLiveCaptions")}</option>
          <option value="teams">{t("settings.general.captionSourceTeams")}</option>
        </select>
        {formData.caption_source === 'teams' && (
          <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
            Teams window selection will appear when you click Start.
          </div>
        )}
      </div>

       <div className="form-group">
        <label>{t("settings.general.language")}</label>
        <select
          value={formData.language || 'en'}
          onChange={e => {
            const newConfig = { ...formData, language: e.target.value };
            setFormData(newConfig);
            autoSave(newConfig);
          }}
        >
          <option value="en">English</option>
          <option value="zh-CN">简体中文</option>
        </select>
      </div>

       <div className="form-group">
        <label>{t("settings.general.logLevel")}</label>
        <select
          value={formData.log_level || 'info'}
          onChange={async e => {
            const newLevel = e.target.value as LogLevel;
            const newConfig: AppConfig = { ...formData, log_level: newLevel };
            setFormData(newConfig);
            try {
              await invoke("update_log_level_command", { level: newLevel });
              autoSave(newConfig, true);
            } catch (err) {
              console.error("Failed to update log level:", err);
              addToast('error', t("toast.logLevelUpdateFailed", { error: String(err) }));
            }
          }}
        >
          <option value="error">{t("settings.general.logLevelError")}</option>
          <option value="warn">{t("settings.general.logLevelWarn")}</option>
          <option value="info">{t("settings.general.logLevelInfo")}</option>
          <option value="debug">{t("settings.general.logLevelDebug")}</option>
        </select>
        <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
          {t("settings.general.logsLocation")}:{' '}
          <span
            style={{
              color: 'var(--accent)',
              cursor: 'pointer',
              textDecoration: 'underline'
            }}
            onClick={async () => {
              try {
                await invoke('open_log_directory');
              } catch (err) {
                console.error('Failed to open log directory:', err);
              }
            }}
          >
            %APPDATA%\LiveCaptionsR\logs
          </span>
        </div>
      </div>

       <div className="form-group">
        <label>{t("settings.general.theme")}</label>
        <select
          value={formData.theme || 'dark'}
          onChange={e => {
            const newConfig = { ...formData, theme: e.target.value };
            setFormData(newConfig);
            autoSave(newConfig);
          }}
        >
          <option value="dark">{t("settings.general.themeDark")}</option>
          <option value="light">{t("settings.general.themeLight")}</option>
        </select>
      </div>

      <div className="form-group">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
          <label>{t("settings.general.backgroundOpacity")}</label>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{Math.round((formData.opacity ?? 1.0) * 100)}%</span>
        </div>
        <input
          type="range"
          min="0.1"
          max="1.0"
          step="0.05"
          value={formData.opacity ?? 1.0}
          onChange={e => {
            const newConfig = { ...formData, opacity: parseFloat(e.target.value) };
            setFormData(newConfig);
            autoSave(newConfig);
          }}
          style={{ width: '100%', accentColor: 'var(--primary)', cursor: 'pointer' }}
        />
      </div>

      {formData.caption_source !== 'teams' && (
        <>
          <div className="form-group checkbox-group">
            <label className="switch">
              <input type="checkbox" checked={formData.hide_system_window} onChange={e => {
                const newConfig = { ...formData, hide_system_window: e.target.checked };
                setFormData(newConfig);
                autoSave(newConfig);
              }} />
              <span className="slider round"></span>
            </label>
            <span>{t("settings.general.hideSystemWindow")}</span>
          </div>

          <div className="form-group checkbox-group">
            <label className="switch">
              <input type="checkbox" checked={formData.include_microphone} onChange={e => {
                const newConfig = { ...formData, include_microphone: e.target.checked };
                setFormData(newConfig);
                autoSave(newConfig);
              }} />
              <span className="slider round"></span>
            </label>
            <span>{t("settings.general.includeMicrophone")}</span>
          </div>
        </>
      )}

      <div className="form-group checkbox-group">
        <label className="switch">
          <input
            type="checkbox"
            checked={formData.always_on_top}
            onChange={async e => {
              const checked = e.target.checked;
              const newConfig = { ...formData, always_on_top: checked };
              setFormData(newConfig);
              onConfigChange?.(newConfig);
              try {
                await invoke("set_always_on_top", { alwaysOnTop: checked });
                autoSave(newConfig);
              } catch (err) {
                console.error("Failed to set always on top:", err);
              }
            }}
          />
          <span className="slider round"></span>
        </label>
        <span>{t("settings.general.alwaysOnTop")}</span>
      </div>
      <div className="mt-6 rounded-xl border border-error/25 bg-error/10 p-4">
        <div className="text-sm font-semibold text-text-primary">{t("settings.general.sessionManagement")}</div>
        <div className="mt-1 text-xs text-text-secondary">{t("settings.general.clearAllSessionsHint")}</div>
        <button
          type="button"
          className={`mt-3 h-10 w-full rounded-lg border transition-all ${hasSessions ? 'border-error/40 bg-error/10 text-error cursor-pointer hover:bg-error/15' : 'border-border bg-input text-text-muted cursor-not-allowed opacity-70'}`}
          onClick={() => { void onClearAllSessions(); }}
          disabled={!hasSessions}
        >
          {t("settings.general.clearAllSessions")}
        </button>
      </div>
    </div>
  );

  const renderTranslationTab = () => (
    <div className="tab-panel">
      <div className="form-group checkbox-group" style={{ marginBottom: '16px' }}>
        <label className="switch">
          <input
            type="checkbox"
            checked={formData.translation_enabled !== false}
            onChange={e => {
              const newConfig = { ...formData, translation_enabled: e.target.checked };
              setFormData(newConfig);
              autoSave(newConfig);
            }}
          />
          <span className="slider round"></span>
        </label>
        <span>{t("settings.translation.enableTranslation")}</span>
      </div>

      <div className="form-group">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
          <label>{t("settings.translation.maxConcurrent")}</label>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{formData.max_concurrent_translations ?? 2}</span>
        </div>
        <input
          type="range"
          min="1"
          max="10"
          step="1"
          value={formData.max_concurrent_translations ?? 2}
          onChange={e => {
            const newConfig = { ...formData, max_concurrent_translations: parseInt(e.target.value) };
            setFormData(newConfig);
            autoSave(newConfig);
          }}
          style={{ width: '100%', accentColor: 'var(--primary)', cursor: 'pointer' }}
        />
      </div>

      <div className="form-row">
        <div className="form-group">
          <label>{t("settings.translation.sourceLanguage")}</label>
          <select
            value={formData.source_lang}
            onChange={e => {
              const newConfig = { ...formData, source_lang: e.target.value };
              setFormData(newConfig);
              autoSave(newConfig);
            }}
          >
            {LANGUAGES.map(lang => (
              <option key={lang.code} value={lang.code}>
                {lang.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>{t("settings.translation.targetLanguage")}</label>
          <select
            value={formData.target_lang}
            onChange={e => {
              const newConfig = { ...formData, target_lang: e.target.value };
              setFormData(newConfig);
              autoSave(newConfig);
            }}
          >
            {LANGUAGES.filter(l => l.code !== 'auto').map(lang => (
              <option key={lang.code} value={lang.code}>
                {lang.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="form-group">
        <label>{t("settings.translation.provider")}</label>
        <select
          value={formData.provider}
          onChange={e => {
            const newConfig = { ...formData, provider: e.target.value };
            setFormData(newConfig);
            autoSave(newConfig);
          }}
        >
          <option value="google">{t("settings.translation.google")}</option>
          <option value="microsoft">{t("settings.translation.microsoft")}</option>
          {formData.ai_models.map(model => {
             const channel = formData.ai_channels.find(c => c.id === model.channel_id);
             return (
               <option key={model.id} value={model.id}>
                 {model.name} ({channel?.name || 'Unknown'})
               </option>
             );
          })}
        </select>
      </div>

      {(() => {
          // Show context setting for AI models (OpenAI or Copilot), not for Google/Microsoft
          const isAIModel = formData.provider !== 'google' && formData.provider !== 'microsoft';
          const showTranslationPrompt = formData.translation_enabled !== false && isAIModel;
          const effectiveTranslationPrompt = formData.translation_prompt?.trim()
            ? formData.translation_prompt
            : DEFAULT_TRANSLATION_PROMPT;
          const isUsingDefaultTranslationPrompt = !formData.translation_prompt?.trim()
            || formData.translation_prompt === DEFAULT_TRANSLATION_PROMPT;

          return isAIModel && (
            <div className="endpoint-card" style={{ marginTop: '0px' }}>
              <div className="form-group">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <label>{t("settings.translation.contextMemory")}</label>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{formData.openai_context_count ?? 2}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="10"
                  value={formData.openai_context_count ?? 2}
                  onChange={e => {
                    const newConfig = { ...formData, openai_context_count: parseInt(e.target.value) };
                    setFormData(newConfig);
                    autoSave(newConfig);
                  }}
                  style={{ width: '100%', accentColor: 'var(--primary)', cursor: 'pointer' }}
                />
              </div>
              {showTranslationPrompt && (
                <div className="form-group">
                  <label>{t("settings.translation.prompt")}</label>
                  <textarea
                    className="summary-prompt-textarea"
                    value={effectiveTranslationPrompt}
                    onChange={e => {
                      const newConfig = { ...formData, translation_prompt: e.target.value };
                      setFormData(newConfig);
                      autoSave(newConfig);
                    }}
                    rows={8}
                  />
                  <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
                    {t("settings.translation.promptHint")}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' }}>
                    <button
                      type="button"
                      onClick={() => {
                        const newConfig = { ...formData, translation_prompt: '' };
                        setFormData(newConfig);
                        autoSave(newConfig);
                      }}
                      disabled={isUsingDefaultTranslationPrompt}
                      style={{
                        padding: '6px 10px',
                        borderRadius: '6px',
                        border: '1px solid var(--border-color)',
                        background: isUsingDefaultTranslationPrompt ? 'var(--bg-input)' : 'var(--bg-card-hover)',
                        color: isUsingDefaultTranslationPrompt ? 'var(--text-muted)' : 'var(--text-primary)',
                        cursor: isUsingDefaultTranslationPrompt ? 'not-allowed' : 'pointer',
                        transition: 'all 0.2s ease',
                      }}
                    >
                      {t("settings.translation.restoreDefault")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
      })()}

      {formData.provider === 'google' && (
        <>
          <div className="divider">{t("settings.translation.googleSettings")}</div>
          <ProxyConfigForm
            proxy={formData.google_proxy}
            onChange={p => {
              const newConfig = { ...formData, google_proxy: p };
              setFormData(newConfig);
              autoSave(newConfig);
            }}
            label={t("settings.translation.useProxy")}
          />
        </>
      )}

      {formData.provider === 'microsoft' && (
        <>
          <div className="divider">{t("settings.translation.microsoftSettings")}</div>
          <div className="form-group">
            <label>{t("settings.translation.apiKey")}</label>
            <input type="password" value={formData.microsoft_api_key || ''} onChange={e => {
              const newConfig = { ...formData, microsoft_api_key: e.target.value };
              setFormData(newConfig);
              autoSave(newConfig);
            }} />
          </div>
          <div className="form-group">
            <label>{t("settings.translation.region")}</label>
            <input type="text" value={formData.microsoft_region || ''} onChange={e => {
              const newConfig = { ...formData, microsoft_region: e.target.value };
              setFormData(newConfig);
              autoSave(newConfig);
            }} />
          </div>
          <ProxyConfigForm
            proxy={formData.microsoft_proxy}
            onChange={p => {
              const newConfig = { ...formData, microsoft_proxy: p };
              setFormData(newConfig);
              autoSave(newConfig);
            }}
            label={t("settings.translation.useProxy")}
          />
        </>
      )}
    </div>
  );

  const renderSummaryTab = () => (
    <div className="tab-panel">
      <div className="form-group">
        <label>{t("settings.summary.provider")}</label>
        <select
          value={formData.summary_provider}
          onChange={e => {
            const newConfig = { ...formData, summary_provider: e.target.value };
            setFormData(newConfig);
            autoSave(newConfig);
          }}
        >
          <option value="">{t("settings.summary.selectProvider")}</option>
          {formData.ai_models.map(model => {
             const channel = formData.ai_channels.find(c => c.id === model.channel_id);
             return (
               <option key={model.id} value={model.id}>
                 {model.name} ({channel?.name || 'Unknown'})
               </option>
             );
          })}
        </select>
      </div>
      <div className="form-group">
        <label>{t("settings.summary.prompt")}</label>
        <textarea
          className="summary-prompt-textarea"
          value={formData.summary_prompt || ''}
          onChange={e => {
            const newConfig = { ...formData, summary_prompt: e.target.value };
            setFormData(newConfig);
            autoSave(newConfig);
          }}
          rows={10}
        />
      </div>
    </div>
  );

  return (
    <div className="form-stack">
      <div className="settings-tabs">
        <button className={`tab-btn ${activeTab === 'general' ? 'active' : ''}`} onClick={() => setActiveTab('general')}>{t("settings.tabs.general")}</button>
        <button className={`tab-btn ${activeTab === 'channels' ? 'active' : ''}`} onClick={() => setActiveTab('channels')}>{t("settings.tabs.channels")}</button>
        <button className={`tab-btn ${activeTab === 'models' ? 'active' : ''}`} onClick={() => setActiveTab('models')}>{t("settings.tabs.models")}</button>
        <button className={`tab-btn ${activeTab === 'translation' ? 'active' : ''}`} onClick={() => setActiveTab('translation')}>{t("settings.tabs.translation")}</button>
        <button className={`tab-btn ${activeTab === 'summary' ? 'active' : ''}`} onClick={() => setActiveTab('summary')}>{t("settings.tabs.summary")}</button>
      </div>

      <div className="tab-content-container" style={{ flex: 1, minHeight: 0 }}>
        {activeTab === 'general' && renderGeneralTab()}
        {activeTab === 'channels' && (
            <ChannelsTab
                channels={formData.ai_channels}
                onChange={channels => {
                  const newConfig = { ...formData, ai_channels: channels };
                  setFormData(newConfig);
                  autoSave(newConfig);
                }}
                onAuth={onStartCopilotAuth}
            />
        )}
        {activeTab === 'models' && (
            <ModelsTab
                models={formData.ai_models}
                channels={formData.ai_channels}
                onChange={models => {
                  const newConfig = { ...formData, ai_models: models };
                  setFormData(newConfig);
                  autoSave(newConfig);
                }}
                addToast={addToast}
            />
        )}
        {activeTab === 'translation' && renderTranslationTab()}
        {activeTab === 'summary' && renderSummaryTab()}
      </div>
    </div>
  );
}
