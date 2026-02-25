import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { IconPlus, IconMinus, IconRetry } from "../Icons";
import { AIModel, AIChannel, CopilotModel } from "../../types";
import { generateId } from "../../utils/textUtils";
import { ErrorDetailModal } from "../modals/ErrorDetailModal";

interface ModelsTabProps {
  models: AIModel[];
  channels: AIChannel[];
  onChange: (models: AIModel[]) => void;
  addToast: (type: 'success' | 'error', msg: string) => void;
}

export function ModelsTab({ models, channels, onChange, addToast }: ModelsTabProps) {
  const { t } = useTranslation();
  const [fetchedModels, setFetchedModels] = useState<Record<string, CopilotModel[]>>({});
  const [isFetching, setIsFetching] = useState<Record<string, boolean>>({});
  const [errorDetails, setErrorDetails] = useState<string | null>(null);

  const addModel = () => {
    const newModel: AIModel = {
      id: generateId(),
      name: 'gpt-4o-mini',
      channel_id: channels.length > 0 ? channels[0].id : 'default',
    };
    onChange([...models, newModel]);
  };

  const updateModel = (id: string, updates: Partial<AIModel>) => {
    onChange(models.map(m => m.id === id ? { ...m, ...updates } : m));
  };

  const removeModel = (id: string) => {
    onChange(models.filter(m => m.id !== id));
  };

  const handleFetchModels = async (channelId: string) => {
    const channel = channels.find(c => c.id === channelId);
    
    if (!channel) {
        addToast('error', t("settings.models.toast.channelNotAuth"));
        return;
    }

    if (channel.type !== 'copilot') {
         addToast('error', t("settings.models.toast.channelNotAuth"));
         return;
    }

    // Explicit check for token now that we know it is copilot
    if (!channel.token) {
        addToast('error', t("settings.models.toast.channelNotAuth"));
        return;
    }

    setIsFetching(prev => ({ ...prev, [channelId]: true }));
    try {
      const result = await invoke<CopilotModel[]>('fetch_copilot_models_command', { channelId });
      setFetchedModels(prev => ({ ...prev, [channelId]: result }));
      addToast('success', t("settings.models.toast.fetched", { count: result.length }));
    } catch (e) {
      console.error(e);
      const errorMsg = String(e);
      addToast('error', t("settings.models.toast.failed", { error: errorMsg }));
      // Show detailed error in a dialog
      setErrorDetails(errorMsg);
    } finally {
      setIsFetching(prev => ({ ...prev, [channelId]: false }));
    }
  };

  return (
    <div className="tab-panel">
      <div className="divider">
        {t("settings.models.title")}
        <button className="btn-add-endpoint" onClick={addModel} title={t("settings.models.add")}>
          <IconPlus />
        </button>
      </div>
      <div className="channels-list">
        {models.map((model) => {
          const selectedChannel = channels.find(c => c.id === model.channel_id);
          const isCopilot = selectedChannel?.type === 'copilot';
          const channelFetchedModels = isCopilot ? fetchedModels[model.channel_id] : null;

          return (
            <div key={model.id} className="endpoint-card">
               <div className="endpoint-header">
                  <span style={{ fontWeight: 500 }}>{model.name}</span>
                  <button className="btn-remove-endpoint" onClick={() => removeModel(model.id)} title={t("settings.ai.removeEndpoint")}>
                    <IconMinus />
                  </button>
               </div>
               
               <div className="form-group">
                 <label>{t("settings.models.channel")}</label>
                 <select 
                   value={model.channel_id} 
                   onChange={e => updateModel(model.id, { channel_id: e.target.value })}
                 >
                   {channels.map(c => (
                     <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                   ))}
                 </select>
               </div>

               <div className="form-group">
                 <label>{t("settings.models.name")}</label>
                 <div style={{ display: 'flex', gap: '8px' }}>
                    {isCopilot && channelFetchedModels ? (
                        <select 
                            value={model.name} 
                            onChange={e => updateModel(model.id, { name: e.target.value })}
                            style={{ flex: 1 }}
                        >
                            {channelFetchedModels.map(m => (
                                <option key={m.id} value={m.id}>{m.name} ({m.id})</option>
                            ))}
                        </select>
                    ) : (
                        <input 
                            type="text" 
                            value={model.name} 
                            onChange={e => updateModel(model.id, { name: e.target.value })}
                            style={{ flex: 1 }}
                            placeholder={t("settings.models.placeholder")}
                        />
                    )}
                    
                    {isCopilot && (
                        <button 
                            className="btn-secondary"
                            onClick={() => handleFetchModels(model.channel_id)}
                            disabled={isFetching[model.channel_id] || (selectedChannel?.type === 'copilot' ? !selectedChannel.token : true)}
                            title={!(selectedChannel?.type === 'copilot' && selectedChannel.token) ? t("settings.models.loginFirst") : t("settings.models.fetchTooltip")}
                            style={{ whiteSpace: 'nowrap', display: 'flex', alignItems: 'center' }}
                        >
                            {isFetching[model.channel_id] ? <span className="spinner" style={{width: 12, height: 12, borderWidth: 2}}></span> : <IconRetry size={14} />}
                            <span style={{ marginLeft: 4 }}>{t("settings.models.fetch")}</span>
                        </button>
                    )}
                 </div>
               </div>
            </div>
          );
        })}
      </div>

      <ErrorDetailModal
        isOpen={errorDetails !== null}
        onClose={() => setErrorDetails(null)}
        errorDetails={errorDetails}
      />
    </div>
  );
}
