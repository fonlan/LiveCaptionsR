import { useTranslation } from "react-i18next";
import { IconPlus, IconMinus } from "../Icons";
import { AIChannel, AIChannelType, OpenAIChannel, CopilotChannel } from "../../types";
import { generateId } from "../../utils/textUtils";
import { ProxyConfigForm } from "./ProxyConfigForm";

interface ChannelsTabProps {
  channels: AIChannel[];
  onChange: (channels: AIChannel[]) => void;
  onAuth: (id: string) => void;
}

export function ChannelsTab({ channels, onChange, onAuth }: ChannelsTabProps) {
  const { t } = useTranslation();

  const addChannel = () => {
    const newChannel: AIChannel = {
      id: generateId(),
      type: 'openai',
      name: 'New Channel',
      api_key: '',
      base_url: 'https://api.openai.com/v1',
      proxy: { url: '', enabled: false }
    };
    onChange([...channels, newChannel]);
  };

  const updateChannel = (id: string, updates: Partial<AIChannel>) => {
    const updatedChannels = channels.map(c => {
      if (c.id !== id) return c;

      // Handle type switching
      if ('type' in updates && updates.type && updates.type !== c.type) {
         if (updates.type === 'openai') {
             return {
                 id: c.id,
                 name: c.name,
                 proxy: c.proxy,
                 type: 'openai',
                 api_key: '',
                 base_url: 'https://api.openai.com/v1',
             } as OpenAIChannel;
         } else {
             return {
                 id: c.id,
                 name: c.name,
                 proxy: c.proxy,
                 type: 'copilot'
             } as CopilotChannel;
         }
      }

      // Normal update - use any cast to avoid Partial<Union> issues
      return { ...c, ...updates } as any as AIChannel;
    });
    
    onChange(updatedChannels);
  };

  const removeChannel = (id: string) => {
    onChange(channels.filter(c => c.id !== id));
  };

  return (
    <div className="tab-panel">
      <div className="divider">
        {t("settings.channels.title")}
        <button className="btn-add-endpoint" onClick={addChannel} title={t("settings.channels.add")}>
          <IconPlus />
        </button>
      </div>
      <div className="channels-list">
        {channels.map((channel) => (
          <div key={channel.id} className="endpoint-card">
             <div className="endpoint-header">
                <input 
                  value={channel.name} 
                  onChange={e => updateChannel(channel.id, { name: e.target.value })}
                  className="endpoint-name-input"
                  placeholder={t("settings.channels.namePlaceholder")}
                />
                <button className="btn-remove-endpoint" onClick={() => removeChannel(channel.id)} title={t("settings.ai.removeEndpoint")}>
                  <IconMinus />
                </button>
             </div>
             
             <div className="form-group">
               <label>{t("settings.channels.type")}</label>
               <select 
                 value={channel.type} 
                 onChange={e => updateChannel(channel.id, { type: e.target.value as AIChannelType })}
               >
                 <option value="openai">{t("settings.channels.types.openai")}</option>
                 <option value="copilot">{t("settings.channels.types.copilot")}</option>
               </select>
             </div>

             {channel.type === 'openai' && (
               <>
                 <div className="form-group">
                   <label>{t("settings.translation.apiKey")}</label>
                   <input type="password" value={channel.api_key || ''} onChange={e => updateChannel(channel.id, { api_key: e.target.value })} />
                 </div>
                 <div className="form-group">
                   <label>{t("settings.ai.baseUrl")}</label>
                   <input type="text" value={channel.base_url || ''} onChange={e => updateChannel(channel.id, { base_url: e.target.value })} placeholder="https://api.openai.com/v1" />
                 </div>
               </>
             )}

             {channel.type === 'copilot' && (
               <div className="form-group">
                 <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-input)', padding: '10px', borderRadius: '6px' }}>
                    <span style={{ fontSize: '13px' }}>{channel.token ? t("settings.channels.login.loggedIn") : t("settings.channels.login.notLoggedIn")}</span>
                    <button 
                      className={channel.token ? "btn-secondary" : "btn-primary"} 
                      onClick={() => onAuth(channel.id)}
                      style={{ padding: '4px 12px', fontSize: '12px', cursor: 'pointer' }}
                    >
                      {channel.token ? t("settings.channels.login.relogin") : t("settings.channels.login.button")}
                    </button>
                 </div>
               </div>
             )}

             <ProxyConfigForm 
               proxy={channel.proxy} 
               onChange={p => updateChannel(channel.id, { proxy: p })} 
               label={t("settings.translation.useProxy")}
             />
          </div>
        ))}
      </div>
    </div>
  );
}
